// POST /extract-bail
// Entrée : { bailB64: string, formuleB64?: string } (PDF en base64)
// Les données extraites sont toujours normalisées et doivent être confirmées
// par l'utilisateur avant le diagnostic.

import {
  buildClaudeExtractionRequest,
  ClaudeExtractionError,
  parseClaudeExtraction,
} from '../../../src/bail-extraction.js';
import { badRequest, json, preflight } from '../_shared/http.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6';
// La limite Anthropic est de 32 Mo pour la requête complète. Une fois encodés
// en base64, 20 Mo de PDF occupent environ 27 Mo et laissent de la place au JSON.
const MAX_COMBINED_PDF_BYTES = 20 * 1024 * 1024;

function estimatedBase64Bytes(value: string): number {
  const clean = value.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function validatePdf(value: unknown, label: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return `${label} requis (PDF en base64)`;
  const clean = value.replace(/\s/g, '');
  if (!clean.startsWith('JVBER')) return `${label} doit être un fichier PDF valide`;
  return null;
}

function upstreamMessage(status: number): string {
  if (status === 429) return 'Le service d’analyse est momentanément saturé. Réessayez dans une minute.';
  if (status === 413) return 'Les documents sont trop volumineux pour être analysés.';
  if (status >= 500) return 'Le service d’analyse est momentanément indisponible. Réessayez dans quelques instants.';
  return 'Le document n’a pas pu être analysé. Vérifiez qu’il s’agit d’un PDF lisible et non protégé par mot de passe.';
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return badRequest('POST attendu');

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    console.error('claude_configuration_error', { missing: 'ANTHROPIC_API_KEY' });
    return json({ error: 'Le service d’analyse n’est pas configuré.', code: 'claude_not_configured' }, 503);
  }

  let body: { bailB64?: string; formuleB64?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest('JSON invalide');
  }

  const bailError = validatePdf(body.bailB64, 'Le bail');
  if (bailError) return badRequest(bailError);
  if (body.formuleB64) {
    const formuleError = validatePdf(body.formuleB64, 'La formule officielle');
    if (formuleError) return badRequest(formuleError);
  }

  const totalBytes = estimatedBase64Bytes(body.bailB64!)
    + (body.formuleB64 ? estimatedBase64Bytes(body.formuleB64) : 0);
  if (totalBytes > MAX_COMBINED_PDF_BYTES) {
    return json({
      error: 'Les documents dépassent 20 Mo au total. Compressez-les puis réessayez.',
      code: 'documents_too_large',
    }, 413);
  }

  let requestId: string | null = null;
  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(buildClaudeExtractionRequest({
        model: MODEL,
        bailB64: body.bailB64!,
        formuleB64: body.formuleB64,
      })),
    });

    requestId = response.headers.get('request-id');
    const responseText = await response.text();
    let data: Record<string, unknown> = {};
    try {
      data = responseText ? JSON.parse(responseText) : {};
    } catch {
      // Une réponse amont non JSON est journalisée uniquement par ses métadonnées.
    }

    if (!response.ok) {
      const anthropicError = data.error && typeof data.error === 'object'
        ? data.error as Record<string, unknown>
        : {};
      console.error('claude_upstream_error', {
        status: response.status,
        requestId,
        type: anthropicError.type ?? 'unknown',
        message: typeof anthropicError.message === 'string'
          ? anthropicError.message.slice(0, 500)
          : 'unknown',
      });
      return json({
        error: upstreamMessage(response.status),
        code: 'claude_upstream_error',
      }, 502);
    }

    try {
      const extracted = parseClaudeExtraction(data, Boolean(body.formuleB64));
      console.info('claude_extraction_completed', {
        requestId,
        model: data.model ?? MODEL,
        stopReason: data.stop_reason ?? null,
        inputTokens: data.usage && typeof data.usage === 'object'
          ? (data.usage as Record<string, unknown>).input_tokens ?? null
          : null,
        outputTokens: data.usage && typeof data.usage === 'object'
          ? (data.usage as Record<string, unknown>).output_tokens ?? null
          : null,
      });
      return json({
        extracted,
        extraction: { provider: 'anthropic', model: data.model ?? MODEL },
      });
    } catch (error) {
      const code = error instanceof ClaudeExtractionError ? error.code : 'invalid_response';
      console.error('claude_extraction_invalid', {
        requestId,
        code,
        model: data.model ?? MODEL,
        stopReason: data.stop_reason ?? null,
      });
      const message = code === 'truncated'
        ? 'Le document est trop complexe pour une seule analyse. Réessayez avec un PDF compressé.'
        : 'Le service d’analyse n’a pas pu interpréter ce document. Réessayez dans quelques instants.';
      return json({ error: message, code }, 502);
    }
  } catch (error) {
    console.error('claude_network_error', {
      requestId,
      name: error instanceof Error ? error.name : 'unknown',
    });
    return json({
      error: 'Le service d’analyse est injoignable. Réessayez dans quelques instants.',
      code: 'claude_network_error',
    }, 502);
  }
});

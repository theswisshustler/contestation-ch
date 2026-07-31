import {
  buildHausseExtractionRequest,
  parseHausseExtractionResponse,
} from '../../../src/hausse-extraction.js';
import { badRequest, json, preflight } from '../_shared/http.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6';
const MAX_COMBINED_PDF_BYTES = 20 * 1024 * 1024;

function estimatedBytes(value: string): number {
  const clean = value.replace(/\s/g, '');
  return Math.max(0, Math.floor((clean.length * 3) / 4) - (clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0));
}
function validatePdf(value: unknown, label: string): string | null {
  if (typeof value !== 'string' || !value.trim()) return `${label} requis (PDF)`;
  return value.replace(/\s/g, '').startsWith('JVBER') ? null : `${label} doit être un PDF valide`;
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== 'POST') return badRequest('POST attendu');
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return json({ error: 'Le service d’analyse n’est pas configuré.' }, 503);

  let body: { notificationB64?: string; bailB64?: string };
  try { body = await req.json(); } catch { return badRequest('JSON invalide'); }
  const notificationError = validatePdf(body.notificationB64, 'La notification de hausse');
  if (notificationError) return badRequest(notificationError);
  if (body.bailB64) {
    const bailError = validatePdf(body.bailB64, 'Le bail');
    if (bailError) return badRequest(bailError);
  }
  if (estimatedBytes(body.notificationB64!) + (body.bailB64 ? estimatedBytes(body.bailB64) : 0) > MAX_COMBINED_PDF_BYTES) {
    return json({ error: 'Les documents dépassent 20 Mo au total. Compressez-les puis réessayez.' }, 413);
  }

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(buildHausseExtractionRequest({
        model: MODEL,
        notificationB64: body.notificationB64!,
        bailB64: body.bailB64,
      })),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('hausse_extraction_upstream_error', { status: response.status, requestId: response.headers.get('request-id') });
      return json({ error: response.status === 429 ? 'Le service est saturé. Réessayez dans une minute.' : 'La notification n’a pas pu être analysée.' }, 502);
    }
    const extracted = parseHausseExtractionResponse(payload);
    return json({ extracted, extraction: { provider: 'anthropic', model: payload.model ?? MODEL } });
  } catch (error) {
    console.error('hausse_extraction_error', { name: error instanceof Error ? error.name : 'unknown' });
    return json({ error: 'Le service n’a pas pu interpréter cette notification. Vérifiez que le PDF est lisible.' }, 502);
  }
});

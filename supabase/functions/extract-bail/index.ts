// POST /extract-bail
// Entrée : { bailB64: string, formuleB64?: string }  (PDF en base64)
// - Envoie le(s) PDF à l'API Claude (lecture native PDF, texte + scan).
// - Renvoie le JSON structuré (schéma EXTRACTION_SYSTEM_PROMPT) à préremplir,
//   que l'utilisateur validera avant /evaluate.
// - Zero-retention côté LLM (config compte Anthropic).

import { EXTRACTION_SYSTEM_PROMPT } from '../_shared/ruleset.ts';
import { badRequest, json, preflight, serverError } from '../_shared/http.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6';

function docBlock(b64: string) {
  return {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data: b64 },
  };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return badRequest('POST attendu');

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) return serverError('ANTHROPIC_API_KEY manquant');

  let body: { bailB64?: string; formuleB64?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest('JSON invalide');
  }
  if (!body.bailB64) return badRequest('bailB64 requis (PDF du bail en base64)');

  const content: unknown[] = [docBlock(body.bailB64)];
  if (body.formuleB64) content.push(docBlock(body.formuleB64));
  content.push({ type: 'text', text: 'Extrais les champs et renvoie uniquement le JSON.' });

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!r.ok) return serverError('Appel Claude échoué', await r.text());

    const data = await r.json();
    const text: string = (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text: string }) => b.text)
      .join('')
      .trim();

    let extracted: Record<string, unknown>;
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
      extracted = JSON.parse(cleaned);
    } catch {
      return serverError('Réponse Claude non-JSON', text.slice(0, 500));
    }

    // Ne jamais déduire « non reçue » du seul fait que l'utilisateur n'a pas
    // téléversé de formule. Cette réponse doit être confirmée par l'utilisateur.
    if (!body.formuleB64) {
      extracted.formuleOfficielleRecue = 'inconnu';
      extracted.loyerPrecedentConnu = false;
      extracted.loyerPrecedentNet = null;
    } else if (extracted.formuleOfficielleRecue !== 'oui') {
      extracted.formuleOfficielleRecue = 'inconnu';
    }

    return json({ extracted });
  } catch (e) {
    return serverError('Erreur extraction', e);
  }
});

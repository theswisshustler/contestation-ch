// POST /download-letter
// Entrée : { letterId: string }
//
// GATE DE PAIEMENT. Renvoie une URL signée du PDF PROPRE UNIQUEMENT si
// letters.unlocked = true (c.-à-d. stripe-webhook a confirmé le paiement).
// Sinon → 402 Payment Required. Le bucket `letters-clean` étant privé et sans
// policy client, il n'existe aucun autre chemin vers le PDF propre.

import { adminClient } from '../_shared/supabase.ts';
import { authorizeDownload } from '../../../src/access-control.ts';
import { badRequest, json, preflight, serverError } from '../_shared/http.ts';

const DOWNLOAD_TTL = 60 * 10; // 10 min

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return badRequest('POST attendu');

  let letterId: string;
  try {
    letterId = (await req.json()).letterId;
  } catch {
    return badRequest('JSON invalide');
  }
  if (!letterId) return badRequest('letterId requis');

  const db = adminClient();
  const { data: letter, error } = await db
    .from('letters')
    .select('clean_pdf_path, unlocked')
    .eq('id', letterId)
    .single();

  // ── Le verrou. Pas de paiement confirmé → pas de PDF propre. ──
  const decision = authorizeDownload(error ? null : letter);
  if (!decision.allow) {
    return json({ error: decision.reason }, decision.status);
  }

  try {
    const signed = await db.storage
      .from('letters-clean')
      .createSignedUrl(decision.path, DOWNLOAD_TTL);
    if (signed.error) throw signed.error;
    return json({ url: signed.data.signedUrl, expiresInSeconds: DOWNLOAD_TTL });
  } catch (e) {
    return serverError('Génération du lien de téléchargement échouée', e);
  }
});

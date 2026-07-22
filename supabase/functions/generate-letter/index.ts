// POST /generate-letter
// Entrée : { dossierId: string }
//
// SÉCURITÉ (exigence produit) :
//   Le PDF PROPRE est généré côté serveur et stocké dans le bucket PRIVÉ
//   `letters-clean`. Il n'est JAMAIS renvoyé ici, ni sous forme d'URL, ni
//   signée. `letters.unlocked` reste false. Seul stripe-webhook le passera à
//   true après paiement, et seul download-letter émettra alors une URL signée.
//
//   Le client ne reçoit QUE des PNG filigranés (filigrane rastérisé, non
//   retirable), servis via URL signée courte durée depuis le bucket `previews`.

import { evaluateDossier, type DossierContestation } from '../_shared/ruleset.ts';
import { letterHtml, watermarkedHtml } from '../_shared/letter-template.ts';
import { htmlToPdf, htmlToPng } from '../_shared/gotenberg.ts';
import { adminClient, flagManualReview } from '../_shared/supabase.ts';
import { badRequest, json, preflight, serverError } from '../_shared/http.ts';

const PREVIEW_TTL = 60 * 30; // 30 min

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return badRequest('POST attendu');

  let dossierId: string;
  try {
    dossierId = (await req.json()).dossierId;
  } catch {
    return badRequest('JSON invalide');
  }
  if (!dossierId) return badRequest('dossierId requis');

  const db = adminClient();

  const { data: row, error } = await db
    .from('dossiers')
    .select('id, payload, eligible')
    .eq('id', dossierId)
    .single();
  if (error || !row) return badRequest('Dossier introuvable');

  const dossier = row.payload as DossierContestation;
  // Recalcul serveur : source de vérité pour la lettre.
  const evaluation = evaluateDossier(dossier);

  if (!evaluation.eligible) {
    return badRequest('Dossier non éligible : pas de génération de lettre.');
  }

  try {
    // 1) PDF PROPRE → bucket privé. Chemin non devinable, jamais exposé.
    const cleanPdf = await htmlToPdf(letterHtml(dossier, evaluation));
    const cleanPath = `${dossierId}/requete-${crypto.randomUUID()}.pdf`;
    const upClean = await db.storage
      .from('letters-clean')
      .upload(cleanPath, cleanPdf, { contentType: 'application/pdf', upsert: true });
    if (upClean.error) throw upClean.error;

    // 2) PREVIEW filigrané → bucket previews (PNG, filigrane incrusté).
    const previewPng = await htmlToPng(watermarkedHtml(dossier, evaluation));
    const previewPath = `${dossierId}/preview-${crypto.randomUUID()}.png`;
    const upPrev = await db.storage
      .from('previews')
      .upload(previewPath, previewPng, { contentType: 'image/png', upsert: true });
    if (upPrev.error) throw upPrev.error;

    // 3) Enregistre la lettre — unlocked=false. Le PDF propre reste verrouillé.
    const { data: letter, error: lErr } = await db
      .from('letters')
      .insert({
        dossier_id: dossierId,
        clean_pdf_path: cleanPath, // stocké côté serveur uniquement
        preview_paths: [previewPath],
        unlocked: false,
      })
      .select('id')
      .single();
    if (lErr || !letter) throw lErr ?? new Error('letters insert');

    // 4) URL signée UNIQUEMENT pour le preview filigrané.
    const signed = await db.storage
      .from('previews')
      .createSignedUrl(previewPath, PREVIEW_TTL);
    if (signed.error) throw signed.error;

    return json({
      letterId: letter.id,
      previews: [signed.data.signedUrl],
      // Volontairement : aucune référence au PDF propre.
    });
  } catch (e) {
    await flagManualReview(db, dossierId, 'Échec génération lettre (Gotenberg/storage)', String(e));
    return serverError('Génération de la lettre échouée', e);
  }
});

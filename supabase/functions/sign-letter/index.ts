// POST /sign-letter
// Régénère le PDF privé avec la signature avant le paiement de l'offre recommandée.

import { evaluateDossier, type DossierContestation } from '../_shared/ruleset.ts';
import { letterHtml } from '../_shared/letter-template.ts';
import { ensureGotenbergReady, htmlToPdf } from '../_shared/gotenberg.ts';
import { adminClient, flagManualReview } from '../_shared/supabase.ts';
import { badRequest, json, preflight, serverError } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return badRequest('POST attendu');
  let body: { dossierId?: string; letterId?: string; signatureDataUrl?: string };
  try { body = await req.json(); } catch { return badRequest('JSON invalide'); }
  if (!body.dossierId || !body.letterId || !body.signatureDataUrl) return badRequest('dossierId, letterId et signature requis');
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(body.signatureDataUrl) || body.signatureDataUrl.length > 500_000) {
    return badRequest('Signature invalide');
  }
  const db = adminClient();
  try {
    const { data: dossierRow } = await db.from('dossiers').select('payload').eq('id', body.dossierId).single();
    const { data: letterRow } = await db.from('letters').select('clean_pdf_path, unlocked').eq('id', body.letterId).eq('dossier_id', body.dossierId).single();
    if (!dossierRow || !letterRow || letterRow.unlocked) return badRequest('Dossier ou lettre indisponible');
    const dossier = { ...(dossierRow.payload as DossierContestation), signatureDataUrl: body.signatureDataUrl };
    const evaluation = evaluateDossier(dossier);
    if (!evaluation.eligible) return badRequest('Dossier non éligible');
    await ensureGotenbergReady();
    const pdf = await htmlToPdf(letterHtml(dossier, evaluation));
    const cleanPath = `${body.dossierId}/requete-signee-${crypto.randomUUID()}.pdf`;
    const upload = await db.storage.from('letters-clean').upload(cleanPath, pdf, { contentType: 'application/pdf' });
    if (upload.error) throw upload.error;
    // Publier d'abord le chemin signé, puis le marqueur de signature utilisé par
    // create-checkout. Si la seconde écriture échoue, le paiement reste bloqué.
    const letterUpdate = await db.from('letters').update({ clean_pdf_path: cleanPath })
      .eq('id', body.letterId).eq('dossier_id', body.dossierId).eq('unlocked', false);
    if (letterUpdate.error) throw letterUpdate.error;
    const dossierUpdate = await db.from('dossiers').update({ payload: dossier }).eq('id', body.dossierId);
    if (dossierUpdate.error) {
      await db.from('letters').update({ clean_pdf_path: letterRow.clean_pdf_path })
        .eq('id', body.letterId).eq('dossier_id', body.dossierId).eq('unlocked', false);
      await db.storage.from('letters-clean').remove([cleanPath]);
      throw dossierUpdate.error;
    }
    if (letterRow.clean_pdf_path) await db.storage.from('letters-clean').remove([letterRow.clean_pdf_path]);
    return json({ signed: true });
  } catch (e) {
    await flagManualReview(db, body.dossierId ?? null, 'Échec de régénération du PDF signé', String(e));
    return serverError('Signature de la lettre échouée', e);
  }
});

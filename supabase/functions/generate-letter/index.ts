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
import { ensureGotenbergReady, htmlToPdf, htmlToPng } from '../_shared/gotenberg.ts';
import { adminClient, flagManualReview } from '../_shared/supabase.ts';
import { badRequest, json, preflight, serverError } from '../_shared/http.ts';

const PREVIEW_TTL = 60 * 30; // 30 min

type StoredLetter = {
  id: string;
  clean_pdf_path: string | null;
  preview_paths: string[];
  unlocked: boolean;
};

async function findExistingLetter(
  db: ReturnType<typeof adminClient>,
  dossierId: string,
): Promise<StoredLetter | null> {
  const { data, error } = await db
    .from('letters')
    .select('id, clean_pdf_path, preview_paths, unlocked')
    .eq('dossier_id', dossierId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data as StoredLetter | null;
}

async function previewPayload(
  db: ReturnType<typeof adminClient>,
  letter: StoredLetter,
): Promise<{ letterId: string; previews: string[]; reused: true } | null> {
  const previewPath = letter.preview_paths?.[0];
  if (!letter.clean_pdf_path || !previewPath) return null;
  const signed = await db.storage.from('previews').createSignedUrl(previewPath, PREVIEW_TTL);
  if (signed.error) throw signed.error;
  return { letterId: letter.id, previews: [signed.data.signedUrl], reused: true };
}

async function removeGeneratedFiles(
  db: ReturnType<typeof adminClient>,
  cleanPath: string | null,
  previewPath: string | null,
): Promise<void> {
  const removals: Promise<unknown>[] = [];
  if (cleanPath) removals.push(db.storage.from('letters-clean').remove([cleanPath]));
  if (previewPath) removals.push(db.storage.from('previews').remove([previewPath]));
  const results = await Promise.allSettled(removals);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('letter_file_cleanup_failed', { error: String(result.reason) });
      continue;
    }
    const storageError = (result.value as { error?: unknown } | null)?.error;
    if (storageError) console.warn('letter_file_cleanup_failed', { error: String(storageError) });
  }
}

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

  let cleanPath: string | null = null;
  let previewPath: string | null = null;
  let committed = false;

  try {
    // Une réponse peut se perdre entre Supabase et le navigateur alors que la
    // génération a bien abouti. Un nouvel appel rend la même lettre et signe
    // seulement une nouvelle URL de preview, sans relancer Chromium.
    const existing = await findExistingLetter(db, dossierId);
    const existingPayload = existing ? await previewPayload(db, existing) : null;
    if (existingPayload) {
      console.info('letter_generation_reused', { dossierId, letterId: existing.id });
      return json(existingPayload);
    }
    if (existing?.unlocked) {
      throw new Error('Lettre déjà payée mais preview indisponible');
    }

    await ensureGotenbergReady();

    // 1) PDF PROPRE → bucket privé. Chemin non devinable, jamais exposé.
    const cleanPdf = await htmlToPdf(letterHtml(dossier, evaluation));
    cleanPath = `${dossierId}/requete-${crypto.randomUUID()}.pdf`;
    const upClean = await db.storage
      .from('letters-clean')
      .upload(cleanPath, cleanPdf, { contentType: 'application/pdf', upsert: true });
    if (upClean.error) throw upClean.error;

    // 2) PREVIEW filigrané → bucket previews (PNG, filigrane incrusté).
    const previewPng = await htmlToPng(watermarkedHtml(dossier, evaluation));
    previewPath = `${dossierId}/preview-${crypto.randomUUID()}.png`;
    const upPrev = await db.storage
      .from('previews')
      .upload(previewPath, previewPng, { contentType: 'image/png', upsert: true });
    if (upPrev.error) throw upPrev.error;

    // 3) Enregistre la lettre — unlocked=false. Le PDF propre reste verrouillé.
    let letter: { id: string } | null = null;
    let lErr: { code?: string; message?: string } | null = null;
    if (existing) {
      const result = await db
        .from('letters')
        .update({ clean_pdf_path: cleanPath, preview_paths: [previewPath] })
        .eq('id', existing.id)
        .eq('dossier_id', dossierId)
        .eq('unlocked', false)
        .select('id')
        .single();
      letter = result.data;
      lErr = result.error;
    } else {
      const result = await db
        .from('letters')
        .insert({
          dossier_id: dossierId,
          clean_pdf_path: cleanPath, // stocké côté serveur uniquement
          preview_paths: [previewPath],
          unlocked: false,
        })
        .select('id')
        .single();
      letter = result.data;
      lErr = result.error;
    }

    // Deux retries concurrents peuvent tous deux avoir commencé avant
    // l'insertion. L'index unique choisit un gagnant ; le perdant supprime ses
    // fichiers puis renvoie la lettre déjà créée.
    if (!existing && lErr?.code === '23505') {
      await removeGeneratedFiles(db, cleanPath, previewPath);
      cleanPath = null;
      previewPath = null;
      const winner = await findExistingLetter(db, dossierId);
      const winnerPayload = winner ? await previewPayload(db, winner) : null;
      if (!winnerPayload) throw new Error('Lettre concurrente introuvable après conflit');
      console.info('letter_generation_race_reused', { dossierId, letterId: winner.id });
      return json(winnerPayload);
    }
    if (lErr || !letter) throw lErr ?? new Error('letters insert/update');
    committed = true;

    // 4) URL signée UNIQUEMENT pour le preview filigrané.
    const signed = await db.storage
      .from('previews')
      .createSignedUrl(previewPath, PREVIEW_TTL);
    if (signed.error) throw signed.error;

    // Une ligne incomplète récupérée a été réparée : les anciens objets ne
    // doivent pas rester orphelins dans les buckets privés.
    if (existing) {
      const oldClean = existing.clean_pdf_path !== cleanPath ? existing.clean_pdf_path : null;
      const oldPreview = existing.preview_paths?.[0] !== previewPath
        ? existing.preview_paths?.[0] ?? null
        : null;
      await removeGeneratedFiles(db, oldClean, oldPreview);
    }

    return json({
      letterId: letter.id,
      previews: [signed.data.signedUrl],
      // Volontairement : aucune référence au PDF propre.
    });
  } catch (e) {
    if (!committed) await removeGeneratedFiles(db, cleanPath, previewPath);
    await flagManualReview(db, dossierId, 'Échec génération lettre (Gotenberg/storage)', String(e));
    return serverError('Génération de la lettre échouée', e);
  }
});

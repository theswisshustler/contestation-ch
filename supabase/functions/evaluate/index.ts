// POST /evaluate
// Entrée : { dossier: DossierContestation }
// - Recalcule le ruleset CÔTÉ SERVEUR (jamais confiance au client).
// - Persiste le dossier + l'évaluation (parcours anonyme, purge J+7).
// - Flag traitement manuel si autorité introuvable.
// Sortie : { dossierId, evaluation } — AUCUN PDF ici.

import { evaluateLoyerInitial, type DossierContestation } from '../_shared/ruleset.ts';
import { adminClient, flagManualReview } from '../_shared/supabase.ts';
import { badRequest, json, preflight, serverError } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return badRequest('POST attendu');

  let dossier: DossierContestation;
  try {
    const body = await req.json();
    dossier = body.dossier;
  } catch {
    return badRequest('JSON invalide');
  }

  if (!dossier?.canton || !dossier?.commune || !dossier?.npa || !dossier?.dateRemiseCles) {
    return badRequest('Champs obligatoires manquants (canton, commune, npa, dateRemiseCles)');
  }

  const evaluation = evaluateLoyerInitial(dossier);

  try {
    const db = adminClient();
    const { data, error } = await db
      .from('dossiers')
      .insert({
        canton: dossier.canton,
        npa: dossier.npa,
        commune: dossier.commune,
        kind: 'loyer_initial',
        payload: dossier,
        evaluation,
        requires_manual: evaluation.requiertTraitementManuel,
        eligible: evaluation.eligible,
      })
      .select('id')
      .single();

    if (error || !data) return serverError('Persistance du dossier échouée', error);

    if (evaluation.requiertTraitementManuel) {
      await flagManualReview(db, data.id, 'Ruleset: traitement manuel requis', {
        avertissements: evaluation.avertissements,
      });
    }

    return json({ dossierId: data.id, evaluation });
  } catch (e) {
    return serverError('Erreur serveur', e);
  }
});

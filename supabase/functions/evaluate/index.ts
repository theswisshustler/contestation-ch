// POST /evaluate
// Entrée : { dossier: DossierContestation }
// - Recalcule le ruleset CÔTÉ SERVEUR (jamais confiance au client).
// - Persiste le dossier + l'évaluation (parcours anonyme, purge J+7).
// - Flag traitement manuel si autorité introuvable.
// Sortie : { dossierId, evaluation } — AUCUN PDF ici.

import { evaluateDossier, type DossierContestation, type ParcoursKind } from '../_shared/ruleset.ts';
import { adminClient, flagManualReview } from '../_shared/supabase.ts';
import { badRequest, json, preflight, serverError } from '../_shared/http.ts';

const VALID_TYPES_BAIL = ['ordinaire', 'indexe', 'echelonne', 'subventionne', 'inconnu'];
const isPositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

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

  const kind: ParcoursKind = dossier?.kind ?? 'loyer_initial';
  if (!['loyer_initial', 'hausse_loyer', 'demande_baisse'].includes(kind)) return badRequest('Type de parcours invalide');
  if (!['VD', 'GE'].includes(dossier?.canton)) return badRequest('Canton non pris en charge');
  if (!dossier?.canton || !dossier?.commune || !dossier?.npa || !dossier?.adresseImmeuble) {
    return badRequest('Champs obligatoires manquants (canton, commune, npa, adresseImmeuble)');
  }
  if (kind === 'loyer_initial' && !isIsoDate(dossier.dateRemiseCles)) {
    return badRequest('dateRemiseCles requise pour le loyer initial');
  }
  if (kind !== 'loyer_initial' && !VALID_TYPES_BAIL.includes(dossier.typeBail ?? '')) {
    return badRequest('Type de bail requis pour ce parcours');
  }
  if (kind === 'hausse_loyer' && (
    !isIsoDate(dossier.dateNotificationHausse)
    || !isPositiveNumber(dossier.loyerAvantHausse)
    || !isPositiveNumber(dossier.loyerApresHausse)
    || dossier.loyerApresHausse <= dossier.loyerAvantHausse
  )) {
    return badRequest('Date valide et loyers positifs avant/après requis; le nouveau loyer doit être supérieur');
  }
  if (kind === 'hausse_loyer' && dossier.dateEffetHausse && !isIsoDate(dossier.dateEffetHausse)) {
    return badRequest("Date d'effet invalide");
  }
  if (kind === 'demande_baisse' && (
    !isPositiveNumber(dossier.loyerNetMensuel)
    || !isPositiveNumber(dossier.tauxReferenceBail)
    || dossier.tauxReferenceBail > 10
  )) {
    return badRequest('Loyer net et taux de référence déterminant requis pour une baisse');
  }
  if (!dossier.locataire?.nom || !dossier.locataire?.adresse || !dossier.locataire?.npa || !dossier.locataire?.ville) {
    return badRequest('Coordonnées du locataire incomplètes');
  }
  if (!dossier.bailleur?.nom || !dossier.bailleur?.adresse || !dossier.bailleur?.npa || !dossier.bailleur?.ville) {
    return badRequest('Coordonnées du bailleur incomplètes');
  }

  dossier.kind = kind;
  const evaluation = evaluateDossier(dossier);

  try {
    const db = adminClient();
    const { data, error } = await db
      .from('dossiers')
      .insert({
        canton: dossier.canton,
        npa: dossier.npa,
        commune: dossier.commune,
        kind,
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

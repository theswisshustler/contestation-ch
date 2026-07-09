/**
 * Contrôle d'accès au PDF propre — logique PURE, testable unitairement.
 *
 * C'est le cœur de l'invariant de sécurité : « le PDF propre n'est jamais servi
 * avant confirmation du paiement ». En l'isolant ici (hors du runtime Deno /
 * Supabase), on peut le prouver par des tests exécutables sous Node.
 *
 * La Edge Function `download-letter` importe et applique cette décision ; elle
 * n'implémente aucune autre voie d'accès au bucket privé `letters-clean`.
 */

export interface LetterAccessState {
  /** Passé à true UNIQUEMENT par stripe-webhook après paiement confirmé. */
  unlocked: boolean;
  /** Chemin du PDF propre dans le bucket privé (null tant que non généré). */
  clean_pdf_path: string | null;
}

export type DownloadDecision =
  | { allow: true; path: string }
  | { allow: false; status: 402 | 404; reason: string };

/**
 * Décide si une URL signée vers le PDF propre peut être émise.
 * Refuse (402) tant que le paiement n'a pas déverrouillé la lettre.
 */
export function authorizeDownload(letter: LetterAccessState | null): DownloadDecision {
  if (!letter) {
    return { allow: false, status: 404, reason: 'Lettre introuvable' };
  }
  if (!letter.unlocked || !letter.clean_pdf_path) {
    return { allow: false, status: 402, reason: 'Paiement requis pour débloquer le PDF.' };
  }
  return { allow: true, path: letter.clean_pdf_path };
}

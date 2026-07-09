import { describe, it, expect } from 'vitest';
import { authorizeDownload, type LetterAccessState } from './access-control';

describe('authorizeDownload — verrou PDF propre', () => {
  it('lettre introuvable → refus 404', () => {
    const d = authorizeDownload(null);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.status).toBe(404);
  });

  it('lettre générée mais NON payée (unlocked=false) → refus 402', () => {
    const letter: LetterAccessState = {
      unlocked: false,
      clean_pdf_path: 'abc/requete.pdf', // le PDF existe côté serveur…
    };
    const d = authorizeDownload(letter);
    expect(d.allow).toBe(false); // …mais reste inaccessible.
    if (!d.allow) expect(d.status).toBe(402);
  });

  it('marquée unlocked mais sans PDF (incohérent) → refus 402', () => {
    const d = authorizeDownload({ unlocked: true, clean_pdf_path: null });
    expect(d.allow).toBe(false);
  });

  it('payée + PDF présent → accès autorisé avec le bon chemin', () => {
    const d = authorizeDownload({ unlocked: true, clean_pdf_path: 'abc/requete.pdf' });
    expect(d.allow).toBe(true);
    if (d.allow) expect(d.path).toBe('abc/requete.pdf');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Invariant bout-en-bout : reproduit la chaîne réelle des états d'une lettre.
//   generate-letter  → insère unlocked=false
//   download-letter  → doit refuser
//   stripe-webhook   → SEUL à passer unlocked=true (après signature vérifiée)
//   download-letter  → autorise
// On modélise chaque acteur par la mutation d'état qu'il produit réellement.
// ─────────────────────────────────────────────────────────────────────────────

describe('invariant: le PDF propre ne sort qu’après stripe-webhook', () => {
  // État tel qu'inséré par generate-letter (cf. functions/generate-letter).
  const afterGenerate = (): LetterAccessState => ({
    unlocked: false,
    clean_pdf_path: 'dossier-1/requete-xyz.pdf',
  });

  // Mutation opérée par stripe-webhook UNIQUEMENT si l'event est "paid".
  const applyWebhook = (l: LetterAccessState, paid: boolean): LetterAccessState =>
    paid ? { ...l, unlocked: true } : l;

  it('juste après génération, le téléchargement est refusé', () => {
    expect(authorizeDownload(afterGenerate()).allow).toBe(false);
  });

  it('un webhook NON payé (ou signature invalide → jamais appliqué) ne débloque rien', () => {
    const state = applyWebhook(afterGenerate(), /* paid */ false);
    expect(authorizeDownload(state).allow).toBe(false);
  });

  it('seul le webhook payé débloque le téléchargement', () => {
    const state = applyWebhook(afterGenerate(), /* paid */ true);
    const d = authorizeDownload(state);
    expect(d.allow).toBe(true);
  });

  it('aucune autre séquence n’ouvre l’accès (exhaustif sur les entrées)', () => {
    for (const unlocked of [false, true]) {
      for (const path of [null, 'x/y.pdf']) {
        const allowed = authorizeDownload({ unlocked, clean_pdf_path: path }).allow;
        // Autorisé si et seulement si payé (unlocked) ET PDF présent.
        expect(allowed).toBe(unlocked === true && path !== null);
      }
    }
  });
});

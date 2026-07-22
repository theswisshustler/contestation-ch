import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('cohérence des tarifs', () => {
  const checkout = readFileSync('supabase/functions/create-checkout/index.ts', 'utf8');
  const webhook = readFileSync('supabase/functions/stripe-webhook/index.ts', 'utf8');
  const signer = readFileSync('supabase/functions/sign-letter/index.ts', 'utf8');
  const app = readFileSync('web/app.js', 'utf8');

  it('facture exactement 14,90 CHF et 49,90 CHF côté Stripe', () => {
    expect(checkout).toContain("imprimer_1490: { amount: 1490");
    expect(checkout).toContain("recommande_4990: { amount: 4990");
  });

  it('envoie les mêmes identifiants depuis le front', () => {
    expect(app).toContain("'recommande_4990' : 'imprimer_1490'");
    expect(app).toContain("'4990' ? '49,90' : '14,90'");
  });

  it('verrouille le recommandé sur une signature persistée et rapproche le montant Stripe', () => {
    expect(checkout).toContain("!dossier.payload?.signatureDataUrl");
    expect(checkout).toContain('evaluateDossier(dossier.payload');
    expect(signer).toContain("eq('unlocked', false)");
    expect(webhook).toContain('session.amount_total !== PAID_OFFERS[offer]');
    expect(webhook).toContain(".eq('dossier_id', dossierId)");
  });
});

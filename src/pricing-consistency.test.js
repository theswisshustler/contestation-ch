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
    expect(checkout).toContain('allow_promotion_codes: true');
  });

  it('envoie les mêmes identifiants depuis le front', () => {
    expect(app).toContain("'recommande_4990' : 'imprimer_1490'");
    expect(app).toContain("'4990' ? '49,90' : '14,90'");
  });

  it('verrouille le recommandé et rapproche le prix catalogue, la remise et le montant payé', () => {
    expect(checkout).toContain("!dossier.payload?.signatureDataUrl");
    expect(checkout).toContain('evaluateDossier(dossier.payload');
    expect(signer).toContain("eq('unlocked', false)");
    expect(webhook).toContain('reconcileCheckoutAmounts');
    expect(webhook).toContain('amount_paid_chf: amounts.paidAmount');
    expect(webhook).toContain('discount_chf: amounts.discountAmount');
    expect(webhook).toContain(".eq('dossier_id', dossierId)");
  });

  it('route le code administrateur vers le client Stripe propre à chaque offre', () => {
    expect(checkout).toContain("Deno.env.get('STRIPE_ADMIN_PROMO_EMAIL')");
    expect(checkout).toContain("Deno.env.get('STRIPE_ADMIN_PRINT_CUSTOMER_ID')");
    expect(checkout).toContain("Deno.env.get('STRIPE_ADMIN_RECOMMENDED_CUSTOMER_ID')");
    expect(checkout).toContain("Deno.env.get('STRIPE_ADMIN_CUSTOMER_ID')");
    expect(checkout).toContain("body.offer === 'imprimer_1490'");
    expect(checkout).toContain('{ customer: adminCustomerId }');
  });
});

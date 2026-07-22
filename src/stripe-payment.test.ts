import { describe, expect, it } from 'vitest';
import { reconcileCheckoutAmounts } from '../supabase/functions/_shared/stripe-payment';

const base = {
  expectedAmount: 4990,
  persistedAmount: 4990,
  persistedCurrency: 'chf',
  sessionSubtotal: 4990,
  sessionTotal: 4990,
  sessionDiscount: 0,
  sessionCurrency: 'chf',
};

describe('rapprochement Stripe avec codes promotionnels', () => {
  it('accepte un paiement sans remise', () => {
    expect(reconcileCheckoutAmounts(base)).toEqual({
      ok: true,
      paidAmount: 4990,
      discountAmount: 0,
    });
  });

  it('accepte une remise Stripe de 99 % sur l’offre à 49,90 CHF', () => {
    expect(reconcileCheckoutAmounts({
      ...base,
      sessionTotal: 50,
      sessionDiscount: 4940,
    })).toEqual({
      ok: true,
      paidAmount: 50,
      discountAmount: 4940,
    });
  });

  it('accepte une remise fixe de 14,40 CHF sur l’offre à 14,90 CHF', () => {
    expect(reconcileCheckoutAmounts({
      ...base,
      expectedAmount: 1490,
      persistedAmount: 1490,
      sessionSubtotal: 1490,
      sessionTotal: 50,
      sessionDiscount: 1440,
    })).toEqual({
      ok: true,
      paidAmount: 50,
      discountAmount: 1440,
    });
  });

  it('refuse une sous-facturation non expliquée par Stripe', () => {
    expect(reconcileCheckoutAmounts({
      ...base,
      sessionTotal: 50,
      sessionDiscount: 0,
    })).toMatchObject({ ok: false, reason: 'discount_mismatch' });
  });

  it('refuse un sous-total qui ne correspond pas à l’offre', () => {
    expect(reconcileCheckoutAmounts({
      ...base,
      sessionSubtotal: 100,
      sessionTotal: 100,
    })).toMatchObject({ ok: false, reason: 'subtotal_mismatch' });
  });

  it('refuse un paiement gratuit ou une autre devise', () => {
    expect(reconcileCheckoutAmounts({ ...base, sessionTotal: 0, sessionDiscount: 4990 }))
      .toMatchObject({ ok: false, reason: 'invalid_total' });
    expect(reconcileCheckoutAmounts({ ...base, sessionCurrency: 'eur' }))
      .toMatchObject({ ok: false, reason: 'currency_mismatch' });
  });
});

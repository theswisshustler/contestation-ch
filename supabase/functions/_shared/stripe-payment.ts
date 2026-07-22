export type CheckoutAmountInput = {
  expectedAmount: number;
  persistedAmount: number;
  persistedCurrency: string;
  sessionSubtotal: number | null;
  sessionTotal: number | null;
  sessionDiscount: number | null;
  sessionCurrency: string | null;
};

export type CheckoutAmountResult =
  | { ok: true; paidAmount: number; discountAmount: number }
  | { ok: false; reason: string };

/**
 * Rapproche le prix catalogue interne avec les montants calculés par Stripe.
 * Un Checkout peut être réduit par un code promotionnel, mais son sous-total
 * doit toujours correspondre exactement à l'offre choisie et la remise doit
 * expliquer au centime près la différence avec le montant encaissé.
 */
export function reconcileCheckoutAmounts(input: CheckoutAmountInput): CheckoutAmountResult {
  const {
    expectedAmount,
    persistedAmount,
    persistedCurrency,
    sessionSubtotal,
    sessionTotal,
    sessionDiscount,
    sessionCurrency,
  } = input;

  if (!Number.isInteger(expectedAmount) || expectedAmount <= 0) {
    return { ok: false, reason: 'invalid_expected_amount' };
  }
  if (persistedAmount !== expectedAmount) {
    return { ok: false, reason: 'persisted_amount_mismatch' };
  }
  if (persistedCurrency !== 'chf' || sessionCurrency !== 'chf') {
    return { ok: false, reason: 'currency_mismatch' };
  }
  if (sessionSubtotal !== expectedAmount) {
    return { ok: false, reason: 'subtotal_mismatch' };
  }
  if (typeof sessionTotal !== 'number' || !Number.isInteger(sessionTotal) || sessionTotal <= 0 || sessionTotal > expectedAmount) {
    return { ok: false, reason: 'invalid_total' };
  }
  if (typeof sessionDiscount !== 'number' || !Number.isInteger(sessionDiscount) || sessionDiscount < 0) {
    return { ok: false, reason: 'invalid_discount' };
  }
  if (sessionSubtotal - sessionDiscount !== sessionTotal) {
    return { ok: false, reason: 'discount_mismatch' };
  }

  return { ok: true, paidAmount: sessionTotal, discountAmount: sessionDiscount };
}

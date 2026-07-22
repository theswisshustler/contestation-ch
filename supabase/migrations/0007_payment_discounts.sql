-- Audit des remises appliquées par Stripe Checkout.
alter table public.payments
  add column if not exists amount_paid_chf integer,
  add column if not exists discount_chf integer not null default 0;

comment on column public.payments.amount_chf is
  'Prix catalogue de l''offre en centimes de CHF, avant remise Stripe.';

comment on column public.payments.amount_paid_chf is
  'Montant effectivement encaissé par Stripe en centimes de CHF.';

comment on column public.payments.discount_chf is
  'Remise Stripe appliquée en centimes de CHF.';

alter table public.payments
  drop constraint if exists payments_amount_paid_chf_nonnegative;

alter table public.payments
  add constraint payments_amount_paid_chf_nonnegative
  check (amount_paid_chf is null or amount_paid_chf > 0);

alter table public.payments
  drop constraint if exists payments_discount_chf_nonnegative;

alter table public.payments
  add constraint payments_discount_chf_nonnegative
  check (discount_chf >= 0 and discount_chf <= amount_chf);

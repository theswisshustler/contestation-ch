-- Aligne les identifiants persistés sur les tarifs commercialisés.
-- RENAME VALUE préserve les paiements historiques et leurs relations.
alter type offer_type rename value 'imprimer_5' to 'imprimer_1490';
alter type offer_type rename value 'recommande_35' to 'recommande_4990';

comment on column payments.amount_chf is
  'Montant encaissé en centimes de CHF (tarifs courants: 1490 / 4990)';

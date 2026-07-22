-- Troisième type de dossier : contestation d'une hausse en cours de bail.
alter type letter_kind add value if not exists 'hausse_loyer';

comment on column dossiers.kind is
  'Parcours juridique: loyer_initial, hausse_loyer ou demande_baisse';

-- ============================================================================
-- contestation.ch — schéma initial
-- Postgres / Supabase. Rétention 7 jours (purge via Edge Function `purge`).
--
-- Principe de sécurité central :
--   Le PDF « propre » (sans filigrane) vit dans un bucket PRIVÉ (`letters-clean`)
--   et n'est JAMAIS servi au client tant que `letters.unlocked = false`.
--   Seul `stripe-webhook` (service_role) passe unlocked=true après paiement
--   confirmé. `download-letter` vérifie ce flag avant d'émettre une URL signée.
--
--   Toutes les tables ont RLS activé et AUCUNE policy permissive par défaut :
--   le parcours anonyme passe exclusivement par des Edge Functions en
--   service_role (qui contourne RLS). Les comptes créés après paiement ne
--   peuvent lire QUE leurs propres dossiers.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ── Enums ────────────────────────────────────────────────────────────────────
create type offer_type as enum ('imprimer_5', 'recommande_35');
create type payment_status as enum ('unpaid', 'pending', 'paid', 'refunded', 'failed');
create type letter_kind as enum ('loyer_initial', 'demande_baisse');
create type mailing_status as enum ('queued', 'sent', 'delivered', 'failed');

-- ── Helper: expiration à J+7 ─────────────────────────────────────────────────
create or replace function set_expires_at()
returns trigger
language plpgsql
as $$
begin
  if new.expires_at is null then
    new.expires_at := coalesce(new.created_at, now()) + interval '7 days';
  end if;
  return new;
end;
$$;

-- ── dossiers ─────────────────────────────────────────────────────────────────
-- Payload du flux (manuel ou import) + résultat du ruleset (recalculé serveur).
create table dossiers (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,

  -- compte créé APRÈS paiement uniquement (nullable pendant tout le parcours).
  user_id         uuid references auth.users (id) on delete set null,

  canton          text not null check (canton in ('VD', 'GE')),
  npa             text not null,
  commune         text not null,
  kind            letter_kind not null default 'loyer_initial',

  -- Données personnelles + bail. jsonb : conforme au type DossierContestation.
  payload         jsonb not null,
  -- Résultat de evaluateLoyerInitial() recalculé côté serveur (jamais le client).
  evaluation      jsonb,

  requires_manual boolean not null default false,
  eligible        boolean not null default false
);
create trigger dossiers_expires before insert on dossiers
  for each row execute function set_expires_at();
create index dossiers_expires_idx on dossiers (expires_at);
create index dossiers_user_idx on dossiers (user_id);
alter table dossiers enable row level security;

-- Un utilisateur authentifié (post-paiement) lit uniquement ses dossiers.
create policy dossiers_owner_select on dossiers
  for select to authenticated
  using (user_id = auth.uid());

-- ── documents ────────────────────────────────────────────────────────────────
-- Métadonnées des fichiers importés (bail, formule officielle). Le binaire est
-- dans le bucket privé `uploads`. Purgé à J+7.
create table documents (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  dossier_id   uuid references dossiers (id) on delete cascade,
  role         text not null check (role in ('bail', 'formule', 'autre')),
  storage_path text not null,          -- chemin dans le bucket `uploads`
  mime         text,
  bytes        integer
);
create trigger documents_expires before insert on documents
  for each row execute function set_expires_at();
create index documents_expires_idx on documents (expires_at);
create index documents_dossier_idx on documents (dossier_id);
alter table documents enable row level security; -- accès service_role only

-- ── letters ──────────────────────────────────────────────────────────────────
-- Une lettre générée par dossier. Sépare bien le PDF propre (privé) du preview.
create table letters (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  dossier_id         uuid not null references dossiers (id) on delete cascade,

  -- PDF PROPRE — bucket privé `letters-clean`. Jamais d'URL publique.
  clean_pdf_path     text,
  -- PNG filigranés — bucket `previews`, servis via URL signée courte durée.
  preview_paths      text[] not null default '{}',

  -- Verrou d'accès au PDF propre. Basculé à true UNIQUEMENT par stripe-webhook.
  unlocked           boolean not null default false,
  unlocked_at        timestamptz
);
create trigger letters_expires before insert on letters
  for each row execute function set_expires_at();
create index letters_dossier_idx on letters (dossier_id);
create index letters_expires_idx on letters (expires_at);
alter table letters enable row level security; -- accès service_role only

-- ── payments ─────────────────────────────────────────────────────────────────
create table payments (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  dossier_id          uuid not null references dossiers (id) on delete cascade,
  offer               offer_type not null,
  amount_chf          integer not null,           -- en centimes (500 / 3500)
  currency            text not null default 'chf',
  status              payment_status not null default 'unpaid',
  stripe_session_id   text unique,
  stripe_payment_intent text,
  paid_at             timestamptz
);
create trigger payments_expires before insert on payments
  for each row execute function set_expires_at();
create index payments_dossier_idx on payments (dossier_id);
create index payments_session_idx on payments (stripe_session_id);
create index payments_expires_idx on payments (expires_at);
alter table payments enable row level security; -- accès service_role only

-- ── mailings (Pingen — offre 35 CHF recommandé) ──────────────────────────────
create table mailings (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  dossier_id     uuid not null references dossiers (id) on delete cascade,
  pingen_id      text,
  status         mailing_status not null default 'queued',
  tracking       jsonb
);
create trigger mailings_expires before insert on mailings
  for each row execute function set_expires_at();
create index mailings_dossier_idx on mailings (dossier_id);
create index mailings_expires_idx on mailings (expires_at);
alter table mailings enable row level security; -- accès service_role only

-- Un utilisateur authentifié suit le statut d'envoi de SES dossiers.
create policy mailings_owner_select on mailings
  for select to authenticated
  using (exists (
    select 1 from dossiers d
    where d.id = mailings.dossier_id and d.user_id = auth.uid()
  ));

-- ── leads (calculateur gratuit « ai-je droit à une baisse ? ») ───────────────
create table leads (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  email       text not null,
  canton      text,
  result      jsonb,          -- sortie de evaluateDemandeBaisse (indicatif)
  source      text
);
create index leads_email_idx on leads (email);
alter table leads enable row level security; -- écriture via Edge Function only

-- ── manual_reviews (notif exploitant sur échec / traitement manuel) ──────────
create table manual_reviews (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  dossier_id  uuid references dossiers (id) on delete cascade,
  reason      text not null,
  detail      jsonb,
  resolved    boolean not null default false
);
create index manual_reviews_dossier_idx on manual_reviews (dossier_id);
alter table manual_reviews enable row level security; -- exploitant only (service_role)

-- ── Storage buckets ──────────────────────────────────────────────────────────
-- Tous PRIVÉS. `letters-clean` en particulier ne doit jamais devenir public.
insert into storage.buckets (id, name, public)
values
  ('uploads',       'uploads',       false),
  ('previews',      'previews',      false),
  ('letters-clean', 'letters-clean', false)
on conflict (id) do nothing;

-- Aucune policy storage pour anon/authenticated : tout passe par service_role
-- via les Edge Functions. (Le bucket privé sans policy = inaccessible au client,
-- ce qui est exactement l'objectif pour `letters-clean`.)

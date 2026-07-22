-- ============================================================================
-- contestation.ch — plateforme de publication intégrée
--
-- Les données éditoriales sont durablement séparées des dossiers locatifs et
-- ne sont jamais concernées par leur purge à J+7. Le contenu publié pointe
-- toujours vers une révision immuable validée par le moteur de normalisation.
-- ============================================================================

create type blog_article_status as enum ('draft', 'published', 'archived');
create type blog_ingestion_status as enum ('received', 'normalized', 'failed');
create type blog_admin_role as enum ('editor', 'publisher', 'owner');

create or replace function set_blog_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Membres autorisés à utiliser /admin. L'utilisateur est créé dans Supabase
-- Auth, puis rattaché ici une seule fois par l'exploitant.
create table blog_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  role        blog_admin_role not null default 'editor',
  created_at  timestamptz not null default now()
);
alter table blog_admins enable row level security;

create or replace function is_blog_admin(required_roles blog_admin_role[] default null)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from blog_admins a
    where a.user_id = auth.uid()
      and (required_roles is null or a.role = any(required_roles))
  );
$$;

revoke all on function is_blog_admin(blog_admin_role[]) from public;
grant execute on function is_blog_admin(blog_admin_role[]) to authenticated, service_role;

create policy blog_admins_self_select on blog_admins
  for select to authenticated
  using (user_id = auth.uid());

create table blog_authors (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null default 'person' check (kind in ('person', 'organization')),
  name        text not null,
  slug        text not null unique,
  bio         text,
  url         text,
  same_as     text[] not null default '{}',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger blog_authors_updated before update on blog_authors
  for each row execute function set_blog_updated_at();
alter table blog_authors enable row level security;
create policy blog_authors_public_select on blog_authors
  for select to anon, authenticated using (active = true);

insert into blog_authors (kind, name, slug, bio, url)
values (
  'organization',
  'Contestation.ch',
  'contestation-ch',
  'Service suisse indépendant qui aide les locataires à comprendre et préparer leurs démarches liées au loyer.',
  'https://contestation.ch/'
)
on conflict (slug) do nothing;

create table blog_media (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  storage_path text unique,
  public_url  text not null,
  mime        text,
  bytes       integer,
  width       integer,
  height      integer,
  alt         text not null default '',
  caption     text,
  credit      text,
  content_hash text,
  active      boolean not null default true
);
alter table blog_media enable row level security;
create policy blog_media_public_select on blog_media
  for select to anon, authenticated using (active = true);

create table blog_articles (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  locale                text not null default 'fr-CH',
  status                blog_article_status not null default 'draft',
  current_slug          text,
  published_revision_id uuid,
  draft_revision_id     uuid,
  first_published_at    timestamptz,
  published_at          timestamptz,
  public_updated_at     timestamptz,
  archived_at           timestamptz,
  deleted_at            timestamptz
);
create unique index blog_articles_current_slug_unique
  on blog_articles (current_slug) where current_slug is not null and deleted_at is null;
create index blog_articles_public_idx
  on blog_articles (status, published_at desc) where deleted_at is null;
create trigger blog_articles_updated before update on blog_articles
  for each row execute function set_blog_updated_at();
alter table blog_articles enable row level security;
create policy blog_articles_public_select on blog_articles
  for select to anon, authenticated
  using (status = 'published' and published_at <= now() and deleted_at is null);

create table blog_api_keys (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  created_by    uuid references auth.users (id) on delete set null,
  name          text not null,
  key_prefix    text not null,
  key_hash      text not null unique,
  scopes        text[] not null default array['articles:import'],
  active        boolean not null default true,
  expires_at    timestamptz,
  last_used_at  timestamptz
);
alter table blog_api_keys enable row level security;

create table blog_ingestions (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  article_id      uuid references blog_articles (id) on delete set null,
  provider        text not null default 'admin',
  external_id     text,
  idempotency_key text,
  format          text not null,
  intent          text not null default 'draft' check (intent in ('draft', 'publish')),
  payload         jsonb,
  status          blog_ingestion_status not null default 'received',
  warnings        jsonb not null default '[]'::jsonb,
  error           text,
  created_by      uuid references auth.users (id) on delete set null,
  api_key_id      uuid references blog_api_keys (id) on delete set null
);
create unique index blog_ingestions_idempotency_unique
  on blog_ingestions (idempotency_key) where idempotency_key is not null;
create index blog_ingestions_external_idx
  on blog_ingestions (provider, external_id, created_at desc) where external_id is not null;
create index blog_ingestions_article_idx on blog_ingestions (article_id, created_at desc);
create trigger blog_ingestions_updated before update on blog_ingestions
  for each row execute function set_blog_updated_at();
alter table blog_ingestions enable row level security;

create table blog_revisions (
  id                uuid primary key default gen_random_uuid(),
  article_id        uuid not null references blog_articles (id) on delete cascade,
  ingestion_id      uuid references blog_ingestions (id) on delete set null,
  version           integer not null,
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users (id) on delete set null,
  title             text not null,
  slug              text not null,
  excerpt           text not null,
  seo_title         text not null,
  seo_description   text not null,
  document          jsonb not null,
  plain_text        text not null,
  content_hash      text not null,
  source_format     text,
  source_content    text,
  featured_media_id uuid references blog_media (id) on delete set null,
  author_id         uuid references blog_authors (id) on delete set null,
  reviewed_by_id    uuid references blog_authors (id) on delete set null,
  reviewed_at       timestamptz,
  next_review_at    date,
  sources           jsonb not null default '[]'::jsonb,
  metadata          jsonb not null default '{}'::jsonb,
  unique (article_id, version)
);
create index blog_revisions_article_idx on blog_revisions (article_id, version desc);
alter table blog_revisions enable row level security;
create policy blog_revisions_public_select on blog_revisions
  for select to anon, authenticated
  using (exists (
    select 1 from blog_articles a
    where a.published_revision_id = blog_revisions.id
      and a.status = 'published' and a.published_at <= now() and a.deleted_at is null
  ));

alter table blog_articles
  add constraint blog_articles_published_revision_fk
    foreign key (published_revision_id) references blog_revisions (id) on delete set null,
  add constraint blog_articles_draft_revision_fk
    foreign key (draft_revision_id) references blog_revisions (id) on delete set null;

create or replace function prevent_blog_revision_update()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Les révisions du blog sont immuables';
end;
$$;
create trigger blog_revisions_immutable before update on blog_revisions
  for each row execute function prevent_blog_revision_update();

create table blog_slug_history (
  slug        text primary key,
  article_id  uuid not null references blog_articles (id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index blog_slug_history_article_idx on blog_slug_history (article_id);
alter table blog_slug_history enable row level security;
create policy blog_slug_history_public_select on blog_slug_history
  for select to anon, authenticated
  using (exists (
    select 1 from blog_articles a where a.id = article_id
      and a.status = 'published' and a.deleted_at is null
  ));

create table blog_tombstones (
  slug        text primary key,
  gone_at     timestamptz not null default now(),
  reason      text
);
alter table blog_tombstones enable row level security;
create policy blog_tombstones_public_select on blog_tombstones
  for select to anon, authenticated using (true);

create table blog_topics (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text not null unique,
  description text,
  created_at  timestamptz not null default now()
);
alter table blog_topics enable row level security;
create policy blog_topics_public_select on blog_topics
  for select to anon, authenticated using (true);

create table blog_article_topics (
  article_id uuid not null references blog_articles (id) on delete cascade,
  topic_id   uuid not null references blog_topics (id) on delete cascade,
  primary key (article_id, topic_id)
);
create index blog_article_topics_topic_idx on blog_article_topics (topic_id, article_id);
alter table blog_article_topics enable row level security;
create policy blog_article_topics_public_select on blog_article_topics
  for select to anon, authenticated
  using (exists (
    select 1 from blog_articles a where a.id = article_id
      and a.status = 'published' and a.deleted_at is null
  ));

create table blog_preview_tokens (
  token_hash   text primary key,
  revision_id  uuid not null references blog_revisions (id) on delete cascade,
  created_by   uuid references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index blog_preview_tokens_expiry_idx on blog_preview_tokens (expires_at);
alter table blog_preview_tokens enable row level security;

create table blog_audit_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  actor_id    uuid references auth.users (id) on delete set null,
  api_key_id  uuid references blog_api_keys (id) on delete set null,
  article_id  uuid references blog_articles (id) on delete set null,
  action      text not null,
  detail      jsonb not null default '{}'::jsonb
);
create index blog_audit_article_idx on blog_audit_log (article_id, created_at desc);
alter table blog_audit_log enable row level security;

-- Vue volontairement aplatie pour le renderer Astro, le sitemap et le RSS.
-- security_invoker conserve les RLS des tables sous-jacentes.
create view blog_public_articles
with (security_invoker = true)
as
select
  a.id,
  a.current_slug as slug,
  a.locale,
  a.first_published_at,
  a.published_at,
  coalesce(a.public_updated_at, a.published_at) as updated_at,
  r.id as revision_id,
  r.title,
  r.excerpt,
  r.seo_title,
  r.seo_description,
  r.document,
  r.plain_text,
  r.content_hash,
  r.reviewed_at,
  r.next_review_at,
  r.sources,
  r.metadata,
  coalesce(author.name, 'Contestation.ch') as author_name,
  coalesce(author.slug, 'contestation-ch') as author_slug,
  coalesce(author.kind, 'organization') as author_kind,
  reviewer.name as reviewer_name,
  media.public_url as featured_image,
  coalesce((
    select jsonb_agg(jsonb_build_object('name', t.name, 'slug', t.slug) order by t.name)
    from blog_article_topics bat join blog_topics t on t.id = bat.topic_id
    where bat.article_id = a.id
  ), '[]'::jsonb) as topics
from blog_articles a
join blog_revisions r on r.id = a.published_revision_id
left join blog_authors author on author.id = r.author_id
left join blog_authors reviewer on reviewer.id = r.reviewed_by_id
left join blog_media media on media.id = r.featured_media_id
where a.status = 'published' and a.published_at <= now() and a.deleted_at is null;

create or replace function get_related_blog_articles(target_article uuid, max_results integer default 3)
returns table (
  id uuid,
  slug text,
  title text,
  excerpt text,
  published_at timestamptz,
  featured_image text
)
language sql
stable
security invoker
set search_path = public
as $$
  select p.id, p.slug, p.title, p.excerpt, p.published_at, p.featured_image
  from blog_public_articles p
  left join lateral (
    select count(*)::integer as shared
    from blog_article_topics candidate
    join blog_article_topics target on target.topic_id = candidate.topic_id
    where candidate.article_id = p.id and target.article_id = target_article
  ) score on true
  where p.id <> target_article
  order by coalesce(score.shared, 0) desc, p.published_at desc
  limit greatest(1, least(max_results, 12));
$$;

grant select on blog_articles, blog_revisions, blog_authors, blog_media,
  blog_slug_history, blog_tombstones, blog_topics, blog_article_topics to anon, authenticated;
grant select on blog_public_articles to anon, authenticated;
grant execute on function get_related_blog_articles(uuid, integer) to anon, authenticated;

revoke all on blog_admins, blog_api_keys, blog_ingestions, blog_preview_tokens,
  blog_audit_log from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'blog-media', 'blog-media', true, 10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Aucun INSERT/UPDATE Storage pour le navigateur. Les uploads administrateur
-- utilisent une URL signée créée par une Edge Function privilégiée.

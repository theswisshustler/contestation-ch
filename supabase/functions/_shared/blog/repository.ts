import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import type { BlogActor } from './auth.ts';
import {
  type BlogDocumentV1,
  deriveExcerpt,
  documentToText,
  normalizeDocument,
  sha256Hex,
  slugify,
} from './document.ts';

export interface DraftMetadata {
  title: string;
  slug?: string;
  excerpt?: string;
  seoTitle?: string;
  seoDescription?: string;
  locale?: string;
  topics?: string[];
  featuredMediaId?: string | null;
  authorId?: string | null;
  reviewedById?: string | null;
  reviewedAt?: string | null;
  nextReviewAt?: string | null;
  sources?: Array<{ label: string; url: string }>;
  extra?: Record<string, unknown>;
}

export interface SaveDraftInput {
  articleId?: string | null;
  ingestionId?: string | null;
  document: BlogDocumentV1;
  metadata: DraftMetadata;
  sourceFormat?: string;
  sourceContent?: string;
}

function cleanTopicNames(values: unknown): string[] {
  return Array.isArray(values)
    ? [...new Set(values.map((value) => String(value).trim()).filter(Boolean))].slice(0, 12)
    : [];
}

async function defaultAuthorId(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.from('blog_authors').select('id').eq('slug', 'contestation-ch').maybeSingle();
  return data?.id || null;
}

async function replaceTopics(db: SupabaseClient, articleId: string, names: string[]): Promise<void> {
  await db.from('blog_article_topics').delete().eq('article_id', articleId);
  if (!names.length) return;
  const rows = names.map((name) => ({ name, slug: slugify(name) }));
  const { data: topics, error } = await db.from('blog_topics').upsert(rows, { onConflict: 'slug', ignoreDuplicates: false }).select('id');
  if (error) throw error;
  if (topics?.length) {
    const link = await db.from('blog_article_topics').insert(topics.map((topic) => ({ article_id: articleId, topic_id: topic.id })));
    if (link.error) throw link.error;
  }
}

export async function saveBlogDraft(actor: BlogActor, input: SaveDraftInput): Promise<{ articleId: string; revisionId: string; version: number; slug: string }> {
  const db = actor.db;
  const document = normalizeDocument(input.document);
  const title = String(input.metadata.title || '').trim().slice(0, 240);
  if (!title) throw new Error('Le titre est requis');
  const proposedSlug = slugify(input.metadata.slug || title);
  const plainText = documentToText(document);
  const excerpt = String(input.metadata.excerpt || deriveExcerpt(document)).trim().slice(0, 320);
  const seoTitle = String(input.metadata.seoTitle || title).trim().slice(0, 70);
  const seoDescription = String(input.metadata.seoDescription || excerpt).trim().slice(0, 180);
  const contentHash = await sha256Hex(JSON.stringify(document));
  const locale = /^\w{2}(?:-[A-Z]{2})?$/.test(input.metadata.locale || '') ? input.metadata.locale! : document.locale;

  let articleId = input.articleId || null;
  if (articleId) {
    const { data: existing } = await db.from('blog_articles').select('id').eq('id', articleId).is('deleted_at', null).maybeSingle();
    if (!existing) throw new Error('Article introuvable');
  } else {
    const inserted = await db.from('blog_articles').insert({ locale }).select('id').single();
    if (inserted.error) throw inserted.error;
    articleId = inserted.data.id;
  }

  const latest = await db.from('blog_revisions').select('version').eq('article_id', articleId).order('version', { ascending: false }).limit(1).maybeSingle();
  if (latest.error) throw latest.error;
  const version = Number(latest.data?.version || 0) + 1;
  const authorId = input.metadata.authorId === undefined ? await defaultAuthorId(db) : input.metadata.authorId;
  const revision = await db.from('blog_revisions').insert({
    article_id: articleId,
    ingestion_id: input.ingestionId || null,
    version,
    created_by: actor.userId,
    title,
    slug: proposedSlug,
    excerpt,
    seo_title: seoTitle,
    seo_description: seoDescription,
    document,
    plain_text: plainText,
    content_hash: contentHash,
    source_format: input.sourceFormat || 'canonical-v1',
    source_content: input.sourceContent?.slice(0, 2_000_000) || null,
    featured_media_id: input.metadata.featuredMediaId || null,
    author_id: authorId,
    reviewed_by_id: input.metadata.reviewedById || null,
    reviewed_at: input.metadata.reviewedAt || null,
    next_review_at: input.metadata.nextReviewAt || null,
    sources: input.metadata.sources || [],
    metadata: input.metadata.extra || {},
  }).select('id').single();
  if (revision.error) throw revision.error;

  const articleUpdate = await db.from('blog_articles').update({
    draft_revision_id: revision.data.id,
    locale,
  }).eq('id', articleId);
  if (articleUpdate.error) throw articleUpdate.error;

  await replaceTopics(db, articleId, cleanTopicNames(input.metadata.topics));
  if (input.ingestionId) {
    await db.from('blog_ingestions').update({ article_id: articleId, status: 'normalized', error: null }).eq('id', input.ingestionId);
  }
  await db.from('blog_audit_log').insert({
    actor_id: actor.userId, api_key_id: actor.apiKeyId, article_id: articleId,
    action: 'draft.saved', detail: { revisionId: revision.data.id, version, contentHash },
  });
  return { articleId, revisionId: revision.data.id, version, slug: proposedSlug };
}

async function uniquePublishedSlug(db: SupabaseClient, articleId: string, proposed: string): Promise<string> {
  let candidate = slugify(proposed);
  for (let suffix = 1; suffix < 100; suffix++) {
    const { data } = await db.from('blog_articles').select('id').eq('current_slug', candidate).neq('id', articleId).is('deleted_at', null).maybeSingle();
    const { data: history } = await db.from('blog_slug_history').select('article_id').eq('slug', candidate).neq('article_id', articleId).maybeSingle();
    const { data: tombstone } = await db.from('blog_tombstones').select('slug').eq('slug', candidate).maybeSingle();
    if (!data && !history && !tombstone) return candidate;
    candidate = `${slugify(proposed)}-${suffix + 1}`;
  }
  throw new Error('Impossible de générer un slug unique');
}

export async function publishBlogArticle(actor: BlogActor, articleId: string): Promise<{ articleId: string; slug: string; publishedAt: string }> {
  const db = actor.db;
  const { data: article, error } = await db.from('blog_articles')
    .select('id, current_slug, draft_revision_id, first_published_at')
    .eq('id', articleId).is('deleted_at', null).maybeSingle();
  if (error || !article?.draft_revision_id) throw new Error('Aucun brouillon publiable');
  const { data: revision } = await db.from('blog_revisions').select('slug').eq('id', article.draft_revision_id).single();
  if (!revision) throw new Error('Révision de brouillon introuvable');
  const slug = await uniquePublishedSlug(db, articleId, revision.slug);
  if (article.current_slug && article.current_slug !== slug) {
    await db.from('blog_slug_history').upsert({ slug: article.current_slug, article_id: articleId }, { onConflict: 'slug' });
  }
  const now = new Date().toISOString();
  const update = await db.from('blog_articles').update({
    status: 'published', current_slug: slug,
    published_revision_id: article.draft_revision_id,
    first_published_at: article.first_published_at || now,
    published_at: now, public_updated_at: now, archived_at: null,
  }).eq('id', articleId);
  if (update.error) throw update.error;
  await db.from('blog_audit_log').insert({
    actor_id: actor.userId, api_key_id: actor.apiKeyId, article_id: articleId,
    action: 'article.published', detail: { revisionId: article.draft_revision_id, slug },
  });
  return { articleId, slug, publishedAt: now };
}

export async function archiveBlogArticle(actor: BlogActor, articleId: string): Promise<void> {
  const now = new Date().toISOString();
  const result = await actor.db.from('blog_articles').update({ status: 'archived', archived_at: now }).eq('id', articleId).is('deleted_at', null);
  if (result.error) throw result.error;
  await actor.db.from('blog_audit_log').insert({ actor_id: actor.userId, api_key_id: actor.apiKeyId, article_id: articleId, action: 'article.archived' });
}

export async function deleteBlogArticle(actor: BlogActor, articleId: string): Promise<{ hardDeleted: boolean }> {
  const db = actor.db;
  const { data: article } = await db.from('blog_articles').select('status, current_slug').eq('id', articleId).maybeSingle();
  if (!article) throw new Error('Article introuvable');
  if (article.status === 'draft' && !article.current_slug) {
    const deleted = await db.from('blog_articles').delete().eq('id', articleId);
    if (deleted.error) throw deleted.error;
    return { hardDeleted: true };
  }
  if (article.current_slug) await db.from('blog_tombstones').upsert({ slug: article.current_slug, reason: 'Article retiré' }, { onConflict: 'slug' });
  const now = new Date().toISOString();
  const updated = await db.from('blog_articles').update({ status: 'archived', archived_at: now, deleted_at: now }).eq('id', articleId);
  if (updated.error) throw updated.error;
  await db.from('blog_audit_log').insert({ actor_id: actor.userId, api_key_id: actor.apiKeyId, article_id: articleId, action: 'article.deleted' });
  return { hardDeleted: false };
}

export async function createPreviewToken(actor: BlogActor, revisionId: string): Promise<{ token: string; expiresAt: string }> {
  const { data: revision } = await actor.db.from('blog_revisions').select('id').eq('id', revisionId).maybeSingle();
  if (!revision) throw new Error('Révision introuvable');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  const tokenHash = await sha256Hex(token);
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const inserted = await actor.db.from('blog_preview_tokens').insert({ token_hash: tokenHash, revision_id: revisionId, created_by: actor.userId, expires_at: expiresAt });
  if (inserted.error) throw inserted.error;
  return { token, expiresAt };
}

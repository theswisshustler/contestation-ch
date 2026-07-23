import { json, preflight } from '../_shared/http.ts';
import { adminClient } from '../_shared/supabase.ts';
import { convertBlogContent, sourceAsString } from '../_shared/blog/ingestion.ts';
import { sanitizeUrl, slugify } from '../_shared/blog/document.ts';
import {
  publishBlogArticle,
  saveBlogDraft,
  type DraftMetadata,
} from '../_shared/blog/repository.ts';
import type { BlogActor } from '../_shared/blog/auth.ts';

interface OutrankArticle {
  id: string;
  title: string;
  content_markdown?: string;
  content_html?: string;
  meta_description?: string;
  created_at?: string;
  image_url?: string;
  slug: string;
  tags?: string[];
}

function bearer(req: Request): string {
  const header = req.headers.get('authorization') || '';
  return /^Bearer\s+\S+$/i.test(header) ? header.replace(/^Bearer\s+/i, '') : '';
}

function constantTimeEqual(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(actual);
  const right = encoder.encode(expected);
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

function isArticle(value: unknown): value is OutrankArticle {
  if (!value || typeof value !== 'object') return false;
  const article = value as Record<string, unknown>;
  return typeof article.id === 'string' && !!article.id.trim()
    && typeof article.title === 'string' && !!article.title.trim()
    && typeof article.slug === 'string' && !!article.slug.trim()
    && (
      (typeof article.content_markdown === 'string' && !!article.content_markdown.trim())
      || (typeof article.content_html === 'string' && !!article.content_html.trim())
    );
}

async function featuredMediaId(
  actor: BlogActor,
  article: OutrankArticle,
): Promise<string | null> {
  const imageUrl = sanitizeUrl(article.image_url, true);
  if (!imageUrl) return null;
  const existing = await actor.db.from('blog_media')
    .select('id').eq('public_url', imageUrl).limit(1).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data) return existing.data.id;
  const inserted = await actor.db.from('blog_media').insert({
    public_url: imageUrl,
    alt: article.title.trim().slice(0, 500),
  }).select('id').single();
  if (inserted.error) throw inserted.error;
  return inserted.data.id;
}

async function findArticleId(actor: BlogActor, article: OutrankArticle): Promise<string | null> {
  const previous = await actor.db.from('blog_ingestions')
    .select('article_id')
    .eq('provider', 'outrank')
    .eq('external_id', article.id)
    .not('article_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previous.error) throw previous.error;
  if (previous.data?.article_id) return previous.data.article_id;

  const slug = slugify(article.slug);
  const current = await actor.db.from('blog_articles')
    .select('id')
    .eq('current_slug', slug)
    .is('deleted_at', null)
    .maybeSingle();
  if (current.error) throw current.error;
  if (current.data) return current.data.id;

  const historical = await actor.db.from('blog_slug_history')
    .select('article_id')
    .eq('slug', slug)
    .maybeSingle();
  if (historical.error) throw historical.error;
  return historical.data?.article_id || null;
}

async function processArticle(
  actor: BlogActor,
  eventType: 'publish_articles' | 'update_article',
  timestamp: string,
  article: OutrankArticle,
): Promise<Record<string, unknown>> {
  const idempotencyKey = `outrank:${eventType}:${timestamp}:${article.id}`.slice(0, 300);
  const previous = await actor.db.from('blog_ingestions')
    .select('id, article_id, status')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();
  if (previous.error) throw previous.error;
  if (previous.data?.status === 'normalized') {
    return {
      id: article.id,
      articleId: previous.data.article_id,
      status: 'already_processed',
    };
  }

  const articleId = await findArticleId(actor, article);
  const format = article.content_markdown?.trim() ? 'markdown' : 'html';
  const content = format === 'markdown' ? article.content_markdown! : article.content_html!;
  const ingestion = previous.data
    ? { data: { id: previous.data.id }, error: null }
    : await actor.db.from('blog_ingestions').insert({
      article_id: articleId,
      provider: 'outrank',
      external_id: article.id,
      idempotency_key: idempotencyKey,
      format,
      intent: 'publish',
      payload: { event_type: eventType, timestamp, article },
    }).select('id').single();
  if (ingestion.error || !ingestion.data) throw ingestion.error || new Error('Import Outrank impossible');

  try {
    const mediaId = await featuredMediaId(actor, article);
    const metadata: DraftMetadata = {
      title: article.title,
      slug: article.slug,
      seoDescription: article.meta_description,
      excerpt: article.meta_description,
      locale: 'fr-CH',
      topics: Array.isArray(article.tags) ? article.tags : [],
      featuredMediaId: mediaId,
      extra: {
        outrankId: article.id,
        outrankCreatedAt: article.created_at || null,
      },
    };
    const converted = await convertBlogContent(format, content, metadata.locale!);
    const draft = await saveBlogDraft(actor, {
      articleId,
      ingestionId: ingestion.data.id,
      document: converted.document,
      metadata,
      sourceFormat: format,
      sourceContent: sourceAsString(content),
    });
    await actor.db.from('blog_ingestions')
      .update({ warnings: converted.warnings })
      .eq('id', ingestion.data.id);
    const published = await publishBlogArticle(actor, draft.articleId);
    return {
      id: article.id,
      articleId: draft.articleId,
      slug: published.slug,
      status: 'published',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Publication Outrank impossible';
    await actor.db.from('blog_ingestions')
      .update({ status: 'failed', error: message })
      .eq('id', ingestion.data.id);
    throw error;
  }
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);

  const expectedToken = Deno.env.get('OUTRANK_WEBHOOK_TOKEN') || '';
  if (!expectedToken) {
    console.error('outrank_webhook_missing_token');
    return json({ error: 'Webhook non configuré' }, 503);
  }
  if (!constantTimeEqual(bearer(req), expectedToken)) {
    return json({ error: 'Access token invalide' }, 401);
  }

  try {
    const body = await req.json() as Record<string, unknown>;
    const eventType = body.event_type;
    const timestamp = typeof body.timestamp === 'string' ? body.timestamp : '';
    const data = body.data && typeof body.data === 'object'
      ? body.data as Record<string, unknown>
      : {};
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) throw new Error('timestamp ISO 8601 invalide');

    let articles: unknown[];
    if (eventType === 'publish_articles') {
      articles = Array.isArray(data.articles) ? data.articles : [];
      if (!articles.length) throw new Error('data.articles doit contenir au moins un article');
    } else if (eventType === 'update_article') {
      articles = [data.article];
    } else {
      return json({ error: `Événement non pris en charge: ${String(eventType || 'absent')}` }, 400);
    }
    if (!articles.every(isArticle)) throw new Error('Article Outrank invalide ou incomplet');

    const db = adminClient();
    const actor: BlogActor = {
      userId: null,
      apiKeyId: null,
      role: null,
      scopes: ['articles:import', 'articles:publish'],
      db,
    };
    const results = [];
    for (const article of articles) {
      results.push(await processArticle(actor, eventType, timestamp, article));
    }
    return json({ message: 'Webhook traité avec succès', results });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook Outrank invalide';
    console.error('outrank_webhook_failed', message);
    return json({ error: message }, 400);
  }
});

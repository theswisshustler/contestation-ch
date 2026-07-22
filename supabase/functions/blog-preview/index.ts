import { json, preflight } from '../_shared/http.ts';
import { adminClient } from '../_shared/supabase.ts';
import { sha256Hex } from '../_shared/blog/document.ts';

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);
  try {
    const body = await req.json() as { token?: string };
    const token = String(body.token || '');
    if (!/^[a-f0-9]{64}$/.test(token)) return json({ error: 'Aperçu invalide' }, 404);
    const db = adminClient();
    const tokenHash = await sha256Hex(token);
    const { data: preview } = await db.from('blog_preview_tokens').select('revision_id, expires_at').eq('token_hash', tokenHash).maybeSingle();
    if (!preview || new Date(preview.expires_at) <= new Date()) return json({ error: 'Aperçu expiré' }, 404);
    const { data: revision } = await db.from('blog_revisions').select('*').eq('id', preview.revision_id).maybeSingle();
    if (!revision) return json({ error: 'Révision introuvable' }, 404);
    const { data: article } = await db.from('blog_articles').select('id, locale, status').eq('id', revision.article_id).maybeSingle();
    const { data: author } = revision.author_id ? await db.from('blog_authors').select('name, slug, kind').eq('id', revision.author_id).maybeSingle() : { data: null };
    const { data: reviewer } = revision.reviewed_by_id ? await db.from('blog_authors').select('name').eq('id', revision.reviewed_by_id).maybeSingle() : { data: null };
    const { data: media } = revision.featured_media_id ? await db.from('blog_media').select('public_url').eq('id', revision.featured_media_id).maybeSingle() : { data: null };
    const { data: topicLinks } = await db.from('blog_article_topics').select('blog_topics(name, slug)').eq('article_id', revision.article_id);
    return json({ article: {
      id: article?.id,
      slug: revision.slug,
      locale: article?.locale || 'fr-CH',
      title: revision.title,
      excerpt: revision.excerpt,
      seo_title: revision.seo_title,
      seo_description: revision.seo_description,
      document: revision.document,
      reviewed_at: revision.reviewed_at,
      next_review_at: revision.next_review_at,
      sources: revision.sources,
      metadata: revision.metadata,
      author_name: author?.name || 'Contestation.ch',
      author_slug: author?.slug || 'contestation-ch',
      author_kind: author?.kind || 'organization',
      reviewer_name: reviewer?.name || null,
      featured_image: media?.public_url || null,
      topics: (topicLinks || []).map((row) => row.blog_topics),
      preview: true,
    } }, 200, { 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow' });
  } catch (error) {
    console.error('blog_preview_error', error);
    return json({ error: 'Aperçu indisponible' }, 500, { 'Cache-Control': 'no-store' });
  }
});

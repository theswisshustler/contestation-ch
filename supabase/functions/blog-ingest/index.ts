import { json, preflight } from '../_shared/http.ts';
import { authenticateBlogIngestion, requireScope } from '../_shared/blog/auth.ts';
import {
  BLOG_INGESTION_FORMATS,
  convertBlogContent,
  sourceAsString,
} from '../_shared/blog/ingestion.ts';
import { publishBlogArticle, saveBlogDraft, type DraftMetadata } from '../_shared/blog/repository.ts';

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);
  let ingestionId: string | null = null;
  try {
    const actor = await authenticateBlogIngestion(req);
    requireScope(actor, 'articles:import');
    const body = await req.json() as Record<string, unknown>;
    const format = String(body.format || '').toLowerCase();
    if (!BLOG_INGESTION_FORMATS.has(format)) throw new Error(`Format non pris en charge: ${format || 'absent'}`);
    const intent = body.intent === 'publish' ? 'publish' : 'draft';
    if (intent === 'publish') requireScope(actor, 'articles:publish');
    const source = body.source && typeof body.source === 'object' ? body.source as Record<string, unknown> : {};
    const provider = String(source.provider || (actor.apiKeyId ? 'api' : 'admin')).trim().slice(0, 100) || 'api';
    const externalId = source.externalId ? String(source.externalId).trim().slice(0, 300) : null;
    const idempotencyKey = (req.headers.get('idempotency-key') || String(body.idempotencyKey || '')).trim().slice(0, 300) || null;

    if (idempotencyKey) {
      let query = actor.db.from('blog_ingestions').select('id, article_id, status, warnings, error').eq('idempotency_key', idempotencyKey);
      if (actor.apiKeyId) query = query.eq('api_key_id', actor.apiKeyId);
      const { data: previous } = await query.maybeSingle();
      if (previous) return json({ ingestionId: previous.id, articleId: previous.article_id, status: previous.status, warnings: previous.warnings, error: previous.error, idempotent: true });
    }

    let articleId = body.articleId ? String(body.articleId) : null;
    if (!articleId && externalId) {
      const { data: previous } = await actor.db.from('blog_ingestions').select('article_id')
        .eq('provider', provider).eq('external_id', externalId).not('article_id', 'is', null)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      articleId = previous?.article_id || null;
    }

    const ingestion = await actor.db.from('blog_ingestions').insert({
      article_id: articleId,
      provider,
      external_id: externalId,
      idempotency_key: idempotencyKey,
      format,
      intent,
      payload: { metadata: body.metadata || {}, content: body.content, source },
      created_by: actor.userId,
      api_key_id: actor.apiKeyId,
    }).select('id').single();
    if (ingestion.error) throw ingestion.error;
    ingestionId = ingestion.data.id;

    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata as unknown as DraftMetadata : {} as DraftMetadata;
    const locale = metadata.locale || 'fr-CH';
    const converted = await convertBlogContent(format, body.content, locale);
    const draft = await saveBlogDraft(actor, {
      articleId,
      ingestionId,
      document: converted.document,
      metadata,
      sourceFormat: format,
      sourceContent: sourceAsString(body.content),
    });
    await actor.db.from('blog_ingestions').update({ warnings: converted.warnings }).eq('id', ingestionId);
    const published = intent === 'publish' ? await publishBlogArticle(actor, draft.articleId) : null;
    return json({
      ingestionId,
      articleId: draft.articleId,
      revisionId: draft.revisionId,
      version: draft.version,
      slug: published?.slug || draft.slug,
      status: published ? 'published' : 'draft',
      warnings: converted.warnings,
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Import impossible';
    console.error('blog_ingest_failed', message);
    if (ingestionId) {
      try {
        const { adminClient } = await import('../_shared/supabase.ts');
        await adminClient().from('blog_ingestions').update({ status: 'failed', error: message }).eq('id', ingestionId);
      } catch (_) { /* la réponse d'erreur reste prioritaire */ }
    }
    const unauthenticated = /Authorization|Authentification|Session|Clé API/.test(message);
    const forbidden = /Accès|Permission/.test(message);
    return json({ error: message }, unauthenticated ? 401 : forbidden ? 403 : 400);
  }
});

import { marked } from 'npm:marked@17.0.1';
import { json, preflight } from '../_shared/http.ts';
import { authenticateBlogIngestion, requireScope } from '../_shared/blog/auth.ts';
import {
  escapeHtml,
  htmlToDocument,
  normalizeDocument,
  tiptapToDocument,
  type BlogDocumentV1,
} from '../_shared/blog/document.ts';
import { publishBlogArticle, saveBlogDraft, type DraftMetadata } from '../_shared/blog/repository.ts';

const FORMATS = new Set(['markdown', 'html', 'rich-text', 'canonical-v1', 'tiptap', 'json', 'plain']);

function sourceAsString(content: unknown): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

async function convert(format: string, content: unknown, locale: string): Promise<{ document: BlogDocumentV1; warnings: string[] }> {
  const warnings: string[] = [];
  if (format === 'canonical-v1') {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    return { document: normalizeDocument(parsed), warnings };
  }
  if (format === 'tiptap') return { document: tiptapToDocument(typeof content === 'string' ? JSON.parse(content) : content, locale), warnings };
  if (format === 'json') {
    const parsed = typeof content === 'string' ? JSON.parse(content) : content;
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).schemaVersion === 1) {
      return { document: normalizeDocument(parsed), warnings };
    }
    if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).type === 'doc') {
      return { document: tiptapToDocument(parsed, locale), warnings };
    }
    throw new Error('JSON inconnu : indiquez canonical-v1 ou tiptap, ou ajoutez un adaptateur fournisseur');
  }
  const raw = String(content || '').slice(0, 2_000_000);
  if (!raw.trim()) throw new Error('Le contenu est vide');
  let html = raw;
  if (format === 'markdown') html = await marked.parse(raw, { gfm: true, breaks: false }) as string;
  if (format === 'plain') html = raw.split(/\n{2,}/).map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('');
  if (/<(?:style|script|iframe|object)\b|\s(?:style|class|on\w+)\s*=/i.test(html)) {
    warnings.push('Les styles, scripts et attributs de présentation ont été retirés du contenu importé.');
  }
  return { document: htmlToDocument(html, locale), warnings };
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);
  let ingestionId: string | null = null;
  try {
    const actor = await authenticateBlogIngestion(req);
    requireScope(actor, 'articles:import');
    const body = await req.json() as Record<string, unknown>;
    const format = String(body.format || '').toLowerCase();
    if (!FORMATS.has(format)) throw new Error(`Format non pris en charge: ${format || 'absent'}`);
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
    const converted = await convert(format, body.content, locale);
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

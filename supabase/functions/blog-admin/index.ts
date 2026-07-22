import { json, preflight } from '../_shared/http.ts';
import { requireBlogAdmin, type BlogRole } from '../_shared/blog/auth.ts';
import { archiveBlogArticle, createPreviewToken, deleteBlogArticle, publishBlogArticle } from '../_shared/blog/repository.ts';
import { sha256Hex, slugify } from '../_shared/blog/document.ts';

function randomToken(bytesLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(bytesLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function extensionFor(mime: string): string {
  return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'image/gif': 'gif' } as Record<string, string>)[mime] || '';
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);
  try {
    const body = await req.json() as Record<string, unknown>;
    const action = String(body.action || 'me');
    const privileged: BlogRole[] = ['publisher', 'owner'];
    const ownerOnly: BlogRole[] = ['owner'];
    const actor = await requireBlogAdmin(req, ['editor', 'publisher', 'owner']);
    const db = actor.db;

    if (action === 'me') return json({ userId: actor.userId, role: actor.role });
    if (action === 'list') {
      const page = Math.max(0, Number(body.page) || 0);
      const pageSize = Math.min(100, Math.max(1, Number(body.pageSize) || 50));
      const query = await db.from('blog_articles')
        .select('id, status, current_slug, draft_revision_id, published_revision_id, published_at, updated_at, deleted_at', { count: 'exact' })
        .is('deleted_at', null).order('updated_at', { ascending: false }).range(page * pageSize, (page + 1) * pageSize - 1);
      if (query.error) throw query.error;
      const revisionIds = [...new Set((query.data || []).flatMap((article) => [article.draft_revision_id, article.published_revision_id]).filter(Boolean))];
      const revisions = revisionIds.length ? await db.from('blog_revisions').select('id, title, slug, excerpt, version, created_at').in('id', revisionIds) : { data: [] };
      const byId = new Map((revisions.data || []).map((revision) => [revision.id, revision]));
      return json({ articles: (query.data || []).map((article) => ({
        ...article,
        draft: article.draft_revision_id ? byId.get(article.draft_revision_id) : null,
        published: article.published_revision_id ? byId.get(article.published_revision_id) : null,
      })), count: query.count || 0 });
    }
    if (action === 'get') {
      const articleId = String(body.articleId || '');
      const articleResult = await db.from('blog_articles').select('*').eq('id', articleId).is('deleted_at', null).maybeSingle();
      if (!articleResult.data) throw new Error('Article introuvable');
      const revisions = await db.from('blog_revisions').select('*').eq('article_id', articleId).order('version', { ascending: false });
      const topicLinks = await db.from('blog_article_topics').select('blog_topics(id, name, slug)').eq('article_id', articleId);
      return json({ article: articleResult.data, revisions: revisions.data || [], topics: (topicLinks.data || []).map((row) => row.blog_topics) });
    }
    if (action === 'publish') {
      if (!privileged.includes(actor.role!)) throw new Error('Rôle publisher requis');
      return json(await publishBlogArticle(actor, String(body.articleId || '')));
    }
    if (action === 'archive') {
      if (!privileged.includes(actor.role!)) throw new Error('Rôle publisher requis');
      await archiveBlogArticle(actor, String(body.articleId || ''));
      return json({ archived: true });
    }
    if (action === 'delete') {
      if (!ownerOnly.includes(actor.role!)) throw new Error('Rôle owner requis');
      return json({ deleted: true, ...(await deleteBlogArticle(actor, String(body.articleId || ''))) });
    }
    if (action === 'preview') return json(await createPreviewToken(actor, String(body.revisionId || '')));
    if (action === 'authors') {
      const authors = await db.from('blog_authors').select('*').order('name');
      if (authors.error) throw authors.error;
      return json({ authors: authors.data || [] });
    }
    if (action === 'save-author') {
      if (!ownerOnly.includes(actor.role!)) throw new Error('Rôle owner requis');
      const author = body.author && typeof body.author === 'object' ? body.author as Record<string, unknown> : {};
      const row = {
        ...(author.id ? { id: String(author.id) } : {}),
        kind: author.kind === 'organization' ? 'organization' : 'person',
        name: String(author.name || '').trim().slice(0, 200),
        slug: slugify(String(author.slug || author.name || '')),
        bio: String(author.bio || '').trim().slice(0, 2_000) || null,
        url: String(author.url || '').trim().slice(0, 1_000) || null,
        active: author.active !== false,
      };
      if (!row.name) throw new Error('Nom auteur requis');
      const saved = await db.from('blog_authors').upsert(row, { onConflict: 'id' }).select().single();
      if (saved.error) throw saved.error;
      return json({ author: saved.data });
    }
    if (action === 'create-api-key') {
      if (!ownerOnly.includes(actor.role!)) throw new Error('Rôle owner requis');
      const raw = `cc_blog_${randomToken(32)}`;
      const scopes = Array.isArray(body.scopes) ? body.scopes.map(String).filter((scope) => ['articles:import', 'articles:write', 'articles:publish'].includes(scope)) : ['articles:import'];
      const key = await db.from('blog_api_keys').insert({
        created_by: actor.userId,
        name: String(body.name || 'Intégration API').trim().slice(0, 200),
        key_prefix: raw.slice(0, 20),
        key_hash: await sha256Hex(raw),
        scopes,
      }).select('id, name, key_prefix, scopes, created_at').single();
      if (key.error) throw key.error;
      return json({ apiKey: raw, key: key.data }, 201);
    }
    if (action === 'list-api-keys') {
      if (!ownerOnly.includes(actor.role!)) throw new Error('Rôle owner requis');
      const keys = await db.from('blog_api_keys').select('id, name, key_prefix, scopes, active, expires_at, created_at, last_used_at').order('created_at', { ascending: false });
      return json({ keys: keys.data || [] });
    }
    if (action === 'revoke-api-key') {
      if (!ownerOnly.includes(actor.role!)) throw new Error('Rôle owner requis');
      await db.from('blog_api_keys').update({ active: false }).eq('id', String(body.id || ''));
      return json({ revoked: true });
    }
    if (action === 'media-upload-url') {
      const mime = String(body.mime || '');
      const ext = extensionFor(mime);
      const bytes = Number(body.bytes) || 0;
      if (!ext || bytes <= 0 || bytes > 10 * 1024 * 1024) throw new Error('Image invalide ou supérieure à 10 Mo');
      const path = `${new Date().getUTCFullYear()}/${crypto.randomUUID()}.${ext}`;
      const signed = await db.storage.from('blog-media').createSignedUploadUrl(path);
      if (signed.error) throw signed.error;
      return json({ path, token: signed.data.token, publicUrl: db.storage.from('blog-media').getPublicUrl(path).data.publicUrl });
    }
    if (action === 'media-register') {
      const row = {
        storage_path: String(body.path || ''), public_url: String(body.publicUrl || ''),
        mime: String(body.mime || ''), bytes: Number(body.bytes) || null,
        width: Number(body.width) || null, height: Number(body.height) || null,
        alt: String(body.alt || '').trim().slice(0, 500), caption: String(body.caption || '').trim().slice(0, 1_000) || null,
        credit: String(body.credit || '').trim().slice(0, 500) || null,
      };
      if (!row.storage_path || !row.public_url) throw new Error('Média incomplet');
      const media = await db.from('blog_media').insert(row).select().single();
      if (media.error) throw media.error;
      return json({ media: media.data }, 201);
    }
    throw new Error(`Action inconnue: ${action}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erreur administration';
    console.error('blog_admin_error', message);
    const status = /Authentification|Session/.test(message) ? 401 : /Accès|Rôle/.test(message) ? 403 : 400;
    return json({ error: message }, status);
  }
});

import { json, preflight } from '../_shared/http.ts';
import { requireBlogAdmin } from '../_shared/blog/auth.ts';
import { normalizeDocument } from '../_shared/blog/document.ts';
import { saveBlogDraft } from '../_shared/blog/repository.ts';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = Deno.env.get('ANTHROPIC_MODEL') ?? 'claude-sonnet-4-6';
const MAX_INSTRUCTION_LENGTH = 4_000;

const improvementTool = {
  name: 'submit_improved_article',
  description: 'Retourne la version éditoriale améliorée et prête à publier.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'excerpt', 'seoTitle', 'seoDescription', 'document'],
    properties: {
      title: { type: 'string', maxLength: 240 },
      excerpt: { type: 'string', maxLength: 320 },
      seoTitle: { type: 'string', maxLength: 70 },
      seoDescription: { type: 'string', maxLength: 180 },
      document: {
        type: 'object',
        additionalProperties: false,
        required: ['schemaVersion', 'locale', 'blocks'],
        properties: {
          schemaVersion: { type: 'integer', enum: [1] },
          locale: { type: 'string' },
          blocks: { type: 'array', items: { type: 'object' } },
        },
      },
      summary: { type: 'string', maxLength: 1_000 },
    },
  },
};

function upstreamMessage(status: number): string {
  if (status === 429) return 'Le service d’amélioration est momentanément saturé. Réessayez dans une minute.';
  if (status >= 500) return 'Le service d’amélioration est indisponible. Réessayez dans quelques instants.';
  return 'L’article n’a pas pu être amélioré par le service éditorial.';
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);

  try {
    const actor = await requireBlogAdmin(req, ['editor', 'publisher', 'owner']);
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) return json({ error: 'Le service d’amélioration n’est pas configuré.' }, 503);

    const body = await req.json() as Record<string, unknown>;
    const articleId = String(body.articleId || '');
    const instruction = String(body.instruction || '').trim().slice(0, MAX_INSTRUCTION_LENGTH);
    if (!articleId) return json({ error: 'Article requis' }, 400);
    if (!instruction) return json({ error: 'Ajoutez une consigne d’amélioration' }, 400);

    const articleResult = await actor.db.from('blog_articles')
      .select('id, current_slug, draft_revision_id, published_revision_id')
      .eq('id', articleId).is('deleted_at', null).maybeSingle();
    const article = articleResult.data;
    if (!article) return json({ error: 'Article introuvable' }, 404);

    const revisionId = article.draft_revision_id || article.published_revision_id;
    const revisionResult = await actor.db.from('blog_revisions').select('*').eq('id', revisionId).maybeSingle();
    const revision = revisionResult.data;
    if (!revision) return json({ error: 'Révision introuvable' }, 404);
    const topicLinks = await actor.db.from('blog_article_topics').select('blog_topics(name)').eq('article_id', articleId);
    const topics = (topicLinks.data || []).map((row) => row.blog_topics?.name).filter(Boolean);

    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 12_000,
        temperature: 0.25,
        system: `Tu es le relecteur en chef de Contestation.ch, spécialiste du droit du bail suisse.
Améliore l'article sans inventer de faits, de lois, de délais, de jurisprudence ni de sources.
Préserve les informations exactes, les liens, images, CTA, tableaux et sources utiles.
Rends le texte plus clair, concret, structuré et naturel en français de Suisse.
Supprime répétitions, formulations vagues et contenu de remplissage. Renforce les titres, l'introduction,
la progression logique et le SEO sans bourrage de mots-clés. Le résultat doit être directement publiable.
Respecte strictement le document canonique fourni et retourne le résultat avec l'outil imposé.`,
        messages: [{
          role: 'user',
          content: `CONSIGNE ÉDITORIALE PERSONNALISÉE
${instruction}

ARTICLE ACTUEL
${JSON.stringify({
  title: revision.title,
  excerpt: revision.excerpt,
  seoTitle: revision.seo_title,
  seoDescription: revision.seo_description,
  topics,
  sources: revision.sources || [],
  document: revision.document,
})}`,
        }],
        tools: [improvementTool],
        tool_choice: { type: 'tool', name: improvementTool.name },
      }),
    });

    const responseText = await response.text();
    const data = responseText ? JSON.parse(responseText) : {};
    if (!response.ok) {
      console.error('blog_improve_upstream_error', { status: response.status, requestId: response.headers.get('request-id') });
      return json({ error: upstreamMessage(response.status) }, 502);
    }

    const toolUse = Array.isArray(data.content)
      ? data.content.find((item: Record<string, unknown>) => item.type === 'tool_use' && item.name === improvementTool.name)
      : null;
    if (!toolUse?.input || typeof toolUse.input !== 'object') throw new Error('Réponse éditoriale invalide');
    const improved = toolUse.input as Record<string, unknown>;
    const document = normalizeDocument(improved.document);

    const saved = await saveBlogDraft(actor, {
      articleId,
      document,
      sourceFormat: 'canonical-v1',
      sourceContent: JSON.stringify(document, null, 2),
      metadata: {
        title: String(improved.title || revision.title),
        slug: revision.slug || article.current_slug,
        excerpt: String(improved.excerpt || revision.excerpt),
        seoTitle: String(improved.seoTitle || revision.seo_title),
        seoDescription: String(improved.seoDescription || revision.seo_description),
        locale: revision.document?.locale || 'fr-CH',
        topics,
        featuredMediaId: revision.featured_media_id,
        authorId: revision.author_id,
        reviewedById: revision.reviewed_by_id,
        reviewedAt: revision.reviewed_at,
        nextReviewAt: revision.next_review_at,
        sources: revision.sources || [],
        extra: { ...(revision.metadata || {}), improvedBy: MODEL, improvementInstruction: instruction },
      },
    });

    return json({
      ...saved,
      summary: String(improved.summary || 'Article relu et amélioré.'),
      model: data.model || MODEL,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erreur pendant l’amélioration';
    console.error('blog_improve_error', message);
    const status = /Authentification|Session/.test(message) ? 401 : /Accès|Rôle/.test(message) ? 403 : 400;
    return json({ error: message }, status);
  }
});

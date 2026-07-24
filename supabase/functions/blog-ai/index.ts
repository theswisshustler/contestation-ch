import { json, preflight } from '../_shared/http.ts';
import { requireBlogAdmin } from '../_shared/blog/auth.ts';
import { sanitizeUrl } from '../_shared/blog/document.ts';

interface GeneratedArticle {
  title: string;
  excerpt: string;
  seoTitle: string;
  seoDescription: string;
  topics: string[];
  markdown: string;
  sources: Array<{ label: string; url: string }>;
}

const ARTICLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'excerpt', 'seoTitle', 'seoDescription', 'topics', 'markdown', 'sources'],
  properties: {
    title: { type: 'string', minLength: 5, maxLength: 240 },
    excerpt: { type: 'string', minLength: 20, maxLength: 320 },
    seoTitle: { type: 'string', minLength: 5, maxLength: 70 },
    seoDescription: { type: 'string', minLength: 20, maxLength: 180 },
    topics: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 2, maxLength: 80 } },
    markdown: { type: 'string', minLength: 100 },
    sources: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'url'],
        properties: {
          label: { type: 'string', minLength: 2, maxLength: 300 },
          url: { type: 'string', minLength: 8, maxLength: 2_000 },
        },
      },
    },
  },
};

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string') return payload.output_text;
  const output = Array.isArray(payload.output) ? payload.output : [];
  for (const item of output) {
    if (!item || typeof item !== 'object' || (item as Record<string, unknown>).type !== 'message') continue;
    const content = Array.isArray((item as Record<string, unknown>).content)
      ? (item as Record<string, unknown>).content as Array<Record<string, unknown>>
      : [];
    const text = content.find((part) => part.type === 'output_text')?.text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function cleanGenerated(value: unknown): GeneratedArticle {
  if (!value || typeof value !== 'object') throw new Error('Réponse IA invalide');
  const row = value as Record<string, unknown>;
  const sources = Array.isArray(row.sources) ? row.sources.flatMap((source) => {
    if (!source || typeof source !== 'object') return [];
    const entry = source as Record<string, unknown>;
    const url = sanitizeUrl(entry.url);
    const label = cleanText(entry.label, 300);
    return url && /^https?:\/\//.test(url) && label ? [{ label, url }] : [];
  }) : [];
  const markdown = cleanText(row.markdown, 200_000);
  const title = cleanText(row.title, 240);
  if (!title || !markdown) throw new Error('La réponse IA ne contient pas un article exploitable');
  return {
    title,
    excerpt: cleanText(row.excerpt, 320),
    seoTitle: cleanText(row.seoTitle, 70) || title.slice(0, 70),
    seoDescription: cleanText(row.seoDescription, 180),
    topics: Array.isArray(row.topics)
      ? [...new Set(row.topics.map((topic) => cleanText(topic, 80)).filter(Boolean))].slice(0, 8)
      : [],
    markdown,
    sources: [...new Map(sources.map((source) => [source.url, source])).values()].slice(0, 20),
  };
}

Deno.serve(async (req) => {
  const pf = preflight(req);
  if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);

  try {
    const actor = await requireBlogAdmin(req);
    const apiKey = Deno.env.get('OPENAI_API_KEY') || '';
    if (!apiKey) return json({ error: 'OPENAI_API_KEY n’est pas configurée dans les secrets Supabase.' }, 503);

    const body = await req.json() as Record<string, unknown>;
    const brief = cleanText(body.brief, 12_000);
    const existingContent = cleanText(body.existingContent, 100_000);
    const sourceUrls = Array.isArray(body.sourceUrls)
      ? body.sourceUrls.map((url) => sanitizeUrl(url)).filter((url) => /^https?:\/\//.test(url)).slice(0, 20)
      : [];
    const requestedMode = body.mode === 'enrich-sources'
      ? 'enrich-sources'
      : body.mode === 'improve'
      ? 'improve'
      : 'create';
    const research = body.research !== false;
    const webEnabled = requestedMode === 'enrich-sources' || research || sourceUrls.length > 0;
    const mode = requestedMode === 'enrich-sources'
      ? 'enrichir le brouillon existant avec des liens et des sources vérifiables sans en changer inutilement le fond'
      : requestedMode === 'improve'
      ? 'améliorer le brouillon existant'
      : 'rédiger un nouvel article';
    if (!brief && !existingContent) throw new Error('Décrivez le sujet ou fournissez un brouillon à améliorer');

    const model = Deno.env.get('OPENAI_BLOG_MODEL') || 'gpt-5.6-luna';
    const instructions = `Tu es le rédacteur en chef de Contestation.ch, un service suisse indépendant d'information sur le droit du bail.
Ta mission est de ${mode} en français de Suisse, avec un style clair, factuel et utile.

Règles impératives :
- Ne présente jamais le texte comme un conseil juridique individualisé.
- Distingue clairement loyer initial, hausse de loyer et demande de baisse.
- N'invente aucune loi, jurisprudence, statistique, date, délai ou autorité.
- Appuie les affirmations vérifiables sur des sources fiables, en priorité admin.ch, fedlex.admin.ch, bwo.admin.ch, vd.ch, ge.ch et les autorités de conciliation.
- Ajoute des liens Markdown contextuels vers les sources pertinentes, sans lien artificiel ni bourrage SEO.
- Chaque lien ajouté doit soutenir directement la phrase ou l'affirmation à laquelle il est attaché.
- N'utilise jamais une URL inventée, approximative ou non consultée.
- Termine par une section "Sources" uniquement si cela améliore la lecture ; dans tous les cas, renseigne le tableau JSON sources.
- Structure le Markdown avec des H2/H3, paragraphes courts, listes, tableau si utile, FAQ et appel à l'action vers /diagnostic si pertinent.
- Le H1 ne doit pas apparaître dans le Markdown : il est fourni séparément dans title.
- Ne publie rien : retourne seulement un brouillon structuré à relire humainement.
${requestedMode === 'enrich-sources' ? `- Préserve le plan, le ton, les conclusions et la longueur du brouillon autant que possible.
- Ne réécris que ce qui est nécessaire pour intégrer naturellement un lien, corriger une affirmation non étayée ou lever une ambiguïté.
- Conserve les liens existants pertinents et remplace uniquement ceux qui sont cassés, faibles ou hors sujet.
- Le tableau sources doit contenir toutes les références ajoutées ou conservées dans le texte.` : ''}`;

    const input = [
      `Brief éditorial :\n${brief || 'Améliorer le brouillon fourni.'}`,
      existingContent ? `\nBrouillon existant :\n${existingContent}` : '',
      sourceUrls.length ? `\nSources imposées à consulter et citer si pertinentes :\n${sourceUrls.join('\n')}` : '',
      `\nRecherche web autorisée : ${webEnabled ? 'oui' : 'non'}.`,
    ].join('');

    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        instructions,
        input,
        store: false,
        reasoning: { effort: 'medium' },
        max_output_tokens: 12_000,
        ...(webEnabled ? { tools: [{ type: 'web_search' }] } : {}),
        text: {
          verbosity: 'medium',
          format: {
            type: 'json_schema',
            name: 'blog_article_draft',
            strict: true,
            schema: ARTICLE_SCHEMA,
          },
        },
      }),
    });

    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) {
      const apiError = payload.error && typeof payload.error === 'object'
        ? cleanText((payload.error as Record<string, unknown>).message, 1_000)
        : '';
      throw new Error(apiError || `OpenAI a répondu avec le statut ${response.status}`);
    }
    const outputText = extractOutputText(payload);
    if (!outputText) throw new Error('OpenAI n’a retourné aucun contenu');
    const article = cleanGenerated(JSON.parse(outputText));

    await actor.db.from('blog_audit_log').insert({
      actor_id: actor.userId,
      action: 'ai.draft.generated',
      detail: {
        model,
        research: webEnabled,
        mode: requestedMode,
        sourceCount: article.sources.length,
        responseId: cleanText(payload.id, 200),
      },
    });
    return json({ article, model, requiresHumanReview: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Génération IA impossible';
    console.error('blog_ai_error', message);
    const status = /Authentification|Session/.test(message) ? 401 : /Accès/.test(message) ? 403 : 400;
    return json({ error: message }, status);
  }
});

import type { APIRoute } from 'astro';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../../../lib/blog.ts';
import { sanitizeUrl } from '../../../../supabase/functions/_shared/blog/document.ts';

export const prerender = false;

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

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

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

async function authenticateAdmin(authorization: string): Promise<void> {
  if (!/^Bearer\s+\S+$/i.test(authorization)) throw new Error('Session administrateur requise');
  const check = await fetch(`${SUPABASE_URL}/functions/v1/blog-admin`, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      apikey: SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'me' }),
  });
  if (!check.ok) throw new Error(check.status === 401 || check.status === 403
    ? 'Accès administrateur refusé'
    : 'Vérification administrateur indisponible');
}

export const POST: APIRoute = async ({ request }) => {
  try {
    await authenticateAdmin(request.headers.get('authorization') || '');
    const apiKey = process.env.OPENAI_API_KEY || import.meta.env.OPENAI_API_KEY || '';
    if (!apiKey) return response({ error: 'Ajoutez OPENAI_API_KEY dans les Secrets du déploiement Replit.' }, 503);

    const body = await request.json() as Record<string, unknown>;
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
    if (!brief && !existingContent) throw new Error('Décrivez le sujet ou fournissez un brouillon à améliorer');

    const research = body.research !== false;
    const webEnabled = requestedMode === 'enrich-sources' || research || sourceUrls.length > 0;
    const mode = requestedMode === 'enrich-sources'
      ? 'enrichir le brouillon existant avec des liens et des sources vérifiables sans en changer inutilement le fond'
      : requestedMode === 'improve'
      ? 'améliorer le brouillon existant'
      : 'rédiger un nouvel article';
    const model = process.env.OPENAI_BLOG_MODEL || import.meta.env.OPENAI_BLOG_MODEL || 'gpt-5.6-luna';

    const instructions = `Tu es le rédacteur en chef de Contestation.ch, un service suisse indépendant d'information sur le droit du bail.
Ta mission est de ${mode} en français de Suisse, avec un style clair, factuel et utile.

Règles impératives :
- Ne présente jamais le texte comme un conseil juridique individualisé.
- Distingue clairement loyer initial, hausse de loyer et demande de baisse.
- N'invente aucune loi, jurisprudence, statistique, date, délai, autorité ou URL.
- Appuie les affirmations vérifiables sur des sources fiables, en priorité admin.ch, fedlex.admin.ch, bwo.admin.ch, vd.ch, ge.ch et les autorités de conciliation.
- Ajoute des liens Markdown contextuels vers les sources pertinentes, sans lien artificiel ni bourrage SEO.
- Chaque lien doit soutenir directement la phrase à laquelle il est attaché.
- Renseigne le tableau JSON sources avec toutes les références utilisées.
- Structure le Markdown avec des H2/H3, paragraphes courts, listes, tableau si utile, FAQ et appel à l'action vers /diagnostic si pertinent.
- Le H1 ne doit pas apparaître dans le Markdown : il est fourni séparément dans title.
- Ne publie rien : retourne seulement un brouillon structuré à relire humainement.
${requestedMode === 'enrich-sources' ? `- Préserve le plan, le ton, les conclusions et la longueur du brouillon autant que possible.
- Ne réécris que ce qui est nécessaire pour intégrer un lien, corriger une affirmation non étayée ou lever une ambiguïté.
- Conserve les liens existants pertinents et remplace uniquement ceux qui sont cassés, faibles ou hors sujet.` : ''}`;

    const input = [
      `Brief éditorial :\n${brief || 'Améliorer le brouillon fourni.'}`,
      existingContent ? `\nBrouillon existant :\n${existingContent}` : '',
      sourceUrls.length ? `\nSources imposées à consulter et citer si pertinentes :\n${sourceUrls.join('\n')}` : '',
    ].join('');

    const openai = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
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
          format: { type: 'json_schema', name: 'blog_article_draft', strict: true, schema: ARTICLE_SCHEMA },
        },
      }),
    });
    const payload = await openai.json() as Record<string, unknown>;
    if (!openai.ok) {
      const apiError = payload.error && typeof payload.error === 'object'
        ? cleanText((payload.error as Record<string, unknown>).message, 1_000)
        : '';
      throw new Error(apiError || `OpenAI a répondu avec le statut ${openai.status}`);
    }
    const outputText = extractOutputText(payload);
    if (!outputText) throw new Error('OpenAI n’a retourné aucun contenu');
    return response({
      article: cleanGenerated(JSON.parse(outputText)),
      model,
      requiresHumanReview: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Génération IA impossible';
    const status = /Session/.test(message) ? 401 : /Accès/.test(message) ? 403 : 400;
    return response({ error: message }, status);
  }
};

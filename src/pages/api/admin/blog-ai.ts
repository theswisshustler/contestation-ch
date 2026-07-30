import type { APIRoute } from 'astro';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../../../lib/blog.ts';
import { sanitizeUrl } from '../../../../supabase/functions/_shared/blog/document.ts';

export const prerender = false;

const ARTICLE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'excerpt', 'seoTitle', 'seoDescription', 'topics', 'markdown', 'sources'],
  properties: {
    title: { type: 'string', minLength: 5, maxLength: 240 },
    excerpt: { type: 'string', minLength: 20, maxLength: 320 },
    seoTitle: { type: 'string', minLength: 5, maxLength: 70 },
    seoDescription: { type: 'string', minLength: 20, maxLength: 180 },
    topics: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 2, maxLength: 80 } },
    markdown: { type: 'string', minLength: 100 },
    sources: { type: 'array', maxItems: 20, items: {
      type: 'object', additionalProperties: false, required: ['label', 'url'],
      properties: { label: { type: 'string', minLength: 2, maxLength: 300 }, url: { type: 'string', minLength: 8, maxLength: 2_000 } },
    } },
  },
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex, nofollow',
  } });
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === 'string') return payload.output_text;
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (!item || typeof item !== 'object' || (item as Record<string, unknown>).type !== 'message') continue;
    const content = Array.isArray((item as Record<string, unknown>).content) ? (item as Record<string, unknown>).content as Array<Record<string, unknown>> : [];
    const text = content.find((part) => part.type === 'output_text')?.text;
    if (typeof text === 'string') return text;
  }
  return '';
}

function cleanGenerated(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Réponse IA invalide');
  const row = value as Record<string, unknown>;
  const sources = Array.isArray(row.sources) ? row.sources.flatMap((source) => {
    if (!source || typeof source !== 'object') return [];
    const entry = source as Record<string, unknown>;
    const url = sanitizeUrl(entry.url); const label = cleanText(entry.label, 300);
    return url && /^https?:\/\//.test(url) && label ? [{ label, url }] : [];
  }) : [];
  const title = cleanText(row.title, 240); const markdown = cleanText(row.markdown, 200_000);
  if (!title || !markdown) throw new Error('La réponse IA ne contient pas un article exploitable');
  return {
    title, markdown, excerpt: cleanText(row.excerpt, 320),
    seoTitle: cleanText(row.seoTitle, 70) || title.slice(0, 70),
    seoDescription: cleanText(row.seoDescription, 180),
    topics: Array.isArray(row.topics) ? [...new Set(row.topics.map((topic) => cleanText(topic, 80)).filter(Boolean))].slice(0, 8) : [],
    sources: [...new Map(sources.map((source) => [source.url, source])).values()].slice(0, 20),
  };
}

async function authenticateAdmin(authorization: string): Promise<void> {
  if (!/^Bearer\s+\S+$/i.test(authorization)) throw new Error('Session administrateur requise');
  const check = await fetch(`${SUPABASE_URL}/functions/v1/blog-admin`, {
    method: 'POST',
    headers: { Authorization: authorization, apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'me' }),
  });
  if (!check.ok) throw new Error(check.status === 401 || check.status === 403 ? 'Accès administrateur refusé' : 'Vérification administrateur indisponible');
}

export const POST: APIRoute = async ({ request }) => {
  try {
    await authenticateAdmin(request.headers.get('authorization') || '');
    const apiKey = process.env.OPENAI_API_KEY || import.meta.env.OPENAI_API_KEY || '';
    if (!apiKey) return response({ error: 'Ajoutez OPENAI_API_KEY dans les secrets du déploiement.' }, 503);
    const body = await request.json() as Record<string, unknown>;
    const brief = cleanText(body.brief, 12_000);
    const existingContent = cleanText(body.existingContent, 100_000);
    const mode = body.mode === 'improve' ? 'improve' : 'create';
    if (!brief && !existingContent) throw new Error('Décrivez le sujet ou fournissez un brouillon à améliorer');
    const sourceUrls = Array.isArray(body.sourceUrls) ? body.sourceUrls.map((url) => sanitizeUrl(url)).filter((url) => /^https?:\/\//.test(url)).slice(0, 20) : [];
    const model = process.env.OPENAI_BLOG_MODEL || import.meta.env.OPENAI_BLOG_MODEL || 'gpt-5.6-luna';
    const openai = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, store: false, reasoning: { effort: 'medium' }, max_output_tokens: 12_000,
        instructions: `Tu es le rédacteur en chef de Contestation.ch, spécialiste du droit du bail suisse.
${mode === 'improve' ? 'Améliore le brouillon existant sans en changer les faits ni supprimer ses éléments utiles.' : 'Rédige un nouvel article complet à partir du brief.'}
Écris en français de Suisse, clairement et concrètement. N’invente aucune loi, date, autorité, statistique, source ou URL.
Préserve les liens, images et CTA existants lors d’une amélioration. Structure avec H2/H3, paragraphes courts, listes, FAQ et CTA vers /diagnostic si pertinent.
Utilise des sources suisses fiables et ajoute les liens dans le Markdown. Ne mets pas de H1 dans le Markdown. Retourne un brouillon prêt à relire, jamais une publication automatique.`,
        input: [`Brief :\n${brief || 'Améliorer la version fournie.'}`, existingContent ? `\nArticle actuel :\n${existingContent}` : '', sourceUrls.length ? `\nSources à utiliser si pertinentes :\n${sourceUrls.join('\n')}` : ''].join(''),
        ...(body.research !== false || sourceUrls.length ? { tools: [{ type: 'web_search' }] } : {}),
        text: { verbosity: 'medium', format: { type: 'json_schema', name: 'blog_article_draft', strict: true, schema: ARTICLE_SCHEMA } },
      }),
    });
    const payload = await openai.json() as Record<string, unknown>;
    if (!openai.ok) {
      const detail = payload.error && typeof payload.error === 'object' ? cleanText((payload.error as Record<string, unknown>).message, 1_000) : '';
      throw new Error(detail || `OpenAI a répondu avec le statut ${openai.status}`);
    }
    const output = extractOutputText(payload);
    if (!output) throw new Error('OpenAI n’a retourné aucun contenu');
    return response({ article: cleanGenerated(JSON.parse(output)), model, requiresHumanReview: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Génération IA impossible';
    return response({ error: message }, /Session/.test(message) ? 401 : /Accès/.test(message) ? 403 : 400);
  }
};

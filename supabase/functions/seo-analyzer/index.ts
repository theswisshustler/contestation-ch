import { json, preflight } from '../_shared/http.ts';
import { requireBlogAdmin } from '../_shared/blog/auth.ts';

type KeywordRow = {
  keyword: string;
  volume: number | null;
  competition: number | null;
  cpc: number | null;
  siteMentions: number;
  competitorMentions: number;
  serpCompetitors: number;
  score: number;
  source: 'dataforseo' | 'heuristic';
};

const STOP_WORDS = new Set([
  'avec', 'avoir', 'cette', 'comme', 'dans', 'des', 'elle', 'entre', 'est', 'faire', 'leur', 'leurs', 'mais',
  'nous', 'pour', 'plus', 'sans', 'sera', 'sont', 'sur', 'une', 'vous', 'votre', 'vos', 'aux', 'ces', 'qui',
  'que', 'quoi', 'dont', 'tout', 'tous', 'être', 'article', 'page', 'site', 'https', 'www',
]);

function normalize(value: unknown): string {
  return String(value || '').toLocaleLowerCase('fr').normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[^a-z0-9 -]/g, ' ').replace(/\s+/g, ' ').trim();
}

function terms(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const words = normalize(text).split(' ').filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  for (let index = 0; index < words.length - 1; index++) {
    const phrase = `${words[index]} ${words[index + 1]}`;
    if (!STOP_WORDS.has(words[index]) && !STOP_WORDS.has(words[index + 1])) counts.set(phrase, (counts.get(phrase) || 0) + 2);
  }
  return counts;
}

function textFromDocument(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textFromDocument).join(' ');
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).map(textFromDocument).join(' ');
  return '';
}

function safeSwissUrl(raw: string): URL {
  const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || (!host.endsWith('.ch') && host !== 'ch.ch')) throw new Error(`Le concurrent ${raw} doit utiliser un domaine suisse en .ch`);
  if (host === 'localhost' || host.endsWith('.local') || /^\d+(?:\.\d+){3}$/.test(host)) throw new Error(`Domaine concurrent interdit : ${raw}`);
  url.hash = ''; url.search = '';
  return url;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/\s+/g, ' ').trim();
}

async function fetchText(url: URL, maxBytes = 800_000, redirects = 0): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'ContestationCH-SEO-Audit/1.0' } });
    if (response.status >= 300 && response.status < 400) {
      if (redirects >= 3) throw new Error('Trop de redirections');
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirection HTTP ${response.status} invalide`);
      const redirected = safeSwissUrl(new URL(location, url).toString());
      return fetchText(redirected, maxBytes, redirects + 1);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const type = response.headers.get('content-type') || '';
    if (!/text\/html|application\/xml|text\/xml/.test(type)) throw new Error('Format non analysable');
    const text = await response.text();
    return text.slice(0, maxBytes);
  } finally { clearTimeout(timer); }
}

async function crawlCompetitor(raw: string): Promise<{ domain: string; pages: number; text: string; error?: string }> {
  const start = safeSwissUrl(raw);
  try {
    const homepage = await fetchText(start);
    let urls: URL[] = [start];
    try {
      const sitemap = await fetchText(new URL('/sitemap.xml', start));
      urls = [...sitemap.matchAll(/<loc>\s*(.*?)\s*<\/loc>/gi)]
        .map((match) => new URL(match[1]))
        .filter((url) => url.hostname === start.hostname)
        .slice(0, 8);
      if (!urls.length) urls = [start];
    } catch (_) { /* la page d’accueil reste analysable sans sitemap */ }
    const pages = await Promise.all(urls.map(async (url, index) => index === 0 && url.pathname === start.pathname ? homepage : fetchText(url).catch(() => '')));
    return { domain: start.hostname, pages: pages.filter(Boolean).length, text: pages.map(stripHtml).join(' ') };
  } catch (error) {
    return { domain: start.hostname, pages: 0, text: '', error: error instanceof Error ? error.message : 'Analyse impossible' };
  }
}

async function dataForSeoIdeas(seeds: string[]): Promise<Map<string, { volume: number | null; competition: number | null; cpc: number | null }>> {
  const login = Deno.env.get('DATAFORSEO_LOGIN');
  const password = Deno.env.get('DATAFORSEO_PASSWORD');
  const result = new Map();
  if (!login || !password || !seeds.length) return result;
  const response = await fetch('https://api.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live', {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${login}:${password}`)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ keywords: seeds.slice(0, 20), location_name: 'Switzerland', language_code: 'fr', limit: 100, order_by: ['keyword_info.search_volume,desc'] }]),
  });
  if (!response.ok) throw new Error(`DataForSEO HTTP ${response.status}`);
  const body = await response.json();
  const items = body?.tasks?.[0]?.result?.[0]?.items || [];
  for (const item of items) result.set(normalize(item.keyword), {
    volume: item.keyword_info?.search_volume ?? null,
    competition: item.keyword_info?.competition ?? null,
    cpc: item.keyword_info?.cpc ?? null,
  });
  return result;
}

async function braveSerp(keywords: string[], competitorDomains: string[]): Promise<Map<string, number>> {
  const token = Deno.env.get('BRAVE_SEARCH_API_KEY');
  const results = new Map<string, number>();
  if (!token) return results;
  await Promise.all(keywords.slice(0, 12).map(async (keyword) => {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', keyword); url.searchParams.set('country', 'ch'); url.searchParams.set('search_lang', 'fr'); url.searchParams.set('count', '10');
    const response = await fetch(url, { headers: { Accept: 'application/json', 'X-Subscription-Token': token } });
    if (!response.ok) return;
    const body = await response.json();
    const domains = (body.web?.results || []).map((item: { url?: string }) => {
      try { return new URL(item.url || '').hostname; } catch (_) { return ''; }
    });
    results.set(keyword, domains.filter((domain: string) => competitorDomains.some((competitor) => domain === competitor || domain.endsWith(`.${competitor}`))).length);
  }));
  return results;
}

function contentIdeas(rows: KeywordRow[]): Array<{ title: string; keyword: string; angle: string; score: number; brief: string }> {
  return rows.slice(0, 12).map((row, index) => {
    const title = index % 3 === 0 ? `${row.keyword} : le guide pratique en Suisse`
      : index % 3 === 1 ? `Comment ${row.keyword} ? Démarches et délais`
      : `${row.keyword} : checklist et erreurs à éviter`;
    return {
      title: title.charAt(0).toLocaleUpperCase('fr') + title.slice(1),
      keyword: row.keyword,
      angle: row.siteMentions ? 'Approfondir un sujet déjà traité' : 'Combler un manque éditorial',
      score: row.score,
      brief: `Répondre à l’intention de recherche « ${row.keyword} » pour un public suisse. Expliquer le cadre légal, les délais, les démarches, les différences cantonales utiles et les recours possibles. Citer uniquement des sources suisses fiables.`,
    };
  });
}

Deno.serve(async (req) => {
  const pf = preflight(req); if (pf) return pf;
  if (req.method !== 'POST') return json({ error: 'Méthode non autorisée' }, 405);
  try {
    const actor = await requireBlogAdmin(req);
    const body = await req.json() as { seeds?: string[]; competitors?: string[] };
    const seeds = (body.seeds || []).map(normalize).filter((item) => item.length >= 3).slice(0, 20);
    const competitors = [...new Set((body.competitors || []).map(String).filter(Boolean))].slice(0, 5);
    if (!seeds.length) throw new Error('Ajoutez au moins un mot-clé de départ');

    const articleQuery = await actor.db.from('blog_articles')
      .select('id,status,current_slug,draft_revision_id,published_revision_id').is('deleted_at', null);
    const revisionIds = [...new Set((articleQuery.data || []).flatMap((row) => [row.draft_revision_id, row.published_revision_id]).filter(Boolean))];
    const revisions = revisionIds.length
      ? await actor.db.from('blog_revisions').select('id,title,excerpt,document,seo_title,seo_description').in('id', revisionIds)
      : { data: [] };
    const siteText = (revisions.data || []).map((revision) => `${revision.title} ${revision.excerpt || ''} ${revision.seo_title || ''} ${revision.seo_description || ''} ${textFromDocument(revision.document)}`).join(' ');
    const siteTerms = terms(siteText);

    const competitorAudits = await Promise.all(competitors.map(crawlCompetitor));
    const competitorTerms = terms(competitorAudits.map((audit) => audit.text).join(' '));
    const candidates = new Set(seeds);
    for (const [term, count] of [...competitorTerms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80)) if (count >= 2) candidates.add(term);
    for (const seed of seeds) {
      candidates.add(`comment ${seed}`); candidates.add(`${seed} suisse`); candidates.add(`${seed} délai`); candidates.add(`${seed} modèle`);
    }

    let volumeData = new Map();
    let volumeError = '';
    try { volumeData = await dataForSeoIdeas(seeds); } catch (error) { volumeError = error instanceof Error ? error.message : 'DataForSEO indisponible'; }
    for (const keyword of volumeData.keys()) candidates.add(keyword);
    const shortlist = [...candidates].filter((keyword) => keyword.length >= 4).slice(0, 150);
    const competitorDomains = competitorAudits.map((audit) => audit.domain);
    const serpData = await braveSerp(shortlist, competitorDomains);
    const rows: KeywordRow[] = shortlist.map((keyword) => {
      const metric = volumeData.get(keyword);
      const siteMentions = siteTerms.get(keyword) || 0;
      const competitorMentions = competitorTerms.get(keyword) || 0;
      const volume = metric?.volume ?? null;
      const serpCompetitors = serpData.get(keyword) || 0;
      const score = Math.min(100, Math.round(
        28 + Math.min(28, competitorMentions * 3) + Math.min(22, Math.log10((volume || 0) + 1) * 7)
        + Math.min(12, serpCompetitors * 3) + (siteMentions === 0 ? 14 : Math.max(0, 8 - siteMentions))
      ));
      return { keyword, volume, competition: metric?.competition ?? null, cpc: metric?.cpc ?? null, siteMentions, competitorMentions, serpCompetitors, score, source: metric ? 'dataforseo' : 'heuristic' };
    }).sort((a, b) => b.score - a.score || (b.volume || 0) - (a.volume || 0));

    return json({
      generatedAt: new Date().toISOString(),
      site: { articles: articleQuery.data?.length || 0, revisions: revisions.data?.length || 0, coveredTerms: siteTerms.size },
      competitors: competitorAudits.map(({ text: _text, ...audit }) => audit),
      providers: {
        serp: Deno.env.get('BRAVE_SEARCH_API_KEY') ? 'Brave Search API' : 'Mode heuristique (clé Brave absente)',
        volume: Deno.env.get('DATAFORSEO_LOGIN') && Deno.env.get('DATAFORSEO_PASSWORD') ? (volumeError || 'DataForSEO') : 'Non configuré — scores estimés',
      },
      keywords: rows.slice(0, 75),
      ideas: contentIdeas(rows),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erreur d’analyse SEO';
    const status = /Authentification|Session/.test(message) ? 401 : /Accès/.test(message) ? 403 : 400;
    return json({ error: message }, status);
  }
});

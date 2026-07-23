import type { APIRoute } from 'astro';
import { allPublishedForFeeds, absoluteUrl, type PublicBlogArticle } from '../lib/blog.ts';

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function lastmodTag(value: string | null): string {
  if (!value) return '';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? `<lastmod>${new Date(timestamp).toISOString()}</lastmod>` : '';
}

export interface SitemapEntry {
  loc: string;
  lastmod: string | null;
}

function newestDate(current: string | null, candidate: string): string {
  return !current || Date.parse(candidate) > Date.parse(current) ? candidate : current;
}

export function buildSitemapEntries(articles: PublicBlogArticle[]): SitemapEntry[] {
  const latestArticleUpdate = articles.reduce<string | null>(
    (latest, article) => newestDate(latest, article.updated_at),
    null,
  );
  const entries: SitemapEntry[] = [
    { loc: absoluteUrl('/'), lastmod: null },
    { loc: absoluteUrl('/diagnostic'), lastmod: null },
    { loc: absoluteUrl('/blog'), lastmod: latestArticleUpdate },
  ];
  const categories = new Map<string, string>();
  const authors = new Map<string, string>();

  for (const article of articles) {
    entries.push({
      loc: absoluteUrl(`/blog/${encodeURIComponent(article.slug)}`),
      lastmod: article.updated_at,
    });
    authors.set(
      article.author_slug,
      newestDate(authors.get(article.author_slug) || null, article.updated_at),
    );
    for (const topic of article.topics || []) {
      categories.set(
        topic.slug,
        newestDate(categories.get(topic.slug) || null, article.updated_at),
      );
    }
  }

  for (const [slug, lastmod] of [...categories].sort(([a], [b]) => a.localeCompare(b))) {
    entries.push({ loc: absoluteUrl(`/blog/categorie/${encodeURIComponent(slug)}`), lastmod });
  }
  for (const [slug, lastmod] of [...authors].sort(([a], [b]) => a.localeCompare(b))) {
    entries.push({ loc: absoluteUrl(`/blog/auteur/${encodeURIComponent(slug)}`), lastmod });
  }

  return entries;
}

export function renderSitemap(urls: SitemapEntry[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((entry) => `  <url><loc>${xml(entry.loc)}</loc>${lastmodTag(entry.lastmod)}</url>`).join('\n')}\n</urlset>`;
}

export const GET: APIRoute = async () => {
  let articles: PublicBlogArticle[] = [];
  try {
    articles = await allPublishedForFeeds();
  } catch (error) {
    // A temporary CMS outage must not make the entire sitemap unavailable to crawlers.
    console.error('sitemap_articles_load_failed', error);
  }
  const body = renderSitemap(buildSitemapEntries(articles));
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400' } });
};

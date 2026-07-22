import type { APIRoute } from 'astro';
import { allPublishedForFeeds, absoluteUrl } from '../lib/blog.ts';

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const GET: APIRoute = async () => {
  const articles = await allPublishedForFeeds();
  const fixed = [
    { loc: absoluteUrl('/'), lastmod: null },
    { loc: absoluteUrl('/blog'), lastmod: articles[0]?.updated_at || null },
  ];
  const urls = [...fixed, ...articles.map((article) => ({ loc: absoluteUrl(`/blog/${article.slug}`), lastmod: article.updated_at }))];
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((entry) => `  <url><loc>${xml(entry.loc)}</loc>${entry.lastmod ? `<lastmod>${xml(new Date(entry.lastmod).toISOString())}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400' } });
};

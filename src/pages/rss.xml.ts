import type { APIRoute } from 'astro';
import { allPublishedForFeeds, absoluteUrl } from '../lib/blog.ts';
import { documentToHtml, escapeHtml } from '../../supabase/functions/_shared/blog/document.ts';

function cdata(value: string): string { return value.replace(/\]\]>/g, ']]]]><![CDATA[>'); }

export const GET: APIRoute = async () => {
  const articles = (await allPublishedForFeeds()).slice(0, 30);
  const items = articles.map((article) => `<item>
    <title>${escapeHtml(article.title)}</title>
    <link>${absoluteUrl(`/blog/${article.slug}`)}</link>
    <guid isPermaLink="true">${absoluteUrl(`/blog/${article.slug}`)}</guid>
    <pubDate>${new Date(article.published_at).toUTCString()}</pubDate>
    <description>${escapeHtml(article.excerpt)}</description>
    <content:encoded><![CDATA[${cdata(documentToHtml(article.document))}]]></content:encoded>
  </item>`).join('\n');
  const body = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>
    <title>Guides Contestation.ch</title><link>${absoluteUrl('/blog')}</link>
    <description>Guides pratiques pour comprendre et contester un loyer en Suisse.</description>
    <language>fr-CH</language><lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
  </channel></rss>`;
  return new Response(body, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400' } });
};

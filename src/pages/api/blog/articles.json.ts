import type { APIRoute } from 'astro';
import { listPublishedArticles } from '../../../lib/blog.ts';

export const GET: APIRoute = async ({ url }) => {
  const page = Math.max(0, Number(url.searchParams.get('page')) || 0);
  const pageSize = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const result = await listPublishedArticles({ page, pageSize });
  return new Response(JSON.stringify({
    articles: result.articles.map(({ document: _document, plain_text: _plainText, ...article }) => article),
    count: result.count, page, pageSize,
  }), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=120' } });
};

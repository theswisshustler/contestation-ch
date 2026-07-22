import legacyHtml from '../../web/index.html?raw';

export const prerender = false;

export function GET(): Response {
  return new Response(legacyHtml, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
    },
  });
}

import type { APIRoute } from 'astro';

export const GET: APIRoute = () => new Response(
  'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /blog/apercu\nDisallow: /diagnostic\nSitemap: https://contestation.ch/sitemap.xml\n',
  { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } },
);

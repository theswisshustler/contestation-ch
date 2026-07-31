import type { APIRoute } from 'astro';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../../../lib/blog.ts';

export const prerender = false;

const ALLOWED = new Set([
  'evaluate', 'evaluate-baisse', 'extract-bail', 'extract-hausse',
  'generate-letter', 'sign-letter', 'create-checkout', 'download-letter',
]);

const response = (error: string, status: number) => new Response(JSON.stringify({ error }), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
});

export const POST: APIRoute = async ({ params, request }) => {
  if (!import.meta.env.DEV) return response('Not found', 404);
  const name = params.function || '';
  if (!ALLOWED.has(name)) return response('Fonction non autorisée', 404);
  const body = await request.text();
  if (body.length > 30_000_000) return response('Requête trop volumineuse', 413);
  try {
    const upstream = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return response('Service Supabase inaccessible', 502);
  }
};

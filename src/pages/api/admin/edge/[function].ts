import type { APIRoute } from 'astro';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../../../../lib/blog.ts';

export const prerender = false;

const ALLOWED_FUNCTIONS = new Set(['blog-admin', 'blog-ingest', 'seo-analyzer']);

function json(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

export const POST: APIRoute = async ({ params, request }) => {
  if (!import.meta.env.DEV) return json('Not found', 404);

  const functionName = params.function || '';
  if (!ALLOWED_FUNCTIONS.has(functionName)) return json('Fonction non autorisée', 404);

  const authorization = request.headers.get('authorization') || '';
  if (!/^Bearer\s+\S+$/i.test(authorization)) return json('Session administrateur requise', 401);

  const body = await request.text();
  if (body.length > 1_000_000) return json('Requête trop volumineuse', 413);

  try {
    const upstream = await fetch(`${SUPABASE_URL}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        apikey: SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body,
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      },
    });
  } catch {
    return json('Service administrateur Supabase inaccessible', 502);
  }
};

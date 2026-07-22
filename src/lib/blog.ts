import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { BlogDocumentV1 } from '../../supabase/functions/_shared/blog/document.ts';

export const SUPABASE_URL = import.meta.env.PUBLIC_SUPABASE_URL || 'https://xdyesbnjspixogzhnxrm.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_nxDs_m7JYXHjbvNbHmJZpA_0szaiTay';

export interface BlogTopic { name: string; slug: string }

export interface BlogAuthor {
  id: string;
  kind: 'person' | 'organization';
  name: string;
  slug: string;
  bio: string | null;
  url: string | null;
  same_as: string[];
}

export interface PublicBlogArticle {
  id: string;
  slug: string;
  locale: string;
  first_published_at: string;
  published_at: string;
  updated_at: string;
  revision_id: string;
  title: string;
  excerpt: string;
  seo_title: string;
  seo_description: string;
  document: BlogDocumentV1;
  plain_text: string;
  content_hash: string;
  reviewed_at: string | null;
  next_review_at: string | null;
  sources: Array<{ label: string; url: string }>;
  metadata: Record<string, unknown>;
  author_name: string;
  author_slug: string;
  author_kind: 'person' | 'organization';
  reviewer_name: string | null;
  featured_image: string | null;
  topics: BlogTopic[];
  preview?: boolean;
}

export interface ArticleSummary {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  published_at: string;
  featured_image: string | null;
}

let client: SupabaseClient | null = null;
export function publicSupabase(): SupabaseClient {
  if (!client) client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export async function listPublishedArticles(options: { page?: number; pageSize?: number; topic?: string; author?: string } = {}): Promise<{ articles: PublicBlogArticle[]; count: number }> {
  const page = Math.max(0, options.page || 0);
  const pageSize = Math.min(100, Math.max(1, options.pageSize || 12));
  let query = publicSupabase().from('blog_public_articles').select('*', { count: 'exact' }).order('published_at', { ascending: false });
  if (options.topic) query = query.contains('topics', [{ slug: options.topic }]);
  if (options.author) query = query.eq('author_slug', options.author);
  const result = await query.range(page * pageSize, (page + 1) * pageSize - 1);
  if (result.error) throw result.error;
  return { articles: (result.data || []) as unknown as PublicBlogArticle[], count: result.count || 0 };
}

export async function getPublicAuthor(slug: string): Promise<BlogAuthor | null> {
  const result = await publicSupabase().from('blog_authors')
    .select('id,kind,name,slug,bio,url,same_as').eq('slug', slug).eq('active', true).maybeSingle();
  if (result.error) throw result.error;
  return result.data as BlogAuthor | null;
}

export async function getPublishedArticle(slug: string): Promise<PublicBlogArticle | null> {
  const result = await publicSupabase().from('blog_public_articles').select('*').eq('slug', slug).maybeSingle();
  if (result.error) throw result.error;
  return result.data as unknown as PublicBlogArticle | null;
}

export async function getRelatedArticles(articleId: string, limit = 3): Promise<ArticleSummary[]> {
  const result = await publicSupabase().rpc('get_related_blog_articles', { target_article: articleId, max_results: limit });
  if (result.error) throw result.error;
  return (result.data || []) as ArticleSummary[];
}

export async function resolveOldSlug(slug: string): Promise<string | null> {
  const history = await publicSupabase().from('blog_slug_history').select('article_id').eq('slug', slug).maybeSingle();
  if (history.error || !history.data) return null;
  const article = await publicSupabase().from('blog_public_articles').select('slug').eq('id', history.data.article_id).maybeSingle();
  return article.data?.slug || null;
}

export async function isGoneSlug(slug: string): Promise<boolean> {
  const result = await publicSupabase().from('blog_tombstones').select('slug').eq('slug', slug).maybeSingle();
  return !!result.data;
}

export async function getPreviewArticle(token: string): Promise<PublicBlogArticle | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const response = await fetch(`${SUPABASE_URL}/functions/v1/blog-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  return payload.article as PublicBlogArticle;
}

export async function allPublishedForFeeds(): Promise<PublicBlogArticle[]> {
  const output: PublicBlogArticle[] = [];
  for (let page = 0; page < 100; page++) {
    const result = await listPublishedArticles({ page, pageSize: 100 });
    output.push(...result.articles);
    if (output.length >= result.count || result.articles.length < 100) break;
  }
  return output;
}

export function absoluteUrl(path: string): string {
  return new URL(path, 'https://contestation.ch').toString();
}

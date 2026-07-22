import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { adminClient } from '../supabase.ts';
import { sha256Hex } from './document.ts';

export type BlogRole = 'editor' | 'publisher' | 'owner';

export interface BlogActor {
  userId: string | null;
  apiKeyId: string | null;
  role: BlogRole | null;
  scopes: string[];
  db: SupabaseClient;
}

function bearer(req: Request): string {
  return (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
}

export async function requireBlogAdmin(req: Request, roles: BlogRole[] = ['editor', 'publisher', 'owner']): Promise<BlogActor> {
  const token = bearer(req);
  if (!token || token.startsWith('cc_blog_')) throw new Error('Authentification administrateur requise');
  const db = adminClient();
  const { data: userData, error: userError } = await db.auth.getUser(token);
  if (userError || !userData.user) throw new Error('Session administrateur invalide');
  const { data: member } = await db.from('blog_admins').select('role').eq('user_id', userData.user.id).maybeSingle();
  if (!member || !roles.includes(member.role as BlogRole)) throw new Error('Accès administrateur refusé');
  return { userId: userData.user.id, apiKeyId: null, role: member.role as BlogRole, scopes: ['articles:import', 'articles:write', 'articles:publish'], db };
}

export async function authenticateBlogIngestion(req: Request): Promise<BlogActor> {
  const token = bearer(req);
  if (!token) throw new Error('Authorization Bearer requise');
  if (!token.startsWith('cc_blog_')) return requireBlogAdmin(req);

  const db = adminClient();
  const keyHash = await sha256Hex(token);
  const { data: key, error } = await db
    .from('blog_api_keys')
    .select('id, scopes, active, expires_at')
    .eq('key_hash', keyHash)
    .maybeSingle();
  if (error || !key || !key.active || (key.expires_at && new Date(key.expires_at) <= new Date())) {
    throw new Error('Clé API invalide ou expirée');
  }
  await db.from('blog_api_keys').update({ last_used_at: new Date().toISOString() }).eq('id', key.id);
  return { userId: null, apiKeyId: key.id, role: null, scopes: key.scopes || [], db };
}

export function requireScope(actor: BlogActor, scope: string): void {
  if (!actor.scopes.includes(scope)) throw new Error(`Permission API manquante: ${scope}`);
}

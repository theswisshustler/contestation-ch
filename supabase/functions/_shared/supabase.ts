import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';

/**
 * Client service_role : contourne RLS. À n'utiliser QUE côté serveur (Edge
 * Functions), jamais exposé au client. C'est ce client qui manipule les
 * dossiers anonymes, le bucket privé `letters-clean`, etc.
 */
export function adminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY manquants');
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Notifie l'exploitant + trace le dossier pour traitement manuel. */
export async function flagManualReview(
  db: SupabaseClient,
  dossierId: string | null,
  reason: string,
  detail?: unknown,
): Promise<void> {
  await db.from('manual_reviews').insert({
    dossier_id: dossierId,
    reason,
    detail: detail ?? null,
  });
  await notifyOperator(`⚠ Traitement manuel requis: ${reason}`, { dossierId, detail });
}

/** Notification exploitant (Slack webhook si configuré, sinon log). */
export async function notifyOperator(text: string, meta?: unknown): Promise<void> {
  const hook = Deno.env.get('OPERATOR_SLACK_WEBHOOK');
  if (!hook) {
    console.warn('operator_notify (no webhook):', text, meta);
    return;
  }
  try {
    await fetch(hook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${text}\n\`\`\`${JSON.stringify(meta ?? {})}\`\`\`` }),
    });
  } catch (e) {
    console.error('operator_notify failed', e);
  }
}

// POST /purge  (déclenché par un cron — pg_cron / scheduler externe)
// Rétention nLPD : supprime toutes les données expirées (created_at + 7j),
// DB ET storage. Protégé par un secret partagé (PURGE_SECRET) car public.
//
// Ordre : d'abord les objets storage (via les chemins encore en DB), puis les
// lignes DB (les cascades nettoient documents/letters/payments/mailings).

import { adminClient } from '../_shared/supabase.ts';
import { json, serverError } from '../_shared/http.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST attendu' }, 405);

  const expected = Deno.env.get('PURGE_SECRET');
  const provided = req.headers.get('x-purge-secret');
  if (!expected || provided !== expected) return json({ error: 'Non autorisé' }, 401);

  const db = adminClient();
  const nowIso = new Date().toISOString();
  const removed = { uploads: 0, previews: 0, clean: 0, dossiers: 0, blogPreviewTokens: 0 };

  try {
    // 1) Documents importés (bucket uploads).
    const { data: docs } = await db
      .from('documents')
      .select('storage_path')
      .lt('expires_at', nowIso);
    if (docs?.length) {
      await db.storage.from('uploads').remove(docs.map((d) => d.storage_path));
      removed.uploads = docs.length;
    }

    // 2) Lettres : previews + PDF propres.
    const { data: letters } = await db
      .from('letters')
      .select('preview_paths, clean_pdf_path')
      .lt('expires_at', nowIso);
    if (letters?.length) {
      const previews = letters.flatMap((l) => l.preview_paths ?? []);
      const cleans = letters.map((l) => l.clean_pdf_path).filter(Boolean) as string[];
      if (previews.length) await db.storage.from('previews').remove(previews);
      if (cleans.length) await db.storage.from('letters-clean').remove(cleans);
      removed.previews = previews.length;
      removed.clean = cleans.length;
    }

    // 3) Lignes DB. Supprimer les dossiers cascade documents/letters/payments/
    //    mailings. Les leads (email marketing) ne sont pas liés à un dossier et
    //    ne sont pas purgés ici (pas de données sensibles / documents).
    const { data: delDossiers } = await db
      .from('dossiers')
      .delete()
      .lt('expires_at', nowIso)
      .select('id');
    removed.dossiers = delDossiers?.length ?? 0;

    // Filet de sécurité : lignes orphelines (dossier déjà nul) expirées.
    await db.from('documents').delete().lt('expires_at', nowIso);
    await db.from('letters').delete().lt('expires_at', nowIso);
    await db.from('payments').delete().lt('expires_at', nowIso);
    await db.from('mailings').delete().lt('expires_at', nowIso);

    // Les articles et leurs révisions sont durables. Seuls les jetons d'aperçu
    // temporaires du blog sont concernés par le nettoyage quotidien.
    const { data: deletedPreviewTokens } = await db
      .from('blog_preview_tokens')
      .delete()
      .lt('expires_at', nowIso)
      .select('token_hash');
    removed.blogPreviewTokens = deletedPreviewTokens?.length ?? 0;

    return json({ ok: true, removed });
  } catch (e) {
    return serverError('Purge échouée', e);
  }
});

-- ============================================================================
-- Ménage automatique des données (rétention nLPD 7 jours).
-- Un « réveil » quotidien appelle la Edge Function `purge` toute seule.
--
-- Deux extensions Supabase :
--   pg_cron  → le réveil / minuteur (planifie des tâches à heure fixe)
--   pg_net   → permet à la base d'appeler une URL (ici, notre fonction purge)
--
-- L'URL du projet et le secret de purge ne sont PAS écrits en dur ici : on les
-- range dans le coffre-fort intégré de Supabase (Vault), et le cron va les y
-- lire au moment de s'exécuter.
-- ============================================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ── À FAIRE UNE SEULE FOIS avant que le ménage fonctionne ───────────────────
-- Ranger dans le coffre-fort (Vault) :
--   1) l'adresse de ton projet Supabase, et
--   2) le même PURGE_SECRET que celui donné aux Edge Functions.
--
-- À exécuter une fois (remplace les deux valeurs entre guillemets) :
--
--   select vault.create_secret(
--     'https://TON-PROJET.supabase.co', 'project_url');
--   select vault.create_secret(
--     'TON_PURGE_SECRET', 'purge_secret');
--
-- (Si tu relances ça plus tard, utilise vault.update_secret au lieu de create.)
-- ────────────────────────────────────────────────────────────────────────────

-- Planifie le ménage tous les jours à 03:15 (heure du serveur).
-- Si une tâche du même nom existe déjà, on la remplace proprement.
select cron.unschedule('purge-donnees-7j')
where exists (select 1 from cron.job where jobname = 'purge-donnees-7j');

select cron.schedule(
  'purge-donnees-7j',
  '15 3 * * *',            -- format cron : « à 3h15, tous les jours »
  $$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets
              where name = 'project_url') || '/functions/v1/purge',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-purge-secret', (select decrypted_secret from vault.decrypted_secrets
                           where name = 'purge_secret')
      ),
      body := '{}'::jsonb
    );
  $$
);

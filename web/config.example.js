/*
 * Configuration runtime du front-end — À COPIER en `web/config.js` puis remplir.
 *
 *   cp web/config.example.js web/config.js
 *
 * `web/config.js` est gitignoré (il contient l'URL et la clé publique du projet).
 * La clé anon Supabase est PUBLIQUE par conception (protégée par les RLS et par
 * le fait que les Edge Functions recalculent tout côté serveur) — ne jamais
 * mettre ici la `service_role`.
 */
window.CONTESTATION_CONFIG = {
  // Ex. https://abcdefgh.supabase.co
  SUPABASE_URL: '',
  // Clé « anon / public » du projet (Settings → API).
  SUPABASE_ANON_KEY: '',
};

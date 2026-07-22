/*
 * Configuration publique de production.
 *
 * La clé publishable Supabase est conçue pour être exposée au navigateur.
 * Les droits restent protégés par les policies et les Edge Functions. Sur un
 * environnement local, web/config.js peut toujours surcharger cette valeur
 * afin d'utiliser un mock ou un autre projet de développement.
 */
(function () {
  var localHosts = ['localhost', '127.0.0.1', '::1'];
  var isLocal = localHosts.indexOf(window.location.hostname) !== -1;

  if (!isLocal || !window.CONTESTATION_CONFIG) {
    window.CONTESTATION_CONFIG = {
      SUPABASE_URL: 'https://xdyesbnjspixogzhnxrm.supabase.co',
      SUPABASE_ANON_KEY: 'sb_publishable_nxDs_m7JYXHjbvNbHmJZpA_0szaiTay',
    };
  }
})();

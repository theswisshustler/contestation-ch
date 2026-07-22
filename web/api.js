/*
 * api.js — client des Edge Functions Supabase.
 *
 * Toutes les fonctions renvoient une Promise résolue avec le JSON de la réponse,
 * ou rejetée avec une Error dont `.status` et `.data` sont renseignés. Le back-end
 * est la source de vérité (il recalcule le ruleset, gère le verrou de paiement…) :
 * le front ne fait qu'appeler et afficher.
 */
(function () {
  'use strict';

  function config() {
    var c = window.CONTESTATION_CONFIG;
    if (!c || !c.SUPABASE_URL || !c.SUPABASE_ANON_KEY) {
      var e = new Error(
        'Configuration Supabase manquante. Copiez web/config.example.js en ' +
        'web/config.js puis renseignez SUPABASE_URL et SUPABASE_ANON_KEY.'
      );
      e.status = 0;
      throw e;
    }
    return c;
  }

  function base() { return config().SUPABASE_URL.replace(/\/+$/, ''); }

  async function call(fn, body, options) {
    var c = config();
    var res;
    var timeoutMs = options && options.timeoutMs ? options.timeoutMs : 45_000;
    var controller = new AbortController();
    var timedOut = false;
    var timeout = setTimeout(function () {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      res = await fetch(base() + '/functions/v1/' + fn, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'apikey': c.SUPABASE_ANON_KEY,
          'authorization': 'Bearer ' + c.SUPABASE_ANON_KEY,
        },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      });
    } catch (networkErr) {
      var ne = new Error(timedOut
        ? 'Le traitement prend plus de temps que prévu. Réessayez : votre dossier a été conservé.'
        : 'Réseau indisponible. Réessayez.');
      ne.status = 0;
      ne.code = timedOut ? 'timeout' : 'network';
      ne.cause = networkErr;
      throw ne;
    } finally {
      clearTimeout(timeout);
    }

    var data = null;
    try { data = await res.json(); } catch (_) { /* réponse non-JSON */ }

    if (!res.ok) {
      var err = new Error((data && data.error) || ('Erreur ' + res.status));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data || {};
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Uniquement pour la génération, désormais idempotente côté serveur. Une
  // réponse peut être coupée par l'infrastructure alors que la lettre a bien
  // été créée ; le second appel récupère alors cette même lettre.
  async function generateLetterWithRecovery(dossierId) {
    try {
      return await call('generate-letter', { dossierId: dossierId }, { timeoutMs: 120_000 });
    } catch (error) {
      if (!error || error.status !== 0) throw error;
      await wait(2_500);
      return call('generate-letter', { dossierId: dossierId }, { timeoutMs: 120_000 });
    }
  }

  window.API = {
    /** { tauxReferenceBail, loyerNetMensuel, email?, canton? } -> { result } */
    evaluateBaisse: function (b) { return call('evaluate-baisse', b); },
    /** { bailB64, formuleB64? } -> { extracted } */
    extractBail: function (b) { return call('extract-bail', b, { timeoutMs: 120_000 }); },
    /** DossierContestation -> { dossierId, evaluation } */
    evaluate: function (dossier) { return call('evaluate', { dossier: dossier }); },
    /** dossierId -> { letterId, previews: [url] } */
    generateLetter: function (dossierId) { return generateLetterWithRecovery(dossierId); },
    /** Régénère le PDF privé avec la signature avant le recommandé. */
    signLetter: function (b) { return call('sign-letter', b, { timeoutMs: 120_000 }); },
    /** { dossierId, letterId, offer } -> { url, sessionId } */
    createCheckout: function (b) { return call('create-checkout', b); },
    /** letterId -> { url } | 402 */
    downloadLetter: function (letterId) { return call('download-letter', { letterId: letterId }); },
    isConfigured: function () {
      var c = window.CONTESTATION_CONFIG;
      return !!(c && c.SUPABASE_URL && c.SUPABASE_ANON_KEY);
    },
  };
})();

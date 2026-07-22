/*
 * Persistance locale du parcours locataire.
 *
 * - Les champs et l'état de navigation restent dans localStorage.
 * - Les PDF, trop volumineux pour localStorage, restent dans IndexedDB.
 * - Aucun détail de présentation n'est enregistré : seulement les données
 *   nécessaires pour reprendre la demande sur ce navigateur.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'cc_draft_v1';
  var VERSION = 1;
  var DB_NAME = 'contestation-ch-drafts';
  var DB_VERSION = 1;
  var FILE_STORE = 'files';

  function storage() {
    try { return window.localStorage; } catch (_) { return null; }
  }

  function load() {
    var target = storage();
    if (!target) return null;
    try {
      var parsed = JSON.parse(target.getItem(STORAGE_KEY) || 'null');
      if (!parsed || parsed.version !== VERSION || !parsed.state || typeof parsed.state !== 'object') {
        return null;
      }
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function save(state, completed) {
    var target = storage();
    if (!target) return false;
    try {
      target.setItem(STORAGE_KEY, JSON.stringify({
        version: VERSION,
        updatedAt: new Date().toISOString(),
        completed: !!completed,
        state: state,
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearState() {
    var target = storage();
    if (!target) return;
    try { target.removeItem(STORAGE_KEY); } catch (_) { /* stockage indisponible */ }
  }

  function openFilesDb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('IndexedDB indisponible')); return; }
      var request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(FILE_STORE)) {
          request.result.createObjectStore(FILE_STORE);
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('Ouverture IndexedDB impossible')); };
    });
  }

  async function withStore(mode, action) {
    var db = await openFilesDb();
    try {
      return await new Promise(function (resolve, reject) {
        var transaction = db.transaction(FILE_STORE, mode);
        var store = transaction.objectStore(FILE_STORE);
        var request = action(store);
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error || new Error('Écriture IndexedDB impossible')); };
        transaction.onabort = function () { reject(transaction.error || new Error('Transaction IndexedDB annulée')); };
      });
    } finally {
      db.close();
    }
  }

  function saveFile(kind, file) {
    if (kind !== 'bail' && kind !== 'formule') return Promise.reject(new Error('Type de document invalide'));
    return withStore('readwrite', function (store) {
      return store.put({
        name: file.name || (kind + '.pdf'),
        type: file.type || 'application/pdf',
        lastModified: file.lastModified || Date.now(),
        blob: file,
      }, kind);
    });
  }

  async function loadFiles() {
    try {
      var entries = await Promise.all(['bail', 'formule'].map(async function (kind) {
        var value = await withStore('readonly', function (store) { return store.get(kind); });
        return [kind, value || null];
      }));
      return Object.fromEntries(entries);
    } catch (_) {
      return { bail: null, formule: null };
    }
  }

  async function clearFiles() {
    try {
      await withStore('readwrite', function (store) { return store.clear(); });
    } catch (_) { /* IndexedDB facultatif */ }
  }

  window.ContestationDraftStore = {
    load: load,
    save: save,
    clearState: clearState,
    saveFile: saveFile,
    loadFiles: loadFiles,
    clearFiles: clearFiles,
  };
})();

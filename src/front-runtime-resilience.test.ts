import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

function draftStoreHarness(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const windowObject: Record<string, unknown> = { localStorage, indexedDB: null };
  vm.runInNewContext(readFileSync('web/draft-store.js', 'utf8'), {
    window: windowObject,
    console,
    Promise,
    Date,
    Error,
    Object,
    JSON,
  });
  return {
    store: windowObject.ContestationDraftStore as {
      load(): { state: Record<string, unknown>; completed: boolean } | null;
      save(state: Record<string, unknown>, completed: boolean): boolean;
      clearState(): void;
    },
    values,
  };
}

describe('moteur de rendu stable', () => {
  const runtime = readFileSync('web/support.js', 'utf8');
  const app = readFileSync('web/app.js', 'utf8');
  const api = readFileSync('web/api.js', 'utf8');
  const html = readFileSync('web/index.html', 'utf8');

  it('réconcilie le DOM sans reconstruction globale', () => {
    expect(runtime).toContain('patchChildren(this.mount, fragment)');
    expect(runtime).not.toContain('this.mount.replaceChildren');
    expect(runtime).not.toContain('_isTouching');
  });

  it('conserve les nœuds de champ et synchronise les anciens onChange à la saisie', () => {
    expect(runtime).toContain("return 'field:' + node.dataset.k");
    expect(runtime).toContain("if (type === 'change') bindEvent(element, 'input', fn)");
    expect(runtime).toContain("current.localName === 'details'");
  });

  it('ne dépend plus de mutations directes pour les données utilisateur', () => {
    expect(app).not.toContain('this.state.data.dateCles = value');
    expect(app).not.toContain('this.state.data.formule = valeur');
    expect(app).not.toContain('this.state.data.signatureData = signatureDataUrl');
  });

  it('bloque les doubles soumissions et borne les appels réseau', () => {
    expect(app).toContain('if (this.state.busy) return');
    expect(app).toContain('if (this.state.payLoading) return');
    expect(app).toContain('if (this._navigationLocked) return');
    expect(api).toContain('var controller = new AbortController()');
    expect(api).toContain("ne.code = timedOut ? 'timeout' : 'network'");
  });

  it('invalide le cache des scripts liés au moteur de rendu', () => {
    expect(html).toContain('draft-store.js?v=20260722.1');
    expect(html).toContain('support.js?v=20260722.1');
    expect(html).toContain('app.js?v=20260722.1');
  });
});

describe('brouillon local du parcours', () => {
  it('enregistre et recharge les champs structurés', () => {
    const { store } = draftStoreHarness();
    expect(store.save({ screen: 'manuel', step: 3, data: { locNom: 'Rivière' } }, false)).toBe(true);
    expect(store.load()).toMatchObject({
      completed: false,
      state: { screen: 'manuel', step: 3, data: { locNom: 'Rivière' } },
    });
  });

  it('ignore un stockage corrompu sans casser le démarrage', () => {
    const { store } = draftStoreHarness({ cc_draft_v1: '{invalide' });
    expect(store.load()).toBeNull();
  });

  it('peut supprimer explicitement le brouillon', () => {
    const { store, values } = draftStoreHarness();
    store.save({ screen: 'choix' }, false);
    store.clearState();
    expect(values.has('cc_draft_v1')).toBe(false);
  });
});

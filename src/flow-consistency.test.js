import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('parcours de demande de baisse', () => {
  const app = readFileSync('web/app.js', 'utf8');
  const html = readFileSync('web/index.html', 'utf8');

  it('commence par le simulateur et non par le formulaire complet', () => {
    expect(app).toContain("kind === 'demande_baisse'");
    expect(app).toContain("screen: 'baisseSim'");
    expect(html).toContain('data-screen-label="simulateur-baisse"');
  });

  it('calcule la baisse côté serveur avant de permettre la préparation', () => {
    expect(app).toContain('await API.evaluateBaisse');
    expect(app).toContain("if (!this.state.baisseSimRes?.eligible) return");
    expect(html).toContain('Préparer ma demande de baisse →');
  });

  it('réutilise le loyer et le taux simulés dans le formulaire suivant', () => {
    expect(html).toContain('{{ baisseSummaryLoyer }} CHF');
    expect(html).toContain('{{ baisseSummaryTaux }} %');
    expect(html).toContain('{{ baisseSimChf }} CHF/mois');
  });
});

describe('validation de la formule officielle importée', () => {
  const app = readFileSync('web/app.js', 'utf8');
  const html = readFileSync('web/index.html', 'utf8');

  it('distingue une formule détectée d’une simple réponse utilisateur', () => {
    expect(app).toContain('extractionFormuleDetected: formuleDetectee');
    expect(app).toContain("x.formuleOfficielleSource");
    expect(html).toContain('FORMULE DÉTECTÉE');
    expect(html).toContain('{{ importFormuleDetectedText }}');
  });

  it('ne repose la question que si aucune formule n’a été identifiée', () => {
    expect(html).toContain('{{ importFormuleNeedsConfirmation }}');
    expect(html).toContain("Nous ne l'avons pas trouvée dans les PDF importés");
    expect(html).not.toContain('DOCUMENT IDENTIFIÉ');
  });

  it('utilise des boutons non-submit avec un état sélectionné visible', () => {
    expect(html).toContain('type="button" aria-pressed="{{ importFormuleOui }}"');
    expect(html).toContain('style="{{ importFormuleOuiStyle }}"');
    expect(app).toContain("setImportFormule('non')");
  });
});

describe('configuration du back-end de production', () => {
  const html = readFileSync('web/index.html', 'utf8');
  const runtimeConfig = readFileSync('web/runtime-config.js', 'utf8');

  it('charge la configuration versionnée après une éventuelle surcharge locale', () => {
    expect(html.indexOf('./runtime-config.js')).toBeGreaterThan(html.indexOf('./config.js'));
    expect(runtimeConfig).toContain('if (!isLocal || !window.CONTESTATION_CONFIG)');
  });

  it('pointe la production vers le projet où les fonctions sont déployées', () => {
    expect(runtimeConfig).toContain('xdyesbnjspixogzhnxrm.supabase.co');
    expect(runtimeConfig).not.toContain('ecxauhrwylsbznvrlmlm');
  });
});

describe('accompagnement pendant la génération de la lettre', () => {
  const app = readFileSync('web/app.js', 'utf8');
  const html = readFileSync('web/index.html', 'utf8');

  it('affiche une progression dédiée plutôt que le loader générique', () => {
    expect(app).toContain("busyKind: 'letter'");
    expect(html).toContain('{{ letterGenerating }}');
    expect(html).toContain('Votre lettre prend forme');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('{{ genericBusy }}');
  });

  it('explique les étapes et demande de garder la page ouverte', () => {
    expect(html).toContain('Structure');
    expect(html).toContain('Personnalisation');
    expect(html).toContain('Mise en page');
    expect(html).toContain('Aperçu sécurisé');
    expect(html).toContain('Gardez cette page ouverte.');
  });

  it('protège la navigation pendant le traitement puis nettoie les listeners', () => {
    expect(app).toContain("window.addEventListener('beforeunload', this._letterBeforeUnload)");
    expect(app).toContain("window.removeEventListener('beforeunload', this._letterBeforeUnload)");
    expect(app).toContain('this.stopLetterGeneration();');
  });
});

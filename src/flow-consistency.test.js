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

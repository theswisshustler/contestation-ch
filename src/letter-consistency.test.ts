import { describe, expect, it } from 'vitest';
import {
  evaluateLoyerInitial,
  evaluateDossier,
  type DossierContestation,
} from './contestation-ruleset';
import { letterHtml, watermarkedHtml } from '../supabase/functions/_shared/letter-template';

function dossier(overrides: Partial<DossierContestation> = {}): DossierContestation {
  return {
    canton: 'VD',
    npa: '1004',
    commune: 'Lausanne',
    adresseImmeuble: 'Avenue de France 10',
    dateRemiseCles: '2026-07-01',
    loyerNetMensuel: 1900,
    chargesMensuelles: 180,
    formuleOfficielleRecue: 'oui',
    loyerPrecedentConnu: false,
    loyerPrecedentNet: null,
    tauxReferenceBail: 1.5,
    anneeConstruction: 1990,
    contraintePersonnelle: false,
    locataire: {
      nom: 'Martin', prenom: 'Léa', adresse: 'Avenue de France 10',
      npa: '1004', ville: 'Lausanne',
    },
    bailleur: {
      nom: 'Régie Test SA', adresse: 'Rue Centrale 1',
      npa: '1003', ville: 'Lausanne',
    },
    signatureDataUrl: null,
    ...overrides,
  };
}

const TODAY = new Date('2026-07-20T12:00:00Z');

describe('cohérence entre le ruleset et la lettre', () => {
  it('ne prétend pas que la formule manque lorsqu’elle a été reçue', () => {
    const d = dossier({ formuleOfficielleRecue: 'oui' });
    const result = evaluateLoyerInitial(d, TODAY);
    const html = letterHtml(d, result);

    expect(result.motifs.some((m) => m.code === 'formule_manquante')).toBe(false);
    expect(result.conclusions.join(' ')).not.toMatch(/nullité/i);
    expect(html).not.toMatch(/formule officielle de fixation du loyer initial manquante/i);
    expect(html).not.toMatch(/formule officielle non remise/i);
  });

  it('génère une contestation de hausse adressée à l’autorité', () => {
    const d = dossier({ kind: 'hausse_loyer', typeBail: 'ordinaire', dateNotificationHausse: '2026-07-10', loyerAvantHausse: 1900, loyerApresHausse: 1990, formuleHausseRecue: 'oui', motifHausse: 'multiple' });
    const result = evaluateDossier(d, TODAY);
    const html = letterHtml(d, result);
    expect(html).toMatch(/contestation de la hausse de loyer/i);
    expect(html).toContain('1990 CHF');
    expect(html).toContain('notification de hausse');
  });

  it('génère une demande de baisse adressée au bailleur', () => {
    const d = dossier({ kind: 'demande_baisse', typeBail: 'ordinaire', tauxReferenceBail: 1.75, loyerNetMensuel: 2000 });
    const result = evaluateDossier(d, TODAY);
    const html = letterHtml(d, result);
    expect(html).toMatch(/demande de baisse de loyer/i);
    expect(html).toContain('5.66 %');
    expect(html).toMatch(/dans les 30 jours/i);
    expect(html).toContain('Régie Test SA');
  });

  it('mentionne la formule manquante uniquement lorsque la réponse est non', () => {
    const d = dossier({ formuleOfficielleRecue: 'non', dateRemiseCles: '2025-01-01' });
    const result = evaluateLoyerInitial(d, TODAY);
    const html = letterHtml(d, result);

    expect(result.horsDelai).toBe(false);
    expect(result.motifs.some((m) => m.code === 'formule_manquante')).toBe(true);
    expect(html).toMatch(/formule officielle de fixation du loyer initial manquante/i);
    expect(html).toMatch(/formule officielle non remise/i);
  });

  it('conserve exactement les motifs calculés dans l’aperçu filigrané', () => {
    const d = dossier({
      formuleOfficielleRecue: 'oui',
      loyerPrecedentConnu: true,
      loyerPrecedentNet: 1500,
    });
    const result = evaluateLoyerInitial(d, TODAY);
    const html = watermarkedHtml(d, result);

    expect(result.motifs.some((m) => m.code === 'hausse_sensible')).toBe(true);
    for (const motif of result.motifs) expect(html).toContain(motif.libelle);
    expect(html).toContain('APERÇU');
    expect(html).not.toMatch(/formule officielle de fixation du loyer initial manquante/i);
  });
});

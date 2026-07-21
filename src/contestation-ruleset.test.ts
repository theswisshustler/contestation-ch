import { describe, it, expect } from 'vitest';
import {
  normalizeCommune,
  resolveAutorite,
  evaluateLoyerInitial,
  evaluateDemandeBaisse,
  fetchTauxReference,
  TAUX_REFERENCE,
  GE_AUTHORITY,
  VD_PREFECTURES,
  type DossierContestation,
  type Partie,
} from './contestation-ruleset';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const locataire: Partie = {
  nom: 'Dupont',
  prenom: 'Marie',
  adresse: 'Rue du Lac 1',
  npa: '1000',
  ville: 'Lausanne',
  email: 'marie@example.ch',
};

const bailleur: Partie = {
  nom: 'Régie Immo SA',
  adresse: 'Avenue de la Gare 5',
  npa: '1003',
  ville: 'Lausanne',
};

/** Dossier de base valide, éligible, dans le délai. Surchargeable par test. */
function makeDossier(over: Partial<DossierContestation> = {}): DossierContestation {
  return {
    canton: 'VD',
    npa: '1000',
    commune: 'Lausanne',
    adresseImmeuble: 'Rue du Lac 1',
    dateRemiseCles: '2026-07-01',
    loyerNetMensuel: 1800,
    chargesMensuelles: 150,
    formuleOfficielleRecue: 'oui',
    loyerPrecedentConnu: false,
    loyerPrecedentNet: null,
    tauxReferenceBail: null,
    anneeConstruction: null,
    contraintePersonnelle: false,
    locataire,
    bailleur,
    signatureDataUrl: null,
    ...over,
  };
}

// Date « aujourd'hui » fixe pour des tests déterministes.
const TODAY = new Date('2026-07-09T12:00:00Z');

// ─────────────────────────────────────────────────────────────────────────────
// normalizeCommune
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeCommune', () => {
  it('met en minuscules et retire les accents', () => {
    expect(normalizeCommune('Yverdon-les-Bains')).toBe('yverdon-les-bains');
    expect(normalizeCommune('Château-d’Oex'.replace('’', "'"))).toBe("chateau-d'oex");
    expect(normalizeCommune('MÉZIÈRES')).toBe('mezieres');
  });

  it('retire le suffixe " VD"', () => {
    expect(normalizeCommune('Roche VD')).toBe('roche');
  });

  it('compacte les espaces et trim', () => {
    expect(normalizeCommune('  La   Sarraz  ')).toBe('la sarraz');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveAutorite
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveAutorite', () => {
  it('GE : renvoie toujours la commission cantonale unique', () => {
    expect(resolveAutorite('GE', '1200', 'Genève')).toBe(GE_AUTHORITY);
    expect(resolveAutorite('GE', '1290', 'Versoix')).toBe(GE_AUTHORITY);
  });

  it('VD : renvoie la préfecture du district de la commune', () => {
    expect(resolveAutorite('VD', '1000', 'Lausanne')).toBe(VD_PREFECTURES.lausanne);
    expect(resolveAutorite('VD', '1110', 'Morges')).toBe(VD_PREFECTURES.morges);
    expect(resolveAutorite('VD', '1800', 'Vevey')).toBe(VD_PREFECTURES.riviera_pays_denhaut);
  });

  it('VD : tolère accents / casse / suffixe VD via normalizeCommune', () => {
    expect(resolveAutorite('VD', '1860', 'Roche VD')).toBe(VD_PREFECTURES.aigle);
    expect(resolveAutorite('VD', '1660', "Château-d'Oex")).toBe(VD_PREFECTURES.riviera_pays_denhaut);
    expect(resolveAutorite('VD', '1400', 'YVERDON-LES-BAINS')).toBe(VD_PREFECTURES.jura_nord_vaudois);
  });

  it('VD : commune absente du mapping → null (traitement manuel)', () => {
    expect(resolveAutorite('VD', '9999', 'Commune-Inexistante')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchTauxReference
// ─────────────────────────────────────────────────────────────────────────────

describe('fetchTauxReference', () => {
  it('renvoie la valeur versionnée', () => {
    expect(fetchTauxReference().value).toBe(TAUX_REFERENCE.value);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateLoyerInitial — compétence / autorité
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateLoyerInitial — autorité', () => {
  it('résout l’autorité pour une commune connue', () => {
    const r = evaluateLoyerInitial(makeDossier(), TODAY);
    expect(r.autorite).toBe(VD_PREFECTURES.lausanne);
    expect(r.requiertTraitementManuel).toBe(false);
  });

  it('commune VD inconnue → autorité null + traitement manuel + avertissement', () => {
    const r = evaluateLoyerInitial(
      makeDossier({ commune: 'Village-Perdu', npa: '9999' }),
      TODAY,
    );
    expect(r.autorite).toBeNull();
    expect(r.requiertTraitementManuel).toBe(true);
    expect(r.avertissements.join(' ')).toMatch(/traitement manuel/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateLoyerInitial — STEP 1 : formule manquante (motif tueur)
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateLoyerInitial — formule officielle manquante', () => {
  it('ajoute le motif tres_forte et court-circuite le délai (contestable en tout temps)', () => {
    const r = evaluateLoyerInitial(
      makeDossier({
        formuleOfficielleRecue: 'non',
        dateRemiseCles: '2020-01-01', // >30j : sans importance si formule manquante
      }),
      TODAY,
    );
    const motif = r.motifs.find((m) => m.code === 'formule_manquante');
    expect(motif).toBeDefined();
    expect(motif!.force).toBe('tres_forte');
    // Malgré > 30 jours, pas hors délai et toujours éligible.
    expect(r.horsDelai).toBe(false);
    expect(r.eligible).toBe(true);
    expect(r.avertissements.join(' ')).toMatch(/en tout temps/i);
  });

  it('classe formule_manquante en tête des motifs', () => {
    const r = evaluateLoyerInitial(
      makeDossier({
        formuleOfficielleRecue: 'non',
        loyerPrecedentConnu: true,
        loyerPrecedentNet: 1000, // déclenche aussi hausse_sensible (forte)
      }),
      TODAY,
    );
    expect(r.motifs[0].code).toBe('formule_manquante');
  });

  it('formule inconnue → avertissement, pas de motif tueur', () => {
    const r = evaluateLoyerInitial(makeDossier({ formuleOfficielleRecue: 'inconnu' }), TODAY);
    expect(r.motifs.find((m) => m.code === 'formule_manquante')).toBeUndefined();
    expect(r.avertissements.join(' ')).toMatch(/chercher avec le bail/i);
    expect(r.avertissements.join(' ')).toMatch(/régie ou au propriétaire/i);
    expect(r.avertissements.join(' ')).toMatch(/délai de contestation/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateLoyerInitial — STEP 2 : gate délai
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateLoyerInitial — gate délai', () => {
  it('formule reçue + > 30 jours → hors délai, non éligible, stop', () => {
    const r = evaluateLoyerInitial(
      makeDossier({ dateRemiseCles: '2026-05-01' }), // ~69 jours avant TODAY
      TODAY,
    );
    expect(r.joursEcoules).toBeGreaterThan(30);
    expect(r.horsDelai).toBe(true);
    expect(r.eligible).toBe(false);
    // STEP 4 pas atteint : pas de motif présomption_rendement.
    expect(r.motifs.find((m) => m.code === 'presomption_rendement')).toBeUndefined();
    expect(r.avertissements.join(' ')).toMatch(/baisse/i);
  });

  it('formule reçue + exactement 30 jours → dans le délai (éligible)', () => {
    const r = evaluateLoyerInitial(
      makeDossier({ dateRemiseCles: '2026-06-09' }), // 30 jours avant TODAY
      TODAY,
    );
    expect(r.joursEcoules).toBe(30);
    expect(r.horsDelai).toBe(false);
    expect(r.eligible).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateLoyerInitial — STEP 3 : conditions matérielles / éligibilité
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateLoyerInitial — éligibilité (art. 270 al.1)', () => {
  it('VD/GE : pénurie reconnue suffit à rendre éligible', () => {
    expect(evaluateLoyerInitial(makeDossier({ canton: 'VD' }), TODAY).eligible).toBe(true);
    expect(
      evaluateLoyerInitial(makeDossier({ canton: 'GE', commune: 'Genève', npa: '1200' }), TODAY)
        .eligible,
    ).toBe(true);
  });

  it('hausse > 10 % vs ancien locataire → motif hausse_sensible (forte)', () => {
    const r = evaluateLoyerInitial(
      makeDossier({
        loyerNetMensuel: 1800,
        loyerPrecedentConnu: true,
        loyerPrecedentNet: 1500, // +20 %
      }),
      TODAY,
    );
    const m = r.motifs.find((x) => x.code === 'hausse_sensible');
    expect(m).toBeDefined();
    expect(m!.force).toBe('forte');
    expect(m!.libelle).toMatch(/20\.0 %/);
  });

  it('hausse ≤ 10 % → pas de motif hausse_sensible', () => {
    const r = evaluateLoyerInitial(
      makeDossier({
        loyerNetMensuel: 1600,
        loyerPrecedentConnu: true,
        loyerPrecedentNet: 1500, // +6.7 %
      }),
      TODAY,
    );
    expect(r.motifs.find((x) => x.code === 'hausse_sensible')).toBeUndefined();
  });

  it('contrainte personnelle enregistrée comme condition (reste éligible)', () => {
    const r = evaluateLoyerInitial(makeDossier({ contraintePersonnelle: true }), TODAY);
    expect(r.eligible).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateLoyerInitial — STEP 4 : présomption de rendement
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateLoyerInitial — présomption rendement', () => {
  it('ajoute toujours le motif présomption_rendement (moyenne) quand éligible', () => {
    const r = evaluateLoyerInitial(makeDossier(), TODAY);
    const m = r.motifs.find((x) => x.code === 'presomption_rendement');
    expect(m).toBeDefined();
    expect(m!.force).toBe('moyenne');
  });

  it('expose rendementAdmissiblePct pédagogique (taux ≤ 2 → +2)', () => {
    const r = evaluateLoyerInitial(makeDossier(), TODAY);
    expect(r.rendementAdmissiblePct).toBe(TAUX_REFERENCE.value + 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateLoyerInitial — STEP 5 : axe argumentaire selon l'âge
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateLoyerInitial — axe argumentaire', () => {
  it('immeuble ancien (≥ 30 ans) → loyers_usuels', () => {
    const r = evaluateLoyerInitial(makeDossier({ anneeConstruction: 1980 }), TODAY);
    expect(r.axeArgumentaire).toBe('loyers_usuels');
  });

  it('immeuble récent (≤ 10 ans) → rendement_brut', () => {
    const r = evaluateLoyerInitial(makeDossier({ anneeConstruction: 2020 }), TODAY);
    expect(r.axeArgumentaire).toBe('rendement_brut');
  });

  it('immeuble intermédiaire → rendement_net', () => {
    const r = evaluateLoyerInitial(makeDossier({ anneeConstruction: 2005 }), TODAY);
    expect(r.axeArgumentaire).toBe('rendement_net');
  });

  it('année inconnue → rendement_net par défaut', () => {
    const r = evaluateLoyerInitial(makeDossier({ anneeConstruction: null }), TODAY);
    expect(r.axeArgumentaire).toBe('rendement_net');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateLoyerInitial — STEP 6 : conclusions & tri
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateLoyerInitial — conclusions', () => {
  it('inclut la nullité seulement si formule manquante', () => {
    const sansFormule = evaluateLoyerInitial(makeDossier({ formuleOfficielleRecue: 'non' }), TODAY);
    expect(sansFormule.conclusions.join(' ')).toMatch(/nullité/i);

    const avecFormule = evaluateLoyerInitial(makeDossier(), TODAY);
    expect(avecFormule.conclusions.join(' ')).not.toMatch(/nullité/i);
  });

  it('demande d’abord les pièces nécessaires avant les conclusions au fond', () => {
    const r = evaluateLoyerInitial(makeDossier(), TODAY);
    expect(r.conclusions[0]).toMatch(/production des pièces nécessaires/i);
    expect(r.conclusions[0]).toMatch(/méthode applicable/i);
    expect(r.conclusions.join(' ')).toMatch(/après examen des pièces/i);
  });

  it('motifs triés par force décroissante', () => {
    const r = evaluateLoyerInitial(
      makeDossier({
        formuleOfficielleRecue: 'non',
        loyerPrecedentConnu: true,
        loyerPrecedentNet: 1000,
      }),
      TODAY,
    );
    const ordre = { tres_forte: 3, forte: 2, moyenne: 1, faible: 0 } as const;
    for (let i = 1; i < r.motifs.length; i++) {
      expect(ordre[r.motifs[i - 1].force]).toBeGreaterThanOrEqual(ordre[r.motifs[i].force]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluateDemandeBaisse
// ─────────────────────────────────────────────────────────────────────────────

describe('evaluateDemandeBaisse', () => {
  it('taux du bail inconnu → non éligible + avertissement', () => {
    const r = evaluateDemandeBaisse(null, 1800);
    expect(r.eligible).toBe(false);
    expect(r.avertissements.join(' ')).toMatch(/inconnu/i);
  });

  it('taux du bail > taux actuel → éligible + estimation', () => {
    // taux actuel = 1.25 ; bail à 1.75 → delta 0.5 pt → ~2 * 2.91 = 5.82 %
    const r = evaluateDemandeBaisse(1.75, 2000);
    expect(r.eligible).toBe(true);
    expect(r.deltaPts).toBe(0.5);
    expect(r.baisseEstimeePct).toBeCloseTo(5.82, 2);
    expect(r.baisseEstimeeChf).toBeCloseTo(116.4, 1);
    expect(r.procedure.length).toBeGreaterThan(0);
  });

  it('taux du bail = taux actuel → non éligible', () => {
    const r = evaluateDemandeBaisse(TAUX_REFERENCE.value, 1800);
    expect(r.eligible).toBe(false);
  });

  it('taux du bail < taux actuel → non éligible', () => {
    const r = evaluateDemandeBaisse(1.0, 1800);
    expect(r.eligible).toBe(false);
  });
});

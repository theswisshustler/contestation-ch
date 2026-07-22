/**
 * ============================================================================
 * contestation.ch — RULESET loyer initial + demande de baisse (VD + GE)
 * v1.0 — module logique headless, testable unitairement.
 *
 * Base juridique : art. 270 / 269 / 269a CO. Voir le document de travail.
 * ⚠ Ce module NE calcule PAS le rendement (données bailleur indisponibles).
 *   Il établit l'éligibilité, hiérarchise les motifs, et prépare une requête
 *   qui invoque le doute + renverse le fardeau de la preuve sur le bailleur.
 * ============================================================================
 */

// ────────────────────────────────────────────────────────────────────────────
// 1. TYPES
// ────────────────────────────────────────────────────────────────────────────

export type Canton = 'VD' | 'GE';
export type TriState = 'oui' | 'non' | 'inconnu';
export type ParcoursKind = 'loyer_initial' | 'hausse_loyer' | 'demande_baisse';
export type TypeBail = 'ordinaire' | 'indexe' | 'echelonne' | 'subventionne' | 'inconnu';

export type VdDistrict =
  | 'aigle' | 'broye_vully' | 'gros_de_vaud' | 'jura_nord_vaudois'
  | 'lausanne' | 'lavaux_oron' | 'morges' | 'nyon'
  | 'ouest_lausannois' | 'riviera_pays_denhaut';

export interface Partie {
  nom: string;
  prenom?: string;
  adresse: string;
  npa: string;
  ville: string;
  email?: string;
}

export interface Autorite {
  nom: string;
  adresse: string;
  casePostale?: string;
  npa: string;
  ville: string;
  canton: Canton;
  district?: VdDistrict;
}

/** Données d'un dossier (issues du flux manuel OU de l'extraction du bail). */
export interface DossierContestation {
  kind?: ParcoursKind;                // absent dans les anciens dossiers => loyer initial
  canton: Canton;
  npa: string;                       // NPA de l'immeuble
  commune: string;                   // commune de l'immeuble
  adresseImmeuble: string;
  dateRemiseCles: string;            // ISO 'YYYY-MM-DD'
  loyerNetMensuel: number;           // CHF
  chargesMensuelles: number;         // CHF
  formuleOfficielleRecue: TriState;  // formule verte de fixation du loyer initial
  loyerPrecedentConnu: boolean;
  loyerPrecedentNet: number | null;  // CHF (figure sur la formule officielle)
  tauxReferenceBail: number | null;  // % mentionné au bail, ex. 1.5
  anneeConstruction: number | null;
  contraintePersonnelle: boolean;    // nécessité perso/familiale (flux manuel)
  locataire: Partie;
  bailleur: Partie;                  // régie ou propriétaire
  signatureDataUrl: string | null;   // pour le flux recommandé (49,90 CHF)
  typeBail?: TypeBail;
  dateNotificationHausse?: string;   // ISO, date de réception de la hausse
  dateEffetHausse?: string;          // ISO, date annoncée d'entrée en vigueur
  loyerAvantHausse?: number;
  loyerApresHausse?: number;
  formuleHausseRecue?: TriState;
  motifHausse?: 'taux_reference' | 'renchérissement' | 'couts' | 'travaux' | 'loyers_usuels' | 'multiple' | 'inconnu';
  tauxReferenceNouveau?: number | null;
}

export type ForceMotif = 'tres_forte' | 'forte' | 'moyenne' | 'faible';

export interface Motif {
  code: string;
  libelle: string;
  force: ForceMotif;
  explication: string;   // texte destiné à alimenter la lettre
}

export type AxeArgumentaire = 'rendement_net' | 'rendement_brut' | 'loyers_usuels';

export interface ResultatContestation {
  kind: ParcoursKind;
  eligible: boolean;
  horsDelai: boolean;
  requiertTraitementManuel: boolean;
  autorite: Autorite | null;
  joursEcoules: number | null;
  motifs: Motif[];                       // motifs pertinents, sans classement affiché
  axeArgumentaire: AxeArgumentaire | null;
  conclusions: string[];
  avertissements: string[];
  rendementAdmissiblePct: number | null; // pédagogie UI uniquement
  estimationPct?: number | null;
  estimationChf?: number | null;
  destinataireType?: 'autorite' | 'bailleur';
}

export interface ResultatBaisse {
  eligible: boolean;
  tauxActuel: number;
  tauxBail: number | null;
  deltaPts: number | null;
  baisseEstimeePct: number | null;
  baisseEstimeeChf: number | null;
  procedure: string[];
  avertissements: string[];
}

// ────────────────────────────────────────────────────────────────────────────
// 2. TAUX DE RÉFÉRENCE (OFL)
// Le taux ne bouge qu'à dates fixes (publication trimestrielle OFL). On le
// versionne avec sa date de validité + un rappel, plutôt qu'un scraper fragile.
// TODO: job trimestriel qui vérifie bwo.admin.ch et met à jour cette constante.
// ────────────────────────────────────────────────────────────────────────────

export const TAUX_REFERENCE = {
  value: 1.25,                       // %
  depuis: '2025-09-02',
  prochainePublication: '2026-09-01',
  source: 'https://www.bwo.admin.ch/fr/taux-de-reference',
} as const;

export function fetchTauxReference(): { value: number } {
  // MVP : constante versionnée. À rafraîchir sur le calendrier OFL.
  return { value: TAUX_REFERENCE.value };
}

// ────────────────────────────────────────────────────────────────────────────
// 3. DATASET DES AUTORITÉS DE CONCILIATION
// ────────────────────────────────────────────────────────────────────────────

/** Genève : une seule autorité cantonale (tout NPA du canton). */
export const GE_AUTHORITY: Autorite = {
  nom: 'Commission de conciliation en matière de baux et loyers',
  adresse: "Rue de l'Athénée 6-8",
  casePostale: 'Case postale 3120',
  npa: '1211',
  ville: 'Genève 3',
  canton: 'GE',
};

/** Vaud : requête à la préfecture du district du lieu de l'immeuble.
 *  Adresses vérifiées — annuaire officiel vd.ch (avril 2025). */
export const VD_PREFECTURES: Record<VdDistrict, Autorite> = {
  aigle: {
    nom: "Préfecture du district d'Aigle",
    adresse: 'Place du Marché 2',
    // ⚠ L'annuaire officiel indique « 1080 Aigle » (probable coquille).
    //    NPA standard d'Aigle = 1860. À confirmer avant mise en prod.
    npa: '1860',
    ville: 'Aigle',
    canton: 'VD',
    district: 'aigle',
  },
  broye_vully: {
    nom: 'Préfecture du district de la Broye-Vully',
    adresse: 'Rue du Temple 6',
    casePostale: 'Case postale 336',
    npa: '1530',
    ville: 'Payerne',
    canton: 'VD',
    district: 'broye_vully',
  },
  gros_de_vaud: {
    nom: 'Préfecture du district du Gros-de-Vaud',
    adresse: 'Place Emile Gardaz 8',
    npa: '1040',
    ville: 'Echallens',
    canton: 'VD',
    district: 'gros_de_vaud',
  },
  jura_nord_vaudois: {
    nom: 'Préfecture du district du Jura-Nord vaudois',
    adresse: 'Rue des Moulins 10',
    casePostale: 'Case postale 1094',
    npa: '1401',
    ville: 'Yverdon-les-Bains',
    canton: 'VD',
    district: 'jura_nord_vaudois',
  },
  lausanne: {
    nom: 'Préfecture du district de Lausanne',
    adresse: 'Place du Château 1',
    npa: '1014',
    ville: 'Lausanne',
    canton: 'VD',
    district: 'lausanne',
  },
  lavaux_oron: {
    nom: 'Préfecture du district de Lavaux-Oron',
    adresse: 'Chemin de Versailles 6',
    npa: '1096',
    ville: 'Cully',
    canton: 'VD',
    district: 'lavaux_oron',
  },
  morges: {
    nom: 'Préfecture du district de Morges',
    adresse: 'Place Saint-Louis 4',
    npa: '1110',
    ville: 'Morges 1',
    canton: 'VD',
    district: 'morges',
  },
  nyon: {
    nom: 'Préfecture du district de Nyon',
    adresse: 'Rue Juste-Olivier 8',
    casePostale: 'Case postale 1332',
    npa: '1260',
    ville: 'Nyon 1',
    canton: 'VD',
    district: 'nyon',
  },
  ouest_lausannois: {
    nom: "Préfecture du district de l'Ouest lausannois",
    adresse: 'Rue de Verdeaux 2',
    casePostale: 'Case postale 285',
    npa: '1020',
    ville: 'Renens 1',
    canton: 'VD',
    district: 'ouest_lausannois',
  },
  riviera_pays_denhaut: {
    nom: "Préfecture du district de la Riviera – Pays-d'Enhaut",
    adresse: 'Rue du Simplon 22',
    npa: '1800',
    ville: 'Vevey',
    canton: 'VD',
    district: 'riviera_pays_denhaut',
  },
};

/**
 * Mapping commune → district (VD).
 * ⚠ STARTER VALIDÉ (centres principaux + district de Morges vérifié officiellement).
 *   Couvre l'essentiel de la population, donc la majorité des dossiers réels.
 *   Toute commune absente → resolveAutorite renvoie null → traitement MANUEL
 *   (cf. Q29). À COMPLÉTER avec la table officielle des ~300 communes VD :
 *   vd.ch/etat-droit-finances/communes/liste-des-communes-et-districts
 *   Clés = nom de commune normalisé (voir normalizeCommune()).
 */
export const VD_COMMUNE_TO_DISTRICT: Record<string, VdDistrict> = {
  // — Lausanne —
  'lausanne': 'lausanne',
  'le mont-sur-lausanne': 'lausanne',
  'epalinges': 'lausanne',
  'cheseaux-sur-lausanne': 'lausanne',
  'romanel-sur-lausanne': 'lausanne',
  'jouxtens-mezery': 'lausanne',

  // — Ouest lausannois —
  'renens': 'ouest_lausannois',
  'bussigny': 'ouest_lausannois',
  'chavannes-pres-renens': 'ouest_lausannois',
  'crissier': 'ouest_lausannois',
  'ecublens': 'ouest_lausannois',
  'prilly': 'ouest_lausannois',
  'saint-sulpice': 'ouest_lausannois',
  'villars-sainte-croix': 'ouest_lausannois',

  // — Morges (liste officielle vérifiée) —
  'morges': 'morges', 'aclens': 'morges', 'allaman': 'morges', 'aubonne': 'morges',
  'ballens': 'morges', 'berolle': 'morges', 'biere': 'morges', 'bougy-villars': 'morges',
  'bremblens': 'morges', 'buchillon': 'morges', 'chavannes-le-veyron': 'morges',
  'chevilly': 'morges', 'chigny': 'morges', 'clarmont': 'morges', 'cossonay': 'morges',
  'cuarnens': 'morges', 'denens': 'morges', 'denges': 'morges', 'dizy': 'morges',
  'echandens': 'morges', 'echichens': 'morges', 'eclepens': 'morges', 'etoy': 'morges',
  'fechy': 'morges', 'ferreyres': 'morges', 'gimel': 'morges', 'gollion': 'morges',
  'grancy': 'morges', 'hautemorges': 'morges', "l'isle": 'morges', 'lavigny': 'morges',
  'lonay': 'morges', 'lully': 'morges', 'lussy-sur-morges': 'morges', 'mauraz': 'morges',
  'moiry': 'morges', 'mollens': 'morges', 'mont-la-ville': 'morges', 'montricher': 'morges',
  'orny': 'morges', 'pompaples': 'morges', 'preverenges': 'morges',
  'romanel-sur-morges': 'morges', 'saint-livres': 'morges', 'saint-oyens': 'morges',
  'saint-prex': 'morges', 'la sarraz': 'morges', 'saubraz': 'morges', 'senarclens': 'morges',
  'tolochenaz': 'morges', 'vaux-sur-morges': 'morges', 'villars-sous-yens': 'morges',
  'vufflens-le-chateau': 'morges', 'vullierens': 'morges', 'yens': 'morges',

  // — Nyon —
  'nyon': 'nyon', 'gland': 'nyon', 'rolle': 'nyon', 'prangins': 'nyon', 'coppet': 'nyon',
  'founex': 'nyon', 'begnins': 'nyon', 'genolier': 'nyon', 'saint-cergue': 'nyon',
  'commugny': 'nyon', 'mies': 'nyon', 'crans-pres-celigny': 'nyon', 'perroy': 'nyon',

  // — Jura-Nord vaudois —
  'yverdon-les-bains': 'jura_nord_vaudois', 'grandson': 'jura_nord_vaudois',
  'orbe': 'jura_nord_vaudois', 'vallorbe': 'jura_nord_vaudois',
  'sainte-croix': 'jura_nord_vaudois', 'chavornay': 'jura_nord_vaudois',
  'le chenit': 'jura_nord_vaudois', 'yvonand': 'jura_nord_vaudois',

  // — Gros-de-Vaud —
  'echallens': 'gros_de_vaud', 'assens': 'gros_de_vaud', 'bottens': 'gros_de_vaud',
  'bercher': 'gros_de_vaud', 'cugy': 'gros_de_vaud', 'froideville': 'gros_de_vaud',
  'poliez-pittet': 'gros_de_vaud',

  // — Lavaux-Oron —
  'pully': 'lavaux_oron', 'paudex': 'lavaux_oron', 'belmont-sur-lausanne': 'lavaux_oron',
  'lutry': 'lavaux_oron', 'savigny': 'lavaux_oron', 'bourg-en-lavaux': 'lavaux_oron',
  'cully': 'lavaux_oron', 'chexbres': 'lavaux_oron', 'puidoux': 'lavaux_oron',
  'oron': 'lavaux_oron', 'servion': 'lavaux_oron', 'forel (lavaux)': 'lavaux_oron',
  'jorat-mezieres': 'lavaux_oron',

  // — Riviera – Pays-d'Enhaut —
  'vevey': 'riviera_pays_denhaut', 'montreux': 'riviera_pays_denhaut',
  'la tour-de-peilz': 'riviera_pays_denhaut', 'blonay-saint-legier': 'riviera_pays_denhaut',
  'corsier-sur-vevey': 'riviera_pays_denhaut', 'corseaux': 'riviera_pays_denhaut',
  'chardonne': 'riviera_pays_denhaut', 'jongny': 'riviera_pays_denhaut',
  'veytaux': 'riviera_pays_denhaut', "chateau-d'oex": 'riviera_pays_denhaut',
  'rougemont': 'riviera_pays_denhaut', 'rossiniere': 'riviera_pays_denhaut',

  // — Aigle (liste officielle vérifiée) —
  'aigle': 'aigle', 'bex': 'aigle', 'ollon': 'aigle', 'villeneuve': 'aigle',
  'roche': 'aigle', 'yvorne': 'aigle', 'leysin': 'aigle', 'gryon': 'aigle',
  'corbeyrier': 'aigle', 'noville': 'aigle', 'chessel': 'aigle', 'rennaz': 'aigle',
  'lavey-morcles': 'aigle',

  // — Broye-Vully —
  'payerne': 'broye_vully', 'avenches': 'broye_vully', 'moudon': 'broye_vully',
  'lucens': 'broye_vully', 'valbroye': 'broye_vully', 'cudrefin': 'broye_vully',
  'corcelles-pres-payerne': 'broye_vully', 'grandcour': 'broye_vully',
};

// ────────────────────────────────────────────────────────────────────────────
// 4. HELPERS
// ────────────────────────────────────────────────────────────────────────────

/** Normalise un nom de commune : minuscules, sans accents, sans suffixe " VD". */
export function normalizeCommune(commune: string): string {
  return commune
    .trim()
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // enlève les accents
    .replace(/\s+vd$/, '')                            // "Roche VD" -> "roche"
    .replace(/\s+/g, ' ');
}

function diffJours(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / 86_400_000);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ────────────────────────────────────────────────────────────────────────────
// 5. resolveAutorite
// ────────────────────────────────────────────────────────────────────────────

export function resolveAutorite(
  canton: Canton,
  npa: string,
  commune: string,
): Autorite | null {
  if (canton === 'GE') return GE_AUTHORITY;

  if (canton === 'VD') {
    const district = VD_COMMUNE_TO_DISTRICT[normalizeCommune(commune)];
    return district ? VD_PREFECTURES[district] : null; // null => traitement manuel
  }

  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// 6. evaluateLoyerInitial — cœur du ruleset
// ────────────────────────────────────────────────────────────────────────────

export function evaluateLoyerInitial(
  d: DossierContestation,
  today: Date = new Date(),
): ResultatContestation {
  const res: ResultatContestation = {
    kind: 'loyer_initial',
    eligible: false,
    horsDelai: false,
    requiertTraitementManuel: false,
    autorite: null,
    joursEcoules: null,
    motifs: [],
    axeArgumentaire: null,
    conclusions: [],
    avertissements: [],
    rendementAdmissiblePct: null,
  };

  // — STEP 0 : compétence —
  res.autorite = resolveAutorite(d.canton, d.npa, d.commune);
  if (!res.autorite) {
    res.requiertTraitementManuel = true;
    res.avertissements.push(
      "Autorité de conciliation introuvable pour cette commune — traitement manuel requis (compléter le mapping communes VD).",
    );
  }

  const jours = diffJours(new Date(d.dateRemiseCles), today);
  res.joursEcoules = jours;

  // — STEP 1 : vice de forme (motif prioritaire) —
  const formuleManquante = d.formuleOfficielleRecue === 'non';
  if (formuleManquante) {
    res.motifs.push({
      code: 'formule_manquante',
      libelle: 'Formule officielle de fixation du loyer initial manquante',
      force: 'tres_forte',
      explication:
        "L'usage de la formule officielle est obligatoire à VD et à GE. Son absence " +
        "entraîne la nullité de la fixation du loyer initial. Le loyer est alors " +
        "contestable en tout temps (le délai de 30 jours ne court pas) et le trop-perçu " +
        "peut être réclamé jusqu'à 10 ans en arrière.",
    });
  } else if (d.formuleOfficielleRecue === 'inconnu') {
    res.avertissements.push(
      "Formule officielle à vérifier : chercher avec le bail, ses annexes et les documents reçus à la remise des clés. " +
      "Si elle reste introuvable, demander une copie écrite à la régie ou au propriétaire sans attendre leur réponse pour respecter un éventuel délai de contestation.",
    );
  }

  // — STEP 2 : délai (uniquement si la formule a bien été reçue) —
  if (!formuleManquante) {
    if (jours > 30) {
      res.horsDelai = true;
      res.eligible = false;
      res.avertissements.push(
        `Délai de 30 jours dépassé (${jours} jours depuis la remise des clés). ` +
        "La contestation du loyer initial est vraisemblablement irrecevable. " +
        "Proposer plutôt une demande de baisse fondée sur le taux de référence si applicable.",
      );
      return res; // on s'arrête : ne pas vendre une lettre vaine
    }
  } else {
    res.avertissements.push(
      "Formule manquante : contestation recevable en tout temps (délai de 30 jours inapplicable).",
    );
  }

  // — STEP 3 : condition matérielle art. 270 al. 1 (au moins une) —
  const conditions: string[] = [];

  // Pénurie reconnue à VD et GE => condition (let. a) quasi automatique.
  if (d.canton === 'VD' || d.canton === 'GE') conditions.push('penurie_reconnue');

  // Hausse sensible (> 10 %) vs ancien locataire (let. b) => indice fort d'abus.
  if (d.loyerPrecedentConnu && d.loyerPrecedentNet && d.loyerPrecedentNet > 0) {
    const hausse = (d.loyerNetMensuel - d.loyerPrecedentNet) / d.loyerPrecedentNet;
    if (hausse > 0.10) {
      conditions.push('hausse_sensible');
      res.motifs.push({
        code: 'hausse_sensible',
        libelle: `Hausse sensible de ${(hausse * 100).toFixed(1)} % par rapport au loyer du locataire précédent`,
        force: 'forte',
        explication:
          `Le loyer net passe de ${d.loyerPrecedentNet.toFixed(0)} à ${d.loyerNetMensuel.toFixed(0)} CHF ` +
          `(+${(hausse * 100).toFixed(1)} %). Une hausse supérieure à 10 % sans travaux à plus-value ` +
          "constitue une hausse sensible au sens de l'art. 270 al. 1 let. b CO et un indice d'abus.",
      });
    }
  }

  if (d.contraintePersonnelle) conditions.push('contrainte_personnelle');

  if (conditions.length > 0) {
    res.eligible = true;
  } else {
    // Improbable en VD/GE (pénurie), mais sécurité.
    res.requiertTraitementManuel = true;
    res.avertissements.push(
      "Aucune condition matérielle de l'art. 270 clairement remplie — traitement manuel.",
    );
  }

  // — STEP 4 : présomption d'abus / rendement (cœur « scare-to-settle ») —
  res.motifs.push({
    code: 'presomption_rendement',
    libelle: "Doute sur le caractère non-excessif du rendement (art. 269 CO)",
    force: 'moyenne',
    explication:
      "Le loyer paraît susceptible de procurer au bailleur un rendement net excessif. " +
      "Le locataire ne disposant pas de la comptabilité de l'immeuble, il est demandé au " +
      "bailleur de produire le décompte de rendement net (prix de revient, fonds propres " +
      "investis, charges). À défaut de collaboration, l'autorité statue en équité.",
  });

  const taux = fetchTauxReference().value;
  res.rendementAdmissiblePct = taux <= 2 ? taux + 2 : taux + 0.5; // indicatif UI

  // — STEP 5 : axe argumentaire selon l'âge de l'immeuble —
  if (d.anneeConstruction) {
    const age = today.getFullYear() - d.anneeConstruction;
    if (age >= 30) res.axeArgumentaire = 'loyers_usuels';      // 269a let. a prime
    else if (age <= 10) res.axeArgumentaire = 'rendement_brut'; // 269a let. c
    else res.axeArgumentaire = 'rendement_net';                 // 269 CO
  } else {
    res.axeArgumentaire = 'rendement_net';
  }

  // — STEP 6 : conclusions —
  // L'ordre suit les faits du dossier. Les motifs ne sont pas présentés comme
  // un palmarès : leur portée juridique dépend des pièces et de la procédure.
  res.conclusions = buildConclusions(d, res, formuleManquante);

  return res;
}

function buildConclusions(
  d: DossierContestation,
  res: ResultatContestation,
  formuleManquante: boolean,
): string[] {
  const c: string[] = [];
  c.push(
    "Requérir de la partie bailleresse la production des pièces nécessaires à la détermination de la méthode applicable et à la vérification du caractère non abusif du loyer initial.",
  );
  if (formuleManquante) {
    c.push("Constater la nullité de la fixation du loyer initial (formule officielle non remise).");
  }
  c.push(
    "Après examen des pièces, fixer le loyer initial net à un montant non abusif, sous réserve de préciser cette conclusion lorsque les données nécessaires seront disponibles.",
  );
  c.push(
    "Ordonner à la partie bailleresse de restituer la différence entre le loyer payé et le loyer ainsi fixé, depuis l'entrée en jouissance.",
  );
  c.push("Adapter la garantie de loyer au montant du loyer ainsi fixé.");
  return c;
}

// ────────────────────────────────────────────────────────────────────────────
// 7. Contestation d'une hausse pendant le bail (art. 269d et 270b CO)
// ────────────────────────────────────────────────────────────────────────────

export function evaluateHausseLoyer(
  d: DossierContestation,
  today: Date = new Date(),
): ResultatContestation {
  const res: ResultatContestation = {
    kind: 'hausse_loyer', eligible: false, horsDelai: false,
    requiertTraitementManuel: false, autorite: resolveAutorite(d.canton, d.npa, d.commune),
    joursEcoules: null, motifs: [], axeArgumentaire: null, conclusions: [],
    avertissements: [], rendementAdmissiblePct: null, destinataireType: 'autorite',
  };
  if (!res.autorite) {
    res.requiertTraitementManuel = true;
    res.avertissements.push("Autorité de conciliation introuvable pour cette commune — vérification humaine requise.");
  }
  if (d.typeBail !== 'ordinaire') {
    res.requiertTraitementManuel = true;
    res.avertissements.push("Les loyers indexés, échelonnés ou subventionnés suivent des règles particulières : aucune lettre automatisée ne sera vendue sans vérification humaine.");
    return res;
  }
  if (!d.dateNotificationHausse) {
    res.requiertTraitementManuel = true;
    res.avertissements.push("La date de réception de la hausse est indispensable pour vérifier le délai.");
    return res;
  }
  const jours = diffJours(new Date(d.dateNotificationHausse), today);
  res.joursEcoules = jours;
  if (jours < 0) {
    res.requiertTraitementManuel = true;
    res.avertissements.push("La date de réception indiquée est dans le futur.");
    return res;
  }
  if (jours > 30) {
    res.horsDelai = true;
    res.avertissements.push(`Le délai ordinaire de 30 jours paraît dépassé (${jours} jours depuis la réception).`);
    return res;
  }
  if (d.formuleHausseRecue === 'non') {
    res.motifs.push({ code: 'hausse_forme', libelle: 'Notification sans formule officielle', force: 'tres_forte', explication: "La hausse n'a pas été notifiée au moyen de la formule agréée par le canton, alors que l'art. 269d CO impose cette forme." });
  } else if (d.formuleHausseRecue === 'inconnu') {
    res.avertissements.push("Vérifiez si le courrier reçu est bien la formule officielle cantonale et conservez son enveloppe.");
  }
  if (!d.motifHausse || d.motifHausse === 'inconnu') {
    res.motifs.push({ code: 'hausse_motivation', libelle: 'Motivation à contrôler', force: 'forte', explication: "Une hausse doit indiquer ses motifs de manière compréhensible. Une motivation absente ou insuffisante peut affecter sa validité." });
  }
  if (d.loyerAvantHausse && d.loyerApresHausse && d.loyerApresHausse > d.loyerAvantHausse) {
    const pct = round2(((d.loyerApresHausse - d.loyerAvantHausse) / d.loyerAvantHausse) * 100);
    res.estimationPct = pct;
    res.estimationChf = round2(d.loyerApresHausse - d.loyerAvantHausse);
    res.motifs.push({ code: 'hausse_calcul', libelle: `Calcul de la hausse de ${pct.toFixed(2)} % à vérifier`, force: 'moyenne', explication: "Le montant doit correspondre aux motifs annoncés et tenir compte des facteurs de baisse intervenus depuis la dernière fixation du loyer." });
  }
  if ((d.motifHausse === 'taux_reference' || d.motifHausse === 'multiple') && d.tauxReferenceBail != null) {
    const nouveau = d.tauxReferenceNouveau ?? TAUX_REFERENCE.value;
    const incoherent = nouveau <= d.tauxReferenceBail || nouveau > TAUX_REFERENCE.value;
    res.motifs.push({ code: 'hausse_taux', libelle: 'Taux de référence invoqué à vérifier', force: incoherent ? 'forte' : 'moyenne', explication: `Le loyer antérieur est indiqué comme fondé sur ${d.tauxReferenceBail.toFixed(2)} % et la notification sur ${nouveau.toFixed(2)} %, tandis que le taux publié est de ${TAUX_REFERENCE.value.toFixed(2)} %. La base et le taux de répercussion doivent être contrôlés.` });
  }
  res.motifs.push({ code: 'hausse_compensations', libelle: 'Facteurs de baisse à prendre en compte', force: 'moyenne', explication: "Le calcul doit aussi intégrer les réductions de coûts pertinentes, notamment l'évolution du taux de référence et du renchérissement depuis la dernière fixation." });
  res.eligible = !res.requiertTraitementManuel;
  res.conclusions = [
    "Déclarer recevable la contestation de la hausse de loyer notifiée.",
    "Constater la nullité de la hausse si les exigences de forme ou de motivation ne sont pas respectées.",
    "À défaut, réduire la hausse au montant qui peut être justifié par les facteurs de coûts admissibles.",
    "Maintenir le loyer antérieur jusqu'à l'entrée en force d'un accord ou d'une décision.",
  ];
  return res;
}

// ────────────────────────────────────────────────────────────────────────────
// 8. Demande de baisse au bailleur (art. 270a CO)
// ────────────────────────────────────────────────────────────────────────────

function baissePourDelta(deltaPts: number): number {
  // Aux niveaux actuels, l'art. 13 OBLF prévoit 3 % de hausse par 0,25 point.
  // La baisse réciproque est x / (100 + x), afin de revenir au montant initial.
  const hausseReciproque = (Math.round(deltaPts / 0.25) * 3);
  return round2((hausseReciproque / (100 + hausseReciproque)) * 100);
}

export function evaluateBaisseDossier(d: DossierContestation): ResultatContestation {
  const res: ResultatContestation = {
    kind: 'demande_baisse', eligible: false, horsDelai: false,
    requiertTraitementManuel: false, autorite: null, joursEcoules: null, motifs: [],
    axeArgumentaire: null, conclusions: [], avertissements: [], rendementAdmissiblePct: null,
    destinataireType: 'bailleur', estimationPct: null, estimationChf: null,
  };
  if (d.typeBail !== 'ordinaire') {
    res.requiertTraitementManuel = true;
    res.avertissements.push("Les loyers indexés, échelonnés ou subventionnés suivent des règles particulières : une vérification humaine est nécessaire.");
    return res;
  }
  if (d.tauxReferenceBail == null) {
    res.requiertTraitementManuel = true;
    res.avertissements.push("Le taux déterminant du loyer actuel est nécessaire. Il figure sur le bail ou la dernière notification de loyer.");
    return res;
  }
  if (d.tauxReferenceBail <= TAUX_REFERENCE.value) {
    res.avertissements.push("Le taux déterminant de votre loyer n'est pas supérieur au taux actuel : aucune baisse ne peut être demandée sur ce seul fondement.");
    return res;
  }
  const delta = round2(d.tauxReferenceBail - TAUX_REFERENCE.value);
  const pct = baissePourDelta(delta);
  res.estimationPct = pct;
  res.estimationChf = round2((d.loyerNetMensuel * pct) / 100);
  res.motifs.push({ code: 'baisse_taux', libelle: `Taux déterminant de ${d.tauxReferenceBail.toFixed(2)} % contre ${TAUX_REFERENCE.value.toFixed(2)} % actuellement`, force: 'forte', explication: `La diminution de ${delta.toFixed(2)} point(s) ouvre en principe la possibilité de demander une adaptation du loyer net.` });
  res.motifs.push({ code: 'baisse_compensation', libelle: 'Autres facteurs de coûts réservés', force: 'moyenne', explication: "Le bailleur peut opposer le renchérissement ou d'autres hausses de coûts, mais il doit expliquer leur incidence sur le calcul." });
  res.eligible = true;
  res.conclusions = [
    `Réduire le loyer net d'environ ${pct.toFixed(2)} %, sous réserve des autres facteurs de coûts justifiés.`,
    `Appliquer la baisse au prochain terme de résiliation possible, conformément à l'art. 270a CO.`,
    "Communiquer dans les 30 jours l'acceptation de la demande ou le calcul détaillé de tout refus ou compensation.",
  ];
  return res;
}

export function evaluateDossier(d: DossierContestation, today: Date = new Date()): ResultatContestation {
  if (d.kind === 'hausse_loyer') return evaluateHausseLoyer(d, today);
  if (d.kind === 'demande_baisse') return evaluateBaisseDossier(d);
  return evaluateLoyerInitial(d, today);
}

// ────────────────────────────────────────────────────────────────────────────
// 9. evaluateDemandeBaisse — produit d'appel gratuit
// ────────────────────────────────────────────────────────────────────────────

export function evaluateDemandeBaisse(
  tauxReferenceBail: number | null,
  loyerNetMensuel: number,
): ResultatBaisse {
  const tauxActuel = fetchTauxReference().value;
  const base: ResultatBaisse = {
    eligible: false,
    tauxActuel,
    tauxBail: tauxReferenceBail,
    deltaPts: null,
    baisseEstimeePct: null,
    baisseEstimeeChf: null,
    procedure: [],
    avertissements: [],
  };

  if (tauxReferenceBail == null) {
    base.avertissements.push(
      "Taux de référence du bail inconnu. Il figure en principe dans le bail ou dans la " +
      "dernière notification de loyer. Sans lui, l'éligibilité à la baisse ne peut être établie.",
    );
    return base;
  }

  if (tauxReferenceBail > tauxActuel) {
    const deltaPts = round2(tauxReferenceBail - tauxActuel);
    // Approximation usuelle : ~ -2,91 % du loyer net par -0,25 pt.
    const baissePct = baissePourDelta(deltaPts);
    base.eligible = true;
    base.deltaPts = deltaPts;
    base.baisseEstimeePct = baissePct;
    base.baisseEstimeeChf = round2((loyerNetMensuel * baissePct) / 100);
    base.procedure = [
      "Adresser une demande écrite de baisse au bailleur pour le prochain terme de résiliation.",
      "Le bailleur dispose de 30 jours pour se déterminer.",
      "En cas de refus ou d'absence de réponse, saisir l'autorité de conciliation dans les 30 jours.",
    ];
    base.avertissements.push(
      "Estimation indicative : la baisse effective se combine avec l'IPC et les hausses de coûts " +
      "que le bailleur peut opposer. Le chiffre affiché est un ordre de grandeur, pas un droit acquis.",
    );
  } else {
    base.avertissements.push(
      "Le taux de référence du bail n'est pas supérieur au taux actuel : pas de droit à la baisse " +
      "par ce seul critère (d'autres facteurs restent possibles).",
    );
  }

  return base;
}

// ────────────────────────────────────────────────────────────────────────────
// 8. PROMPT D'EXTRACTION — Claude API (bail + formule officielle → JSON)
//
// Appel recommandé : envoyer le(s) PDF en blocs `document` (base64) — l'API
// Claude lit nativement le PDF (texte ET scan), pas besoin d'OCR séparé dans
// la plupart des cas. Demander une sortie JSON stricte (pas de Markdown).
// ────────────────────────────────────────────────────────────────────────────

export const EXTRACTION_SYSTEM_PROMPT = `
Tu es un assistant d'extraction de données pour un outil de contestation de loyer en Suisse (cantons VD et GE).
On te fournit un contrat de bail et, si disponible, la formule officielle de notification du loyer initial.

Ta tâche : extraire UNIQUEMENT les champs ci-dessous et répondre par un objet JSON valide, sans aucun texte autour, sans backticks Markdown.

Règles :
- Si un champ est absent ou illisible, mets null (ne devine jamais).
- "formuleOfficielleRecue" : "oui" si une formule officielle de fixation du loyer initial est présente/mentionnée, "non" si le bail indique explicitement son absence, sinon "inconnu".
- "loyerPrecedentNet" : le loyer de l'ancien locataire, qui figure sur la formule officielle (jamais dans le bail seul). null si la formule est absente.
- "dateRemiseCles" : date d'entrée en jouissance / remise des clés au format ISO 'YYYY-MM-DD'. À défaut, la date de début du bail.
- "tauxReferenceBail" : taux hypothécaire de référence mentionné (nombre, ex. 1.5), sinon null.
- Montants en CHF, nombres purs (pas de "CHF", pas d'apostrophe de milliers).
- Ajoute un objet "confiance" (0 à 1) par champ sensible et une liste "champs_incertains".

Schéma de sortie :
{
  "canton": "VD" | "GE" | null,
  "npa": string | null,
  "commune": string | null,
  "adresseImmeuble": string | null,
  "dateRemiseCles": string | null,
  "loyerNetMensuel": number | null,
  "chargesMensuelles": number | null,
  "formuleOfficielleRecue": "oui" | "non" | "inconnu",
  "loyerPrecedentConnu": boolean,
  "loyerPrecedentNet": number | null,
  "tauxReferenceBail": number | null,
  "anneeConstruction": number | null,
  "locataire": { "nom": string|null, "prenom": string|null, "adresse": string|null, "npa": string|null, "ville": string|null },
  "bailleur": { "nom": string|null, "adresse": string|null, "npa": string|null, "ville": string|null },
  "champs_incertains": string[]
}
`.trim();

/*
 * Exemple d'appel (pseudo, côté serveur — clé gérée par l'infra) :
 *
 * const r = await anthropic.messages.create({
 *   model: 'claude-sonnet-4-6',
 *   max_tokens: 1500,
 *   system: EXTRACTION_SYSTEM_PROMPT,
 *   messages: [{
 *     role: 'user',
 *     content: [
 *       { type: 'document', source: { type:'base64', media_type:'application/pdf', data: bailB64 } },
 *       { type: 'document', source: { type:'base64', media_type:'application/pdf', data: formuleB64 } },
 *       { type: 'text', text: 'Extrais les champs et renvoie uniquement le JSON.' },
 *     ],
 *   }],
 * });
 * const dossierPartiel = JSON.parse(extractText(r)); // -> valider avant evaluateLoyerInitial()
 */

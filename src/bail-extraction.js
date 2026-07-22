/**
 * Contrat unique entre l'analyse Claude et les différents serveurs de l'app.
 * Le schéma contraint la sortie du modèle ; la normalisation reste nécessaire
 * pour protéger le reste du parcours contre des valeurs métier aberrantes.
 */

export const EXTRACTION_SYSTEM_PROMPT = `
Tu extrais les données d'un contrat de bail suisse et de ses annexes. La formule
officielle de notification du loyer initial peut se trouver parmi les pages du
PDF du bail ou dans un second PDF fourni séparément.

Règles :
- N'invente aucune valeur. Utilise null ou une chaîne vide, selon le schéma, si l'information est absente ou illisible.
- Distingue l'adresse du logement de l'adresse actuelle du locataire et de celle du bailleur.
- Le loyer net exclut les acomptes et forfaits de charges.
- La date de remise des clés est la date d'entrée en jouissance ou de début du bail, au format YYYY-MM-DD.
- Le loyer précédent ne peut provenir que de la formule officielle.
- "formuleOfficielleRecue" vaut "oui" uniquement si le document est bien une formule officielle de notification du loyer initial. Ne conclus jamais "non" de la seule absence d'un document.
- Si la formule est identifiée, indique dans "formuleOfficielleSource" si elle se trouve dans le PDF du bail et de ses annexes ("document_bail") ou dans le second PDF ("document_formule"). Sinon utilise "non_identifiee".
- Le taux de référence est un nombre, par exemple 1.5 pour 1,5 %.
- Les montants sont des nombres en CHF, sans symbole ni séparateur de milliers.
- Signale dans "champs_incertains" chaque champ ambigu, calculé ou peu lisible.

Le format de sortie est imposé par le schéma JSON de la requête.
`.trim();

const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const partySchema = {
  type: 'object',
  properties: {
    nom: { type: 'string', description: 'Chaîne vide si absent.' },
    prenom: { type: 'string', description: 'Chaîne vide si absent.' },
    adresse: { type: 'string', description: 'Chaîne vide si absente.' },
    npa: { type: 'string', description: 'NPA suisse à quatre chiffres, ou chaîne vide.' },
    ville: { type: 'string', description: 'Chaîne vide si absente.' },
  },
  required: ['nom', 'prenom', 'adresse', 'npa', 'ville'],
  additionalProperties: false,
};

export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    canton: {
      anyOf: [
        { type: 'string', enum: ['VD', 'GE'] },
        { type: 'null' },
      ],
    },
    npa: nullableString,
    commune: nullableString,
    adresseImmeuble: nullableString,
    dateRemiseCles: nullableString,
    loyerNetMensuel: nullableNumber,
    chargesMensuelles: nullableNumber,
    formuleOfficielleRecue: { type: 'string', enum: ['oui', 'non', 'inconnu'] },
    formuleOfficielleSource: {
      type: 'string',
      enum: ['document_bail', 'document_formule', 'non_identifiee'],
    },
    loyerPrecedentConnu: { type: 'boolean' },
    loyerPrecedentNet: nullableNumber,
    tauxReferenceBail: nullableNumber,
    anneeConstruction: { type: ['integer', 'null'] },
    locataire: partySchema,
    bailleur: partySchema,
    champs_incertains: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'canton', 'npa', 'commune', 'adresseImmeuble', 'dateRemiseCles',
    'loyerNetMensuel', 'chargesMensuelles', 'formuleOfficielleRecue',
    'formuleOfficielleSource',
    'loyerPrecedentConnu', 'loyerPrecedentNet', 'tauxReferenceBail',
    'anneeConstruction', 'locataire', 'bailleur', 'champs_incertains',
  ],
  additionalProperties: false,
};

function docBlock(data, title) {
  return {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data },
    title,
  };
}

export function buildClaudeExtractionRequest({ model, bailB64, formuleB64 }) {
  const content = [docBlock(bailB64, 'Contrat de bail et annexes éventuelles')];
  if (formuleB64) content.push(docBlock(formuleB64, 'Formule officielle fournie séparément'));
  content.push({
    type: 'text',
    text: 'Extrais les champs demandés à partir des documents fournis. Vérifie chaque montant et chaque adresse dans le document source.',
  });

  return {
    model,
    max_tokens: 4096,
    system: EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema: EXTRACTION_JSON_SCHEMA } },
  };
}

function cleanString(value, max = 250) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function cleanNumber(value, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function cleanNpa(value) {
  const npa = cleanString(value, 10);
  return npa && /^\d{4}$/.test(npa) ? npa : null;
}

function cleanDate(value) {
  const date = cleanString(value, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date ? null : date;
}

function cleanParty(value) {
  const party = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    nom: cleanString(party.nom),
    prenom: cleanString(party.prenom),
    adresse: cleanString(party.adresse),
    npa: cleanNpa(party.npa),
    ville: cleanString(party.ville),
  };
}

export function normalizeExtraction(raw, hasSeparateFormule) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClaudeExtractionError('invalid_payload', 'La réponse d’extraction est invalide.');
  }

  const cantonValue = typeof raw.canton === 'string' ? raw.canton.toUpperCase() : null;
  const canton = cantonValue === 'VD' || cantonValue === 'GE' ? cantonValue : null;
  // La formule peut être une annexe du PDF principal. La présence d'un second
  // fichier n'est donc pas une condition de validité de la détection Claude.
  const formuleDetectee = String(raw.formuleOfficielleRecue).toLowerCase() === 'oui';
  const formule = formuleDetectee ? 'oui' : 'inconnu';
  const loyerPrecedentNet = formuleDetectee
    ? cleanNumber(raw.loyerPrecedentNet, 0, 100000)
    : null;
  const rawSource = String(raw.formuleOfficielleSource || '').toLowerCase();
  let formuleSource = 'non_identifiee';
  if (formuleDetectee) {
    if (rawSource === 'document_bail') formuleSource = 'document_bail';
    else if (rawSource === 'document_formule' && hasSeparateFormule) formuleSource = 'document_formule';
    // Sans second fichier, une formule effectivement détectée provient
    // nécessairement du PDF principal, même si l'amont omet la provenance.
    else if (!hasSeparateFormule) formuleSource = 'document_bail';
  }

  return {
    canton,
    npa: cleanNpa(raw.npa),
    commune: cleanString(raw.commune),
    adresseImmeuble: cleanString(raw.adresseImmeuble),
    dateRemiseCles: cleanDate(raw.dateRemiseCles),
    loyerNetMensuel: cleanNumber(raw.loyerNetMensuel, 0, 100000),
    chargesMensuelles: cleanNumber(raw.chargesMensuelles, 0, 50000),
    formuleOfficielleRecue: formule,
    formuleOfficielleSource: formuleSource,
    loyerPrecedentConnu: loyerPrecedentNet !== null,
    loyerPrecedentNet,
    tauxReferenceBail: cleanNumber(raw.tauxReferenceBail, 0, 20),
    anneeConstruction: cleanNumber(raw.anneeConstruction, 1700, new Date().getFullYear() + 2),
    locataire: cleanParty(raw.locataire),
    bailleur: cleanParty(raw.bailleur),
    champs_incertains: Array.isArray(raw.champs_incertains)
      ? raw.champs_incertains
        .map((value) => cleanString(value, 100))
        .filter(Boolean)
        .slice(0, 30)
      : [],
  };
}

export function parseJsonResponse(text) {
  const cleaned = String(text || '').trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch { /* erreur uniforme ci-dessous */ }
    }
    throw new ClaudeExtractionError('invalid_json', 'Le service d’analyse n’a pas renvoyé un résultat exploitable.');
  }
}

export function parseClaudeExtraction(message, hasFormule) {
  const stopReason = message && typeof message === 'object' ? message.stop_reason : null;
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
    throw new ClaudeExtractionError('truncated', 'La réponse de Claude a été tronquée.');
  }
  if (stopReason === 'refusal') {
    throw new ClaudeExtractionError('refusal', 'Claude n’a pas pu analyser ce document.');
  }

  const blocks = message && typeof message === 'object' && Array.isArray(message.content)
    ? message.content
    : [];
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
  if (!text) throw new ClaudeExtractionError('empty_response', 'Claude n’a renvoyé aucun résultat.');

  return normalizeExtraction(parseJsonResponse(text), hasFormule);
}

export class ClaudeExtractionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClaudeExtractionError';
    this.code = code;
  }
}

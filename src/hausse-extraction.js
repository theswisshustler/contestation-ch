/**
 * Contrat d'extraction d'une notification suisse de hausse de loyer.
 * Les valeurs restent soumises à confirmation avant toute évaluation.
 */

export const HAUSSE_EXTRACTION_SYSTEM_PROMPT = `
Tu analyses une notification suisse de hausse de loyer et, si fourni, le bail
auquel elle se rapporte.

Règles :
- N'invente rien. Utilise null ou une chaîne vide si une donnée est absente ou illisible.
- Distingue le loyer net des charges et l'ancien loyer du nouveau loyer.
- Extrais la date figurant sur la notification, la date d'effet annoncée et tous les motifs invoqués.
- "formuleHausseRecue" vaut "oui" uniquement si le document est une formule officielle cantonale ou une notification dont la forme officielle est clairement identifiable. Sinon utilise "inconnu", jamais "non" par simple absence de preuve.
- "motifHausse" vaut "oui" si des motifs compréhensibles sont indiqués, "non" si la zone de motivation est explicitement vide, sinon "inconnu".
- Le taux de référence de l'ancien loyer et le nouveau taux doivent rester distincts.
- Les montants sont des nombres en CHF, sans symbole ni séparateur de milliers.
- Les dates utilisent YYYY-MM-DD.
- Résume fidèlement chaque justification dans "motifsInvoques" : taux de référence, IPC, hausse générale des coûts, travaux à plus-value, rendement, adaptation aux loyers usuels ou autre.
- Signale dans "champs_incertains" tout champ ambigu, calculé ou peu lisible.
`.trim();

const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const partySchema = {
  type: 'object',
  properties: {
    nom: { type: 'string' },
    prenom: { type: 'string' },
    adresse: { type: 'string' },
    npa: { type: 'string' },
    ville: { type: 'string' },
  },
  required: ['nom', 'prenom', 'adresse', 'npa', 'ville'],
  additionalProperties: false,
};

export const HAUSSE_EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  properties: {
    canton: { anyOf: [{ type: 'string', enum: ['VD', 'GE'] }, { type: 'null' }] },
    npa: nullableString,
    commune: nullableString,
    adresseImmeuble: nullableString,
    dateNotificationHausse: nullableString,
    dateEffetHausse: nullableString,
    loyerAvantHausse: nullableNumber,
    loyerApresHausse: nullableNumber,
    chargesMensuelles: nullableNumber,
    formuleHausseRecue: { type: 'string', enum: ['oui', 'non', 'inconnu'] },
    motifHausse: { type: 'string', enum: ['oui', 'non', 'inconnu'] },
    tauxReferenceBail: nullableNumber,
    tauxReferenceNouveau: nullableNumber,
    motifsInvoques: { type: 'array', items: { type: 'string' } },
    locataire: partySchema,
    bailleur: partySchema,
    champs_incertains: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'canton', 'npa', 'commune', 'adresseImmeuble', 'dateNotificationHausse',
    'dateEffetHausse', 'loyerAvantHausse', 'loyerApresHausse',
    'chargesMensuelles', 'formuleHausseRecue', 'motifHausse',
    'tauxReferenceBail', 'tauxReferenceNouveau', 'motifsInvoques',
    'locataire', 'bailleur', 'champs_incertains',
  ],
  additionalProperties: false,
};

function documentBlock(data, title) {
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title };
}

export function buildHausseExtractionRequest({ model, notificationB64, bailB64 }) {
  const content = [documentBlock(notificationB64, 'Notification de hausse de loyer reçue par le locataire')];
  if (bailB64) content.push(documentBlock(bailB64, 'Contrat de bail fourni comme document complémentaire'));
  content.push({
    type: 'text',
    text: 'Extrais les données demandées. Analyse précisément les motifs et les bases de calcul invoqués par le bailleur.',
  });
  return {
    model,
    max_tokens: 4096,
    system: HAUSSE_EXTRACTION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema: HAUSSE_EXTRACTION_JSON_SCHEMA } },
  };
}

function cleanString(value, max = 500) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}
function cleanNumber(value, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function cleanDate(value) {
  const date = cleanString(value, 10);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}
function cleanNpa(value) {
  const npa = cleanString(value, 10);
  return npa && /^\d{4}$/.test(npa) ? npa : null;
}
function cleanParty(value) {
  const party = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    nom: cleanString(party.nom, 250),
    prenom: cleanString(party.prenom, 250),
    adresse: cleanString(party.adresse, 250),
    npa: cleanNpa(party.npa),
    ville: cleanString(party.ville, 250),
  };
}
function triState(value) {
  const normalized = String(value || '').toLowerCase();
  return ['oui', 'non'].includes(normalized) ? normalized : 'inconnu';
}

export function normalizeHausseExtraction(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Extraction de hausse invalide');
  const cantonValue = String(raw.canton || '').toUpperCase();
  return {
    canton: ['VD', 'GE'].includes(cantonValue) ? cantonValue : null,
    npa: cleanNpa(raw.npa),
    commune: cleanString(raw.commune, 250),
    adresseImmeuble: cleanString(raw.adresseImmeuble, 300),
    dateNotificationHausse: cleanDate(raw.dateNotificationHausse),
    dateEffetHausse: cleanDate(raw.dateEffetHausse),
    loyerAvantHausse: cleanNumber(raw.loyerAvantHausse, 0, 100000),
    loyerApresHausse: cleanNumber(raw.loyerApresHausse, 0, 100000),
    chargesMensuelles: cleanNumber(raw.chargesMensuelles, 0, 50000),
    formuleHausseRecue: triState(raw.formuleHausseRecue),
    motifHausse: triState(raw.motifHausse),
    tauxReferenceBail: cleanNumber(raw.tauxReferenceBail, 0, 20),
    tauxReferenceNouveau: cleanNumber(raw.tauxReferenceNouveau, 0, 20),
    motifsInvoques: Array.isArray(raw.motifsInvoques)
      ? raw.motifsInvoques.map((value) => cleanString(value, 500)).filter(Boolean).slice(0, 20)
      : [],
    locataire: cleanParty(raw.locataire),
    bailleur: cleanParty(raw.bailleur),
    champs_incertains: Array.isArray(raw.champs_incertains)
      ? raw.champs_incertains.map((value) => cleanString(value, 100)).filter(Boolean).slice(0, 30)
      : [],
  };
}

export function parseHausseExtractionResponse(message) {
  if (message?.stop_reason === 'max_tokens' || message?.stop_reason === 'model_context_window_exceeded') {
    throw new Error('Réponse d’extraction tronquée');
  }
  const text = (Array.isArray(message?.content) ? message.content : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  if (!text) throw new Error('Réponse d’extraction vide');
  return normalizeHausseExtraction(JSON.parse(text));
}

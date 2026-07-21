const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

const EXTRACTION_PROMPT = `
Tu extrais des données d'un contrat de bail suisse et, éventuellement, de sa formule officielle.
Réponds uniquement avec un objet JSON valide. N'invente jamais une valeur : utilise null si elle n'est pas lisible.

Règles importantes :
- Distingue le logement loué de l'adresse actuelle du locataire et de l'adresse du bailleur.
- Le loyer net exclut les acomptes et forfaits de charges.
- La dateRemiseCles est la date d'entrée en jouissance ou de début du bail, au format YYYY-MM-DD.
- Le loyer précédent ne peut provenir que de la formule officielle.
- formuleOfficielleRecue vaut "oui" uniquement si le second document est bien une formule officielle de notification du loyer initial ; sinon "inconnu". Ne conclus jamais "non" de la seule absence d'un document.
- Ajoute à champs_incertains tout champ ambigu, calculé ou peu lisible.

Schéma exact :
{
  "canton": "VD" | "GE" | null,
  "npa": string | null,
  "commune": string | null,
  "adresseImmeuble": string | null,
  "dateRemiseCles": string | null,
  "loyerNetMensuel": number | null,
  "chargesMensuelles": number | null,
  "formuleOfficielleRecue": "oui" | "inconnu",
  "loyerPrecedentConnu": boolean,
  "loyerPrecedentNet": number | null,
  "tauxReferenceBail": number | null,
  "anneeConstruction": number | null,
  "locataire": { "nom": string|null, "prenom": string|null, "adresse": string|null, "npa": string|null, "ville": string|null },
  "bailleur": { "nom": string|null, "adresse": string|null, "npa": string|null, "ville": string|null },
  "champs_incertains": string[]
}`.trim();

function pdfBlock(data, title) {
  return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title };
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
  const p = value && typeof value === 'object' ? value : {};
  return {
    nom: cleanString(p.nom), prenom: cleanString(p.prenom), adresse: cleanString(p.adresse),
    npa: cleanNpa(p.npa), ville: cleanString(p.ville),
  };
}

function normalizeExtraction(raw, hasFormule) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('La réponse d’extraction est invalide.');
  const canton = raw.canton === 'VD' || raw.canton === 'GE' ? raw.canton : null;
  const loyerPrecedentNet = hasFormule ? cleanNumber(raw.loyerPrecedentNet, 0, 100000) : null;
  return {
    canton,
    npa: cleanNpa(raw.npa),
    commune: cleanString(raw.commune),
    adresseImmeuble: cleanString(raw.adresseImmeuble),
    dateRemiseCles: cleanDate(raw.dateRemiseCles),
    loyerNetMensuel: cleanNumber(raw.loyerNetMensuel, 0, 100000),
    chargesMensuelles: cleanNumber(raw.chargesMensuelles, 0, 50000),
    formuleOfficielleRecue: hasFormule && raw.formuleOfficielleRecue === 'oui' ? 'oui' : 'inconnu',
    loyerPrecedentConnu: loyerPrecedentNet !== null,
    loyerPrecedentNet,
    tauxReferenceBail: cleanNumber(raw.tauxReferenceBail, 0, 20),
    anneeConstruction: cleanNumber(raw.anneeConstruction, 1700, new Date().getFullYear() + 2),
    locataire: cleanParty(raw.locataire),
    bailleur: cleanParty(raw.bailleur),
    champs_incertains: Array.isArray(raw.champs_incertains)
      ? raw.champs_incertains.filter(v => typeof v === 'string').slice(0, 30)
      : [],
  };
}

function parseJsonResponse(text) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error('Le service d’extraction n’a pas renvoyé de JSON valide.');
  }
}

export async function extractBailDocuments({ bailB64, formuleB64 }, env = process.env) {
  if (!bailB64) return [400, { error: 'bailB64 requis' }];
  if (!env.ANTHROPIC_API_KEY) {
    return [503, { error: "Extraction réelle non configurée : ajoutez ANTHROPIC_API_KEY dans supabase/functions/.env. Aucune donnée fictive n'a été générée." }];
  }

  const content = [pdfBlock(bailB64, 'Contrat de bail')];
  if (formuleB64) content.push(pdfBlock(formuleB64, 'Formule officielle fournie séparément'));
  content.push({ type: 'text', text: 'Extrais les champs demandés à partir des documents fournis.' });

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: EXTRACTION_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      return [502, { error: `Échec du service d’extraction (${response.status}).`, detail }];
    }
    const data = await response.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    const extracted = normalizeExtraction(parseJsonResponse(text), Boolean(formuleB64));
    return [200, { extracted, extraction: { provider: 'anthropic', model: data.model || env.ANTHROPIC_MODEL } }];
  } catch (error) {
    return [502, { error: `Erreur pendant l’extraction : ${error instanceof Error ? error.message : String(error)}` }];
  }
}

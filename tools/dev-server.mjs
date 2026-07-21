/*
 * dev-server.mjs — serveur de développement unique pour Replit.
 *
 * Sert le front statique (web/) et proxifie /api/* vers la logique du mock
 * backend (tools/mock-backend.mjs), le tout sur un seul port (5000), pour
 * éviter les soucis CORS/host derrière le proxy Replit.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBailDocuments } from './extract-bail.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 5000);

// Charge les secrets locaux sans les exposer au navigateur.
for (const envPath of [path.join(__dirname, '..', '.env'), path.join(__dirname, '..', 'supabase', 'functions', '.env')]) {
  try {
    const source = fs.readFileSync(envPath, 'utf8');
    for (const line of source.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* fichier facultatif */ }
}

const letters = new Map();

const handlers = {
  'evaluate-baisse': (b) => {
    const tauxActuel = 1.25;
    const t = b.tauxReferenceBail;
    if (typeof b.loyerNetMensuel !== 'number') return [400, { error: 'loyerNetMensuel requis' }];
    if (t == null) return [200, { result: { eligible: false, tauxActuel, tauxBail: null, deltaPts: null, baisseEstimeePct: null, baisseEstimeeChf: null, procedure: [], avertissements: ['Taux de référence du bail inconnu.'] } }];
    if (t > tauxActuel) {
      const deltaPts = Math.round((t - tauxActuel) * 100) / 100;
      const pct = Math.round((deltaPts / 0.25) * 2.91 * 100) / 100;
      return [200, { result: { eligible: true, tauxActuel, tauxBail: t, deltaPts, baisseEstimeePct: pct, baisseEstimeeChf: Math.round((b.loyerNetMensuel * pct) / 100), procedure: ['…'], avertissements: [] } }];
    }
    return [200, { result: { eligible: false, tauxActuel, tauxBail: t, deltaPts: null, baisseEstimeePct: null, baisseEstimeeChf: null, procedure: [], avertissements: [] } }];
  },

  'extract-bail': (b) => extractBailDocuments(b),

  'evaluate': (b) => {
    const d = b.dossier;
    if (!d || !d.canton || !d.commune || !d.npa || !d.dateRemiseCles) return [400, { error: 'Champs obligatoires manquants' }];
    const motifs = [];
    const formuleManquante = d.formuleOfficielleRecue === 'non';
    const joursEcoules = Math.floor((Date.now() - new Date(d.dateRemiseCles).getTime()) / 86400000);
    if (formuleManquante)
      motifs.push({ code: 'formule_manquante', libelle: 'Formule officielle de fixation du loyer initial manquante', force: 'tres_forte', explication: "L'usage de la formule officielle est obligatoire à VD et GE. Son absence entraîne la nullité de la fixation du loyer initial." });
    const horsDelai = !formuleManquante && joursEcoules > 30;
    if (d.loyerPrecedentConnu && d.loyerPrecedentNet && d.loyerNetMensuel > d.loyerPrecedentNet * 1.1) {
      const h = ((d.loyerNetMensuel - d.loyerPrecedentNet) / d.loyerPrecedentNet * 100).toFixed(1);
      motifs.push({ code: 'hausse_sensible', libelle: `Hausse sensible de ${h} % par rapport au locataire précédent`, force: 'forte', explication: `Le loyer net passe de ${d.loyerPrecedentNet} à ${d.loyerNetMensuel} CHF (+${h} %).` });
    }
    motifs.push({ code: 'presomption_rendement', libelle: 'Doute sur le caractère non-excessif du rendement (art. 269 CO)', force: 'moyenne', explication: 'Le bailleur est sommé de produire son décompte de rendement net.' });
    const autorite = d.canton === 'GE'
      ? { nom: 'Commission de conciliation en matière de baux et loyers', adresse: "Rue de l'Athénée 6-8", casePostale: 'Case postale 3120', npa: '1211', ville: 'Genève 3', canton: 'GE' }
      : { nom: 'Préfecture du district de Lausanne', adresse: 'Place du Château 1', npa: '1014', ville: 'Lausanne', canton: 'VD' };
    const conclusions = horsDelai ? [] : [
      'Requérir de la partie bailleresse la production des pièces nécessaires à la détermination de la méthode applicable et à la vérification du caractère non abusif du loyer initial.',
      ...(formuleManquante ? ['Constater la nullité de la fixation du loyer initial (formule officielle non remise).'] : []),
      'Après examen des pièces, fixer le loyer initial net à un montant non abusif, sous réserve de préciser cette conclusion lorsque les données nécessaires seront disponibles.',
      "Ordonner à la partie bailleresse de restituer la différence entre le loyer payé et le loyer ainsi fixé, depuis l'entrée en jouissance.",
      'Adapter la garantie de loyer au montant du loyer ainsi fixé.',
    ];
    const avertissements = formuleManquante
      ? ['Formule manquante : contestation recevable en tout temps (délai de 30 jours inapplicable).']
      : horsDelai
        ? [`Délai de 30 jours dépassé (${joursEcoules} jours depuis la remise des clés).`]
        : d.formuleOfficielleRecue === 'inconnu'
          ? ["Formule officielle à vérifier : cherchez avec le bail et ses annexes. Si elle reste introuvable, demandez une copie écrite à la régie ou au propriétaire sans attendre leur réponse pour respecter un éventuel délai de contestation."]
          : [];
    const evaluation = {
      eligible: !horsDelai, horsDelai, requiertTraitementManuel: false, autorite,
      joursEcoules, motifs: horsDelai ? motifs.filter((m) => m.code === 'formule_manquante') : motifs, axeArgumentaire: horsDelai ? null : 'rendement_net',
      conclusions, avertissements, rendementAdmissiblePct: horsDelai ? null : 3.25,
    };
    return [200, { dossierId: 'mock-dossier-1', evaluation }];
  },

  'generate-letter': (b) => {
    if (!b.dossierId) return [400, { error: 'dossierId requis' }];
    const letterId = 'mock-letter-1';
    letters.set(letterId, { unlocked: false });
    return [200, { letterId, previews: [] }];
  },

  'create-checkout': (b) => {
    if (!b.dossierId || !b.letterId || !b.offer) return [400, { error: 'dossierId, letterId, offer requis' }];
    const l = letters.get(b.letterId); if (l) l.unlocked = true;
    return [200, { url: '/index.html?paid=1', sessionId: 'cs_mock_123' }];
  },

  'download-letter': (b) => {
    if (!b.letterId) return [400, { error: 'letterId requis' }];
    const l = letters.get(b.letterId);
    if (!l || !l.unlocked) return [402, { error: 'Paiement non confirmé' }];
    const PDF = 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCg==';
    return [200, { url: PDF, expiresInSeconds: 600 }];
  },
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(WEB_DIR, urlPath);
  if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

function handleApi(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
      'access-control-allow-methods': 'POST, GET, OPTIONS',
    }).end();
    return;
  }
  const m = req.url.match(/^\/api\/functions\/v1\/([\w-]+)/);
  if (!m || !handlers[m[1]]) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' })); return; }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400).end(JSON.stringify({ error: 'JSON invalide' })); return; }
    const [status, payload] = await handlers[m[1]](body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
    }).end(JSON.stringify(payload));
  });
}

http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  return serveStatic(req, res);
}).listen(PORT, '0.0.0.0', () => {
  console.log(`dev server on http://0.0.0.0:${PORT}`);
});

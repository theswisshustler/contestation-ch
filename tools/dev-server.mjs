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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, '..', 'web');
const PORT = Number(process.env.PORT || 5000);

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

  'extract-bail': (b) => {
    if (!b.bailB64) return [400, { error: 'bailB64 requis' }];
    return [200, { extracted: {
      canton: 'VD', npa: '1004', commune: 'Lausanne', adresseImmeuble: 'Avenue de la Gare 12',
      dateRemiseCles: new Date(Date.now() - 16 * 86400000).toISOString().slice(0, 10),
      loyerNetMensuel: 1980, chargesMensuelles: 160,
      formuleOfficielleRecue: 'non', loyerPrecedentConnu: true, loyerPrecedentNet: 1650,
      tauxReferenceBail: 1.75, anneeConstruction: 1972,
      locataire: { nom: 'Rochat', prenom: 'Camille', adresse: 'Avenue de la Gare 12', npa: '1004', ville: 'Lausanne' },
      bailleur: { nom: 'Régie Lémanique SA', adresse: 'Rue du Midi 3', npa: '1003', ville: 'Lausanne' },
      champs_incertains: ['dateRemiseCles', 'loyerPrecedentNet'],
    } }];
  },

  'evaluate': (b) => {
    const d = b.dossier;
    if (!d || !d.canton || !d.commune || !d.npa || !d.dateRemiseCles) return [400, { error: 'Champs obligatoires manquants' }];
    const motifs = [];
    if (d.formuleOfficielleRecue === 'non')
      motifs.push({ code: 'formule_manquante', libelle: 'Formule officielle de fixation du loyer initial manquante', force: 'tres_forte', explication: "L'usage de la formule officielle est obligatoire à VD et GE. Son absence entraîne la nullité de la fixation du loyer initial." });
    if (d.loyerPrecedentConnu && d.loyerPrecedentNet && d.loyerNetMensuel > d.loyerPrecedentNet * 1.1) {
      const h = ((d.loyerNetMensuel - d.loyerPrecedentNet) / d.loyerPrecedentNet * 100).toFixed(1);
      motifs.push({ code: 'hausse_sensible', libelle: `Hausse sensible de ${h} % par rapport au locataire précédent`, force: 'forte', explication: `Le loyer net passe de ${d.loyerPrecedentNet} à ${d.loyerNetMensuel} CHF (+${h} %).` });
    }
    motifs.push({ code: 'presomption_rendement', libelle: 'Doute sur le caractère non-excessif du rendement (art. 269 CO)', force: 'moyenne', explication: 'Le bailleur est sommé de produire son décompte de rendement net.' });
    const autorite = d.canton === 'GE'
      ? { nom: 'Commission de conciliation en matière de baux et loyers', adresse: "Rue de l'Athénée 6-8", casePostale: 'Case postale 3120', npa: '1211', ville: 'Genève 3', canton: 'GE' }
      : { nom: 'Préfecture du district de Lausanne', adresse: 'Place du Château 1', npa: '1014', ville: 'Lausanne', canton: 'VD' };
    const evaluation = {
      eligible: true, horsDelai: false, requiertTraitementManuel: false, autorite,
      joursEcoules: 16, motifs, axeArgumentaire: 'rendement_net',
      conclusions: ['Constater la nullité de la fixation du loyer initial.', 'Fixer le loyer initial à un montant non abusif.', 'Ordonner la production du décompte de rendement net.'],
      avertissements: ['Formule manquante : contestation recevable en tout temps.'], rendementAdmissiblePct: 3.25,
    };
    return [200, { dossierId: 'mock-dossier-1', evaluation }];
  },

  'generate-letter': (b) => {
    if (!b.dossierId) return [400, { error: 'dossierId requis' }];
    const letterId = 'mock-letter-1';
    letters.set(letterId, { unlocked: false });
    const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    return [200, { letterId, previews: [PNG] }];
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
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { res.writeHead(400).end(JSON.stringify({ error: 'JSON invalide' })); return; }
    const [status, payload] = handlers[m[1]](body);
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

/*
 * mock-backend.mjs — faux serveur des Edge Functions, pour développer et tester
 * le front sans projet Supabase live. Il reproduit les CONTRATS (formes de
 * requête/réponse + CORS + verrou de paiement), pas la logique juridique réelle.
 *
 *   node tools/mock-backend.mjs [port]     # défaut 8787
 *
 * Pointez web/config.js sur http://localhost:<port> pour l'utiliser.
 */
import http from 'node:http';

const PORT = Number(process.argv[2] || 8787);
const letters = new Map(); // letterId -> { unlocked }

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
};
const send = (res, status, body) =>
  res.writeHead(status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(body));

// 1x1 PNG transparent (aperçu factice) et PDF minimal (téléchargement factice).
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PDF = 'data:application/pdf;base64,JVBERi0xLjQKJcOkw7zDtsOfCg==';

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
    return [200, { letterId, previews: [PNG] }];
  },

  'create-checkout': (b) => {
    if (!b.dossierId || !b.letterId || !b.offer) return [400, { error: 'dossierId, letterId, offer requis' }];
    // Le vrai flux confirme via webhook Stripe ; ici on débloque tout de suite
    // et on renvoie une URL qui rentre dans l'app avec ?paid=1 (simule le retour).
    const l = letters.get(b.letterId); if (l) l.unlocked = true;
    return [200, { url: '/index.html?paid=1', sessionId: 'cs_mock_123' }];
  },

  'download-letter': (b) => {
    if (!b.letterId) return [400, { error: 'letterId requis' }];
    const l = letters.get(b.letterId);
    if (!l || !l.unlocked) return [402, { error: 'Paiement non confirmé' }];
    return [200, { url: PDF, expiresInSeconds: 600 }];
  },
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return res.writeHead(204, CORS).end();
  const m = req.url.match(/^\/functions\/v1\/([\w-]+)/);
  if (!m || !handlers[m[1]]) return send(res, 404, { error: 'not found' });
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { error: 'JSON invalide' }); }
    const [status, payload] = handlers[m[1]](body);
    send(res, status, payload);
  });
}).listen(PORT, () => console.log(`mock backend on http://localhost:${PORT}`));

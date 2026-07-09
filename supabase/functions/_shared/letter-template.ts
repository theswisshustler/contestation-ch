// Génération du HTML de la requête (format lettre suisse). Deux variantes :
//   letterHtml(...)      → lettre propre (→ PDF propre, bucket privé)
//   watermarkedHtml(...) → même lettre + filigranes diagonaux incrustés
//                          (→ screenshot PNG servi en preview)
//
// Le filigrane est rendu DANS le document (répété, sous le texte), donc il
// finit rastérisé dans le PNG : pas d'overlay CSS retirable côté client.

import type {
  DossierContestation,
  ResultatContestation,
} from './ruleset.ts';

function esc(s: string | number | null | undefined): string {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDateFr(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('fr-CH', { day: '2-digit', month: 'long', year: 'numeric' });
}

const BASE_CSS = `
  @page { size: A4; margin: 25mm 22mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Times New Roman', Georgia, serif; font-size: 11.5pt;
         color: #111; line-height: 1.5; margin: 0; }
  .expediteur { margin-bottom: 24px; }
  .destinataire { margin: 24px 0 8px auto; width: 60%; }
  .lieu-date { text-align: right; margin: 24px 0; }
  .objet { font-weight: bold; margin: 24px 0 12px; }
  h2 { font-size: 12pt; margin: 20px 0 6px; }
  ol.conclusions { margin: 8px 0 8px 18px; }
  ol.conclusions li { margin-bottom: 4px; }
  .motif { margin-bottom: 10px; }
  .motif .lib { font-weight: bold; }
  .signature { margin-top: 40px; }
  .signature img { max-height: 70px; }
  .footer-note { margin-top: 30px; font-size: 8.5pt; color: #666; border-top: 1px solid #ccc;
                 padding-top: 8px; }
`;

const WATERMARK_CSS = `
  .wm-layer { position: fixed; inset: 0; z-index: 0; pointer-events: none;
              display: grid; grid-template-columns: repeat(3, 1fr);
              align-content: space-around; }
  .wm-layer span { transform: rotate(-30deg); font-size: 22pt; font-weight: bold;
                   color: rgba(200, 30, 30, 0.18); white-space: nowrap;
                   text-align: center; letter-spacing: 2px; }
  .content { position: relative; z-index: 1; }
`;

export function letterHtml(d: DossierContestation, res: ResultatContestation): string {
  const a = res.autorite;
  const dest = a
    ? [a.nom, a.adresse, a.casePostale, `${a.npa} ${a.ville}`].filter(Boolean).map(esc).join('<br>')
    : '[Autorité de conciliation à compléter]';

  const motifs = res.motifs
    .map(
      (m) => `<div class="motif"><span class="lib">${esc(m.libelle)}.</span>
        ${esc(m.explication)}</div>`,
    )
    .join('\n');

  const conclusions = res.conclusions.map((c) => `<li>${esc(c)}</li>`).join('\n');

  const nomComplet = [d.locataire.prenom, d.locataire.nom].filter(Boolean).map(esc).join(' ');
  const lieu = esc(d.locataire.ville);
  const dateLettre = formatDateFr(new Date().toISOString());

  const signature = d.signatureDataUrl
    ? `<img src="${esc(d.signatureDataUrl)}" alt="signature" />`
    : '<div style="height:60px"></div>';

  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<style>${BASE_CSS}</style></head><body><div class="content">
  <div class="expediteur">
    ${nomComplet}<br>
    ${esc(d.locataire.adresse)}<br>
    ${esc(d.locataire.npa)} ${esc(d.locataire.ville)}
  </div>

  <div class="destinataire">${dest}</div>

  <div class="lieu-date">${lieu}, le ${dateLettre}</div>

  <div class="objet">
    Objet : Requête en contestation du loyer initial — ${esc(d.adresseImmeuble)}, ${esc(d.npa)} ${esc(d.commune)}
  </div>

  <p>Madame, Monsieur,</p>

  <p>Par la présente, j'ai l'honneur de saisir votre autorité d'une requête en
  contestation du loyer initial afférent au logement sis ${esc(d.adresseImmeuble)},
  ${esc(d.npa)} ${esc(d.commune)}, dont le loyer net mensuel s'élève à
  ${esc(d.loyerNetMensuel)} CHF (charges : ${esc(d.chargesMensuelles)} CHF),
  loué par ${esc(d.bailleur.nom)}.</p>

  <h2>En fait et en droit</h2>
  ${motifs}

  <h2>Conclusions</h2>
  <p>Cela étant, je conclus respectueusement à ce qu'il plaise à votre autorité :</p>
  <ol class="conclusions">${conclusions}</ol>

  <p>Dans l'attente d'une convocation en audience de conciliation, je vous prie
  d'agréer, Madame, Monsieur, mes salutations distinguées.</p>

  <div class="signature">
    ${signature}<br>
    ${nomComplet}
  </div>

  <div class="footer-note">
    Requête générée avec l'aide de contestation.ch — outil d'aide à la rédaction,
    sans valeur de conseil juridique. Le locataire demeure responsable du suivi
    de sa procédure (délais, réception, suites).
  </div>
</div></body></html>`;
}

export function watermarkedHtml(d: DossierContestation, res: ResultatContestation): string {
  const clean = letterHtml(d, res);
  const wmCells = Array.from({ length: 12 })
    .map(() => '<span>APERÇU — contestation.ch — payez pour débloquer</span>')
    .join('');
  const wmLayer = `<div class="wm-layer">${wmCells}</div>`;
  // Injecte le CSS filigrane + la couche répétée juste après <body>.
  return clean
    .replace('</style>', `${WATERMARK_CSS}</style>`)
    .replace('<body>', `<body>${wmLayer}`);
}

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
  .faits { margin: 8px 0 14px; border-collapse: collapse; width: 100%; }
  .faits td { padding: 4px 7px; border: 1px solid #bbb; vertical-align: top; }
  .faits td:first-child { width: 38%; font-weight: bold; background: #f4f4f4; }
  ol.conclusions { margin: 8px 0 8px 18px; }
  ol.conclusions li { margin-bottom: 10px; padding-left: 3px; }
  ol.conclusions .demande { font-weight: bold; }
  ol.conclusions .pourquoi { display: block; margin-top: 2px; color: #444; }
  .motif { margin-bottom: 10px; }
  .motif .lib { font-weight: bold; }
  .signature { margin-top: 40px; }
  .signature img { max-height: 70px; }
  .footer-note { margin-top: 30px; font-size: 8.5pt; color: #666; border-top: 1px solid #ccc;
                 padding-top: 8px; }
`;

const WATERMARK_CSS = `
  .wm-layer { position: fixed; inset: -8%; z-index: 2; pointer-events: none;
              display: grid; grid-template-columns: repeat(4, 1fr);
              align-content: space-around; }
  .wm-layer span { transform: rotate(-30deg); font-size: 14pt; font-weight: bold;
                   color: rgba(196, 61, 46, 0.22); white-space: nowrap;
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

  const conclusionPourquoi = (c: string): string => {
    if (c.startsWith('Requérir de la partie bailleresse')) return "obtenir les données qui manquent avant de déterminer si le loyer est abusif et à quel montant il doit être fixé.";
    if (c.startsWith('Constater la nullité')) return "faire réexaminer le loyer puisque la formule obligatoire ne m'a pas été remise.";
    if (c.startsWith('Après examen des pièces')) return "remplacer le montant contesté par le loyer que les pièces et la méthode juridique applicable permettront d'établir.";
    if (c.startsWith('Ordonner à la partie bailleresse')) return "me rembourser la différence éventuellement payée en trop depuis mon entrée dans le logement.";
    if (c.startsWith('Adapter la garantie')) return "recalculer la garantie bancaire sur la base du loyer finalement fixé.";
    return '';
  };
  const conclusionInstruction = res.conclusions.find((c) => c.startsWith('Requérir de la partie bailleresse')) || '';
  const conclusionsFond = res.conclusions.filter((c) => c !== conclusionInstruction);
  const renderConclusion = (c: string) => {
    const pourquoi = conclusionPourquoi(c);
    return `<li><span class="demande">${esc(c)}</span>${pourquoi ? `<span class="pourquoi">Concrètement, cette demande vise à ${esc(pourquoi)}</span>` : ''}</li>`;
  };
  const conclusions = conclusionsFond.map(renderConclusion).join('\n');

  const pieces = [
    'Copie du contrat de bail et de ses annexes.',
    ...(d.formuleOfficielleRecue === 'oui'
      ? ['Copie de la formule officielle de notification du loyer initial.']
      : []),
  ];
  const piecesHtml = pieces.map((p) => `<li>${esc(p)}</li>`).join('\n');

  const nomComplet = [d.locataire.prenom, d.locataire.nom].filter(Boolean).map(esc).join(' ');
  const lieu = esc(d.locataire.ville);
  const dateLettre = formatDateFr(new Date().toISOString());

  const signature = d.signatureDataUrl
    ? `<img src="${esc(d.signatureDataUrl)}" alt="signature" />`
    : '<div style="height:60px"></div>';

  const formule = d.formuleOfficielleRecue === 'oui'
    ? 'La formule officielle de notification du loyer initial a été remise.'
    : d.formuleOfficielleRecue === 'non'
      ? "La formule officielle de notification du loyer initial n'a pas été remise."
      : 'La remise de la formule officielle de notification du loyer initial doit encore être clarifiée.';
  const precedent = d.loyerPrecedentConnu && d.loyerPrecedentNet
    ? `${esc(d.loyerPrecedentNet)} CHF par mois`
    : 'Non connu / non communiqué';
  const recevabilite = d.formuleOfficielleRecue === 'non'
    ? "L'absence de remise de la formule officielle est invoquée et la nullité de la fixation du loyer initial est demandée."
    : res.joursEcoules != null
      ? `La présente requête est formée ${esc(res.joursEcoules)} jour(s) après la remise des clés, dans le délai prévu par l'art. 270 al. 1 CO.`
      : "La présente requête est fondée sur l'art. 270 CO.";

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
  contestation du loyer initial, conformément aux art. 269, 269a et 270 du Code
  des obligations (CO), et d'en demander la fixation à un montant non abusif.</p>

  <h2>I. Recevabilité</h2>
  <p>${recevabilite}</p>
  <p>Le logement se situe dans le canton de ${esc(d.canton)}, où la situation du
  marché du logement justifie l'examen de la contestation par l'autorité de
  conciliation. La compétence de votre autorité résulte du lieu de situation de
  l'immeuble.</p>

  <h2>II. Exposé des faits</h2>
  <table class="faits">
    <tr><td>Logement concerné</td><td>${esc(d.adresseImmeuble)}, ${esc(d.npa)} ${esc(d.commune)}</td></tr>
    <tr><td>Partie bailleresse / régie</td><td>${esc(d.bailleur.nom)}, ${esc(d.bailleur.adresse)}, ${esc(d.bailleur.npa)} ${esc(d.bailleur.ville)}</td></tr>
    <tr><td>Date de remise des clés</td><td>${formatDateFr(d.dateRemiseCles)}</td></tr>
    <tr><td>Loyer initial contesté</td><td>${esc(d.loyerNetMensuel)} CHF nets par mois, plus ${esc(d.chargesMensuelles)} CHF de charges</td></tr>
    <tr><td>Loyer précédent</td><td>${precedent}</td></tr>
    <tr><td>Formule officielle</td><td>${formule}</td></tr>
  </table>

  <p>Le loyer initial a été arrêté dans le contrat de bail sans que je dispose
  des données permettant de vérifier le prix de revient de l'immeuble, les fonds
  propres investis, les charges effectives et le rendement obtenu par la partie
  bailleresse. Ces éléments se trouvent dans la sphère de celle-ci.</p>

  <h2>III. Motifs de la contestation</h2>
  ${motifs}

  <p>Au regard de ces éléments, le caractère abusif ou non du loyer ne peut pas
  être vérifié en l'état, les données déterminantes se trouvant principalement
  en mains de la partie bailleresse.</p>

  <p>Je sollicite dès lors la production de toutes les pièces permettant de déterminer
  la méthode de contrôle applicable et d'effectuer ce contrôle, notamment le titre et
  la date d'acquisition de l'immeuble, son prix d'acquisition ou de revient, le financement,
  les fonds propres investis et réévalués, les investissements ultérieurs, ainsi que les
  charges immobilières détaillées et les états locatifs utiles. Si la partie bailleresse
  entend se prévaloir des loyers usuels de la localité ou du quartier, je sollicite la
  production des objets de comparaison et de leurs caractéristiques justificatives.</p>

  <h2>IV. Mes demandes à l'autorité de conciliation</h2>
  <p><strong>A. Préalablement — obtenir les éléments nécessaires au contrôle</strong></p>
  <ol class="conclusions">${conclusionInstruction ? renderConclusion(conclusionInstruction) : ''}</ol>
  <p>Cette demande préalable ne suppose pas que le caractère abusif du loyer soit déjà établi. Elle doit permettre de vérifier le loyer selon la méthode applicable.</p>

  <p><strong>B. Au fond — après examen des pièces</strong></p>
  <p>Sur la base du résultat de cette instruction, je prends les conclusions suivantes :</p>
  <ol class="conclusions">${conclusions}</ol>

  <h2>V. Documents que je joins à cette requête</h2>
  <p>Je transmets à l'autorité, avec la présente lettre, les documents suivants :</p>
  <ol>${piecesHtml}</ol>

  <p>Je me réserve la faculté de compléter la présente requête et mes moyens
  après production des pièces par la partie bailleresse.</p>

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
  const wmCells = Array.from({ length: 32 })
    .map(() => '<span>APERÇU — NON VALABLE — contestation.ch</span>')
    .join('');
  const wmLayer = `<div class="wm-layer">${wmCells}</div>`;
  // Injecte le CSS filigrane + la couche répétée juste après <body>.
  return clean
    .replace('</style>', `${WATERMARK_CSS}</style>`)
    .replace('<body>', `<body>${wmLayer}`);
}

const authority = (d) => d.canton === 'GE'
  ? { nom: 'Commission de conciliation en matière de baux et loyers', adresse: "Rue de l'Athénée 6-8", casePostale: 'Case postale 3120', npa: '1211', ville: 'Genève 3', canton: 'GE' }
  : { nom: 'Préfecture du district de Lausanne', adresse: 'Place du Château 1', npa: '1014', ville: 'Lausanne', canton: 'VD' };

export function mockEvaluateDossier(d) {
  if (!d || !d.kind || d.kind === 'loyer_initial') return null;
  if (!d.canton || !d.commune || !d.npa || !d.adresseImmeuble) return [400, { error: 'Adresse complète requise' }];
  if (d.typeBail !== 'ordinaire') return [200, { dossierId: 'mock-dossier-1', evaluation: { kind: d.kind, eligible: false, horsDelai: false, requiertTraitementManuel: true, autorite: null, motifs: [], conclusions: [], avertissements: ['Ce type de bail exige une vérification humaine.'] } }];
  if (d.kind === 'hausse_loyer') {
    const jours = Math.floor((Date.now() - new Date(d.dateNotificationHausse).getTime()) / 86400000);
    const horsDelai = jours > 30;
    const pct = Math.round(((d.loyerApresHausse - d.loyerAvantHausse) / d.loyerAvantHausse) * 10000) / 100;
    const motifs = [{ code: 'hausse_calcul', libelle: `Calcul de la hausse de ${pct.toFixed(2)} % à vérifier`, force: 'moyenne', explication: 'Le calcul doit correspondre aux motifs annoncés et intégrer les facteurs de baisse.' }, { code: 'hausse_compensations', libelle: 'Facteurs de baisse à prendre en compte', force: 'moyenne', explication: 'Le taux de référence et les autres réductions de coûts doivent être pris en compte.' }];
    if (d.formuleHausseRecue === 'non') motifs.unshift({ code: 'hausse_forme', libelle: 'Notification sans formule officielle', force: 'tres_forte', explication: 'La forme légale de la notification doit être contrôlée.' });
    return [200, { dossierId: 'mock-dossier-1', evaluation: { kind: d.kind, eligible: !horsDelai, horsDelai, requiertTraitementManuel: false, autorite: authority(d), joursEcoules: jours, motifs, conclusions: horsDelai ? [] : ['Déclarer recevable la contestation.', 'Annuler ou réduire la hausse au montant justifié.'], avertissements: horsDelai ? ['Délai de 30 jours dépassé.'] : [], estimationPct: pct, estimationChf: d.loyerApresHausse - d.loyerAvantHausse } }];
  }
  const tauxActuel = 1.25;
  if (!(d.tauxReferenceBail > tauxActuel)) return [200, { dossierId: 'mock-dossier-1', evaluation: { kind: d.kind, eligible: false, horsDelai: false, requiertTraitementManuel: false, autorite: null, motifs: [], conclusions: [], avertissements: ["Le taux du loyer n'est pas supérieur au taux actuel."] } }];
  const rise = Math.round((d.tauxReferenceBail - tauxActuel) / 0.25) * 3;
  const pct = Math.round((rise / (100 + rise)) * 10000) / 100;
  return [200, { dossierId: 'mock-dossier-1', evaluation: { kind: d.kind, eligible: true, horsDelai: false, requiertTraitementManuel: false, autorite: null, motifs: [{ code: 'baisse_taux', libelle: `Taux du loyer supérieur au taux actuel de ${tauxActuel} %`, force: 'forte', explication: 'Une adaptation du loyer peut être demandée.' }], conclusions: [`Réduire le loyer net d'environ ${pct.toFixed(2)} %.`, 'Répondre dans les 30 jours.'], avertissements: ['Les autres facteurs de coûts peuvent modifier le résultat.'], estimationPct: pct, estimationChf: Math.round(d.loyerNetMensuel * pct) / 100 } }];
}

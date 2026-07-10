// app.js — component logic ported verbatim from Contestation.dc.html
// (state machine + evaluation ruleset). Rendered by web/support.js.

class Component extends DCLogic {
  state = {
    screen: 'landing',
    loyer: '', taux: '', calcLoading: false, calcRes: null,
    parcours: null,
    step: 0,
    importState: 'upload',
    data: {
      canton: '', commune: '', npa: '', adresse: '',
      dateCles: '', loyerNet: '', charges: '',
      formule: '', loyerPrecConnu: null, loyerPrec: '',
      tauxRef: '', tauxRefInconnu: false, annee: '',
      locNom: '', locPrenom: '', locAdresse: '', locNpa: '', locVille: '', locEmail: '',
      regNom: '', regAdresse: '', regNpa: '', regVille: '',
    },
    offre: null,
  };

  TAUX_ACTUEL = 1.25;

  num(v) { const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n; }
  fmt(n) { return Math.round(n).toLocaleString('fr-CH').replace(/[\u202f\u00a0,]/g, '\u2019'); }

  computeBaisse(loyer, taux) {
    const l = this.num(loyer), t = this.num(taux);
    if (!l || t == null) return { error: true };
    if (t > this.TAUX_ACTUEL) {
      const delta = Math.round((t - this.TAUX_ACTUEL) * 100) / 100;
      const pct = Math.round((delta / 0.25) * 2.91 * 10) / 10;
      return { eligible: true, delta, pct, chf: Math.round((l * pct) / 100) };
    }
    return { eligible: false };
  }

  checkCalc() {
    this.setState({ calcLoading: true, calcRes: null });
    const { loyer, taux } = this.state;
    setTimeout(() => this.setState({ calcLoading: false, calcRes: this.computeBaisse(loyer, taux) }), 1150);
  }

  go(screen) { this.setState({ screen }); }
  setD(key, val) { this.setState(s => ({ data: { ...s.data, [key]: val } })); }

  next() { this.setState(s => (s.step >= 10 ? { screen: 'diagnostic', result: this.evaluate(s.data) } : { step: s.step + 1 })); }
  prev() { this.setState(s => (s.step <= 0 ? { screen: 'choix' } : { step: s.step - 1 })); }

  daysAgoISO(n) { const dt = new Date(Date.now() - n * 86400000); return dt.toISOString().slice(0, 10); }

  initSig(node) {
    const ctx = node.getContext('2d');
    ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#12303F';
    let drawing = false, last = null;
    const pos = (e) => { const r = node.getBoundingClientRect(); return { x: (e.clientX - r.left) * (node.width / r.width), y: (e.clientY - r.top) * (node.height / r.height) }; };
    node.addEventListener('pointerdown', (e) => { drawing = true; last = pos(e); node.setPointerCapture(e.pointerId); if (!this.state.sigDrawn) this.setState({ sigDrawn: true }); e.preventDefault(); });
    node.addEventListener('pointermove', (e) => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(p.x, p.y); ctx.stroke(); last = p; e.preventDefault(); });
    node.addEventListener('pointerup', () => { drawing = false; });
    node.addEventListener('pointerleave', () => { drawing = false; });
    this._sigNode = node; this._sigCtx = ctx;
  }
  clearSig() { if (this._sigNode) this._sigCtx.clearRect(0, 0, this._sigNode.width, this._sigNode.height); this.setState({ sigDrawn: false }); }
  validateSig() { if (this._sigNode) this.setD('signatureData', this._sigNode.toDataURL()); this.setState({ screen: 'checkout' }); }

  startAnalyse() {
    this.setState({ importState: 'analyse', analyseStep: 0 });
    [700, 1400, 2100].forEach((ms, i) => setTimeout(() => this.setState({ analyseStep: i + 1 }), ms));
    setTimeout(() => {
      this.setState(s => ({
        importState: 'validation',
        data: {
          ...s.data,
          canton: 'VD', commune: 'Lausanne', npa: '1004', adresse: 'Avenue de la Gare 12',
          dateCles: this.daysAgoISO(16), loyerNet: '1980', charges: '160',
          formule: 'non', loyerPrecConnu: true, loyerPrec: '1650',
          tauxRef: '1.75', annee: '1972',
          locNom: 'Rochat', locPrenom: 'Camille', locAdresse: 'Avenue de la Gare 12', locNpa: '1004', locVille: 'Lausanne', locEmail: 'camille.rochat@example.ch',
          regNom: 'Régie Lémanique SA', regAdresse: 'Rue du Midi 3', regNpa: '1003', regVille: 'Lausanne',
        },
      }));
    }, 2900);
  }

  // ── Ruleset porté du module TS (source de vérité) ──
  GE_AUTHORITY = { nom: 'Commission de conciliation en matière de baux et loyers', adresse: "Rue de l'Athénée 6-8", casePostale: 'Case postale 3120', npa: '1211', ville: 'Genève 3', canton: 'GE' };
  VD_PREFECTURES = {
    lausanne: { nom: 'Préfecture du district de Lausanne', adresse: 'Place du Château 1', npa: '1014', ville: 'Lausanne', canton: 'VD' },
    ouest_lausannois: { nom: "Préfecture du district de l'Ouest lausannois", adresse: 'Rue de Verdeaux 2', casePostale: 'Case postale 285', npa: '1020', ville: 'Renens 1', canton: 'VD' },
    morges: { nom: 'Préfecture du district de Morges', adresse: 'Place Saint-Louis 4', npa: '1110', ville: 'Morges 1', canton: 'VD' },
    nyon: { nom: 'Préfecture du district de Nyon', adresse: 'Rue Juste-Olivier 8', casePostale: 'Case postale 1332', npa: '1260', ville: 'Nyon 1', canton: 'VD' },
    jura_nord_vaudois: { nom: 'Préfecture du district du Jura-Nord vaudois', adresse: 'Rue des Moulins 10', casePostale: 'Case postale 1094', npa: '1401', ville: 'Yverdon-les-Bains', canton: 'VD' },
    riviera_pays_denhaut: { nom: "Préfecture du district de la Riviera – Pays-d'Enhaut", adresse: 'Rue du Simplon 22', npa: '1800', ville: 'Vevey', canton: 'VD' },
    lavaux_oron: { nom: 'Préfecture du district de Lavaux-Oron', adresse: 'Chemin de Versailles 6', npa: '1096', ville: 'Cully', canton: 'VD' },
    aigle: { nom: "Préfecture du district d'Aigle", adresse: 'Place du Marché 2', npa: '1860', ville: 'Aigle', canton: 'VD' },
    gros_de_vaud: { nom: 'Préfecture du district du Gros-de-Vaud', adresse: 'Place Emile Gardaz 8', npa: '1040', ville: 'Echallens', canton: 'VD' },
    broye_vully: { nom: 'Préfecture du district de la Broye-Vully', adresse: 'Rue du Temple 6', casePostale: 'Case postale 336', npa: '1530', ville: 'Payerne', canton: 'VD' },
  };
  VD_MAP = {
    'lausanne': 'lausanne', 'le mont-sur-lausanne': 'lausanne', 'epalinges': 'lausanne', 'cheseaux-sur-lausanne': 'lausanne', 'romanel-sur-lausanne': 'lausanne',
    'renens': 'ouest_lausannois', 'bussigny': 'ouest_lausannois', 'crissier': 'ouest_lausannois', 'ecublens': 'ouest_lausannois', 'prilly': 'ouest_lausannois', 'chavannes-pres-renens': 'ouest_lausannois',
    'morges': 'morges', 'saint-prex': 'morges', 'preverenges': 'morges', 'aubonne': 'morges', 'cossonay': 'morges', 'lonay': 'morges', 'echichens': 'morges',
    'nyon': 'nyon', 'gland': 'nyon', 'rolle': 'nyon', 'prangins': 'nyon', 'coppet': 'nyon', 'founex': 'nyon', 'begnins': 'nyon',
    'yverdon-les-bains': 'jura_nord_vaudois', 'grandson': 'jura_nord_vaudois', 'orbe': 'jura_nord_vaudois', 'vallorbe': 'jura_nord_vaudois',
    'vevey': 'riviera_pays_denhaut', 'montreux': 'riviera_pays_denhaut', 'la tour-de-peilz': 'riviera_pays_denhaut', 'blonay-saint-legier': 'riviera_pays_denhaut',
    'pully': 'lavaux_oron', 'lutry': 'lavaux_oron', 'paudex': 'lavaux_oron', 'belmont-sur-lausanne': 'lavaux_oron', 'savigny': 'lavaux_oron', 'oron': 'lavaux_oron',
    'aigle': 'aigle', 'bex': 'aigle', 'ollon': 'aigle', 'villeneuve': 'aigle', 'leysin': 'aigle',
    'echallens': 'gros_de_vaud', 'assens': 'gros_de_vaud', 'bottens': 'gros_de_vaud',
    'payerne': 'broye_vully', 'avenches': 'broye_vully', 'moudon': 'broye_vully', 'lucens': 'broye_vully',
  };
  normalizeCommune(c) { return String(c || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+vd$/, '').replace(/\s+/g, ' '); }
  resolveAutorite(canton, commune) {
    if (canton === 'GE') return this.GE_AUTHORITY;
    if (canton === 'VD') { const d = this.VD_MAP[this.normalizeCommune(commune)]; return d ? this.VD_PREFECTURES[d] : null; }
    return null;
  }

  evaluate(d) {
    const res = { eligible: false, horsDelai: false, manuel: false, autorite: null, jours: null, motifs: [], axe: null, conclusions: [], avertissements: [], rendementPct: null };
    res.autorite = this.resolveAutorite(d.canton, d.commune);
    if (!res.autorite) { res.manuel = true; res.avertissements.push("Autorité de conciliation introuvable pour cette commune — nous traitons votre cas à la main."); }

    const loyer = this.num(d.loyerNet) || 0;
    const prec = this.num(d.loyerPrec);
    const cles = d.dateCles ? new Date(d.dateCles) : null;
    const jours = cles ? Math.floor((Date.now() - cles.getTime()) / 86400000) : null;
    res.jours = jours;

    const formuleManquante = d.formule === 'non';
    if (formuleManquante) {
      res.motifs.push({ code: 'formule_manquante', libelle: 'Formule officielle de fixation du loyer initial manquante', force: 'tres_forte',
        explication: "L'usage de la formule officielle est obligatoire à VD et GE. Son absence entraîne la nullité de la fixation du loyer initial : contestable en tout temps, trop-perçu réclamable jusqu'à 10 ans." });
    } else if (d.formule === 'inconnu') {
      res.avertissements.push("Réception de la formule officielle non confirmée — à clarifier (motif potentiel de nullité).");
    }

    if (!formuleManquante && jours != null && jours > 30) {
      res.horsDelai = true; res.eligible = false;
      res.avertissements.push(`Délai de 30 jours dépassé (${jours} jours depuis la remise des clés). La contestation du loyer initial est vraisemblablement irrecevable.`);
      return res;
    } else if (formuleManquante) {
      res.avertissements.push("Formule manquante : contestation recevable en tout temps (délai de 30 jours inapplicable).");
    }

    const conditions = [];
    if (d.canton === 'VD' || d.canton === 'GE') conditions.push('penurie');
    if (d.loyerPrecConnu && prec && prec > 0) {
      const hausse = (loyer - prec) / prec;
      if (hausse > 0.10) {
        conditions.push('hausse');
        res.motifs.push({ code: 'hausse_sensible', libelle: `Hausse sensible de ${(hausse * 100).toFixed(1)} % par rapport au locataire précédent`, force: 'forte',
          explication: `Le loyer net passe de ${this.fmt(prec)} à ${this.fmt(loyer)} CHF (+${(hausse * 100).toFixed(1)} %). Une hausse supérieure à 10 % sans travaux à plus-value constitue un indice d'abus (art. 270 al. 1 let. b CO).` });
      }
    }
    if (conditions.length > 0) res.eligible = true; else { res.manuel = true; res.avertissements.push("Aucune condition matérielle clairement remplie — traitement manuel."); }

    res.motifs.push({ code: 'presomption_rendement', libelle: "Doute sur le caractère non-excessif du rendement (art. 269 CO)", force: 'moyenne',
      explication: "Le loyer paraît susceptible de procurer un rendement net excessif. Le bailleur est sommé de produire son décompte de rendement net. À défaut de collaboration, l'autorité statue en équité." });

    res.rendementPct = this.TAUX_ACTUEL + 2;
    if (d.annee) { const age = new Date().getFullYear() - this.num(d.annee); res.axe = age >= 30 ? 'loyers_usuels' : (age <= 10 ? 'rendement_brut' : 'rendement_net'); } else res.axe = 'rendement_net';

    const order = { tres_forte: 3, forte: 2, moyenne: 1, faible: 0 };
    res.motifs.sort((a, b) => order[b.force] - order[a.force]);
    res.conclusions = [];
    if (formuleManquante) res.conclusions.push("Constater la nullité de la fixation du loyer initial (formule officielle non remise).");
    res.conclusions.push("Constater le caractère abusif du loyer initial.", "Fixer le loyer initial à un montant non abusif.", "Ordonner au bailleur de produire le décompte de rendement net.", "Condamner le bailleur à restituer le trop-perçu depuis l'entrée en jouissance.", "Adapter en conséquence la garantie de loyer.");
    return res;
  }

  FORCE_UI = {
    tres_forte: { label: 'TRÈS FORT', color: '#C43D2E', bg: '#FBEAE7', bar: '#C43D2E' },
    forte: { label: 'FORT', color: '#7A5406', bg: '#FFF3DF', bar: '#F4A73B' },
    moyenne: { label: 'MOYEN', color: '#1B4965', bg: '#EAF1F5', bar: '#1B4965' },
    faible: { label: 'FAIBLE', color: '#5A6A70', bg: '#F1F0EB', bar: '#8A979C' },
  };

  renderVals() {
    const st = this.state, r = st.calcRes, rr = st.result;
    const motifsUI = rr ? rr.motifs.map(m => ({ libelle: m.libelle, explication: m.explication, ...this.FORCE_UI[m.force] })) : [];
    const aut = rr && rr.autorite;
    return {
      isDiagnostic: st.screen === 'diagnostic',
      diagEligible: !!(rr && rr.eligible && !rr.horsDelai),
      diagHorsDelai: !!(rr && rr.horsDelai),
      diagManuel: !!(rr && rr.manuel && !rr.eligible && !rr.horsDelai),
      diagMotifsCount: motifsUI.length,
      motifs: motifsUI,
      conclusions: rr ? rr.conclusions : [],
      avertissements: rr ? rr.avertissements : [],
      hasAvert: !!(rr && rr.avertissements.length),
      autPresent: !!aut,
      autNom: aut ? aut.nom : '',
      autAdresse: aut ? aut.adresse : '',
      autCase: aut && aut.casePostale ? aut.casePostale : '',
      autVille: aut ? `${aut.npa} ${aut.ville}` : '',
      autType: aut && aut.canton === 'GE' ? 'Commission cantonale de conciliation' : 'Préfecture du district',
      goApercu: () => this.go('apercu'),
      // apercu + offres
      isApercu: st.screen === 'apercu',
      wmTiles: Array.from({ length: 40 }, (_, i) => i),
      letterNom: `${st.data.locPrenom || 'Camille'} ${st.data.locNom || 'Rochat'}`.trim(),
      letterAdr: st.data.locAdresse || 'Avenue de la Gare 12',
      letterVille: `${st.data.locNpa || '1004'} ${st.data.locVille || 'Lausanne'}`,
      letterAutNom: aut ? aut.nom : 'Commission de conciliation en matière de baux et loyers',
      letterAutAdr: aut ? aut.adresse : "Rue de l'Athénée 6-8",
      letterAutVille: aut ? `${aut.npa} ${aut.ville}` : '1211 Genève 3',
      lieuDate: `${st.data.locVille || 'Lausanne'}, le ${new Date().toLocaleDateString('fr-CH', { day: '2-digit', month: 'long', year: 'numeric' })}`,
      selectOffre5: () => this.setState({ offre: '5', screen: 'checkout' }),
      selectOffre35: () => this.setState({ offre: '35', screen: 'signature' }),
      // signature
      isSignature: st.screen === 'signature',
      sigDrawn: !!st.sigDrawn,
      sigRef: (node) => { if (node && !node.__sigInit) { node.__sigInit = true; this.initSig(node); } },
      clearSig: () => this.clearSig(),
      validateSig: () => this.validateSig(),
      // checkout
      isCheckout: st.screen === 'checkout',
      offre: st.offre,
      offrePrice: st.offre === '35' ? '35.00' : '5.00',
      offreTitle: st.offre === '35' ? "Envoi en recommandé" : "Lettre à imprimer",
      offreDesc: st.offre === '35' ? "On imprime et on poste pour vous" : "PDF final à imprimer vous-même",
      isTwint: st.payMethod !== 'carte',
      isCarte: st.payMethod === 'carte',
      twintBorder: st.payMethod !== 'carte' ? '#1B4965' : '#E4E2DB',
      twintBg: st.payMethod !== 'carte' ? '#EAF1F5' : '#fff',
      carteBorder: st.payMethod === 'carte' ? '#1B4965' : '#E4E2DB',
      carteBg: st.payMethod === 'carte' ? '#EAF1F5' : '#fff',
      trackNum: 'RR ' + '98 072 145 6 CH',
      setTwint: () => this.setState({ payMethod: 'twint' }),
      setCarte: () => this.setState({ payMethod: 'carte' }),
      payLoading: !!st.payLoading,
      payNow: () => { this.setState({ payLoading: true }); setTimeout(() => this.setState({ payLoading: false, screen: 'succes' }), 1700); },
      // succès / dashboard
      isSucces: st.screen === 'succes',
      isDashboard: st.screen === 'dashboard',
      is35: st.offre === '35',
      is5: st.offre !== '35',
      goDashboard: () => this.go('dashboard'),
      goCheckout: () => this.go('checkout'),
      tauxActuel: '1,25',
      isLanding: st.screen === 'landing',
      isChoix: st.screen === 'choix',
      isManuel: st.screen === 'manuel',
      isImport: st.screen === 'import',
      // calc
      loyer: st.loyer, taux: st.taux,
      onLoyer: (e) => this.setState({ loyer: e.target.value }),
      onTaux: (e) => this.setState({ taux: e.target.value }),
      checkCalc: () => this.checkCalc(),
      calcLoading: st.calcLoading,
      calcElig: !!(r && r.eligible),
      calcNo: !!(r && !r.eligible && !r.error),
      calcErr: !!(r && r.error),
      calcPct: r && r.eligible ? String(r.pct).replace('.', ',') : '',
      calcChf: r && r.eligible ? this.fmt(r.chf) : '',
      // nav
      goLanding: () => this.go('landing'),
      goChoix: () => this.go('choix'),
      goManuel: () => this.setState({ screen: 'manuel', parcours: 'manuel', step: 0 }),
      goImport: () => this.setState({ screen: 'import', parcours: 'import', importState: 'upload' }),
      // import flow
      importUpload: st.screen === 'import' && st.importState === 'upload',
      importAnalyse: st.screen === 'import' && st.importState === 'analyse',
      importValidation: st.screen === 'import' && st.importState === 'validation',
      bailFilled: !!st.bailFilled,
      formuleFilled: !!st.formuleFilled,
      bailNotFilled: !st.bailFilled,
      formuleNotFilled: !st.formuleFilled,
      uploadBail: () => this.setState({ bailFilled: true }),
      uploadFormule: () => this.setState({ formuleFilled: true }),
      startAnalyse: () => this.startAnalyse(),
      an0: (st.analyseStep || 0) >= 1, an1: (st.analyseStep || 0) >= 2, an2: (st.analyseStep || 0) >= 3,
      goDiagnostic: () => this.setState(s => ({ screen: 'diagnostic', result: this.evaluate(s.data) })),
      goCgv: () => this.go('cgv'),
      goPrivacy: () => this.go('privacy'),
      isCgv: st.screen === 'cgv',
      isPrivacy: st.screen === 'privacy',
      // manual flow
      d: st.data,
      step: st.step,
      stepLabel: `${st.step + 1} / 11`,
      progress: `${(((st.step + 1) / 11) * 100).toFixed(0)}%`,
      next: () => this.next(),
      prev: () => this.prev(),
      isStep0: st.step === 0, isStep1: st.step === 1, isStep2: st.step === 2, isStep3: st.step === 3,
      isStep4: st.step === 4, isStep5: st.step === 5, isStep6: st.step === 6, isStep7: st.step === 7,
      isStep8: st.step === 8, isStep9: st.step === 9, isStep10: st.step === 10,
      chooseCantonVD: () => { this.setD('canton', 'VD'); this.next(); },
      chooseCantonGE: () => { this.setD('canton', 'GE'); this.next(); },
      chooseFormuleOui: () => { this.setD('formule', 'oui'); this.next(); },
      chooseFormuleNon: () => { this.setD('formule', 'non'); this.next(); },
      chooseFormuleInconnu: () => { this.setD('formule', 'inconnu'); this.next(); },
      choosePrecOui: () => { this.setD('loyerPrecConnu', true); },
      choosePrecNon: () => { this.setD('loyerPrecConnu', false); this.setD('loyerPrec', ''); this.next(); },
      precOui: st.data.loyerPrecConnu === true,
      showManuelCta: [1, 2, 3, 4, 7, 8, 9, 10].includes(st.step) || (st.step === 6 && st.data.loyerPrecConnu === true),
      ctaLabel: st.step === 10 ? 'Voir mon diagnostic →' : 'Continuer',
      toggleTauxInconnu: () => this.setState(s => ({ data: { ...s.data, tauxRefInconnu: !s.data.tauxRefInconnu, tauxRef: !s.data.tauxRefInconnu ? '' : s.data.tauxRef } })),
      tauxInconnu: st.data.tauxRefInconnu,
      onCommune: (e) => this.setD('commune', e.target.value),
      onNpa: (e) => this.setD('npa', e.target.value),
      onAdresse: (e) => this.setD('adresse', e.target.value),
      onDateCles: (e) => this.setD('dateCles', e.target.value),
      onLoyerNet: (e) => this.setD('loyerNet', e.target.value),
      onCharges: (e) => this.setD('charges', e.target.value),
      onLoyerPrec: (e) => this.setD('loyerPrec', e.target.value),
      onTauxRef: (e) => this.setD('tauxRef', e.target.value),
      onAnnee: (e) => this.setD('annee', e.target.value),
      onLocNom: (e) => this.setD('locNom', e.target.value),
      onLocPrenom: (e) => this.setD('locPrenom', e.target.value),
      onLocAdresse: (e) => this.setD('locAdresse', e.target.value),
      onLocNpa: (e) => this.setD('locNpa', e.target.value),
      onLocVille: (e) => this.setD('locVille', e.target.value),
      onLocEmail: (e) => this.setD('locEmail', e.target.value),
      onRegNom: (e) => this.setD('regNom', e.target.value),
      onRegAdresse: (e) => this.setD('regAdresse', e.target.value),
      onRegNpa: (e) => this.setD('regNpa', e.target.value),
      onRegVille: (e) => this.setD('regVille', e.target.value),
    };
  }
}

window.__bootDC(Component);

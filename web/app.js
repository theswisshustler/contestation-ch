// app.js — logique d'écran du front contestation.ch.
//
// La logique métier (ruleset, autorités, éligibilité, génération de lettre,
// verrou de paiement) vit CÔTÉ SERVEUR dans les Edge Functions Supabase. Ce
// composant ne fait que collecter les saisies, appeler l'API (voir api.js) et
// afficher les résultats renvoyés. Aucune règle juridique n'est dupliquée ici.

class Component extends DCLogic {
  state = {
    screen: 'landing',
    loyer: '', taux: '', calcLoading: false, calcRes: null, tauxActuel: null,
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
      signatureData: null,
    },
    // dossier serveur
    dossierId: null, letterId: null, previewUrl: '',
    // upload import
    bailB64: null, formuleB64: null, bailName: '', formuleName: '',
    // offre / paiement
    offre: null,
    // UI transverse
    busy: false, errorMsg: '',
    // validation flux manuel
    stepErrors: {},
  };

  constructor() {
    super();
    this.resumeFromReturn();
    if (!API.isConfigured()) {
      this.state.errorMsg =
        'Back-end non configuré : renseignez web/config.js (SUPABASE_URL, SUPABASE_ANON_KEY).';
    }
  }

  // ── helpers de format (UI uniquement) ──────────────────────────────
  num(v) { const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n; }
  fmt(n) { return Math.round(n).toLocaleString('fr-CH').replace(/[\u202f\u00a0,]/g, '\u2019'); }

  go(screen) { this.setState({ screen }); }
  setD(key, val) { this.setState(s => ({ data: { ...s.data, [key]: val }, stepErrors: {} })); }
  fail(e) {
    console.error(e);
    this.setState({ busy: false, calcLoading: false, payLoading: false, errorMsg: (e && e.message) || 'Une erreur est survenue.' });
  }

  // ── persistance légère (survie au round-trip Stripe) ───────────────
  persist(patch) {
    try {
      const cur = JSON.parse(localStorage.getItem('cc_session') || '{}');
      localStorage.setItem('cc_session', JSON.stringify({ ...cur, ...patch }));
    } catch (_) { /* stockage indisponible : on continue sans */ }
  }
  resumeFromReturn() {
    let q;
    try { q = new URLSearchParams(location.search); } catch (_) { return; }
    if (!q.get('session_id') && !q.get('paid')) return;
    let s = {};
    try { s = JSON.parse(localStorage.getItem('cc_session') || '{}'); } catch (_) {}
    this.state.screen = 'succes';
    this.state.offre = s.offre || this.state.offre;
    this.state.dossierId = s.dossierId || null;
    this.state.letterId = s.letterId || null;
    try { history.replaceState({}, '', location.pathname); } catch (_) {}
  }

  // ── mapping état front → DossierContestation (schéma serveur) ───────
  buildDossier() {
    const d = this.state.data;
    const n = (v) => this.num(v);
    return {
      canton: d.canton,
      npa: d.npa,
      commune: d.commune,
      adresseImmeuble: d.adresse,
      dateRemiseCles: d.dateCles,
      loyerNetMensuel: n(d.loyerNet) || 0,
      chargesMensuelles: n(d.charges) || 0,
      formuleOfficielleRecue: d.formule || 'inconnu',
      loyerPrecedentConnu: d.loyerPrecConnu === true,
      loyerPrecedentNet: d.loyerPrecConnu === true ? n(d.loyerPrec) : null,
      tauxReferenceBail: d.tauxRefInconnu ? null : n(d.tauxRef),
      anneeConstruction: n(d.annee),
      contraintePersonnelle: false,
      locataire: { nom: d.locNom, prenom: d.locPrenom, adresse: d.locAdresse, npa: d.locNpa, ville: d.locVille, email: d.locEmail },
      bailleur: { nom: d.regNom, adresse: d.regAdresse, npa: d.regNpa, ville: d.regVille },
      signatureDataUrl: d.signatureData || null,
    };
  }

  // ── calculateur landing (POST /evaluate-baisse) ────────────────────
  async checkCalc() {
    const loyer = this.num(this.state.loyer), taux = this.num(this.state.taux);
    if (!loyer) { this.setState({ calcRes: { error: true } }); return; }
    this.setState({ calcLoading: true, calcRes: null, errorMsg: '' });
    try {
      const { result } = await API.evaluateBaisse({
        loyerNetMensuel: loyer,
        tauxReferenceBail: taux,
        canton: this.state.data.canton || undefined,
        email: this.state.data.locEmail || undefined,
      });
      this.setState({
        calcLoading: false,
        tauxActuel: result.tauxActuel,
        calcRes: { eligible: result.eligible, pct: result.baisseEstimeePct, chf: result.baisseEstimeeChf, error: false },
      });
    } catch (e) { this.fail(e); }
  }

  // ── validation flux manuel ────────────────────────────────────────────
  validateCurrentStep() {
    const d = this.state.data;
    const step = this.state.step;
    const errors = {};
    if (step === 1) {
      if (!d.commune.trim()) errors.commune = 'Veuillez indiquer la commune.';
      if (!d.npa.trim()) errors.npa = 'Veuillez indiquer le NPA.';
    }
    if (step === 2) {
      if (!d.adresse.trim()) errors.adresse = "Veuillez indiquer l'adresse de l'immeuble.";
    }
    if (step === 3) {
      if (!d.dateCles) errors.dateCles = 'Veuillez indiquer la date de remise des clés.';
    }
    if (step === 4) {
      if (!d.loyerNet || !this.num(d.loyerNet)) errors.loyerNet = 'Veuillez indiquer le loyer net mensuel.';
    }
    if (step === 6 && d.loyerPrecConnu === true) {
      if (!d.loyerPrec || !this.num(d.loyerPrec)) errors.loyerPrec = "Veuillez indiquer le loyer de l'ancien locataire.";
    }
    if (step === 7 && !d.tauxRefInconnu) {
      if (!d.tauxRef || !this.num(d.tauxRef)) errors.tauxRef = 'Veuillez indiquer le taux ou cochez « Je ne le connais pas ».';
    }
    if (step === 9) {
      if (!d.locPrenom.trim()) errors.locPrenom = 'Prénom requis.';
      if (!d.locNom.trim()) errors.locNom = 'Nom requis.';
      if (!d.locAdresse.trim()) errors.locAdresse = 'Adresse requise.';
      if (!d.locNpa.trim()) errors.locNpa = 'NPA requis.';
      if (!d.locVille.trim()) errors.locVille = 'Ville requise.';
    }
    if (step === 10) {
      if (!d.regNom.trim()) errors.regNom = 'Veuillez indiquer le nom de la régie ou du propriétaire.';
    }
    return errors;
  }

  // ── flux manuel : soumission du dossier (POST /evaluate) ────────────
  async submitDossier() {
    this.setState({ busy: true, errorMsg: '', stepErrors: {} });
    try {
      const { dossierId, evaluation } = await API.evaluate(this.buildDossier());
      evaluation.manuel = evaluation.requiertTraitementManuel; // alias attendu par l'UI
      this.persist({ dossierId });
      this.setState({ busy: false, screen: 'diagnostic', result: evaluation, dossierId });
    } catch (e) { this.fail(e); }
  }
  next() {
    const errors = this.validateCurrentStep();
    if (Object.keys(errors).length > 0) { this.setState({ stepErrors: errors }); return; }
    this.setState({ stepErrors: {} });
    if (this.state.step >= 10) this.submitDossier(); else this.setState(s => ({ step: s.step + 1 }));
  }
  prev() { this.setState(s => (s.step <= 0 ? { screen: 'choix', stepErrors: {} } : { step: s.step - 1, stepErrors: {} })); }

  // ── flux import : upload réel + extraction (POST /extract-bail) ─────
  pickFile(kind) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/pdf';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = String(reader.result).split(',')[1] || '';
        if (kind === 'bail') this.setState({ bailFilled: true, bailName: f.name, bailB64: b64 });
        else this.setState({ formuleFilled: true, formuleName: f.name, formuleB64: b64 });
      };
      reader.readAsDataURL(f);
    };
    input.click();
  }
  async startAnalyse() {
    if (!this.state.bailB64) { this.setState({ errorMsg: 'Ajoutez au moins votre contrat de bail (PDF).' }); return; }
    this.setState({ importState: 'analyse', analyseStep: 1, errorMsg: '' });
    try {
      const { extracted } = await API.extractBail({
        bailB64: this.state.bailB64,
        formuleB64: this.state.formuleB64 || undefined,
      });
      this.setState({ analyseStep: 3 });
      this.applyExtraction(extracted);
      this.setState({ importState: 'validation' });
    } catch (e) {
      this.setState({ importState: 'upload' });
      this.fail(e);
    }
  }
  applyExtraction(x) {
    if (!x) return;
    const d = { ...this.state.data };
    const set = (k, v) => { if (v !== null && v !== undefined && v !== '') d[k] = v; };
    set('canton', x.canton);
    set('commune', x.commune);
    set('npa', x.npa);
    set('adresse', x.adresseImmeuble);
    set('dateCles', x.dateRemiseCles);
    if (x.loyerNetMensuel != null) d.loyerNet = String(x.loyerNetMensuel);
    if (x.chargesMensuelles != null) d.charges = String(x.chargesMensuelles);
    if (x.formuleOfficielleRecue) d.formule = x.formuleOfficielleRecue;
    if (typeof x.loyerPrecedentConnu === 'boolean') d.loyerPrecConnu = x.loyerPrecedentConnu;
    if (x.loyerPrecedentNet != null) { d.loyerPrec = String(x.loyerPrecedentNet); d.loyerPrecConnu = true; }
    if (x.tauxReferenceBail != null) d.tauxRef = String(x.tauxReferenceBail);
    if (x.anneeConstruction != null) d.annee = String(x.anneeConstruction);
    if (x.locataire) { set('locNom', x.locataire.nom); set('locPrenom', x.locataire.prenom); set('locAdresse', x.locataire.adresse); set('locNpa', x.locataire.npa); set('locVille', x.locataire.ville); }
    if (x.bailleur) { set('regNom', x.bailleur.nom); set('regAdresse', x.bailleur.adresse); set('regNpa', x.bailleur.npa); set('regVille', x.bailleur.ville); }
    this.setState({ data: d });
  }

  // ── aperçu : génération lettre + preview filigrané (POST /generate-letter) ──
  async goApercu() {
    if (!this.state.dossierId) { this.setState({ errorMsg: 'Dossier non évalué.' }); return; }
    this.setState({ busy: true, errorMsg: '' });
    try {
      const { letterId, previews } = await API.generateLetter(this.state.dossierId);
      this.persist({ letterId });
      this.setState({ busy: false, screen: 'apercu', letterId, previewUrl: (previews && previews[0]) || '' });
    } catch (e) { this.fail(e); }
  }

  // ── signature (flux recommandé 35) ─────────────────────────────────
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

  // ── paiement : Stripe Checkout (POST /create-checkout) ─────────────
  async payNow() {
    if (!this.state.dossierId || !this.state.letterId) { this.setState({ errorMsg: 'Lettre non générée.' }); return; }
    const offer = this.state.offre === '35' ? 'recommande_35' : 'imprimer_5';
    this.setState({ payLoading: true, errorMsg: '' });
    try {
      this.persist({ offre: this.state.offre, dossierId: this.state.dossierId, letterId: this.state.letterId });
      const { url } = await API.createCheckout({ dossierId: this.state.dossierId, letterId: this.state.letterId, offer });
      if (!url) throw new Error('URL de paiement absente.');
      window.location.href = url; // redirection vers Stripe Checkout
    } catch (e) { this.fail(e); }
  }

  // ── téléchargement du PDF propre après paiement (POST /download-letter) ──
  async downloadLetter() {
    if (!this.state.letterId) { this.setState({ errorMsg: 'Aucune lettre à télécharger.' }); return; }
    this.setState({ busy: true, errorMsg: '' });
    try {
      const { url } = await API.downloadLetter(this.state.letterId);
      this.setState({ busy: false });
      if (url) window.open(url, '_blank');
    } catch (e) {
      if (e && e.status === 402) this.setState({ busy: false, errorMsg: 'Paiement non confirmé : le PDF n’est pas encore débloqué.' });
      else this.fail(e);
    }
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
    const tauxActuelStr = st.tauxActuel != null ? String(st.tauxActuel).replace('.', ',') : '1,25';
    return {
      // transverse
      busy: !!st.busy,
      errorMsg: st.errorMsg || '',
      dismissError: () => this.setState({ errorMsg: '' }),

      isDiagnostic: st.screen === 'diagnostic',
      diagEligible: !!(rr && rr.eligible && !rr.horsDelai),
      diagHorsDelai: !!(rr && rr.horsDelai),
      diagManuel: !!(rr && rr.manuel && !rr.eligible && !rr.horsDelai),
      diagMotifsCount: motifsUI.length,
      motifs: motifsUI,
      conclusions: rr ? rr.conclusions : [],
      avertissements: rr ? rr.avertissements : [],
      hasAvert: !!(rr && rr.avertissements && rr.avertissements.length),
      autPresent: !!aut,
      autNom: aut ? aut.nom : '',
      autAdresse: aut ? aut.adresse : '',
      autCase: aut && aut.casePostale ? aut.casePostale : '',
      autVille: aut ? `${aut.npa} ${aut.ville}` : '',
      autType: aut && aut.canton === 'GE' ? 'Commission cantonale de conciliation' : 'Préfecture du district',
      goApercu: () => this.goApercu(),
      // apercu + offres
      isApercu: st.screen === 'apercu',
      previewUrl: st.previewUrl || '',
      hasPreview: !!st.previewUrl,
      noPreview: !st.previewUrl,
      wmTiles: Array.from({ length: 40 }, (_, i) => i),
      letterNom: `${st.data.locPrenom || ''} ${st.data.locNom || ''}`.trim(),
      letterAdr: st.data.locAdresse || '',
      letterVille: `${st.data.locNpa || ''} ${st.data.locVille || ''}`.trim(),
      letterAutNom: aut ? aut.nom : '',
      letterAutAdr: aut ? aut.adresse : '',
      letterAutVille: aut ? `${aut.npa} ${aut.ville}` : '',
      lieuDate: `${st.data.locVille || ''}, le ${new Date().toLocaleDateString('fr-CH', { day: '2-digit', month: 'long', year: 'numeric' })}`,
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
      offreTitle: st.offre === '35' ? 'Envoi en recommandé' : 'Lettre à imprimer',
      offreDesc: st.offre === '35' ? "On imprime et on poste pour vous" : 'PDF final à imprimer vous-même',
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
      payNow: () => this.payNow(),
      // succès / dashboard
      isSucces: st.screen === 'succes',
      isDashboard: st.screen === 'dashboard',
      is35: st.offre === '35',
      is5: st.offre !== '35',
      goDashboard: () => this.go('dashboard'),
      goCheckout: () => this.go('checkout'),
      downloadLetter: () => this.downloadLetter(),
      tauxActuel: tauxActuelStr,
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
      calcPct: r && r.eligible && r.pct != null ? String(r.pct).replace('.', ',') : '',
      calcChf: r && r.eligible && r.chf != null ? this.fmt(r.chf) : '',
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
      bailName: st.bailName || 'bail.pdf',
      formuleName: st.formuleName || 'formule.pdf',
      uploadBail: () => this.pickFile('bail'),
      uploadFormule: () => this.pickFile('formule'),
      startAnalyse: () => this.startAnalyse(),
      an0: (st.analyseStep || 0) >= 1, an1: (st.analyseStep || 0) >= 2, an2: (st.analyseStep || 0) >= 3,
      goDiagnostic: () => this.submitDossier(),
      goCgv: () => this.go('cgv'),
      goPrivacy: () => this.go('privacy'),
      isCgv: st.screen === 'cgv',
      isPrivacy: st.screen === 'privacy',
      // manual flow — validation
      stepErr: st.stepErrors || {},
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
      tauxConnu: !st.data.tauxRefInconnu,
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

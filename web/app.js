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
    baisseSimLoading: false, baisseSimRes: null, baisseSimError: '',
    parcours: null,
    flowKind: null,
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
      typeBail: 'ordinaire', dateHausse: '', dateEffetHausse: '',
      loyerAvantHausse: '', loyerApresHausse: '', formuleHausse: 'inconnu',
      motifHausse: 'inconnu', tauxRefNouveau: '',
    },
    // dossier serveur
    dossierId: null, letterId: null, previewUrl: '',
    // upload import
    bailB64: null, formuleB64: null, bailName: '', formuleName: '',
    // offre / paiement
    offre: null,
    // UI transverse
    busy: false, busyKind: '', errorMsg: '',
    letterGenerationStep: 0,
    // validation flux manuel
    stepErrors: {},
    // autocomplétion de l'adresse de l'immeuble (geo.admin.ch)
    addressSuggestions: [], addressLoading: false,
    extractionUncertain: [], extractionProvider: '',
    extractionFormuleDetected: false, extractionFormuleSource: '',
  };

  constructor() {
    super();
    if (window.CONTESTATION_START_SCREEN === 'choix') this.state.screen = 'choix';
    this.applyRequestedFlow();
    this.track(this.state.screen === 'landing' ? 'landing_view' : 'diagnostic_entry_view');
    this.resumeFromReturn();
    if (!API.isConfigured()) {
      this.state.errorMsg =
        'Back-end non configuré : renseignez web/config.js (SUPABASE_URL, SUPABASE_ANON_KEY).';
    }
  }

  // ── helpers de format (UI uniquement) ──────────────────────────────
  num(v) { const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n; }
  fmt(n) { return Math.round(n).toLocaleString('fr-CH').replace(/[\u202f\u00a0,]/g, '\u2019'); }
  fmtMoney(n) { return Number(n).toLocaleString('fr-CH', { minimumFractionDigits: 0, maximumFractionDigits: 2 }); }
  importFormuleChoiceStyle(selected, color) {
    const active = selected
      ? `background:${color};border-color:${color};color:#fff;box-shadow:0 5px 12px -8px ${color};`
      : 'background:#fff;border-color:#9CB6C2;color:#1B4965;';
    return `${active}border-style:solid;border-width:1px;border-radius:9px;padding:9px 11px;font-size:12px;font-weight:700;cursor:pointer;`;
  }

  track(name, detail = {}) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: name, ...detail });
      window.dispatchEvent(new CustomEvent('contestation:analytics', { detail: { event: name, ...detail } }));
    } catch (_) { /* la mesure ne doit jamais bloquer le parcours */ }
  }

  applyRequestedFlow() {
    let flow;
    try { flow = new URLSearchParams(location.search).get('flow'); } catch (_) { return; }
    if (!['loyer_initial', 'hausse_loyer', 'demande_baisse'].includes(flow)) return;
    this.state.flowKind = flow;
    this.state.parcours = flow;
    if (flow === 'loyer_initial') this.state.screen = 'mode';
    else if (flow === 'demande_baisse') this.state.screen = 'baisseSim';
    else this.state.screen = 'altForm';
  }

  go(screen) { this.setState({ screen }); }
  setD(key, val) {
    if (this.state.data[key] === val) return; // valeur inchangée → pas de re-render
    this.setState(s => ({ data: { ...s.data, [key]: val }, stepErrors: {} }));
  }
  setImportFormule(value) {
    if (!['oui', 'non', 'inconnu'].includes(value)) return;
    this.setState(s => ({
      data: { ...s.data, formule: value },
      extractionFormuleDetected: false,
      extractionFormuleSource: '',
      stepErrors: {},
    }));
  }
  correctDetectedFormule() {
    this.setImportFormule('inconnu');
  }
  setDateWithoutRender(value) {
    // Un <input type="date"> natif peut émettre `change` pendant la saisie de
    // chaque segment (jour/mois/année). Un setState reconstruirait alors le DOM
    // et ferait perdre à Chrome le segment actif. La valeur reste bien dans
    // l'état, mais le rendu attend l'action suivante du wizard.
    this.state.data.dateCles = value;
  }
  fail(e) {
    console.error(e);
    this.setState({ busy: false, busyKind: '', calcLoading: false, baisseSimLoading: false, payLoading: false, errorMsg: (e && e.message) || 'Une erreur est survenue.' });
  }

  startLetterGeneration() {
    this.stopLetterGeneration();
    this.setState({
      busy: true,
      busyKind: 'letter',
      letterGenerationStep: 0,
      errorMsg: '',
    });

    // Ces paliers accompagnent une opération serveur atomique : ils ne
    // prétendent pas mesurer chaque sous-tâche, mais expliquent le travail en
    // cours sans laisser l'utilisateur face à un spinner muet.
    const stages = [
      { delay: 2200, step: 1 },
      { delay: 6000, step: 2 },
      { delay: 12000, step: 3 },
      { delay: 24000, step: 4 },
    ];
    this._letterGenerationTimers = stages.map(({ delay, step }) => setTimeout(() => {
      if (this.state.busy && this.state.busyKind === 'letter') {
        this.setState({ letterGenerationStep: step });
      }
    }, delay));

    this._letterBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', this._letterBeforeUnload);
  }

  stopLetterGeneration() {
    (this._letterGenerationTimers || []).forEach(clearTimeout);
    this._letterGenerationTimers = [];
    if (this._letterBeforeUnload) {
      window.removeEventListener('beforeunload', this._letterBeforeUnload);
      this._letterBeforeUnload = null;
    }
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
    // Stripe ajoute toujours session_id à l'URL de succès. Le simple paramètre
    // `paid=1` n'est pas une preuve de paiement et ne doit jamais suffire.
    if (!q.get('session_id')) return;
    let s = {};
    try { s = JSON.parse(localStorage.getItem('cc_session') || '{}'); } catch (_) {}
    this.state.screen = 'succes';
    // Normalise aussi les anciennes sessions locales créées avant le changement
    // tarifaire, afin que leur écran de succès conserve le bon type d'offre.
    this.state.offre = s.offre === '35' ? '4990' : s.offre === '5' ? '1490' : (s.offre || this.state.offre);
    this.state.dossierId = s.dossierId || null;
    this.state.letterId = s.letterId || null;
    this.state.flowKind = s.flowKind || null;
    try { history.replaceState({}, '', location.pathname); } catch (_) {}
  }

  // ── mapping état front → DossierContestation (schéma serveur) ───────
  buildDossier() {
    const d = this.state.data;
    const n = (v) => this.num(v);
    const kind = this.state.flowKind || 'loyer_initial';
    return {
      kind,
      canton: d.canton,
      npa: d.npa,
      commune: d.commune,
      adresseImmeuble: d.adresse,
      dateRemiseCles: d.dateCles,
      loyerNetMensuel: kind === 'hausse_loyer' ? (n(d.loyerAvantHausse) || 0) : (n(d.loyerNet) || 0),
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
      typeBail: d.typeBail || 'ordinaire',
      dateNotificationHausse: d.dateHausse || undefined,
      dateEffetHausse: d.dateEffetHausse || undefined,
      loyerAvantHausse: n(d.loyerAvantHausse),
      loyerApresHausse: n(d.loyerApresHausse),
      formuleHausseRecue: d.formuleHausse || 'inconnu',
      motifHausse: d.motifHausse || 'inconnu',
      tauxReferenceNouveau: n(d.tauxRefNouveau),
    };
  }

  selectFlow(kind) {
    this.track('legal_flow_selected', { kind });
    if (kind === 'loyer_initial') {
      this.setState({ flowKind: kind, parcours: kind, screen: 'mode' });
    } else if (kind === 'demande_baisse') {
      this.setState({
        flowKind: kind, parcours: kind, screen: 'baisseSim',
        baisseSimRes: null, baisseSimError: '', stepErrors: {},
        result: null, dossierId: null, letterId: null,
      });
    } else {
      this.setState({ flowKind: kind, parcours: kind, screen: 'altForm', stepErrors: {}, result: null, dossierId: null, letterId: null });
    }
  }

  async runBaisseSimulation() {
    if (this.state.baisseSimLoading) return;
    const loyer = this.num(this.state.data.loyerNet);
    const taux = this.num(this.state.data.tauxRef);
    if (!loyer || loyer <= 0) {
      this.setState({ baisseSimError: 'Indiquez votre loyer net mensuel.', baisseSimRes: null });
      return;
    }
    if (!taux || taux <= 0 || taux > 10) {
      this.setState({ baisseSimError: 'Indiquez le taux de référence qui détermine actuellement votre loyer.', baisseSimRes: null });
      return;
    }
    this.track('rent_reduction_simulation_started');
    this.setState({ baisseSimLoading: true, baisseSimError: '', baisseSimRes: null, errorMsg: '' });
    try {
      const { result } = await API.evaluateBaisse({
        loyerNetMensuel: loyer,
        tauxReferenceBail: taux,
      });
      // Si l'utilisateur a modifié une valeur pendant la requête, ignorer la
      // réponse devenue obsolète et lui laisser relancer le calcul.
      if (this.num(this.state.data.loyerNet) !== loyer || this.num(this.state.data.tauxRef) !== taux) {
        this.setState({ baisseSimLoading: false, baisseSimRes: null });
        return;
      }
      const baisse = result.baisseEstimeeChf || 0;
      this.track('rent_reduction_simulation_completed', { eligible: !!result.eligible });
      this.setState({
        baisseSimLoading: false,
        tauxActuel: result.tauxActuel,
        baisseSimRes: {
          eligible: !!result.eligible,
          pct: result.baisseEstimeePct,
          chf: baisse,
          annuel: baisse * 12,
          nouveauLoyer: Math.max(0, loyer - baisse),
          avertissements: result.avertissements || [],
        },
      });
    } catch (e) { this.fail(e); }
  }

  continueBaisseFlow() {
    if (!this.state.baisseSimRes?.eligible) return;
    this.track('rent_reduction_request_started');
    this.setState({ screen: 'altForm', stepErrors: {} });
  }

  validateAltForm() {
    const d = this.state.data, errors = {};
    if (!d.adresse.trim()) errors.alt = "Indiquez l'adresse du logement.";
    else if (!d.canton || !d.commune || !d.npa) errors.alt = "Choisissez une adresse complète à Vaud ou Genève.";
    if (this.state.flowKind === 'hausse_loyer') {
      if (!d.dateHausse) errors.alt = 'Indiquez la date à laquelle vous avez reçu la hausse.';
      else if (!this.num(d.loyerAvantHausse) || !this.num(d.loyerApresHausse)) errors.alt = 'Indiquez le loyer avant et après la hausse.';
      else if (this.num(d.loyerApresHausse) <= this.num(d.loyerAvantHausse)) errors.alt = 'Le nouveau loyer doit être supérieur au loyer actuel.';
    } else if (this.state.flowKind === 'demande_baisse') {
      if (!this.num(d.loyerNet) || !this.num(d.tauxRef)) errors.alt = 'Indiquez votre loyer net et le taux de référence déterminant.';
    }
    if (!d.locPrenom.trim() || !d.locNom.trim() || !d.locAdresse.trim() || !d.locNpa.trim() || !d.locVille.trim()) errors.alt = 'Complétez vos coordonnées.';
    if (!d.regNom.trim() || !d.regAdresse.trim() || !d.regNpa.trim() || !d.regVille.trim()) errors.alt = 'Complétez les coordonnées de la régie ou du propriétaire.';
    return errors;
  }

  submitAltForm() {
    const errors = this.validateAltForm();
    if (Object.keys(errors).length) { this.setState({ stepErrors: errors }); return; }
    this.submitDossier();
  }

  // ── calculateur landing (POST /evaluate-baisse) ────────────────────
  async checkCalc() {
    this.track('rate_calculator_started');
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
    if (step === 0) {
      if (!d.adresse.trim()) errors.adresse = "Veuillez indiquer l'adresse de l'immeuble.";
      else if (!d.canton || !d.commune || !d.npa) errors.adresse = 'Veuillez choisir une adresse proposée dans la liste.';
    }
    if (step === 1) {
      if (!d.dateCles) errors.dateCles = 'Veuillez indiquer la date de remise des clés.';
    }
    if (step === 2) {
      if (!d.loyerNet || !this.num(d.loyerNet)) errors.loyerNet = 'Veuillez indiquer le loyer net mensuel.';
    }
    if (step === 4 && d.loyerPrecConnu === true) {
      if (!d.loyerPrec || !this.num(d.loyerPrec)) errors.loyerPrec = "Veuillez indiquer le loyer de l'ancien locataire.";
    }
    if (step === 5 && !d.tauxRefInconnu) {
      if (!d.tauxRef || !this.num(d.tauxRef)) errors.tauxRef = 'Veuillez indiquer le taux ou cochez « Je ne le connais pas ».';
    }
    if (step === 7) {
      if (!d.locPrenom.trim()) errors.locPrenom = 'Prénom requis.';
      if (!d.locNom.trim()) errors.locNom = 'Nom requis.';
      if (!d.locAdresse.trim()) errors.locAdresse = 'Adresse requise.';
      if (!d.locNpa.trim()) errors.locNpa = 'NPA requis.';
      if (!d.locVille.trim()) errors.locVille = 'Ville requise.';
    }
    if (step === 8) {
      if (!d.regNom.trim()) errors.regNom = 'Veuillez indiquer le nom de la régie ou du propriétaire.';
    }
    return errors;
  }

  // ── flux manuel : soumission du dossier (POST /evaluate) ────────────
  async submitDossier() {
    this.track('diagnostic_started', { parcours: this.state.parcours || 'unknown' });
    this.setState({ busy: true, errorMsg: '', stepErrors: {} });
    try {
      const { dossierId, evaluation } = await API.evaluate(this.buildDossier());
      evaluation.manuel = evaluation.requiertTraitementManuel; // alias attendu par l'UI
      this.persist({ dossierId, flowKind: this.state.flowKind || 'loyer_initial' });
      this.track('diagnostic_completed', {
        parcours: this.state.parcours || 'unknown',
        eligible: !!evaluation.eligible,
        hors_delai: !!evaluation.horsDelai,
      });
      this.setState({ busy: false, screen: 'diagnostic', result: evaluation, dossierId });
    } catch (e) { this.fail(e); }
  }
  async confirmerFormuleDepuisDiagnostic(valeur) {
    // La réponse change la recevabilité et les motifs : le serveur doit donc
    // recalculer entièrement le diagnostic, comme lors de la soumission.
    this.state.data.formule = valeur;
    await this.submitDossier();
  }
  next() {
    const errors = this.validateCurrentStep();
    if (Object.keys(errors).length > 0) { this.setState({ stepErrors: errors }); return; }
    this.setState({ stepErrors: {} });
    if (this.state.step >= 8) {
      this.submitDossier();
    } else if (this.state.step === 6) {
      // Le logement est généralement aussi l'adresse actuelle du locataire.
      // Ne jamais écraser des coordonnées déjà renseignées (ex. import).
      this.setState(s => ({
        step: 7,
        data: {
          ...s.data,
          locAdresse: s.data.locAdresse || s.data.adresse,
          locNpa: s.data.locNpa || s.data.npa,
          locVille: s.data.locVille || s.data.commune,
        },
      }));
    } else {
      this.setState(s => ({ step: s.step + 1 }));
    }
  }

  // ── mode de test local : dossiers cohérents et modifiables ──────────
  isLocalTestMode() {
    return ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  }
  daysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }
  loadRandomTestScenario() {
    const scenarios = [
      {
        name: 'VD · formule reçue · hausse forte',
        canton: 'VD', commune: 'Lausanne', npa: '1004', adresse: 'Avenue de France 10',
        dateCles: this.daysAgo(12), formule: 'oui', loyerNet: '2150', charges: '180',
        loyerPrecConnu: true, loyerPrec: '1750', tauxRef: '1.75', annee: '1988',
      },
      {
        name: 'GE · formule reçue · sans ancien loyer',
        canton: 'GE', commune: 'Genève', npa: '1205', adresse: 'Rue de Carouge 42',
        dateCles: this.daysAgo(8), formule: 'oui', loyerNet: '1980', charges: '210',
        loyerPrecConnu: false, loyerPrec: '', tauxRef: '1.50', annee: '1975',
      },
      {
        name: 'VD · formule non reçue · ancien dossier',
        canton: 'VD', commune: 'Morges', npa: '1110', adresse: 'Rue Louis-de-Savoie 18',
        dateCles: this.daysAgo(180), formule: 'non', loyerNet: '1870', charges: '160',
        loyerPrecConnu: true, loyerPrec: '1500', tauxRef: '2.00', annee: '1964',
      },
      {
        name: 'GE · formule inconnue · dans le délai',
        canton: 'GE', commune: 'Carouge', npa: '1227', adresse: 'Rue Ancienne 25',
        dateCles: this.daysAgo(20), formule: 'inconnu', loyerNet: '2250', charges: '230',
        loyerPrecConnu: false, loyerPrec: '', tauxRef: '', tauxRefInconnu: true, annee: '',
      },
      {
        name: 'VD · formule reçue · hors délai',
        canton: 'VD', commune: 'Nyon', npa: '1260', adresse: 'Rue de la Gare 7',
        dateCles: this.daysAgo(45), formule: 'oui', loyerNet: '2400', charges: '250',
        loyerPrecConnu: true, loyerPrec: '2100', tauxRef: '1.75', annee: '2005',
      },
      {
        name: 'VD · hausse inférieure à 10 %',
        canton: 'VD', commune: 'Vevey', npa: '1800', adresse: 'Rue du Lac 14',
        dateCles: this.daysAgo(5), formule: 'oui', loyerNet: '1780', charges: '145',
        loyerPrecConnu: true, loyerPrec: '1700', tauxRef: '1.25', annee: '2019',
      },
    ];
    let index;
    do { index = Math.floor(Math.random() * scenarios.length); }
    while (scenarios.length > 1 && index === this._lastTestScenario);
    this._lastTestScenario = index;
    const s = scenarios[index];
    const people = [
      ['Léa', 'Martin'], ['Nicolas', 'Rochat'], ['Sofia', 'Meyer'], ['Julien', 'Favre'],
    ];
    const [prenom, nom] = people[Math.floor(Math.random() * people.length)];
    const data = {
      canton: s.canton, commune: s.commune, npa: s.npa, adresse: s.adresse,
      dateCles: s.dateCles, loyerNet: s.loyerNet, charges: s.charges,
      formule: s.formule, loyerPrecConnu: s.loyerPrecConnu, loyerPrec: s.loyerPrec,
      tauxRef: s.tauxRef, tauxRefInconnu: !!s.tauxRefInconnu, annee: s.annee,
      locNom: nom, locPrenom: prenom, locAdresse: s.adresse, locNpa: s.npa,
      locVille: s.commune, locEmail: `${prenom}.${nom}@example.test`.toLowerCase(),
      regNom: s.canton === 'GE' ? 'Régie du Rhône SA' : 'Régie Lémanique SA',
      regAdresse: 'Rue Centrale 5', regNpa: s.canton === 'GE' ? '1204' : '1003',
      regVille: s.canton === 'GE' ? 'Genève' : 'Lausanne', signatureData: null,
    };
    this.setState({
      screen: 'manuel', parcours: 'manuel', flowKind: 'loyer_initial', step: 0, data,
      testScenarioName: s.name, stepErrors: {}, errorMsg: '',
      dossierId: null, letterId: null, previewUrl: '', result: null,
    });
  }
  prev() { this.setState(s => (s.step <= 0 ? { screen: 'mode', stepErrors: {} } : { step: s.step - 1, stepErrors: {} })); }

  // ── autocomplétion d'adresse (service officiel geo.admin.ch) ────────
  onBuildingAddressInput(value) {
    this.setState(s => ({
      data: { ...s.data, adresse: value, canton: '', commune: '', npa: '' },
      stepErrors: {},
    }));
    clearTimeout(this._addressTimer);
    if (value.trim().length < 3) {
      this.setState({ addressSuggestions: [], addressLoading: false });
      return;
    }
    this._addressTimer = setTimeout(() => this.searchBuildingAddress(value), 300);
  }

  async searchBuildingAddress(value) {
    const d = this.state.data;
    const query = [value.trim(), d.npa, d.commune].filter(Boolean).join(' ');
    const requestId = (this._addressRequestId || 0) + 1;
    this._addressRequestId = requestId;
    this.setState({ addressLoading: true });

    try {
      const url = 'https://api3.geo.admin.ch/rest/services/api/SearchServer?' +
        new URLSearchParams({
          searchText: query,
          type: 'locations',
          origins: 'address',
          limit: '5',
          lang: 'fr',
        });
      const response = await fetch(url);
      if (!response.ok) throw new Error('Recherche d\'adresse indisponible');
      const payload = await response.json();
      if (requestId !== this._addressRequestId) return;

      const suggestions = (payload.results || []).map((result) => {
        const holder = document.createElement('div');
        holder.innerHTML = result.attrs && result.attrs.label || '';
        const label = (holder.textContent || '').replace(/\s+/g, ' ').trim();
        const postalMatch = label.match(/\b(\d{4})\b/);
        const npa = postalMatch ? postalMatch[1] : '';
        const parts = postalMatch ? label.split(postalMatch[0]) : [label, ''];
        const address = parts[0].replace(/,\s*$/, '').trim();
        const city = (parts.slice(1).join(postalMatch ? postalMatch[0] : '') || '')
          .replace(/^\s*,?\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
        // Pour une adresse, `detail` se termine notamment par "ch vd" ou "ch ge".
        const detail = result.attrs && result.attrs.detail || '';
        const cantonMatch = detail.match(/\bch\s+(vd|ge)\b/i) || label.match(/\((VD|GE)\)\s*$/i);
        const canton = cantonMatch ? cantonMatch[1].toUpperCase() : '';
        return {
          label,
          canton,
          select: () => this.selectBuildingAddress({ address, npa, city, canton }),
        };
      }).filter((item) => item.label && (item.canton === 'VD' || item.canton === 'GE'));

      this.setState({ addressSuggestions: suggestions, addressLoading: false });
    } catch (_) {
      if (requestId === this._addressRequestId) {
        // L'utilisateur peut toujours saisir librement son adresse.
        this.setState({ addressSuggestions: [], addressLoading: false });
      }
    }
  }

  selectBuildingAddress(selected) {
    const current = this.state.data;
    const data = {
      ...current,
      adresse: selected.address || current.adresse,
      canton: selected.canton,
      npa: selected.npa || current.npa,
      commune: selected.city || current.commune,
      locAdresse: this.state.screen === 'altForm' && !current.locAdresse ? (selected.address || current.adresse) : current.locAdresse,
      locNpa: this.state.screen === 'altForm' && !current.locNpa ? (selected.npa || current.npa) : current.locNpa,
      locVille: this.state.screen === 'altForm' && !current.locVille ? (selected.city || current.commune) : current.locVille,
    };
    this.setState({ data, addressSuggestions: [], addressLoading: false, stepErrors: {} });
  }

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
    this.track('import_started', { formule_jointe: !!this.state.formuleB64 });
    this.setState({ importState: 'analyse', analyseStep: 1, errorMsg: '' });
    try {
      const { extracted, extraction } = await API.extractBail({
        bailB64: this.state.bailB64,
        formuleB64: this.state.formuleB64 || undefined,
      });
      this.setState({ analyseStep: 3 });
      this.applyExtraction(extracted);
      this.setState({
        importState: 'validation',
        extractionUncertain: Array.isArray(extracted.champs_incertains) ? extracted.champs_incertains : [],
        extractionProvider: extraction && extraction.provider ? extraction.provider : '',
      });
      this.track('import_completed', { champs_incertains: Array.isArray(extracted.champs_incertains) ? extracted.champs_incertains.length : 0 });
    } catch (e) {
      this.track('import_failed', { status: e && e.status ? e.status : 0 });
      this.setState({ importState: 'upload' });
      this.fail(e);
    }
  }
  applyExtraction(x) {
    if (!x) return;
    // Une nouvelle analyse repart de champs vides. Une valeur absente du PDF
    // ne doit jamais laisser subsister une ancienne extraction ou un scénario.
    const d = {
      ...this.state.data,
      canton: '', commune: '', npa: '', adresse: '', dateCles: '', loyerNet: '', charges: '',
      formule: 'inconnu', loyerPrecConnu: false, loyerPrec: '', tauxRef: '', annee: '',
      locNom: '', locPrenom: '', locAdresse: '', locNpa: '', locVille: '',
      regNom: '', regAdresse: '', regNpa: '', regVille: '',
    };
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
    if (!d.locAdresse) d.locAdresse = d.adresse;
    if (!d.locNpa) d.locNpa = d.npa;
    if (!d.locVille) d.locVille = d.commune;
    const formuleDetectee = x.formuleOfficielleRecue === 'oui';
    let formuleSource = formuleDetectee ? x.formuleOfficielleSource : '';
    if (!['document_bail', 'document_formule'].includes(formuleSource)) {
      formuleSource = formuleDetectee
        ? (this.state.formuleB64 ? 'documents_importes' : 'document_bail')
        : '';
    }
    this.setState({
      data: d,
      extractionFormuleDetected: formuleDetectee,
      extractionFormuleSource: formuleSource,
    });
  }

  submitImportedDossier() {
    const d = this.state.data;
    const missing = [];
    if (!d.canton) missing.push('canton');
    if (!d.npa) missing.push('NPA');
    if (!d.commune) missing.push('commune');
    if (!d.adresse) missing.push('adresse du logement');
    if (!d.dateCles) missing.push('date de remise des clés');
    if (!d.loyerNet || !this.num(d.loyerNet)) missing.push('loyer net');
    if (!d.locNom || !d.locPrenom) missing.push('nom et prénom du locataire');
    if (!d.regNom) missing.push('régie ou propriétaire');
    if (missing.length) {
      this.setState({ errorMsg: `Complétez les champs manquants avant le diagnostic : ${missing.join(', ')}.` });
      return;
    }
    this.submitDossier();
  }

  // ── aperçu : génération lettre + preview filigrané (POST /generate-letter) ──
  async goApercu() {
    if (!this.state.dossierId) { this.setState({ errorMsg: 'Dossier non évalué.' }); return; }
    if (this.state.busy) return;
    this.startLetterGeneration();
    try {
      const { letterId, previews } = await API.generateLetter(this.state.dossierId);
      this.stopLetterGeneration();
      this.persist({ letterId });
      this.setState({ busy: false, busyKind: '', screen: 'apercu', letterId, previewUrl: (previews && previews[0]) || '' });
    } catch (e) {
      this.stopLetterGeneration();
      this.fail(e);
    }
  }

  // ── signature (flux recommandé 49,90 CHF) ──────────────────────────
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
  async validateSig() {
    if (!this._sigNode || !this.state.sigDrawn) { this.setState({ errorMsg: 'Dessinez votre signature avant de continuer.' }); return; }
    const signatureDataUrl = this._sigNode.toDataURL('image/png');
    if (!this.state.dossierId || !this.state.letterId) { this.setState({ errorMsg: 'Lettre non générée.' }); return; }
    this.setState({ busy: true, errorMsg: '' });
    try {
      await API.signLetter({ dossierId: this.state.dossierId, letterId: this.state.letterId, signatureDataUrl });
      this.state.data.signatureData = signatureDataUrl;
      this.setState({ busy: false, screen: 'checkout' });
    } catch (e) { this.fail(e); }
  }

  // ── paiement : Stripe Checkout (POST /create-checkout) ─────────────
  async payNow() {
    if (!this.state.dossierId || !this.state.letterId) { this.setState({ errorMsg: 'Lettre non générée.' }); return; }
    const offer = this.state.offre === '4990' ? 'recommande_4990' : 'imprimer_1490';
    this.setState({ payLoading: true, errorMsg: '' });
    try {
      this.persist({ offre: this.state.offre, dossierId: this.state.dossierId, letterId: this.state.letterId, flowKind: this.state.flowKind || 'loyer_initial' });
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

  MOTIF_PEDAGOGIE = {
    formule_manquante: "À Vaud et à Genève, le bailleur doit vous remettre un document officiel qui explique comment le loyer a été fixé. Sans ce document, vous n'avez pas pu vérifier le montant demandé : la fixation du loyer peut donc être considérée comme nulle.",
    hausse_sensible: "Une forte hausse entre deux locataires peut indiquer que le nouveau loyer n'est pas justifié, surtout si le logement n'a pas bénéficié de travaux importants. L'autorité peut demander au bailleur d'expliquer précisément cette augmentation.",
    presomption_rendement: "Un loyer ne doit pas procurer un bénéfice excessif au bailleur. Comme vous n'avez pas accès aux comptes de l'immeuble, la contestation permet de demander au bailleur de les présenter. L'autorité pourra alors vérifier le calcul et réduire le loyer s'il est trop élevé.",
  };

  CONCLUSION_PEDAGOGIE(c) {
    if (c.startsWith('Requérir de la partie bailleresse')) return "Obtenir les données qui manquent avant de déterminer si le loyer est abusif et à quel montant il doit être fixé.";
    if (c.startsWith('Constater la nullité')) return "Le loyer doit être réexaminé parce que la formule officielle obligatoire ne vous a pas été remise.";
    if (c.startsWith('Après examen des pièces')) return "L'autorité remplacera le montant contesté par le loyer que les pièces et la méthode juridique applicable permettront d'établir.";
    if (c.startsWith('Ordonner à la partie bailleresse')) return "La différence éventuellement payée en trop depuis votre entrée dans le logement devra vous être remboursée.";
    if (c.startsWith('Adapter la garantie')) return "La garantie bancaire sera recalculée sur la base du loyer finalement fixé.";
    return '';
  }

  renderVals() {
    const st = this.state, r = st.calcRes, rr = st.result, bs = st.baisseSimRes;
    const motifsUI = rr ? rr.motifs.map(m => ({
      code: m.code,
      libelle: m.libelle,
      explication: m.explication,
      explicationSimple: this.MOTIF_PEDAGOGIE[m.code] || m.explication,
    })) : [];
    const isInitialFlow = (st.flowKind || (rr && rr.kind) || 'loyer_initial') === 'loyer_initial';
    const isHausseFlow = (st.flowKind || (rr && rr.kind)) === 'hausse_loyer';
    const isBaisseFlow = (st.flowKind || (rr && rr.kind)) === 'demande_baisse';
    const aut = rr && rr.autorite ? rr.autorite : (isBaisseFlow ? {
      nom: st.data.regNom, adresse: st.data.regAdresse, npa: st.data.regNpa,
      ville: st.data.regVille, canton: st.data.canton,
    } : null);
    const formuleAClarifier = isInitialFlow && st.data.formule === 'inconnu';
    const avertissementsUI = rr
      ? rr.avertissements.filter(a => !/formule officielle (?:non confirmée|à vérifier)/i.test(a))
      : [];
    const conclusionsDetail = rr ? rr.conclusions.map(c => ({ demande: c, explication: this.CONCLUSION_PEDAGOGIE(c) })) : [];
    const conclusionInstruction = conclusionsDetail.filter(c => c.demande.startsWith('Requérir de la partie bailleresse'));
    const conclusionsFond = conclusionsDetail.filter(c => !c.demande.startsWith('Requérir de la partie bailleresse'));
    const tauxActuelStr = st.tauxActuel != null ? String(st.tauxActuel).replace('.', ',') : '1,25';
    return {
      // transverse
      busy: !!st.busy,
      genericBusy: !!st.busy && st.busyKind !== 'letter',
      letterGenerating: !!st.busy && st.busyKind === 'letter',
      letterGenerationProgress: ['16%', '34%', '56%', '78%', '90%'][st.letterGenerationStep] || '16%',
      letterGenerationProgressValue: [16, 34, 56, 78, 90][st.letterGenerationStep] || 16,
      letterGenerationTitle: [
        'Nous structurons votre demande',
        'Nous personnalisons vos arguments',
        'Nous mettons la lettre en page',
        'Nous créons votre aperçu sécurisé',
        'Derniers contrôles en cours',
      ][st.letterGenerationStep] || 'Nous structurons votre demande',
      letterGenerationText: [
        'Votre diagnostic est transformé en une demande claire et cohérente.',
        'Les motifs, montants, coordonnées et demandes sont adaptés à votre situation.',
        'La lettre et la liste des documents à joindre prennent leur forme finale.',
        'Nous préparons une version consultable sans exposer le document original.',
        'La mise en page peut parfois prendre un peu plus de temps. Votre lettre arrive.',
      ][st.letterGenerationStep] || '',
      letterStep0Done: st.letterGenerationStep > 0,
      letterStep0Active: st.letterGenerationStep === 0,
      letterStep1Done: st.letterGenerationStep > 1,
      letterStep1Active: st.letterGenerationStep === 1,
      letterStep2Done: st.letterGenerationStep > 2,
      letterStep2Active: st.letterGenerationStep === 2,
      letterStep3Done: st.letterGenerationStep > 3,
      letterStep3Active: st.letterGenerationStep >= 3,
      errorMsg: st.errorMsg || '',
      dismissError: () => this.setState({ errorMsg: '' }),

      isDiagnostic: st.screen === 'diagnostic',
      diagEligible: !!(rr && rr.eligible && !rr.horsDelai),
      diagHorsDelai: !!(rr && rr.horsDelai),
      diagManuel: !!(rr && rr.manuel && !rr.eligible && !rr.horsDelai),
      diagNo: !!(rr && !rr.eligible && !rr.horsDelai && !rr.manuel),
      diagNoTitle: isBaisseFlow ? 'Aucune baisse liée au taux identifiée' : 'Aucune lettre automatisée proposée',
      diagNoText: isBaisseFlow ? "Le taux déterminant indiqué n'est pas supérieur au taux actuel. Nous ne vous proposons donc pas de lettre payante sur ce fondement." : "Les informations fournies ne permettent pas de proposer une contestation automatisée.",
      diagMotifsCount: motifsUI.length,
      diagMotifsText: motifsUI.length === 1 ? 'un motif pertinent' : `${motifsUI.length} motifs pertinents`,
      diagTitle: isBaisseFlow ? 'Une demande de baisse paraît possible.' : isHausseFlow ? 'Votre hausse peut être contestée.' : 'Votre dossier paraît solide.',
      diagSummary: isBaisseFlow
        ? `Le taux déterminant de votre loyer est supérieur au taux actuel. La lettre demandera une baisse estimée à ${rr && rr.estimationPct != null ? String(rr.estimationPct).replace('.', ',') : ''} %.`
        : isHausseFlow
          ? 'Vous êtes encore dans le délai indiqué par les informations fournies. La lettre demandera le contrôle de la forme, du calcul et des motifs de la hausse.'
          : `Nous avons identifié ${motifsUI.length === 1 ? 'un motif pertinent' : `${motifsUI.length} motifs pertinents`}. Au vu des informations fournies, il vaut la peine de contester votre loyer initial.`,
      diagLateTitle: isHausseFlow ? 'Le délai de contestation est dépassé' : 'Le délai de 30 jours est dépassé',
      diagLateText: isHausseFlow ? "Une hausse doit être contestée dans les 30 jours suivant sa réception. Nous ne proposons pas de lettre payante dans cette situation." : "La contestation du loyer initial n'est plus recevable par le parcours ordinaire. Vérifiez plutôt si le taux de référence ouvre un droit à une baisse.",
      diagSectionTitle: isBaisseFlow ? 'Pourquoi demander une baisse' : 'Vos motifs de contestation',
      diagSectionIntro: isBaisseFlow ? 'Les éléments qui seront exposés à votre bailleur dans la demande.' : 'Les éléments juridiques et factuels qui seront développés dans votre requête.',
      motifs: motifsUI,
      conclusions: rr ? rr.conclusions : [],
      avertissements: avertissementsUI,
      hasAvert: avertissementsUI.length > 0,
      formuleAClarifier,
      formuleRetrouvee: () => this.confirmerFormuleDepuisDiagnostic('oui'),
      formuleNonRecue: () => this.confirmerFormuleDepuisDiagnostic('non'),
      autPresent: !!aut,
      autNom: aut ? aut.nom : '',
      autAdresse: aut ? aut.adresse : '',
      autCase: aut && aut.casePostale ? aut.casePostale : '',
      autVille: aut ? `${aut.npa} ${aut.ville}` : '',
      autType: isBaisseFlow ? 'Régie ou propriétaire' : aut && aut.canton === 'GE' ? 'Commission cantonale de conciliation' : 'Préfecture du district',
      goApercu: () => this.goApercu(),
      // apercu + offres
      isApercu: st.screen === 'apercu',
      previewUrl: st.previewUrl || '',
      hasPreview: !!st.previewUrl,
      noPreview: !st.previewUrl,
      noPreviewInitial: !st.previewUrl && isInitialFlow,
      noPreviewAlt: !st.previewUrl && !isInitialFlow,
      wmTiles: Array.from({ length: 40 }, (_, i) => i),
      letterNom: `${st.data.locPrenom || ''} ${st.data.locNom || ''}`.trim(),
      letterAdr: st.data.locAdresse || '',
      letterVille: `${st.data.locNpa || ''} ${st.data.locVille || ''}`.trim(),
      letterAutNom: aut ? aut.nom : '',
      letterAutAdr: aut ? aut.adresse : '',
      letterAutVille: aut ? `${aut.npa} ${aut.ville}` : '',
      lieuDate: `${st.data.locVille || ''}, le ${new Date().toLocaleDateString('fr-CH', { day: '2-digit', month: 'long', year: 'numeric' })}`,
      letterMotifs: rr ? rr.motifs : [],
      letterConclusionInstruction: conclusionInstruction,
      letterConclusionsFond: conclusionsFond,
      letterPieces: isHausseFlow
        ? ['Copie du contrat de bail', 'Copie de la notification de hausse et de son enveloppe', 'Copie de la dernière fixation de loyer disponible']
        : isBaisseFlow
          ? ['Copie du contrat de bail', 'Copie de la dernière notification ayant fixé le loyer et son taux de référence']
          : ['Copie du contrat de bail et de ses annexes', ...(st.data.formule === 'oui' ? ['Copie de la formule officielle de notification du loyer initial'] : [])],
      letterFormuleNonJointe: isInitialFlow && st.data.formule !== 'oui',
      letterObject: isHausseFlow ? 'Contestation de la hausse de loyer' : isBaisseFlow ? 'Demande de baisse de loyer' : 'Requête en contestation du loyer initial',
      letterIntro: isHausseFlow ? `Je conteste la hausse de ${st.data.loyerAvantHausse || ''} à ${st.data.loyerApresHausse || ''} CHF qui m'a été notifiée.` : isBaisseFlow ? `Je demande une baisse de mon loyer net, fondé sur un taux de ${st.data.tauxRef || ''} %, alors que le taux actuel est de ${tauxActuelStr} %.` : '',
      letterAdresseImmeuble: st.data.adresse || '',
      letterLoyer: st.data.loyerNet || '',
      letterCharges: st.data.charges || '0',
      letterBailleur: st.data.regNom || '',
      letterDateCles: st.data.dateCles ? new Date(st.data.dateCles).toLocaleDateString('fr-CH') : '',
      letterFormule: st.data.formule === 'oui' ? 'La formule officielle a été remise.' : st.data.formule === 'non' ? "La formule officielle n'a pas été remise." : 'La remise de la formule officielle doit encore être clarifiée.',
      selectOffre5: () => this.setState({ offre: '1490', screen: 'checkout' }),
      selectOffre35: () => this.setState({ offre: '4990', screen: 'signature' }),
      // signature
      isSignature: st.screen === 'signature',
      sigDrawn: !!st.sigDrawn,
      sigRef: (node) => { if (node && !node.__sigInit) { node.__sigInit = true; this.initSig(node); } },
      clearSig: () => this.clearSig(),
      validateSig: () => this.validateSig(),
      // checkout
      isCheckout: st.screen === 'checkout',
      offre: st.offre,
      offrePrice: st.offre === '4990' ? '49,90' : '14,90',
      offreTitle: st.offre === '4990' ? 'Envoi en recommandé, tout compris' : 'Lettre personnalisée à imprimer',
      offreDesc: st.offre === '4990' ? "Impression, affranchissement et suivi inclus" : 'Lettre personnalisée et checklist des pièces',
      trackNum: 'RR ' + '98 072 145 6 CH',
      payLoading: !!st.payLoading,
      payNow: () => this.payNow(),
      // succès / dashboard
      isSucces: st.screen === 'succes',
      isDashboard: st.screen === 'dashboard',
      is35: st.offre === '4990',
      is5: st.offre !== '4990',
      successPrintText: isBaisseFlow
        ? "Votre lettre est débloquée. Téléchargez-la, imprimez-la et envoyez-la à votre régie ou propriétaire, de préférence en recommandé."
        : "Votre lettre est débloquée. Téléchargez-la, imprimez-la et envoyez-la à l'autorité de conciliation.",
      goDashboard: () => this.go('dashboard'),
      goCheckout: () => this.go('checkout'),
      downloadLetter: () => this.downloadLetter(),
      tauxActuel: tauxActuelStr,
      isLanding: st.screen === 'landing',
      isChoix: st.screen === 'choix',
      isMode: st.screen === 'mode',
      isBaisseSim: st.screen === 'baisseSim',
      isAltForm: st.screen === 'altForm',
      isHausseFlow,
      isBaisseFlow,
      isInitialFlow,
      altTitle: isHausseFlow ? 'Contester une hausse de loyer' : 'Demander une baisse de loyer',
      altIntro: isHausseFlow ? 'Renseignez la notification reçue et vos coordonnées. Nous vérifierons le délai, la forme et les bases du calcul.' : 'Votre baisse paraît possible. Complétez maintenant les informations nécessaires pour préparer la demande à votre bailleur.',
      chooseInitialFlow: () => this.selectFlow('loyer_initial'),
      chooseHausseFlow: () => this.selectFlow('hausse_loyer'),
      chooseBaisseFlow: () => this.selectFlow('demande_baisse'),
      backToFlows: () => this.go('choix'),
      backFromAltForm: () => this.go(isBaisseFlow ? 'baisseSim' : 'choix'),
      submitAltForm: () => this.submitAltForm(),
      altError: st.stepErrors && st.stepErrors.alt || '',
      runBaisseSimulation: () => this.runBaisseSimulation(),
      continueBaisseFlow: () => this.continueBaisseFlow(),
      editBaisseSimulation: () => this.setState({ screen: 'baisseSim', baisseSimRes: null, baisseSimError: '' }),
      onBaisseSimLoyer: (e) => this.setState(s => ({ data: { ...s.data, loyerNet: e.target.value }, baisseSimRes: null, baisseSimError: '' })),
      onBaisseSimTaux: (e) => this.setState(s => ({ data: { ...s.data, tauxRef: e.target.value }, baisseSimRes: null, baisseSimError: '' })),
      baisseSimLoading: !!st.baisseSimLoading,
      baisseSimError: st.baisseSimError || '',
      baisseSimEligible: !!(bs && bs.eligible),
      baisseSimNo: !!(bs && !bs.eligible),
      baisseSimPct: bs && bs.pct != null ? String(bs.pct).replace('.', ',') : '',
      baisseSimChf: bs ? this.fmtMoney(bs.chf) : '',
      baisseSimAnnuel: bs ? this.fmtMoney(bs.annuel) : '',
      baisseSimNouveauLoyer: bs ? this.fmtMoney(bs.nouveauLoyer) : '',
      baisseSummaryLoyer: this.num(st.data.loyerNet) ? this.fmtMoney(this.num(st.data.loyerNet)) : '',
      baisseSummaryTaux: st.data.tauxRef ? String(st.data.tauxRef).replace('.', ',') : '',
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
      goChoix: (e) => {
        this.track('primary_cta_clicked', { label: e && e.currentTarget ? e.currentTarget.textContent.trim() : 'unknown' });
        this.go('choix');
      },
      goManuel: () => {
        this.track('path_selected', { parcours: 'manuel' });
        this.setState({ screen: 'manuel', parcours: 'manuel', flowKind: 'loyer_initial', step: 0, testScenarioName: '' });
      },
      testModeAvailable: this.isLocalTestMode(),
      loadTestScenario: () => this.loadRandomTestScenario(),
      runTestScenario: () => this.submitDossier(),
      testScenarioName: st.testScenarioName || '',
      hasTestScenario: !!st.testScenarioName,
      goImport: () => {
        this.track('path_selected', { parcours: 'import' });
        this.setState({ screen: 'import', parcours: 'import', flowKind: 'loyer_initial', importState: 'upload' });
      },
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
      submitImportedDossier: () => this.submitImportedDossier(),
      backToDiagnostic: () => this.go('diagnostic'),
      importFormuleDetected: !!st.extractionFormuleDetected && st.data.formule === 'oui',
      importFormuleNeedsConfirmation: !st.extractionFormuleDetected,
      importFormuleDetectedText: st.extractionFormuleSource === 'document_formule'
        ? `La formule officielle a été identifiée dans le fichier « ${st.formuleName || 'formule officielle'} ». Elle sera prise en compte dans votre diagnostic.`
        : st.extractionFormuleSource === 'document_bail'
          ? `La formule officielle a été identifiée dans le PDF « ${st.bailName || 'bail et annexes'} ». Elle sera prise en compte dans votre diagnostic.`
          : 'La formule officielle a été identifiée dans les documents importés. Elle sera prise en compte dans votre diagnostic.',
      importFormuleOui: st.data.formule === 'oui',
      importFormuleNon: st.data.formule === 'non',
      importFormuleInconnue: st.data.formule !== 'oui' && st.data.formule !== 'non',
      importFormuleOuiStyle: this.importFormuleChoiceStyle(st.data.formule === 'oui', '#178A5B'),
      importFormuleNonStyle: this.importFormuleChoiceStyle(st.data.formule === 'non', '#C43D2E'),
      importFormuleInconnueStyle: this.importFormuleChoiceStyle(st.data.formule !== 'oui' && st.data.formule !== 'non', '#B97912'),
      setImportFormuleOui: () => this.setImportFormule('oui'),
      setImportFormuleNon: () => this.setImportFormule('non'),
      setImportFormuleInconnue: () => this.setImportFormule('inconnu'),
      correctDetectedFormule: () => this.correctDetectedFormule(),
      extractionHasUncertain: st.extractionUncertain.length > 0,
      extractionUncertainText: st.extractionUncertain.join(', '),
      goCgv: () => this.go('cgv'),
      goPrivacy: () => this.go('privacy'),
      isCgv: st.screen === 'cgv',
      isPrivacy: st.screen === 'privacy',
      // manual flow — validation
      stepErr: st.stepErrors || {},
      addressSuggestions: st.addressSuggestions || [],
      hasAddressSuggestions: !!(st.addressSuggestions && st.addressSuggestions.length),
      addressLoading: !!st.addressLoading,
      // manual flow
      d: st.data,
      step: st.step,
      stepLabel: `${st.step + 1} / 9`,
      progress: `${(((st.step + 1) / 9) * 100).toFixed(0)}%`,
      next: () => this.next(),
      prev: () => this.prev(),
      isStep0: st.step === 0, isStep1: false, isStep2: false, isStep3: st.step === 1,
      isStep4: st.step === 2, isStep5: st.step === 3, isStep6: st.step === 4, isStep7: st.step === 5,
      isStep8: st.step === 6, isStep9: st.step === 7, isStep10: st.step === 8,
      chooseCantonVD: () => { this.setD('canton', 'VD'); this.next(); },
      chooseCantonGE: () => { this.setD('canton', 'GE'); this.next(); },
      chooseFormuleOui: () => { this.setD('formule', 'oui'); this.next(); },
      chooseFormuleNon: () => { this.setD('formule', 'non'); this.next(); },
      chooseFormuleInconnu: () => { this.setD('formule', 'inconnu'); this.next(); },
      choosePrecOui: () => { this.setD('loyerPrecConnu', true); },
      choosePrecNon: () => { this.setD('loyerPrecConnu', false); this.setD('loyerPrec', ''); this.next(); },
      precOui: st.data.loyerPrecConnu === true,
      showManuelCta: [0, 1, 2, 5, 6, 7, 8].includes(st.step) || (st.step === 4 && st.data.loyerPrecConnu === true),
      ctaLabel: st.step === 8 ? 'Voir mon diagnostic →' : 'Continuer',
      toggleTauxInconnu: () => this.setState(s => ({ data: { ...s.data, tauxRefInconnu: !s.data.tauxRefInconnu, tauxRef: !s.data.tauxRefInconnu ? '' : s.data.tauxRef } })),
      tauxInconnu: st.data.tauxRefInconnu,
      tauxConnu: !st.data.tauxRefInconnu,
      onCommune: (e) => this.setD('commune', e.target.value),
      onCanton: (e) => this.setD('canton', e.target.value),
      onNpa: (e) => this.setD('npa', e.target.value),
      onAdresse: (e) => this.onBuildingAddressInput(e.target.value),
      onAdresseSimple: (e) => this.setD('adresse', e.target.value),
      onDateCles: (e) => this.setDateWithoutRender(e.target.value),
      onLoyerNet: (e) => this.setD('loyerNet', e.target.value),
      onCharges: (e) => this.setD('charges', e.target.value),
      onLoyerPrec: (e) => this.setD('loyerPrec', e.target.value),
      onTauxRef: (e) => this.setD('tauxRef', e.target.value),
      onTypeBail: (e) => this.setD('typeBail', e.target.value),
      onDateHausse: (e) => this.setD('dateHausse', e.target.value),
      onDateEffetHausse: (e) => this.setD('dateEffetHausse', e.target.value),
      onLoyerAvantHausse: (e) => this.setD('loyerAvantHausse', e.target.value),
      onLoyerApresHausse: (e) => this.setD('loyerApresHausse', e.target.value),
      onFormuleHausse: (e) => this.setD('formuleHausse', e.target.value),
      onMotifHausse: (e) => this.setD('motifHausse', e.target.value),
      onTauxRefNouveau: (e) => this.setD('tauxRefNouveau', e.target.value),
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

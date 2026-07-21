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
    // autocomplétion de l'adresse de l'immeuble (geo.admin.ch)
    addressSuggestions: [], addressLoading: false,
    extractionUncertain: [], extractionProvider: '',
  };

  constructor() {
    super();
    this.track('landing_view');
    this.resumeFromReturn();
    if (!API.isConfigured()) {
      this.state.errorMsg =
        'Back-end non configuré : renseignez web/config.js (SUPABASE_URL, SUPABASE_ANON_KEY).';
    }
  }

  // ── helpers de format (UI uniquement) ──────────────────────────────
  num(v) { const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n; }
  fmt(n) { return Math.round(n).toLocaleString('fr-CH').replace(/[\u202f\u00a0,]/g, '\u2019'); }

  track(name, detail = {}) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push({ event: name, ...detail });
      window.dispatchEvent(new CustomEvent('contestation:analytics', { detail: { event: name, ...detail } }));
    } catch (_) { /* la mesure ne doit jamais bloquer le parcours */ }
  }

  go(screen) { this.setState({ screen }); }
  setD(key, val) {
    if (this.state.data[key] === val) return; // valeur inchangée → pas de re-render
    this.setState(s => ({ data: { ...s.data, [key]: val }, stepErrors: {} }));
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
      this.persist({ dossierId });
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
      screen: 'manuel', parcours: 'manuel', step: 0, data,
      testScenarioName: s.name, stepErrors: {}, errorMsg: '',
      dossierId: null, letterId: null, previewUrl: '', result: null,
    });
  }
  prev() { this.setState(s => (s.step <= 0 ? { screen: 'choix', stepErrors: {} } : { step: s.step - 1, stepErrors: {} })); }

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
      this.track('rate_calculator_completed', { eligible: !!result.eligible });
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
    this.setState({ data: d });
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
    const st = this.state, r = st.calcRes, rr = st.result;
    const motifsUI = rr ? rr.motifs.map(m => ({
      code: m.code,
      libelle: m.libelle,
      explication: m.explication,
      explicationSimple: this.MOTIF_PEDAGOGIE[m.code] || m.explication,
      ...this.FORCE_UI[m.force],
    })) : [];
    const aut = rr && rr.autorite;
    const formuleAClarifier = st.data.formule === 'inconnu';
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
      errorMsg: st.errorMsg || '',
      dismissError: () => this.setState({ errorMsg: '' }),

      isDiagnostic: st.screen === 'diagnostic',
      diagEligible: !!(rr && rr.eligible && !rr.horsDelai),
      diagHorsDelai: !!(rr && rr.horsDelai),
      diagManuel: !!(rr && rr.manuel && !rr.eligible && !rr.horsDelai),
      diagMotifsCount: motifsUI.length,
      diagMotifsText: motifsUI.length === 1 ? 'un motif pertinent' : `${motifsUI.length} motifs pertinents`,
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
      letterMotifs: rr ? rr.motifs : [],
      letterConclusionInstruction: conclusionInstruction,
      letterConclusionsFond: conclusionsFond,
      letterPieces: [
        'Copie du contrat de bail et de ses annexes',
        ...(st.data.formule === 'oui' ? ['Copie de la formule officielle de notification du loyer initial'] : []),
      ],
      letterFormuleNonJointe: st.data.formule !== 'oui',
      letterAdresseImmeuble: st.data.adresse || '',
      letterLoyer: st.data.loyerNet || '',
      letterCharges: st.data.charges || '0',
      letterBailleur: st.data.regNom || '',
      letterDateCles: st.data.dateCles ? new Date(st.data.dateCles).toLocaleDateString('fr-CH') : '',
      letterFormule: st.data.formule === 'oui' ? 'La formule officielle a été remise.' : st.data.formule === 'non' ? "La formule officielle n'a pas été remise." : 'La remise de la formule officielle doit encore être clarifiée.',
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
      goChoix: (e) => {
        this.track('primary_cta_clicked', { label: e && e.currentTarget ? e.currentTarget.textContent.trim() : 'unknown' });
        this.go('choix');
      },
      goManuel: () => {
        this.track('path_selected', { parcours: 'manuel' });
        this.setState({ screen: 'manuel', parcours: 'manuel', step: 0, testScenarioName: '' });
      },
      testModeAvailable: this.isLocalTestMode(),
      loadTestScenario: () => this.loadRandomTestScenario(),
      runTestScenario: () => this.submitDossier(),
      testScenarioName: st.testScenarioName || '',
      hasTestScenario: !!st.testScenarioName,
      goImport: () => {
        this.track('path_selected', { parcours: 'import' });
        this.setState({ screen: 'import', parcours: 'import', importState: 'upload' });
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
      goDiagnostic: () => this.submitImportedDossier(),
      importFormuleOui: st.data.formule === 'oui',
      importFormuleNon: st.data.formule === 'non',
      importFormuleInconnue: st.data.formule !== 'oui' && st.data.formule !== 'non',
      setImportFormuleOui: () => this.setD('formule', 'oui'),
      setImportFormuleNon: () => this.setD('formule', 'non'),
      setImportFormuleInconnue: () => this.setD('formule', 'inconnu'),
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

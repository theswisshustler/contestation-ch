/*
 * Smoke test navigateur sans dépendance externe.
 * Requiert Chrome lancé avec --remote-debugging-port=9222 et le front local.
 */
const FRONT_URL = process.env.FRONT_URL || 'http://127.0.0.1:5000';
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

const targets = await fetch(`${CDP_URL}/json/list`).then((response) => response.json());
const target = targets.find((entry) => entry.type === 'page');
if (!target) throw new Error('Aucun onglet Chrome disponible');

const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
const browserErrors = [];
let sequence = 0;

await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
    return;
  }
  if (message.method === 'Runtime.exceptionThrown') {
    browserErrors.push(message.params.exceptionDetails.text || 'Exception navigateur');
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    browserErrors.push(message.params.args.map((arg) => arg.value || arg.description || '').join(' '));
  }
});

function command(method, params = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Évaluation Chrome impossible');
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 8_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await evaluate(`Boolean(${expression})`)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Condition non atteinte: ${expression}`);
}

function assert(value, message) {
  if (!value) throw new Error(message);
}

await command('Runtime.enable');
await command('Page.enable');
if (process.env.MOBILE_VIEWPORT === '1') {
  await command('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}
await command('Page.navigate', { url: `${FRONT_URL}/` });
await waitFor(`document.readyState === 'complete' && window.__DC?.component`);

// Partir d'un navigateur propre, puis vérifier le rendu initial.
await evaluate(`localStorage.removeItem('cc_draft_v1'); localStorage.removeItem('cc_session'); location.reload(); true`);
await waitFor(`document.readyState === 'complete' && window.__DC?.component`);
assert(await evaluate(`document.querySelector('[data-screen-label="landing"]') !== null`), 'Landing absente');
if (process.env.MOBILE_VIEWPORT === '1') {
  assert(await evaluate(`document.documentElement.scrollWidth <= window.innerWidth + 2`), 'Débordement horizontal sur mobile');
}

const indexedDbFiles = await evaluate(`(async () => {
  const file = new File([new Uint8Array([37, 80, 68, 70])], 'bail-test.pdf', { type: 'application/pdf' });
  await ContestationDraftStore.saveFile('bail', file);
  const files = await ContestationDraftStore.loadFiles();
  const valid = files.bail?.name === 'bail-test.pdf' && files.bail?.blob?.size === 4;
  await ContestationDraftStore.clearFiles();
  return valid;
})()`);
assert(indexedDbFiles, 'Le PDF du brouillon ne survit pas dans IndexedDB');

// Un rendu déclenché par une saisie ne doit ni remplacer l'accordéon ni le rouvrir.
const stableDetails = await evaluate(`(async () => {
  const details = document.querySelector('details');
  details.open = false;
  window.__smokeDetails = details;
  const input = document.querySelector('[data-k="loyer"]');
  input.value = '1800';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  return window.__smokeDetails === document.querySelector('details') && !details.open;
})()`);
assert(stableDetails, 'Un accordéon a été remplacé ou réinitialisé pendant la saisie');

// Un clic unique traverse les trois premiers écrans.
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Vérifier mon loyer'))?.click()`);
await waitFor(`document.querySelector('[data-screen-label="choix-parcours"]')`);

await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Vérifier si vous pouvez obtenir une baisse'))?.click()`);
await waitFor(`document.querySelector('[data-screen-label="simulateur-baisse"]') && window.__DC.component.state.flowKind === 'demande_baisse'`);
await evaluate(`window.__DC.component.setState({ screen: 'choix' }); true`);
await waitFor(`document.querySelector('[data-screen-label="choix-parcours"]')`);
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Contester une hausse reçue'))?.click()`);
await waitFor(`document.querySelector('[data-screen-label="formulaire-parcours"]') && window.__DC.component.state.flowKind === 'hausse_loyer'`);
await evaluate(`window.__DC.component.setState({ screen: 'choix' }); true`);
await waitFor(`document.querySelector('[data-screen-label="choix-parcours"]')`);
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Contester votre loyer initial'))?.click()`);
await waitFor(`document.querySelector('[data-screen-label="mode-loyer-initial"]')`);
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('Répondre à quelques questions'))?.click()`);
await waitFor(`document.querySelector('[data-screen-label="flux-manuel"]')`);

// La saisie conserve le même input DOM et un seul clic avance d'une seule étape.
await evaluate(`window.__DC.component.setState((state) => ({ step: 2, data: { ...state.data, adresse: 'Rue du Test 1', canton: 'VD', commune: 'Lausanne', npa: '1000', dateCles: '2026-07-15' } })); true`);
await waitFor(`window.__DC.component.state.step === 2 && document.querySelector('[data-k="d.loyerNet"]')`);
const stableField = await evaluate(`(async () => {
  const input = document.querySelector('[data-k="d.loyerNet"]');
  window.__smokeField = input;
  input.value = '1875';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
  return window.__smokeField === document.querySelector('[data-k="d.loyerNet"]')
    && window.__DC.component.state.data.loyerNet === '1875';
})()`);
assert(stableField, 'Le champ a été remplacé ou sa valeur n’a pas atteint l’état');
await evaluate(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Continuer')?.click()`);
await waitFor(`window.__DC.component.state.step === 3`);
assert(await evaluate(`window.__DC.component.state.step === 3`), 'Un clic a avancé de plusieurs étapes');

// Retour puis reprise : la dernière valeur saisie reste disponible.
await evaluate(`window.__DC.component.setState((state) => ({ step: 7, data: { ...state.data, locPrenom: 'Louis', locNom: '', locAdresse: 'Rue du Test 1', locNpa: '1000', locVille: 'Lausanne' } })); true`);
await waitFor(`document.querySelector('[data-k="d.locNom"]')`);
await evaluate(`(async () => {
  const input = document.querySelector('[data-k="d.locNom"]');
  input.value = 'Rivière';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  window.__DC.component.saveDraftNow();
  return true;
})()`);
await command('Page.reload');
await waitFor(`document.readyState === 'complete' && window.__DC?.component?.state?.data?.locNom === 'Rivière'`);
assert(await evaluate(`window.__DC.component.state.screen === 'manuel' && window.__DC.component.state.step === 7`), 'Écran ou étape non restauré');
assert(await evaluate(`document.querySelector('[data-k="d.locNom"]')?.value === 'Rivière'`), 'Valeur du champ non restaurée');

await command('Page.navigate', { url: `${FRONT_URL}/?legal=cgv` });
await waitFor(`document.readyState === 'complete' && document.querySelector('[data-screen-label="cgv"]')`);

if (process.env.TEST_DIAGNOSTIC_ROUTE === '1') {
  await command('Page.navigate', { url: `${FRONT_URL}/diagnostic?flow=demande_baisse` });
  await waitFor(`document.readyState === 'complete' && document.querySelector('[data-screen-label="simulateur-baisse"]')`);
}

if (browserErrors.length) throw new Error(`Erreurs navigateur: ${browserErrors.join(' | ')}`);
socket.close();
console.log(JSON.stringify({
  ok: true,
  checks: [
    'rendu différentiel', 'trois parcours', 'clic unique', 'champ stable',
    'brouillon restauré', 'PDF restaurable', 'routes légales',
    ...(process.env.TEST_DIAGNOSTIC_ROUTE === '1' ? ['route /diagnostic'] : []),
    ...(process.env.MOBILE_VIEWPORT === '1' ? ['viewport mobile'] : []),
  ],
}));

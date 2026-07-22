// Client Gotenberg (service externe HTML → PDF / image).
// Une machine Fly arrêtée peut répondre avant que Chromium soit réellement
// prêt. Les conversions sont donc rejouées uniquement sur les erreurs amont
// transitoires ; une erreur de formulaire 4xx n'est jamais masquée.

declare const Deno: { env: { get(name: string): string | undefined } };

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_500, 3_000];
const HEALTH_MAX_WAIT_MS = 30_000;
const HEALTH_POLL_MS = 750;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const CONVERSION_TIMEOUT_MS = 30_000;
const READY_CACHE_MS = 60_000;

let readyUntil = 0;
let readinessPromise: Promise<void> | null = null;

function gotenbergBase(): string {
  const url = Deno.env.get('GOTENBERG_URL');
  if (!url) throw new Error('GOTENBERG_URL manquant');
  return url.replace(/\/$/, '');
}

function authHeader(): Record<string, string> {
  const basic = Deno.env.get('GOTENBERG_BASIC_AUTH');
  return basic ? { Authorization: `Basic ${btoa(basic)}` } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function traceId(response: Response): string | null {
  return response.headers.get('Gotenberg-Trace');
}

function shortDetail(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 500) || 'réponse vide';
}

/**
 * Attend que Gotenberg et Chromium soient réellement prêts. Sur Fly.io, le
 * proxy peut accepter la connexion alors que Chromium termine encore son
 * démarrage. La route officielle /health évite de consommer une conversion
 * comme sonde de disponibilité.
 */
export async function ensureGotenbergReady(): Promise<void> {
  if (Date.now() < readyUntil) return;
  if (readinessPromise) return readinessPromise;

  readinessPromise = (async () => {
    const startedAt = Date.now();
    let attempts = 0;
    let lastDetail = 'aucune réponse';

    while (Date.now() - startedAt < HEALTH_MAX_WAIT_MS) {
      attempts += 1;
      try {
        const response = await fetchWithTimeout(`${gotenbergBase()}/health`, {
          method: 'GET',
          headers: authHeader(),
        }, HEALTH_REQUEST_TIMEOUT_MS);

        if (response.ok) {
          readyUntil = Date.now() + READY_CACHE_MS;
          console.info('gotenberg_ready', {
            attempts,
            durationMs: Date.now() - startedAt,
          });
          return;
        }

        lastDetail = `HTTP ${response.status}: ${shortDetail(await response.text())}`;
      } catch (error) {
        lastDetail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }

      const remainingMs = HEALTH_MAX_WAIT_MS - (Date.now() - startedAt);
      if (remainingMs <= 0) break;
      await sleep(Math.min(HEALTH_POLL_MS, remainingMs));
    }

    throw new Error(
      `Gotenberg indisponible après ${Date.now() - startedAt} ms (${attempts} sondes): ${lastDetail}`,
    );
  })().finally(() => {
    readinessPromise = null;
  });

  return readinessPromise;
}

async function convertWithRetry(
  route: string,
  label: string,
  makeForm: () => FormData,
): Promise<Uint8Array> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout(`${gotenbergBase()}${route}`, {
        method: 'POST',
        headers: authHeader(),
        body: makeForm(),
      }, CONVERSION_TIMEOUT_MS);

      if (response.ok) {
        const result = new Uint8Array(await response.arrayBuffer());
        console.info('gotenberg_conversion_completed', {
          route,
          attempt,
          durationMs: Date.now() - startedAt,
          bytes: result.byteLength,
        });
        return result;
      }

      const detail = shortDetail(await response.text());
      const trace = traceId(response);
      lastError = new Error(
        `Gotenberg ${label} ${response.status}: ${detail}${trace ? ` (trace ${trace})` : ''}`,
      );

      if (!TRANSIENT_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
        throw lastError;
      }

      console.warn('gotenberg_retry', {
        route,
        attempt,
        status: response.status,
        trace,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (error === lastError) throw error;
      lastError = error;
      if (attempt === MAX_ATTEMPTS) throw error;
      console.warn('gotenberg_retry', {
        route,
        attempt,
        status: 'network_error',
        name: error instanceof Error ? error.name : 'unknown',
        durationMs: Date.now() - startedAt,
      });
    }

    await sleep(RETRY_DELAYS_MS[attempt - 1]);
  }

  throw lastError instanceof Error ? lastError : new Error(`Gotenberg ${label} indisponible`);
}

/** HTML → PDF via Chromium (route /forms/chromium/convert/html). */
export async function htmlToPdf(html: string): Promise<Uint8Array> {
  return convertWithRetry('/forms/chromium/convert/html', 'PDF', () => {
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('preferCssPageSize', 'true');
    return form;
  });
}

/**
 * HTML → PNG via Chromium. Le filigrane du HTML est ainsi rastérisé et ne peut
 * pas être retiré côté client.
 */
export async function htmlToPng(html: string): Promise<Uint8Array> {
  return convertWithRetry('/forms/chromium/screenshot/html', 'screenshot', () => {
    const form = new FormData();
    form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
    form.append('format', 'png');
    form.append('width', '820');
    form.append('optimizeForSpeed', 'true');
    return form;
  });
}

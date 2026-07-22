// Client Gotenberg (service externe HTML → PDF / image).
// Une machine Fly arrêtée peut répondre avant que Chromium soit réellement
// prêt. Les conversions sont donc rejouées uniquement sur les erreurs amont
// transitoires ; une erreur de formulaire 4xx n'est jamais masquée.

declare const Deno: { env: { get(name: string): string | undefined } };

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_500, 3_000];

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

function traceId(response: Response): string | null {
  return response.headers.get('Gotenberg-Trace');
}

function shortDetail(value: string): string {
  return value.trim().replace(/\s+/g, ' ').slice(0, 500) || 'réponse vide';
}

async function convertWithRetry(
  route: string,
  label: string,
  makeForm: () => FormData,
): Promise<Uint8Array> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${gotenbergBase()}${route}`, {
        method: 'POST',
        headers: authHeader(),
        body: makeForm(),
      });

      if (response.ok) return new Uint8Array(await response.arrayBuffer());

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

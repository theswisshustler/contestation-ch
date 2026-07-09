// Client Gotenberg (service externe HTML→PDF / HTML→screenshot).
// Self-host sur l'hébergeur suisse, ou instance dédiée. URL + auth optionnelle
// via variables d'environnement — jamais en dur.
//
//   GOTENBERG_URL         ex. https://gotenberg.internal
//   GOTENBERG_BASIC_AUTH  ex. "user:pass" (optionnel)

function gotenbergBase(): string {
  const url = Deno.env.get('GOTENBERG_URL');
  if (!url) throw new Error('GOTENBERG_URL manquant');
  return url.replace(/\/$/, '');
}

function authHeader(): Record<string, string> {
  const basic = Deno.env.get('GOTENBERG_BASIC_AUTH');
  return basic ? { Authorization: `Basic ${btoa(basic)}` } : {};
}

/** HTML → PDF via Chromium (route /forms/chromium/convert/html). */
export async function htmlToPdf(html: string): Promise<Uint8Array> {
  const form = new FormData();
  // Gotenberg exige un fichier nommé index.html.
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  form.append('preferCssPageSize', 'true');

  const res = await fetch(`${gotenbergBase()}/forms/chromium/convert/html`, {
    method: 'POST',
    headers: authHeader(),
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Gotenberg PDF ${res.status}: ${await res.text()}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * HTML → PNG via Chromium (route /forms/chromium/screenshot/html).
 * Le filigrane étant rendu dans le HTML, il est rastérisé dans le PNG :
 * impossible à retirer côté client. Résolution volontairement modeste.
 */
export async function htmlToPng(html: string): Promise<Uint8Array> {
  const form = new FormData();
  form.append('files', new Blob([html], { type: 'text/html' }), 'index.html');
  form.append('format', 'png');
  form.append('width', '820');
  form.append('optimizeForSpeed', 'true');

  const res = await fetch(`${gotenbergBase()}/forms/chromium/screenshot/html`, {
    method: 'POST',
    headers: authHeader(),
    body: form,
  });
  if (!res.ok) {
    throw new Error(`Gotenberg screenshot ${res.status}: ${await res.text()}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

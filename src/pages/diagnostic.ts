import legacyHtml from '../../web/index.html?raw';

export const prerender = false;

export function GET(): Response {
  const html = legacyHtml
    .replace('<title>', '<title>Diagnostic loyer — ')
    .replace('</head>', '<script>window.CONTESTATION_START_SCREEN="choix";</script></head>');
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, follow',
    },
  });
}

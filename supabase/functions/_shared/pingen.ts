// Client Pingen minimal (envoi recommandé, expéditeur = le locataire).
// OAuth client-credentials. Sandbox → prod via variables d'env.
//
//   PINGEN_API_URL     ex. https://api.pingen.com (ou staging)
//   PINGEN_TOKEN_URL   ex. https://identity.pingen.com/auth/access-tokens
//   PINGEN_CLIENT_ID / PINGEN_CLIENT_SECRET
//   PINGEN_ORG_ID

async function accessToken(): Promise<string> {
  const url = Deno.env.get('PINGEN_TOKEN_URL');
  const id = Deno.env.get('PINGEN_CLIENT_ID');
  const secret = Deno.env.get('PINGEN_CLIENT_SECRET');
  if (!url || !id || !secret) throw new Error('Config Pingen (token) manquante');

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret,
    }),
  });
  if (!res.ok) throw new Error(`Pingen token ${res.status}: ${await res.text()}`);
  return (await res.json()).access_token as string;
}

/**
 * Envoie un PDF en recommandé. Retourne l'id Pingen pour le suivi.
 * `pdf` = le PDF PROPRE (déjà payé). L'adresse expéditeur = le locataire.
 */
export async function sendRegistered(pdf: Uint8Array, fileName: string): Promise<string> {
  const apiUrl = Deno.env.get('PINGEN_API_URL');
  const org = Deno.env.get('PINGEN_ORG_ID');
  if (!apiUrl || !org) throw new Error('Config Pingen (api/org) manquante');

  const token = await accessToken();

  // 1) Upload du fichier (endpoint de file upload Pingen).
  const up = await fetch(`${apiUrl}/file-upload`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!up.ok) throw new Error(`Pingen file-upload ${up.status}`);
  const { data: uploadData } = await up.json();
  const { url: putUrl, url_signature } = uploadData.attributes;

  await fetch(putUrl, { method: 'PUT', body: pdf });

  // 2) Création de la lettre en recommandé (delivery_product = registered).
  const create = await fetch(`${apiUrl}/organisations/${org}/letters`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/vnd.api+json',
    },
    body: JSON.stringify({
      data: {
        type: 'letters',
        attributes: {
          file_original_name: fileName,
          file_url: putUrl,
          file_url_signature: url_signature,
          address_position: 'left',
          auto_send: true,
          delivery_product: 'registered',
          print_mode: 'simplex',
          print_spectrum: 'grayscale',
        },
      },
    }),
  });
  if (!create.ok) throw new Error(`Pingen letters ${create.status}: ${await create.text()}`);
  const { data } = await create.json();
  return data.id as string;
}

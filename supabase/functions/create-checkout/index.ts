// POST /create-checkout
// Entrée : { dossierId, letterId, offer: 'imprimer_5' | 'recommande_35' }
// - Crée une session Stripe Checkout (CHF, carte + TWINT).
// - Crée la ligne payments (status 'pending'), avec la session id.
// - Renvoie l'URL de redirection Stripe. Aucun déverrouillage ici.

import Stripe from 'npm:stripe@17';
import { adminClient } from '../_shared/supabase.ts';
import { badRequest, json, preflight, serverError } from '../_shared/http.ts';

const OFFERS = {
  imprimer_5: { amount: 500, label: 'Lettre à imprimer (PDF)' },
  recommande_35: { amount: 3500, label: 'Envoi recommandé (Pingen)' },
} as const;

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return badRequest('POST attendu');

  const secret = Deno.env.get('STRIPE_SECRET_KEY');
  if (!secret) return serverError('STRIPE_SECRET_KEY manquant');
  const appOrigin = Deno.env.get('APP_ORIGIN') ?? 'https://contestation.ch';

  let body: { dossierId?: string; letterId?: string; offer?: keyof typeof OFFERS };
  try {
    body = await req.json();
  } catch {
    return badRequest('JSON invalide');
  }
  if (!body.dossierId || !body.letterId || !body.offer || !OFFERS[body.offer]) {
    return badRequest('dossierId, letterId et offer (imprimer_5|recommande_35) requis');
  }

  const offer = OFFERS[body.offer];
  const stripe = new Stripe(secret, { apiVersion: '2024-06-20' });
  const db = adminClient();

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card', 'twint'],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'chf',
            unit_amount: offer.amount,
            product_data: { name: `contestation.ch — ${offer.label}` },
          },
        },
      ],
      // Le webhook fait foi : ces métadonnées lient la session au dossier.
      metadata: { dossierId: body.dossierId, letterId: body.letterId, offer: body.offer },
      success_url: `${appOrigin}/merci?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appOrigin}/apercu?dossier=${body.dossierId}`,
    });

    await db.from('payments').insert({
      dossier_id: body.dossierId,
      offer: body.offer,
      amount_chf: offer.amount,
      currency: 'chf',
      status: 'pending',
      stripe_session_id: session.id,
    });

    return json({ url: session.url, sessionId: session.id });
  } catch (e) {
    return serverError('Création session Stripe échouée', e);
  }
});

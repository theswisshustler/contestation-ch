// POST /create-checkout
// Entrée : { dossierId, letterId, offer: 'imprimer_1490' | 'recommande_4990' }
// - Crée une session Stripe Checkout (CHF, carte + TWINT).
// - Crée la ligne payments (status 'pending'), avec la session id.
// - Renvoie l'URL de redirection Stripe. Aucun déverrouillage ici.

import Stripe from 'npm:stripe@17';
import { adminClient } from '../_shared/supabase.ts';
import { badRequest, json, preflight, serverError } from '../_shared/http.ts';
import { evaluateDossier, type DossierContestation } from '../_shared/ruleset.ts';

const OFFERS = {
  imprimer_1490: { amount: 1490, label: 'Lettre personnalisée à imprimer' },
  recommande_4990: { amount: 4990, label: 'Envoi recommandé tout compris' },
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
    return badRequest('dossierId, letterId et offer (imprimer_1490|recommande_4990) requis');
  }

  const offer = OFFERS[body.offer];
  const stripe = new Stripe(secret, { apiVersion: '2024-06-20' });
  const db = adminClient();

  try {
    // Ne jamais facturer un dossier inéligible ni accepter un letterId appartenant
    // à un autre dossier. Le recommandé exige en plus le PDF régénéré avec signature.
    const { data: dossier } = await db.from('dossiers').select('eligible, payload').eq('id', body.dossierId).single();
    const { data: letter } = await db.from('letters').select('id, unlocked').eq('id', body.letterId).eq('dossier_id', body.dossierId).single();
    const liveEvaluation = dossier?.payload
      ? evaluateDossier(dossier.payload as DossierContestation)
      : null;
    if (!dossier?.eligible || !liveEvaluation?.eligible || !letter || letter.unlocked) {
      return badRequest('Dossier ou lettre non disponible au paiement');
    }
    if (body.offer === 'recommande_4990' && !dossier.payload?.signatureDataUrl) return badRequest('Signature requise pour l’envoi recommandé');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
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
      // Retour sur la racine avec l'info en paramètre de requête : l'app (SPA
      // d'un seul fichier) lit le paramètre quel que soit le chemin, donc aucun
      // routing SPA côté hébergeur n'est nécessaire (marche partout, y compris
      // Lovable/Replit).
      success_url: `${appOrigin}/?paid=1&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appOrigin}/?dossier=${body.dossierId}`,
    });

    const paymentInsert = await db.from('payments').insert({
      dossier_id: body.dossierId,
      offer: body.offer,
      amount_chf: offer.amount,
      currency: 'chf',
      status: 'pending',
      stripe_session_id: session.id,
    });
    if (paymentInsert.error) {
      // Éviter qu'une session payable existe sans ligne interne rapprochable par
      // le webhook. L'expiration est best-effort; l'erreur reste bloquante.
      try { await stripe.checkout.sessions.expire(session.id); } catch { /* ignore */ }
      throw paymentInsert.error;
    }
    if (!session.url) throw new Error('Stripe n’a pas renvoyé d’URL de paiement');

    return json({ url: session.url, sessionId: session.id });
  } catch (e) {
    return serverError('Création session Stripe échouée', e);
  }
});

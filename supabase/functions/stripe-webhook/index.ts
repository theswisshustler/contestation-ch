// POST /stripe-webhook  (endpoint Stripe — signature vérifiée)
//
// C'EST LE SEUL POINT QUI DÉVERROUILLE LE PDF PROPRE.
// Sur `checkout.session.completed` :
//   1. Vérifie la signature Stripe (anti-forge).
//   2. Marque payments.status = 'paid'.
//   3. Passe letters.unlocked = true  → download-letter pourra servir le PDF.
//   4. Offre 'recommande_35' → envoie le PDF propre en recommandé via Pingen.
//
// Aucune autre fonction ne met unlocked=true. Tant que ce webhook n'a pas
// confirmé le paiement, le PDF propre reste inaccessible au client.

import Stripe from 'npm:stripe@17';
import { adminClient, flagManualReview, notifyOperator } from '../_shared/supabase.ts';
import { sendRegistered } from '../_shared/pingen.ts';
import { json, serverError } from '../_shared/http.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'POST attendu' }, 405);

  const secret = Deno.env.get('STRIPE_SECRET_KEY');
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  if (!secret || !webhookSecret) return serverError('Config Stripe manquante');

  const stripe = new Stripe(secret, { apiVersion: '2024-06-20' });
  const sig = req.headers.get('stripe-signature');
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig!, webhookSecret);
  } catch (e) {
    // Signature invalide → refuser. Ne jamais déverrouiller sur un event non signé.
    return json({ error: `Signature invalide: ${e}` }, 400);
  }

  if (event.type !== 'checkout.session.completed') {
    return json({ received: true }); // ignore le reste
  }

  const session = event.data.object as Stripe.Checkout.Session;
  const dossierId = session.metadata?.dossierId;
  const letterId = session.metadata?.letterId;
  const offer = session.metadata?.offer;
  const db = adminClient();

  try {
    // 2) Paiement confirmé.
    await db
      .from('payments')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        stripe_payment_intent: (session.payment_intent as string) ?? null,
      })
      .eq('stripe_session_id', session.id);

    // 3) DÉVERROUILLAGE du PDF propre — le seul de tout le système.
    if (letterId) {
      await db
        .from('letters')
        .update({ unlocked: true, unlocked_at: new Date().toISOString() })
        .eq('id', letterId);
    }

    // 4) Offre recommandé : envoi Pingen du PDF propre.
    if (offer === 'recommande_35' && letterId && dossierId) {
      await dispatchRegistered(db, dossierId, letterId);
    }

    return json({ received: true });
  } catch (e) {
    await flagManualReview(db, dossierId ?? null, 'Webhook Stripe: post-paiement échoué', String(e));
    // 200 pour éviter les retries infinis Stripe ; l'exploitant est notifié.
    return json({ received: true, warning: 'post-traitement manuel' });
  }
});

async function dispatchRegistered(
  db: ReturnType<typeof adminClient>,
  dossierId: string,
  letterId: string,
): Promise<void> {
  const { data: letter } = await db
    .from('letters')
    .select('clean_pdf_path')
    .eq('id', letterId)
    .single();
  if (!letter?.clean_pdf_path) throw new Error('PDF propre introuvable pour envoi');

  const dl = await db.storage.from('letters-clean').download(letter.clean_pdf_path);
  if (dl.error || !dl.data) throw dl.error ?? new Error('download clean pdf');
  const pdf = new Uint8Array(await dl.data.arrayBuffer());

  const { data: mailing } = await db
    .from('mailings')
    .insert({ dossier_id: dossierId, status: 'queued' })
    .select('id')
    .single();

  try {
    const pingenId = await sendRegistered(pdf, `requete-${dossierId}.pdf`);
    await db
      .from('mailings')
      .update({ pingen_id: pingenId, status: 'sent' })
      .eq('id', mailing!.id);
    await notifyOperator(`📨 Recommandé Pingen envoyé (dossier ${dossierId}, pingen ${pingenId})`);
  } catch (e) {
    await db.from('mailings').update({ status: 'failed' }).eq('id', mailing!.id);
    throw e;
  }
}

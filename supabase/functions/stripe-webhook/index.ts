// POST /stripe-webhook  (endpoint Stripe — signature vérifiée)
//
// C'EST LE SEUL POINT QUI DÉVERROUILLE LE PDF PROPRE.
// Sur `checkout.session.completed` :
//   1. Vérifie la signature Stripe (anti-forge).
//   2. Marque payments.status = 'paid'.
//   3. Passe letters.unlocked = true  → download-letter pourra servir le PDF.
//   4. Offre 'recommande_4990' → envoie le PDF propre en recommandé via Pingen.
//
// Aucune autre fonction ne met unlocked=true. Tant que ce webhook n'a pas
// confirmé le paiement, le PDF propre reste inaccessible au client.

import Stripe from 'npm:stripe@17';
import { adminClient, flagManualReview, notifyOperator } from '../_shared/supabase.ts';
import { sendRegistered } from '../_shared/pingen.ts';
import { reconcileCheckoutAmounts } from '../_shared/stripe-payment.ts';
import { json, serverError } from '../_shared/http.ts';

const PAID_OFFERS: Record<string, number> = {
  imprimer_1490: 1490,
  recommande_4990: 4990,
  // Compatibilité avec les sessions ouvertes avant la migration tarifaire.
  recommande_35: 3500,
};

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
    if (!dossierId || !letterId || !offer || !PAID_OFFERS[offer]) {
      throw new Error('Métadonnées Stripe incomplètes ou offre inconnue');
    }
    if (session.payment_status !== 'paid') {
      return json({ received: true, pending: true });
    }

    // Ne jamais se fier aux seules métadonnées : rapprocher la session de la
    // ligne de paiement créée côté serveur avant la redirection vers Stripe.
    const { data: payment, error: paymentError } = await db
      .from('payments')
      .select('id, dossier_id, offer, amount_chf, amount_paid_chf, discount_chf, currency, status')
      .eq('stripe_session_id', session.id)
      .single();
    if (paymentError || !payment) throw paymentError ?? new Error('Paiement interne introuvable');
    const persistedOffer = offer === 'recommande_35' ? 'recommande_4990' : offer;
    const expectedAmount = PAID_OFFERS[offer];
    if (
      payment.dossier_id !== dossierId
      || payment.offer !== persistedOffer
    ) throw new Error('Incohérence entre la session Stripe et le paiement interne');
    const amounts = reconcileCheckoutAmounts({
      expectedAmount,
      persistedAmount: payment.amount_chf,
      persistedCurrency: payment.currency,
      sessionSubtotal: session.amount_subtotal,
      sessionTotal: session.amount_total,
      sessionDiscount: session.total_details?.amount_discount ?? 0,
      sessionCurrency: session.currency,
    });
    if (!amounts.ok) {
      throw new Error(`Incohérence des montants Stripe: ${amounts.reason}`);
    }

    const { data: letter, error: letterError } = await db
      .from('letters')
      .select('id, unlocked')
      .eq('id', letterId)
      .eq('dossier_id', dossierId)
      .single();
    if (letterError || !letter) throw letterError ?? new Error('Lettre liée au paiement introuvable');

    // Un retry Stripe ne doit pas provoquer un second envoi postal. Si le
    // processus s'est arrêté après l'encaissement mais avant la mise en file,
    // le retry reprend uniquement cette dernière étape.
    if (payment.status === 'paid') {
      if (offer === 'recommande_4990' || offer === 'recommande_35') {
        const { data: mailing } = await db.from('mailings').select('id').eq('dossier_id', dossierId).limit(1).maybeSingle();
        if (!mailing) await dispatchRegistered(db, dossierId, letterId);
      }
      return json({ received: true, duplicate: true });
    }

    // 2) Paiement confirmé.
    const paidUpdate = await db
      .from('payments')
      .update({
        status: 'paid',
        paid_at: new Date().toISOString(),
        amount_paid_chf: amounts.paidAmount,
        discount_chf: amounts.discountAmount,
        stripe_payment_intent: (session.payment_intent as string) ?? null,
      })
      .eq('stripe_session_id', session.id)
      .neq('status', 'paid');
    if (paidUpdate.error) throw paidUpdate.error;

    // 3) DÉVERROUILLAGE du PDF propre — le seul de tout le système.
    if (letterId) {
      await db
        .from('letters')
        .update({ unlocked: true, unlocked_at: new Date().toISOString() })
        .eq('id', letterId)
        .eq('dossier_id', dossierId);
    }

    // 4) Offre recommandé : envoi Pingen du PDF propre.
    // L'ancien identifiant reste accepté pour terminer correctement une session
    // Stripe créée juste avant le changement tarifaire.
    if ((offer === 'recommande_4990' || offer === 'recommande_35') && letterId && dossierId) {
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
    .eq('dossier_id', dossierId)
    .single();
  if (!letter?.clean_pdf_path) throw new Error('PDF propre introuvable pour envoi');

  const dl = await db.storage.from('letters-clean').download(letter.clean_pdf_path);
  if (dl.error || !dl.data) throw dl.error ?? new Error('download clean pdf');
  const pdf = new Uint8Array(await dl.data.arrayBuffer());

  const { data: mailing, error: mailingError } = await db
    .from('mailings')
    .insert({ dossier_id: dossierId, status: 'queued' })
    .select('id')
    .single();
  if (mailingError || !mailing) throw mailingError ?? new Error('Création du suivi postal échouée');

  try {
    const pingenId = await sendRegistered(pdf, `requete-${dossierId}.pdf`);
    await db
      .from('mailings')
      .update({ pingen_id: pingenId, status: 'sent' })
      .eq('id', mailing.id);
    await notifyOperator(`📨 Recommandé Pingen envoyé (dossier ${dossierId}, pingen ${pingenId})`);
  } catch (e) {
    await db.from('mailings').update({ status: 'failed' }).eq('id', mailing.id);
    throw e;
  }
}

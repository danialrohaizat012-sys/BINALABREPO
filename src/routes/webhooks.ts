// Webhooks are the source of truth for "was this paid?". Never fulfil from
// the success page: customers can close the tab before it loads, and FPX or
// other bank payments can settle later.
import express, { Router } from 'express';
import type Stripe from 'stripe';
import { stripe, CURRENCY } from '../stripe.js';
import { cardPaymentsStatus } from './connect.js';
import { FieldValue } from 'firebase-admin/firestore';
import { db } from '../firebase.js';

export const webhooks = Router();
const raw = express.raw({ type: 'application/json' }); // signature checks need the raw body

// Two endpoints in the Dashboard (Developers > Webhooks) point here:
//  - "Your account" events     -> STRIPE_WEBHOOK_SECRET
//  - "Connected accounts" events -> STRIPE_CONNECT_WEBHOOK_SECRET
const secrets = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean) as string[];

// Stripe retries deliveries, so handle each event once. Firestore remembers
// processed event IDs across restarts; the in-memory set is the fallback.
const seen = new Set<string>();
async function alreadyHandled(id: string): Promise<boolean> {
  if (seen.has(id)) return true;
  if (!db) return false;
  return (await db.collection('stripeEvents').doc(id).get()).exists;
}
async function markHandled(event: Stripe.Event) {
  seen.add(event.id);
  await db?.collection('stripeEvents').doc(event.id).set({ type: event.type, at: FieldValue.serverTimestamp() });
}

webhooks.post('/stripe', raw, async (req, res) => {
  const signature = req.header('stripe-signature') ?? '';
  let event: Stripe.Event | undefined;
  for (const secret of secrets) {
    try {
      event = stripe.webhooks.constructEvent(req.body, signature, secret);
      break;
    } catch {
      /* try the next secret */
    }
  }
  if (!event) {
    res.status(400).send('Invalid signature');
    return;
  }
  if (await alreadyHandled(event.id)) {
    res.sendStatus(200);
    return;
  }

  // event.account is set when the event happened on an SME's account.
  const sme = event.account;
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      if (session.payment_status !== 'unpaid') await fulfilCheckout(session, sme);
      break;
    }
    case 'checkout.session.async_payment_failed':
      console.warn('Bank payment failed', event.data.object.id, sme);
      break;
    case 'invoice.paid':
      await markInvoicePaid(event.data.object, sme);
      break;
    case 'invoice.payment_failed':
      console.warn('Invoice payment failed', event.data.object.id, sme);
      await syncStudioInvoice(event.data.object, { stripeLastPaymentError: 'payment_failed' });
      break;
    case 'invoice.voided':
    case 'invoice.marked_uncollectible':
      await syncStudioInvoice(event.data.object);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      await syncSubscription(event.data.object);
      break;
    case 'charge.refunded':
    case 'charge.dispute.created':
    case 'radar.early_fraud_warning.created':
      console.warn(`Risk event ${event.type}`, event.data.object.id, sme ?? 'binalab');
      break;
  }

  await markHandled(event);
  res.sendStatus(200);
});

// Accounts v2 sends "thin" events through an Event Destination
// (Developers > Event destinations). Use them to see when an SME finishes
// onboarding and can take payments, or needs to supply more documents.
webhooks.post('/stripe-v2', raw, async (req, res) => {
  const secret = process.env.STRIPE_V2_WEBHOOK_SECRET;
  if (!secret) {
    res.status(500).send('STRIPE_V2_WEBHOOK_SECRET not set');
    return;
  }
  let notification;
  try {
    notification = stripe.parseEventNotification(req.body, req.header('stripe-signature') ?? '', secret);
  } catch {
    res.status(400).send('Invalid signature');
    return;
  }
  if (notification.type === 'v2.core.account[configuration.merchant].capability_status_updated') {
    // Thin events carry no data, so fetch the current state.
    const accountId = notification.related_object.id;
    const status = await cardPaymentsStatus(accountId);
    console.log(`SME ${accountId} card_payments is now ${status}`);
    // TODO: save the status, and email the SME if Stripe needs more information.
  }
  res.sendStatus(200);
});

// ---- Replace these with writes to your own database ----
async function fulfilCheckout(session: Stripe.Checkout.Session, sme?: string) {
  console.log(`Paid: ${session.id} ${session.amount_total} ${session.currency ?? CURRENCY}`, sme ? `(SME ${sme})` : '(Binalab)');
}
async function markInvoicePaid(invoice: Stripe.Invoice, sme?: string) {
  console.log(`Invoice paid: ${invoice.id} ${invoice.amount_paid}`, sme ? `(SME ${sme})` : '(Binalab)');
  if (!sme) {
    await syncStudioInvoice(invoice, {
      status: 'paid',
      paidAt: FieldValue.serverTimestamp(),
      paidAmountSen: invoice.amount_paid,
      stripeLastPaymentError: null,
    });
  }
}

// Mirror a Stripe invoice's state onto the Studio invoice it came from.
async function syncStudioInvoice(invoice: Stripe.Invoice, extra: Record<string, unknown> = {}) {
  const id = invoice.metadata?.firestoreInvoiceId;
  if (!id || !db) return;
  const ref = db.collection('invoices').doc(id);
  const current = (await ref.get()).data();
  // Ignore events for an older link that was replaced by a newer one.
  if (!current || current.stripeInvoiceId !== invoice.id) return;
  await ref.update({ stripeStatus: invoice.status, updatedAt: FieldValue.serverTimestamp(), ...extra });
}
async function syncSubscription(sub: Stripe.Subscription) {
  console.log(`Subscription ${sub.id} is ${sub.status}`);
}

// BinaLab Studio -> Stripe. An invoice made in Studio (Firestore `invoices/{id}`)
// becomes a Stripe-hosted payment page that BinaLab sends to the client on WhatsApp.
// Amounts are always recalculated here from Firestore, never taken from the browser.
import { Router } from 'express';
import { FieldValue } from 'firebase-admin/firestore';
import Stripe from 'stripe';
import { stripe, CURRENCY } from '../stripe.js';
import { db } from '../firebase.js';

// Mounted behind requireStaff in server.ts.
export const studio = Router();

type StudioItem = { description?: string; qty?: number; price?: number };
type StudioInvoice = {
  ref?: string;
  businessName?: string;
  clientName?: string;
  phone?: string;
  email?: string;
  caseId?: string;
  notes?: string;
  items?: StudioItem[];
  taxRate?: number;
  status?: string;
  stripeInvoiceId?: string;
  stripeStatus?: string;
};

const MIN_SEN = 200; // Stripe's minimum charge in MYR is RM 2.00
const sen = (rm: number) => Math.round(rm * 100);

// Turn Studio's line items (RM, with qty) into Stripe line items (sen).
export function linesFor(inv: StudioInvoice) {
  const lines = (inv.items ?? [])
    .map((i) => ({
      description: String(i.description ?? '').trim().slice(0, 250),
      quantity: Math.max(0, Math.floor(Number(i.qty ?? 1))),
      unitSen: sen(Number(i.price ?? 0)),
    }))
    .filter((l) => l.description && l.quantity > 0 && l.unitSen > 0);
  const subtotal = lines.reduce((s, l) => s + l.unitSen * l.quantity, 0);
  const rate = Math.max(0, Number(inv.taxRate ?? 0));
  const taxSen = Math.round((subtotal * rate) / 100);
  return { lines, subtotal, rate, taxSen, total: subtotal + taxSen };
}

// One Stripe customer per client, keyed by WhatsApp number (or business name).
async function customerAccountFor(inv: StudioInvoice): Promise<string> {
  const key = (inv.phone ?? '').replace(/\D/g, '') || (inv.businessName ?? 'client').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const ref = db!.collection('stripeCustomers').doc(key);
  const snap = await ref.get();
  const existing = snap.data()?.accountId as string | undefined;
  const email = inv.email!.trim();
  if (existing) {
    if (email && snap.data()?.email !== email) {
      await stripe.v2.core.accounts.update(existing, { contact_email: email });
      await ref.set({ email }, { merge: true });
    }
    return existing;
  }
  const account = await stripe.v2.core.accounts.create({
    display_name: (inv.businessName || inv.clientName || 'BinaLab client').slice(0, 100),
    contact_email: email,
    configuration: { customer: { capabilities: {} } },
    metadata: { phone: inv.phone ?? '', source: 'binalab-studio' },
  });
  await ref.set({ accountId: account.id, businessName: inv.businessName ?? '', phone: inv.phone ?? '', email, createdAt: FieldValue.serverTimestamp() });
  return account.id;
}

// Create (or return the existing) payment link for a Studio invoice.
studio.post('/invoices/:id/payment-link', async (req, res) => {
  const docRef = db!.collection('invoices').doc(req.params.id);
  const snap = await docRef.get();
  if (!snap.exists) {
    res.status(404).json({ error: 'Invoice not found. Save it in Studio first.' });
    return;
  }
  const inv = snap.data() as StudioInvoice;
  if (inv.status === 'paid') {
    res.status(409).json({ error: 'This invoice is already paid.' });
    return;
  }

  // Reuse an open link instead of billing twice.
  if (inv.stripeInvoiceId && inv.stripeStatus === 'open') {
    const existing = await stripe.invoices.retrieve(inv.stripeInvoiceId);
    if (existing.status === 'open') {
      res.json(linkPayload(existing));
      return;
    }
  }

  const { lines, rate, taxSen, total } = linesFor(inv);
  if (!lines.length) {
    res.status(400).json({ error: 'Add at least one item with a price.' });
    return;
  }
  const email = inv.email?.trim() ?? '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // Stripe needs an email to issue an invoice; it also emails the receipt there.
    res.status(400).json({ error: 'Isi email pelanggan yang sah dalam invois dahulu. Stripe perlukan email untuk invois dan resit.' });
    return;
  }
  if (total < MIN_SEN) {
    res.status(400).json({ error: 'Stripe needs at least RM 2.00.' });
    return;
  }

  const customerAccount = await customerAccountFor(inv);
  const daysUntilDue = Math.min(60, Math.max(1, Number(req.body?.daysUntilDue ?? 7)));
  const metadata = { firestoreInvoiceId: snap.id, ref: inv.ref ?? '', caseId: inv.caseId ?? '' };

  // No idempotency key: a half-built draft must never be reused. Studio disables
  // the button while a request runs, and the amount check below catches the rest.
  const draft = await stripe.invoices.create({
    customer_account: customerAccount,
    collection_method: 'send_invoice',
    days_until_due: daysUntilDue,
    currency: CURRENCY,
    description: inv.notes?.slice(0, 500) || undefined,
    footer: inv.ref ? `Rujukan BinaLab: ${inv.ref}` : undefined,
    metadata,
    auto_advance: true, // Stripe sends reminders and marks it past due
  });

  for (const l of lines) {
    await stripe.invoiceItems.create({
      customer_account: customerAccount,
      invoice: draft.id,
      description: l.description,
      quantity: l.quantity,
      unit_amount_decimal: Stripe.Decimal.from(l.unitSen),
      currency: CURRENCY,
    });
  }
  if (taxSen > 0) {
    await stripe.invoiceItems.create({
      customer_account: customerAccount,
      invoice: draft.id,
      description: `SST (${rate}%)`,
      amount: taxSen,
      currency: CURRENCY,
    });
  }

  const final = await stripe.invoices.finalizeInvoice(draft.id!);
  if (final.amount_due !== total) {
    // Should never happen; stop before a client sees a wrong amount.
    await stripe.invoices.voidInvoice(final.id!);
    res.status(500).json({ error: `Amount mismatch (Stripe ${final.amount_due} vs Studio ${total} sen). Link was cancelled.` });
    return;
  }
  // Stripe emails the invoice too; BinaLab sends the same link on WhatsApp.
  const sent = await stripe.invoices.sendInvoice(final.id!);

  await docRef.update({
    stripeInvoiceId: sent.id,
    stripeStatus: sent.status,
    stripeHostedUrl: sent.hosted_invoice_url,
    stripePdfUrl: sent.invoice_pdf,
    stripeAmountSen: sent.amount_due,
    stripeDueDate: sent.due_date ? new Date(sent.due_date * 1000).toISOString() : null,
    stripeCreatedBy: res.locals.staffEmail,
    updatedAt: FieldValue.serverTimestamp(),
  });
  res.json(linkPayload(sent));
});

// Cancel a link, e.g. after the invoice amount changed. A new one can then be made.
studio.post('/invoices/:id/void-payment-link', async (req, res) => {
  const docRef = db!.collection('invoices').doc(req.params.id);
  const inv = (await docRef.get()).data() as StudioInvoice | undefined;
  if (!inv?.stripeInvoiceId) {
    res.status(404).json({ error: 'No payment link on this invoice.' });
    return;
  }
  const current = await stripe.invoices.retrieve(inv.stripeInvoiceId);
  if (current.status === 'paid') {
    res.status(409).json({ error: 'Already paid. Refund it from the Stripe Dashboard instead.' });
    return;
  }
  const voided = current.status === 'open' ? await stripe.invoices.voidInvoice(current.id!) : current;
  await docRef.update({ stripeStatus: voided.status, stripeHostedUrl: null, updatedAt: FieldValue.serverTimestamp() });
  res.json({ status: voided.status });
});

function linkPayload(i: Stripe.Invoice) {
  return {
    stripeInvoiceId: i.id,
    status: i.status,
    url: i.hosted_invoice_url,
    pdf: i.invoice_pdf,
    amountSen: i.amount_due,
    dueDate: i.due_date ? new Date(i.due_date * 1000).toISOString() : null,
  };
}

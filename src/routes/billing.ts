// Part A: Binalab bills its own clients (project fees, retainers, packages).
// Money lands in Binalab's Stripe balance. No Connect involved.
import { Router } from 'express';
import { stripe, APP_URL, CURRENCY, integrationId } from '../stripe.js';

export const billing = Router();

type LineItem = { description: string; amount: number; quantity?: number };

// Create a client record. Stripe recommends modelling customers as
// customer-configured Accounts (Accounts v2) rather than v1 Customer objects.
// SMEs that also use the Connect platform get the same Account (see connect.ts),
// so one record covers "Binalab bills them" and "they get paid through Binalab".
billing.post('/clients', async (req, res) => {
  const { name, email } = req.body as { name: string; email: string };
  const account = await stripe.v2.core.accounts.create({
    display_name: name,
    contact_email: email,
    configuration: { customer: { capabilities: {} } },
    include: ['configuration.customer'],
  });
  res.json({ customerAccount: account.id });
});

// One-off invoice, e.g. a project milestone. Stripe emails it to the client
// with a hosted payment page (card, FPX, GrabPay etc., whichever you enable).
billing.post('/invoices', async (req, res) => {
  const { customerAccount, items, daysUntilDue = 14, memo } = req.body as {
    customerAccount: string;
    items: LineItem[];
    daysUntilDue?: number;
    memo?: string;
  };

  const invoice = await stripe.invoices.create({
    customer_account: customerAccount,
    collection_method: 'send_invoice',
    days_until_due: daysUntilDue,
    currency: CURRENCY,
    description: memo,
    auto_advance: true, // Stripe sends reminders and marks it past due
  });

  for (const item of items) {
    await stripe.invoiceItems.create({
      customer_account: customerAccount,
      invoice: invoice.id,
      description: item.description,
      quantity: item.quantity ?? 1,
      price_data: { currency: CURRENCY, product: await productFor(item.description), unit_amount: item.amount },
    });
  }

  await stripe.invoices.finalizeInvoice(invoice.id!);
  const sent = await stripe.invoices.sendInvoice(invoice.id!);
  // Don't mark anything paid here. Wait for the invoice.paid webhook.
  res.json({ invoiceId: sent.id, hostedUrl: sent.hosted_invoice_url, pdf: sent.invoice_pdf });
});

// Website checkout for a fixed package (mode: 'payment') or a monthly/annual
// retainer (mode: 'subscription'). Create Products/Prices in the Dashboard:
// one Product per plan, with monthly/annual as separate Prices on it.
billing.post('/checkout', async (req, res) => {
  const { priceId, mode = 'payment', customerAccount } = req.body as {
    priceId: string;
    mode?: 'payment' | 'subscription';
    customerAccount?: string;
  };

  const session = await stripe.checkout.sessions.create({
    mode,
    line_items: [{ price: priceId, quantity: 1 }],
    ...(customerAccount ? { customer_account: customerAccount } : {}),
    // No payment_method_types: Stripe shows the best eligible methods
    // (cards, FPX, GrabPay...) based on your Dashboard settings.
    success_url: `${APP_URL}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_URL}/pricing`,
    integration_identifier: integrationId(mode),
  });
  res.json({ url: session.url });
});

// Lets clients manage their retainer, card and invoices themselves.
billing.post('/portal', async (req, res) => {
  const { customerAccount } = req.body as { customerAccount: string };
  const portal = await stripe.billingPortal.sessions.create({
    customer_account: customerAccount,
    return_url: `${APP_URL}/account`,
  });
  res.json({ url: portal.url });
});

// Reuse one Product per line-item name so invoices read cleanly.
const productCache = new Map<string, string>();
async function productFor(name: string): Promise<string> {
  const cached = productCache.get(name);
  if (cached) return cached;
  const product = await stripe.products.create({ name });
  productCache.set(name, product.id);
  return product.id;
}

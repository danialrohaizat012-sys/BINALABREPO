// Part B: SMEs using Binalab's software get paid by their own customers.
// SaaS pattern: each SME is a connected account and the merchant of record
// (direct charges). Stripe bills the SME its processing fees and carries
// negative-balance risk, and Binalab takes an application fee per payment.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { stripe, APP_URL, CURRENCY, integrationId } from '../stripe.js';

export const connect = Router();

// Your cut of each SME payment, in basis points (150 = 1.5%). If it's small,
// consider covering Stripe's fees in it so your margin holds.
const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS ?? 150);
const feeFor = (amount: number) => Math.round((amount * PLATFORM_FEE_BPS) / 10_000);

type LineItem = { description: string; amount: number; quantity?: number };

// 1. Create the SME's account. The merchant config lets it accept payments.
//    The customer config lets Binalab bill the same SME for its subscription.
connect.post('/smes', async (req, res) => {
  const { businessName, email } = req.body as { businessName: string; email: string };
  const account = await stripe.v2.core.accounts.create({
    display_name: businessName,
    contact_email: email,
    dashboard: 'full', // SMEs run their own business, so they get the full Stripe Dashboard
    identity: { country: 'my', entity_type: 'company', business_details: { registered_name: businessName } },
    configuration: {
      merchant: { capabilities: { card_payments: { requested: true } } },
      customer: { capabilities: {} },
    },
    defaults: {
      currency: CURRENCY,
      locales: ['en-GB'],
      responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' },
    },
    include: ['configuration.merchant', 'configuration.customer', 'identity', 'requirements'],
  });
  res.json({ accountId: account.id });
});

// 2. Stripe-hosted onboarding (KYC, bank details). Send the SME to this URL.
connect.post('/smes/:id/onboarding-link', async (req, res) => {
  const link = await stripe.v2.core.accountLinks.create({
    account: req.params.id as string,
    use_case: {
      type: 'account_onboarding',
      account_onboarding: {
        refresh_url: `${APP_URL}/smes/${req.params.id}/onboarding?refresh=1`,
        return_url: `${APP_URL}/smes/${req.params.id}/onboarding/done`,
      },
    },
  });
  res.json({ url: link.url });
});

connect.get('/smes/:id/status', async (req, res) => {
  res.json({ cardPayments: await cardPaymentsStatus(req.params.id as string) });
});

// Refuse to take payments until Stripe has activated the account.
async function requireActive(req: Request, res: Response, next: NextFunction) {
  const status = await cardPaymentsStatus(req.params.id as string);
  if (status !== 'active') {
    res.status(409).json({ error: `SME can't accept payments yet (card_payments: ${status}). Finish onboarding first.` });
    return;
  }
  next();
}

// 3a. The SME's customer pays online (e.g. a booking or an order).
connect.post('/smes/:id/checkout', requireActive, async (req, res) => {
  const { items } = req.body as { items: LineItem[] };
  const total = items.reduce((sum, i) => sum + i.amount * (i.quantity ?? 1), 0);
  const session = await stripe.checkout.sessions.create(
    {
      mode: 'payment',
      line_items: items.map((i) => ({
        quantity: i.quantity ?? 1,
        price_data: { currency: CURRENCY, unit_amount: i.amount, product_data: { name: i.description } },
      })),
      payment_intent_data: { application_fee_amount: feeFor(total) },
      success_url: `${APP_URL}/pay/thanks?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_URL}/pay/cancelled`,
      integration_identifier: integrationId('sme_checkout'),
    },
    { stripeAccount: req.params.id as string }, // direct charge on the SME's account
  );
  res.json({ url: session.url });
});

// 3b. The SME invoices its customer. The invoice comes from the SME's account
//     in its name, and Binalab's fee is deducted automatically.
connect.post('/smes/:id/invoices', requireActive, async (req, res) => {
  const stripeAccount = req.params.id as string;
  const { customer, items, daysUntilDue = 14 } = req.body as {
    customer: { name: string; email: string };
    items: LineItem[];
    daysUntilDue?: number;
  };
  const total = items.reduce((sum, i) => sum + i.amount * (i.quantity ?? 1), 0);

  // The SME's customers live on the SME's own account.
  const cust = await stripe.customers.create(customer, { stripeAccount });
  const invoice = await stripe.invoices.create(
    {
      customer: cust.id,
      collection_method: 'send_invoice',
      days_until_due: daysUntilDue,
      currency: CURRENCY,
      application_fee_amount: feeFor(total),
      auto_advance: true,
    },
    { stripeAccount },
  );
  for (const i of items) {
    await stripe.invoiceItems.create(
      { customer: cust.id, invoice: invoice.id, description: i.description, quantity: i.quantity ?? 1,
        price_data: { currency: CURRENCY, product: await productFor(stripeAccount, i.description), unit_amount: i.amount } },
      { stripeAccount },
    );
  }
  await stripe.invoices.finalizeInvoice(invoice.id!, {}, { stripeAccount });
  const sent = await stripe.invoices.sendInvoice(invoice.id!, {}, { stripeAccount });
  res.json({ invoiceId: sent.id, hostedUrl: sent.hosted_invoice_url });
});

export async function cardPaymentsStatus(accountId: string): Promise<string> {
  const account = await stripe.v2.core.accounts.retrieve(accountId, { include: ['configuration.merchant'] });
  return account.configuration?.merchant?.capabilities?.card_payments?.status ?? 'not_requested';
}

const productCache = new Map<string, string>();
async function productFor(stripeAccount: string, name: string): Promise<string> {
  const k = `${stripeAccount}:${name}`;
  const cached = productCache.get(k);
  if (cached) return cached;
  const product = await stripe.products.create({ name }, { stripeAccount });
  productCache.set(k, product.id);
  return product.id;
}

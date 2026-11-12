// Runs the Studio -> Stripe flow against a Stripe SANDBOX with an in-memory Firestore.
// Usage: STRIPE_SECRET_KEY=rk_test_... STRIPE_WEBHOOK_SECRET=whsec_test npx tsx test/studio-sandbox.ts
// It creates and then voids real sandbox invoices; it never touches live mode.
import express from 'express';
import type { Firestore } from 'firebase-admin/firestore';
import { setFirestoreForTests } from '../src/firebase.js';
import { studio } from '../src/routes/studio.js';
import { stripe } from '../src/stripe.js';
import { webhooks } from '../src/routes/webhooks.js';

const data = new Map<string, Record<string, any>>();
const docRef = (path: string) => ({
  id: path.split('/').pop()!,
  async get() { const v = data.get(path); return { exists: !!v, id: path.split('/').pop()!, data: () => v }; },
  async set(v: any, o?: { merge?: boolean }) { data.set(path, o?.merge ? { ...data.get(path), ...v } : v); },
  async update(v: any) { if (!data.has(path)) throw new Error('missing ' + path); data.set(path, { ...data.get(path), ...v }); },
});
setFirestoreForTests({ collection: (c: string) => ({ doc: (id: string) => docRef(`${c}/${id}`) }) } as unknown as Firestore);

const app = express();
app.use('/webhooks', webhooks);
app.use(express.json());
app.use((_q, res, next) => { res.locals.staffEmail = 'test@binalab.my'; next(); });
app.use('/studio', studio);
app.use(((err, _req, res, _next) => { console.error(err.message); res.status(500).json({ error: err.message }); }) as express.ErrorRequestHandler);
const server = app.listen(0);
const base = `http://localhost:${(server.address() as any).port}`;
const post = async (p: string) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return { status: r.status, body: await r.json() as any }; };
const check = (ok: boolean, msg: string) => { console.log(ok ? 'PASS' : 'FAIL', msg); if (!ok) process.exitCode = 1; };

const id = 'test-' + Date.now();
data.set(`invoices/${id}`, {
  ref: 'INV-TEST-0001', businessName: 'Kedai Ujian', clientName: 'Ali', phone: '60123456789', email: 'ujian@example.com', caseId: 'BNL-2026-TEST',
  items: [{ description: 'Sistem POS', qty: 1, price: 1500 }, { description: 'Latihan staf', qty: 2, price: 99.95 }],
  taxRate: 8, status: 'unpaid',
});

try {
  const a = await post(`/studio/invoices/${id}/payment-link`);
  // 1500 + 2*99.95 = 1699.90 ; SST 8% = 135.99(2) -> 13599 sen ; total 183589
  check(a.status === 200 && a.body.amountSen === 183589, `create link: ${a.status} amount=${a.body.amountSen} url=${a.body.url}`);
  check(data.get(`invoices/${id}`)!.stripeStatus === 'open', 'firestore invoice marked open with link');
  const b = await post(`/studio/invoices/${id}/payment-link`);
  check(b.body.stripeInvoiceId === a.body.stripeInvoiceId, 'second call reuses the same open link');
  const inv = await stripe.invoices.retrieve(a.body.stripeInvoiceId);
  check(inv.metadata?.firestoreInvoiceId === id && inv.currency === 'myr', 'stripe invoice carries firestore id, MYR');
  const v = await post(`/studio/invoices/${id}/void-payment-link`);
  check(v.body.status === 'void', 'void link');
  const c = await post(`/studio/invoices/${id}/payment-link`);
  check(c.status === 200 && c.body.stripeInvoiceId !== a.body.stripeInvoiceId, 'new link after void');
  // Simulate Stripe's signed invoice.paid webhook for the current link.
  const paidInvoice = await stripe.invoices.retrieve(c.body.stripeInvoiceId);
  const sendEvent = async (evId: string, inv: any) => {
    const payload = JSON.stringify({ id: evId, object: 'event', type: 'invoice.paid', data: { object: { ...inv, status: 'paid', amount_paid: inv.amount_due } } });
    const sig = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET! });
    return (await fetch(base + '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': sig }, body: payload })).status;
  };
  check((await sendEvent('evt_old', { ...paidInvoice, id: a.body.stripeInvoiceId })) === 200 && data.get(`invoices/${id}`)!.status === 'unpaid', 'webhook for an old voided link is ignored');
  check((await sendEvent('evt_test_paid', paidInvoice)) === 200, 'webhook accepted');
  const after = data.get(`invoices/${id}`)!;
  check(after.status === 'paid' && after.stripeStatus === 'paid' && after.paidAmountSen === 183589, 'webhook marks Studio invoice paid');
  check(data.has('stripeEvents/evt_test_paid'), 'event id stored for dedupe');
  const bad = await fetch(base + '/webhooks/stripe', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
  check(bad.status === 400, 'rejects unsigned webhook');
  check((await post(`/studio/invoices/${id}/payment-link`)).status === 409, 'no new link for a paid invoice');
  await stripe.invoices.voidInvoice(c.body.stripeInvoiceId);
  data.set(`invoices/${id}-noemail`, { items: [{ description: 'x', qty: 1, price: 50 }] });
  check((await post(`/studio/invoices/${id}-noemail/payment-link`)).status === 400, 'asks for email when missing');
  data.set(`invoices/${id}-tiny`, { email: 'a@b.co', items: [{ description: 'x', qty: 1, price: 1 }] });
  check((await post(`/studio/invoices/${id}-tiny/payment-link`)).status === 400, 'rejects below RM 2');
  check((await post(`/studio/invoices/nope/payment-link`)).status === 404, '404 for unknown invoice');
} finally {
  server.close();
}

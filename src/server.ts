import express, { type ErrorRequestHandler } from 'express';
import { webhooks } from './routes/webhooks.js';
import { billing } from './routes/billing.js';
import { connect } from './routes/connect.js';
import { studio } from './routes/studio.js';
import { cors } from './cors.js';
import { requireStaff } from './firebase.js';

const app = express();

// Webhooks first: they need the raw body, not parsed JSON.
app.use('/webhooks', webhooks);
app.use(cors);
app.use(express.json());

// BinaLab Studio (Firebase-authenticated staff only): payment links for invoices.
app.use('/studio', requireStaff, studio);

// Staff only for now. When SMEs log in themselves, /connect/smes/:id routes
// should also allow the SME that owns :id.
app.use('/billing', requireStaff, billing);
app.use('/connect', requireStaff, connect);

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const onError: ErrorRequestHandler = (err, _req, res, _next) => {
  // Log Stripe's message and request ID, never the key or the full request.
  console.error(err?.type ?? 'Error', err?.message, err?.requestId ?? '');
  res.status(err?.statusCode ?? 500).json({ error: err?.message ?? 'Internal error' });
};
app.use(onError);

const port = Number(process.env.PORT ?? 4242);
app.listen(port, () => console.log(`Binalab Stripe server on http://localhost:${port}`));

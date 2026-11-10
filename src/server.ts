import express, { type ErrorRequestHandler } from 'express';
import { webhooks } from './routes/webhooks.js';
import { billing } from './routes/billing.js';
import { connect } from './routes/connect.js';

const app = express();

// Webhooks first: they need the raw body, not parsed JSON.
app.use('/webhooks', webhooks);
app.use(express.json());

// TODO: put your app's auth in front of these routes. Only signed-in Binalab
// staff (or the SME that owns :id) should be able to call them.
app.use('/billing', billing);
app.use('/connect', connect);

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

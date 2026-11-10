import Stripe from 'stripe';
import { HttpsProxyAgent } from 'https-proxy-agent';

// The key comes from the environment (or better, your host's secrets vault).
// Never hard-code it, log it, or ship it to the browser.
const key = process.env.STRIPE_SECRET_KEY;
if (!key) {
  throw new Error('STRIPE_SECRET_KEY is not set. Use a restricted key (rk_...) from a sandbox while developing.');
}

// Guard against accidentally pointing a dev machine at live money.
if (/^[sr]k_live_/.test(key) && process.env.ALLOW_LIVE_KEYS !== 'true') {
  throw new Error('A live Stripe key is configured. Set ALLOW_LIVE_KEYS=true only on your production server.');
}

// One client instance for the whole app. The SDK pins the API version it
// was built for (2026-10-28.endive for stripe@23.1.0).
// If the server sits behind an outbound proxy, route Stripe calls through it.
const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
export const stripe = new Stripe(key, {
  appInfo: { name: 'binalab-stripe' },
  ...(proxy ? { httpAgent: new HttpsProxyAgent(proxy) } : {}),
});

export const APP_URL = process.env.APP_URL ?? 'http://localhost:4242';

// Malaysian ringgit. Stripe amounts are in the smallest unit (sen): RM 150.00 = 15000.
export const CURRENCY = 'myr';

// Tags Checkout Sessions so each flow can be compared in the Dashboard.
// Stripe recommends a label ending in 8 random letters.
export function integrationId(flow: string): string {
  const letters = Array.from({ length: 8 }, () =>
    String.fromCharCode(97 + Math.floor(Math.random() * 26)),
  ).join('');
  return `binalab_${flow}_${letters}`;
}

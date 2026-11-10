# Binalab × Stripe: Payments + Invoicing

Built from Stripe's official best-practices skill (API `2026-10-28.endive`, `stripe@23.1.0`).

## The plan

Binalab has two money flows. One Stripe account handles both.

| | A. Binalab bills its clients | B. SMEs bill their own customers |
|---|---|---|
| Who gets paid | Binalab | The SME (Binalab takes a fee) |
| Stripe product | Invoicing, Checkout, Billing (retainers) | Connect (SaaS pattern) + Checkout/Invoicing |
| Customer record | Accounts v2 with `customer` config | SME = Accounts v2 with `merchant` + `customer` config |
| Charge type | Normal charge on Binalab's account | **Direct charge** on the SME's account + `application_fee_amount` |
| Code | `src/routes/billing.ts` | `src/routes/connect.ts` |

**Why this Connect setup:** your SMEs run their own businesses and own their customers. So each one is the merchant of record (`dashboard: full`, `fees_collector: stripe`, `losses_collector: stripe`). Stripe carries the fraud and negative-balance risk, not Binalab. The same SME account also has a `customer` config, so Binalab can bill that SME for its software subscription.

## Endpoints

| Route | What it does |
|---|---|
| `POST /billing/clients` | Create a Binalab client `{name, email}` |
| `POST /billing/invoices` | Email an invoice `{customerAccount, items:[{description, amount}], daysUntilDue}` |
| `POST /billing/checkout` | Checkout for a package or retainer `{priceId, mode: payment\|subscription}` |
| `POST /billing/portal` | Self-service portal for retainer clients |
| `POST /connect/smes` | Create an SME's connected account |
| `POST /connect/smes/:id/onboarding-link` | Stripe-hosted onboarding URL (KYC + bank) |
| `GET /connect/smes/:id/status` | Is `card_payments` active? |
| `POST /connect/smes/:id/checkout` | SME's customer pays online, minus Binalab's fee |
| `POST /connect/smes/:id/invoices` | SME invoices its customer, minus Binalab's fee |
| `POST /webhooks/stripe` | Payment, invoice, subscription and risk events (signature-verified) |
| `POST /webhooks/stripe-v2` | SME onboarding/capability changes (Accounts v2 thin events) |

All amounts are in **sen** (RM 150.00 = `15000`). Stripe's minimum charge is RM 2.00.

## Run it

```bash
npm install
cp .env.example .env    # fill in your sandbox keys
npm run dev
```

Forward webhooks locally with the Stripe CLI:

```bash
stripe listen --forward-to localhost:4242/webhooks/stripe --forward-connect-to localhost:4242/webhooks/stripe
```

## Set up your existing Stripe account (once)

1. **Develop in a sandbox**, not live. Dashboard → account menu → *Sandboxes* → create one.
2. **Use a restricted key** (`rk_…`), not the secret key. *Developers → API keys → Create restricted key*. Grant write on: Accounts (v2), Customers, Products, Prices, Invoices, Invoice items, Checkout Sessions, Payment Intents, Subscriptions, Billing portal. Read on Events.
3. **Enable Connect**: *Connect → Get started*, and choose a platform where sellers have their own Stripe Dashboard.
4. **Payment methods**: *Settings → Payment methods*. Turn on **FPX** and **GrabPay** alongside cards. They show up automatically because the code never hard-codes `payment_method_types`.
5. **Webhooks**: *Developers → Webhooks*. Add an endpoint for "Your account" and one for "Connected accounts". Then go to *Event destinations* and add a v2 destination for `v2.core.account[configuration.merchant].capability_status_updated`.
6. **Branding**: *Settings → Branding* (logo and colours on invoices and Checkout) and *Settings → Invoices* (invoice numbering, footer, SST number).

## Before going live

- [ ] Replace the `console.log` handlers in `webhooks.ts` with database writes. Fulfil only from webhooks.
- [ ] Store processed event IDs in your database (the in-memory `seen` set resets on restart).
- [ ] Put auth on `/billing` and `/connect`. Only Binalab staff, or the SME that owns `:id`, may call them.
- [ ] Use a live restricted key from a secrets vault, with `ALLOW_LIVE_KEYS=true` only on production. Add an IP access policy to the key.
- [ ] Re-create webhook endpoints in live mode (live signing secrets differ).
- [ ] Add a Content-Security-Policy allowing `https://*.stripe.com` if you embed Stripe.js.
- [ ] Enforce passkey/authenticator-app 2FA for your Dashboard team.
- [ ] **SST**: Stripe doesn't add tax unless you set it up. If Binalab or your SMEs are SST-registered, add tax rates on invoices or check Stripe Tax support for Malaysia. Don't just flip `automatic_tax` on.
- [ ] Walk through Stripe's [go-live checklist](https://docs.stripe.com/get-started/checklist/go-live.md).

## Next ideas

- Embedded Connect components in your SME dashboard: `account_onboarding`, `notification_banner` (strongly recommended), `payments`, `payouts`.
- Have SMEs pay for Binalab's software via a subscription on their `customer_account`.

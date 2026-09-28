# DNA Kit Registration

Customers register their own DNA kit on their phone by scanning the unique barcode on the back of the card, then pay with Stripe. In the lab, staff scan the same barcode with a USB scanner to see the person's details and payment.

## Pages

| Address | Who | What |
|---|---|---|
| `/` | Customers | Scan the card barcode (phone camera) or type the number, enter details, consent, pay |
| `/done` | Customers | Confirmation screen after payment, shown to staff |
| `/staff` | Staff (login) | Lab scan, records, CSV export, staff check-in backup, settings, staff accounts |

## How it works

- No dependencies: Node 22 with its built-in SQLite. The database file lives on the Railway volume at `/data/kits.db`.
- Stripe Checkout is created per kit with `client_reference_id` = kit barcode. The record becomes **Paid** through the Stripe webhook, and is also checked when the customer lands on `/done`.
- A kit locks once it's paid, so no one can register over it.
- Every staff view and change is written to an activity log per kit.

## Settings (Railway variables)

| Variable | Example | Notes |
|---|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_...` | From Stripe → Developers → API keys. Use the test key until you go live. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` | From the webhook endpoint pointing at `/stripe/webhook` |
| `PRICE_AMOUNT` | `899` | Price in whole currency units |
| `CURRENCY` | `dkk` | |
| `PRODUCT_NAME` | `DNA test` | Shown on the payment page |
| `COMPANY_NAME` | `Acme DNA` | Shown to customers and in the consent text |
| `PRIVACY_URL` | `https://...` | Link to your privacy notice |
| `PUBLIC_URL` | `https://...` | The app's public address |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | | Creates the first admin on first start only. Change the password after signing in. |

## Run locally

```
PRICE_AMOUNT=899 ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=changeme12345 node server.js
```
Then open http://localhost:3000 and http://localhost:3000/staff

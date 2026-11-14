# PayPal checkout operations

Foggy Layers uses PayPal JavaScript SDK v6 in the browser and the PayPal Orders v2 API from the Cloudflare Worker. Product names, bundle discounts, shipping, and totals are recalculated from `src/data/products.json` on the Worker. The browser never supplies an authoritative price.

## Required Cloudflare secrets

The production Worker needs these PayPal values:

- `PAYPAL_CLIENT_ID` - PayPal sandbox or live client ID. It is returned to the checkout page only when checkout is fully enabled.
- `PAYPAL_CLIENT_SECRET` - Cloudflare secret. Never place it in GitHub or browser code.
- `PAYPAL_ENVIRONMENT` - `sandbox` or `live`. Use `sandbox` until a sandbox buyer payment has completed successfully.
- `PAYPAL_COMMERCE_ENABLED` - set in `wrangler.jsonc` and currently `true`.

The repository exports a private Durable Object named `OrderStore`, so no separate D1 database is required for the initial launch. If a D1 binding named `DB` is present, the Worker remains compatible with it and uses D1 first.

Checkout remains closed unless persistent order storage and both PayPal credentials are available in the same production Worker environment.

## Checkout settings

The initial launch settings are in `wrangler.jsonc`:

- `MINIMUM_ORDER_CENTS=500` - $5.00 merchandise minimum.
- `FLAT_SHIPPING_CENTS=800` - $8.00 flat-rate US shipping.
- Everett, Washington pickup is free.
- Currency is USD and shipping checkout accepts US addresses only.

Change these values and deploy again when pricing changes.

## Order notifications

PayPal records the payer and delivery details after capture. Custom seller and customer emails are sent when all of these are configured:

- `RESEND_API_KEY`
- `MAIL_FROM` using a verified sending domain
- `orders@foggylayers.com` in `src/data/site.json`

Without those values, payment capture and the order dashboard still work. PayPal may send its own payment receipts separately.

## Order dashboard

Open `/admin/orders/`. The dashboard accepts either:

- `ORDERS_ADMIN_TOKEN`, or
- the existing `FACEBOOK_ADMIN_TOKEN` as a fallback.

Use a random URL-safe token at least 32 characters long. The page stores it only in session storage and sends it in the `Authorization` header. The token must be configured as a production Worker secret; never commit it to GitHub.

Order workflow values are New, Printing, Ready for pickup, Shipped, Completed, and Cancelled.

## Order storage

The private `OrderStore` Durable Object stores:

- local Foggy Layers order ID and short reference
- normalized cart and bundle pricing
- subtotal, shipping, and total cents
- PayPal order and capture IDs
- payer and shipping details
- payment and fulfillment status

PayPal order IDs and capture IDs are indexed inside the object to prevent accidental reuse across orders. The store is reachable only through an internal Worker binding.

## Functional checks

Run:

```sh
npm test
npm run build
npm run check
```

The PayPal tests mock the external API and verify trusted pricing, bundle discounts, minimum order enforcement, pickup, shipping, capture validation, duplicate retry behavior, same-origin controls, both D1 and Durable Object persistence, and admin authorization.

For a real sandbox browser test, add at least $5.00 to the bag, choose pickup or shipping, approve with a PayPal sandbox buyer account, and confirm that the success page shows a paid order and `/admin/orders/` lists the same capture ID. Do not switch `PAYPAL_ENVIRONMENT` to `live` until that test succeeds.

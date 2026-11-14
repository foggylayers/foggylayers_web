import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createPayPalAPI, normalizePayPalCart, paypalConfiguration } from '../worker/paypal.mjs';

const origin = 'https://foggylayers.com';
const business = { name: 'Foggy Layers', url: origin, contactEmail: 'orders@example.com', pickupCity: 'Everett', pickupState: 'WA' };
const catalog = [
  { id: 'test-print', name: 'Test print', priceCents: 1500, status: 'available' },
  { id: 'mini-pet', name: 'Mini pet', priceCents: 50, status: 'available', bundlePricing: { group: 'mini-pets', quantity: 12, priceCents: 500 } },
  { id: 'inquiry', name: 'Inquiry only', priceCents: null, status: 'inquiry' }
];
const paypalId = '5O190127TN364715T';
const captureId = '3C679366HH908993F';

class TestDB {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    const wrapper = values => ({
      bind: (...next) => wrapper(next),
      first: async () => statement.get(...values) || null,
      all: async () => ({ results: statement.all(...values) }),
      run: async () => ({ meta: { changes: Number(statement.run(...values).changes) } })
    });
    return wrapper([]);
  }
}

function environment(overrides = {}) {
  return {
    DB: new TestDB(),
    PAYPAL_CLIENT_ID: 'test-client-id',
    PAYPAL_CLIENT_SECRET: 'test-client-secret-value',
    PAYPAL_ENVIRONMENT: 'sandbox',
    PAYPAL_COMMERCE_ENABLED: 'true',
    MINIMUM_ORDER_CENTS: '500',
    FLAT_SHIPPING_CENTS: '800',
    SITE_URL: origin,
    ORDERS_ADMIN_TOKEN: 'A'.repeat(43),
    ...overrides
  };
}

function write(path, data, headers = {}) {
  return new Request(`${origin}${path}`, {
    method: headers.method || 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(data)
  });
}

function paypalFetcher(records, shipping = false) {
  let createdPayload;
  return async (url, init) => {
    records.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) {
      assert.match(init.headers.Authorization, /^Basic /);
      return Response.json({ access_token: 'access-token-long-enough-for-tests', expires_in: 3600 });
    }
    if (url.endsWith('/v2/checkout/orders') && init.method === 'POST') {
      createdPayload = JSON.parse(init.body);
      return Response.json({ id: paypalId, status: 'PAYER_ACTION_REQUIRED', intent: 'CAPTURE', purchase_units: createdPayload.purchase_units }, { status: 201 });
    }
    if (url.endsWith(`/v2/checkout/orders/${paypalId}`) && init.method === 'GET') {
      const unit = structuredClone(createdPayload.purchase_units[0]);
      if (shipping) unit.shipping = { name: { full_name: 'Test Buyer' }, address: { address_line_1: '1 Main St', admin_area_2: 'Everett', admin_area_1: 'WA', postal_code: '98201', country_code: 'US' } };
      return Response.json({ id: paypalId, status: 'APPROVED', intent: 'CAPTURE', payer: { payer_id: 'BUYER123', email_address: 'buyer@example.com', name: { given_name: 'Test', surname: 'Buyer' } }, purchase_units: [unit] });
    }
    if (url.endsWith(`/v2/checkout/orders/${paypalId}/capture`) && init.method === 'POST') {
      const unit = structuredClone(createdPayload.purchase_units[0]);
      if (shipping) unit.shipping = { name: { full_name: 'Test Buyer' }, address: { address_line_1: '1 Main St', admin_area_2: 'Everett', admin_area_1: 'WA', postal_code: '98201', country_code: 'US' } };
      unit.payments = { captures: [{ id: captureId, status: 'COMPLETED', amount: unit.amount }] };
      return Response.json({ id: paypalId, status: 'COMPLETED', intent: 'CAPTURE', payer: { payer_id: 'BUYER123', email_address: 'buyer@example.com', name: { given_name: 'Test', surname: 'Buyer' } }, purchase_units: [unit] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

async function create(api, env, data) {
  return api(write('/api/paypal/orders', data), env, { waitUntil() {} });
}

async function capture(api, env, checkoutKey) {
  return api(write(`/api/paypal/orders/${paypalId}/capture`, { checkoutKey }), env, { waitUntil() {} });
}

test('configuration exposes the client ID but never the secret', () => {
  const env = environment();
  const config = paypalConfiguration(env, business);
  assert.equal(config.checkoutEnabled, true);
  assert.equal(config.clientId, env.PAYPAL_CLIENT_ID);
  assert.equal(config.environment, 'sandbox');
  assert.equal(JSON.stringify(config).includes(env.PAYPAL_CLIENT_SECRET), false);
});

test('cart normalization trusts only catalog prices and applies bundle pricing', () => {
  const normal = normalizePayPalCart([{ id: 'test-print', quantity: 2, priceCents: 1, name: 'Fake' }], catalog);
  assert.equal(normal[0].priceCents, 1500);
  assert.equal(normal[0].name, 'Test print');
  const bundle = normalizePayPalCart([{ id: 'mini-pet', quantity: 12, lineTotalCents: 1 }], catalog);
  assert.equal(bundle[0].lineTotalCents, 500);
  assert.throws(() => normalizePayPalCart([{ id: 'inquiry', quantity: 1 }], catalog));
  assert.throws(() => normalizePayPalCart([{ id: 'missing', quantity: 1 }], catalog));
});

test('pickup order creates and captures with trusted totals, then reports paid', async () => {
  const env = environment(); const records = [];
  const api = createPayPalAPI({ business, catalog, fetcher: paypalFetcher(records), now: () => Date.parse('2026-11-13T20:00:00Z') });
  const checkoutKey = crypto.randomUUID();
  const created = await create(api, env, { items: [{ id: 'test-print', quantity: 2, priceCents: 1 }], fulfillment: 'pickup', checkoutKey, paymentMethod: 'paypal' });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).id, paypalId);
  const createCall = records.find(record => record.url.endsWith('/v2/checkout/orders'));
  const payload = JSON.parse(createCall.init.body);
  assert.equal(payload.purchase_units[0].amount.value, '30.00');
  assert.equal(payload.purchase_units[0].amount.breakdown.shipping.value, '0.00');
  assert.equal(payload.payment_source.paypal.experience_context.shipping_preference, 'NO_SHIPPING');

  const captured = await capture(api, env, checkoutKey);
  assert.equal(captured.status, 200);
  const result = await captured.json();
  assert.equal(result.status, 'paid');
  assert.equal(result.captureId, captureId);
  const row = env.DB.db.prepare('SELECT * FROM orders WHERE id = ?').get(checkoutKey);
  assert.equal(row.status, 'paid');
  assert.equal(row.total_cents, 3000);
  assert.equal(row.paypal_capture_id, captureId);
  assert.equal(JSON.parse(row.customer_json).payer.email, 'buyer@example.com');

  const status = await api(new Request(`${origin}/api/paypal/orders/status?order_id=${checkoutKey}`), env);
  assert.deepEqual(await status.json(), { status: 'paid', fulfillment: 'pickup', fulfillmentStatus: 'new', reference: `FL-${checkoutKey.slice(0, 8).toUpperCase()}`, totalCents: 3000, paid: true });
});

test('shipping order adds the configured flat rate and keeps the US address', async () => {
  const env = environment(); const records = [];
  const api = createPayPalAPI({ business, catalog, fetcher: paypalFetcher(records, true) });
  const checkoutKey = crypto.randomUUID();
  assert.equal((await create(api, env, { items: [{ id: 'test-print', quantity: 1 }], fulfillment: 'shipping', checkoutKey, paymentMethod: 'venmo' })).status, 201);
  const payload = JSON.parse(records.find(record => record.url.endsWith('/v2/checkout/orders')).init.body);
  assert.equal(payload.purchase_units[0].amount.value, '23.00');
  assert.equal(payload.purchase_units[0].amount.breakdown.shipping.value, '8.00');
  assert.equal(payload.payment_source.venmo.experience_context.shipping_preference, 'GET_FROM_FILE');
  assert.equal((await capture(api, env, checkoutKey)).status, 200);
  const customer = JSON.parse(env.DB.db.prepare('SELECT customer_json FROM orders WHERE id = ?').get(checkoutKey).customer_json);
  assert.equal(customer.shipping.address.country_code, 'US');
});

test('minimum order, changed carts, and cross-origin writes are rejected', async () => {
  const env = environment(); const api = createPayPalAPI({ business, catalog, fetcher: paypalFetcher([]) });
  const low = await create(api, env, { items: [{ id: 'mini-pet', quantity: 1 }], fulfillment: 'pickup', checkoutKey: crypto.randomUUID(), paymentMethod: 'paypal' });
  assert.equal(low.status, 400); assert.equal((await low.json()).code, 'MINIMUM_ORDER');
  const checkoutKey = crypto.randomUUID();
  assert.equal((await create(api, env, { items: [{ id: 'test-print', quantity: 1 }], fulfillment: 'pickup', checkoutKey, paymentMethod: 'paypal' })).status, 201);
  assert.equal((await create(api, env, { items: [{ id: 'test-print', quantity: 2 }], fulfillment: 'pickup', checkoutKey, paymentMethod: 'paypal' })).status, 409);
  const cross = new Request(`${origin}/api/paypal/orders`, { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal((await api(cross, env)).status, 403);
});

test('create retries are idempotent and do not create a second PayPal order', async () => {
  const env = environment(); const records = [];
  const api = createPayPalAPI({ business, catalog, fetcher: paypalFetcher(records) });
  const data = { items: [{ id: 'test-print', quantity: 1 }], fulfillment: 'pickup', checkoutKey: crypto.randomUUID(), paymentMethod: 'paypal' };
  assert.equal((await create(api, env, data)).status, 201);
  assert.equal((await create(api, env, data)).status, 200);
  assert.equal(records.filter(record => record.url.endsWith('/v2/checkout/orders')).length, 1);
});

test('admin token protects order details and status updates', async () => {
  const env = environment(); const api = createPayPalAPI({ business, catalog, fetcher: paypalFetcher([]) });
  const unauthorized = await api(new Request(`${origin}/api/admin/orders`), env);
  assert.equal(unauthorized.status, 401);
  const headers = { Authorization: `Bearer ${env.ORDERS_ADMIN_TOKEN}` };
  const listed = await api(new Request(`${origin}/api/admin/orders`, { headers }), env);
  assert.equal(listed.status, 200);
  const id = crypto.randomUUID();
  env.DB.db.prepare("INSERT INTO orders (id, created_at, updated_at, status, cart_json, fulfillment, payment_provider, subtotal_cents, shipping_cents, total_cents, fulfillment_status) VALUES (?, ?, ?, 'paid', '[]', 'pickup', 'paypal', 500, 0, 500, 'new')").run(id, new Date().toISOString(), new Date().toISOString());
  const updated = await api(write(`/api/admin/orders/${id}`, { fulfillmentStatus: 'printing' }, { method: 'PATCH', Authorization: `Bearer ${env.ORDERS_ADMIN_TOKEN}` }), env);
  assert.equal(updated.status, 200);
  assert.equal(env.DB.db.prepare('SELECT fulfillment_status FROM orders WHERE id = ?').get(id).fulfillment_status, 'printing');
});

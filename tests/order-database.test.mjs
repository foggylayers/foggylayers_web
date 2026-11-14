import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPalAPI } from '../worker/paypal.mjs';
import { createOrderDatabase, OrderStore } from '../worker/order-database.mjs';

const origin = 'https://foggylayers.com';
const paypalOrderId = '5O190127TN364715T';
const captureId = '3C679366HH908993F';
const catalog = [{ id: 'test-print', name: 'Test print', priceCents: 1500, status: 'available' }];
const business = { name: 'Foggy Layers', url: origin, contactEmail: '', pickupCity: 'Everett', pickupState: 'WA' };

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return this.values.has(key) ? structuredClone(this.values.get(key)) : undefined; }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async list({ prefix = '' } = {}) {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)]));
  }
  async transaction(callback) { return callback(this); }
}

class MemoryNamespace {
  constructor() {
    this.storage = new MemoryStorage();
    this.object = new OrderStore({ storage: this.storage });
  }
  idFromName(name) { return name; }
  get() { return { fetch: request => this.object.fetch(request) }; }
}

function request(path, body) {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function paypalFetcher(records) {
  let created;
  return async (url, init) => {
    records.push({ url, init });
    if (url.endsWith('/v1/oauth2/token')) return Response.json({ access_token: 'access-token-long-enough-for-tests' });
    if (url.endsWith('/v2/checkout/orders') && init.method === 'POST') {
      created = JSON.parse(init.body);
      return Response.json({ id: paypalOrderId, status: 'PAYER_ACTION_REQUIRED', intent: 'CAPTURE', purchase_units: created.purchase_units }, { status: 201 });
    }
    if (url.endsWith(`/v2/checkout/orders/${paypalOrderId}`) && init.method === 'GET') {
      return Response.json({ id: paypalOrderId, status: 'APPROVED', intent: 'CAPTURE', payer: { email_address: 'buyer@example.com' }, purchase_units: created.purchase_units });
    }
    if (url.endsWith(`/v2/checkout/orders/${paypalOrderId}/capture`) && init.method === 'POST') {
      const unit = structuredClone(created.purchase_units[0]);
      unit.payments = { captures: [{ id: captureId, status: 'COMPLETED', amount: unit.amount }] };
      return Response.json({ id: paypalOrderId, status: 'COMPLETED', intent: 'CAPTURE', payer: { email_address: 'buyer@example.com' }, purchase_units: [unit] });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
}

test('Durable Object database adapter supports the full PayPal order lifecycle', async () => {
  const namespace = new MemoryNamespace();
  const records = [];
  const env = {
    DB: createOrderDatabase(namespace),
    PAYPAL_CLIENT_ID: 'sandbox-client-id',
    PAYPAL_CLIENT_SECRET: 'sandbox-client-secret',
    PAYPAL_ENVIRONMENT: 'sandbox',
    PAYPAL_COMMERCE_ENABLED: 'true',
    MINIMUM_ORDER_CENTS: '500',
    FLAT_SHIPPING_CENTS: '800',
    SITE_URL: origin,
    ORDERS_ADMIN_TOKEN: 'A'.repeat(43)
  };
  const api = createPayPalAPI({ catalog, business, fetcher: paypalFetcher(records), now: () => Date.parse('2026-11-14T05:00:00Z') });
  const checkoutKey = crypto.randomUUID();

  const created = await api(request('/api/paypal/orders', {
    items: [{ id: 'test-print', quantity: 1 }],
    fulfillment: 'pickup',
    checkoutKey,
    paymentMethod: 'paypal'
  }), env, { waitUntil() {} });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).id, paypalOrderId);

  const captured = await api(request(`/api/paypal/orders/${paypalOrderId}/capture`, { checkoutKey }), env, { waitUntil() {} });
  assert.equal(captured.status, 200);
  assert.equal((await captured.json()).captureId, captureId);

  const status = await api(new Request(`${origin}/api/paypal/orders/status?order_id=${checkoutKey}`), env);
  const statusBody = await status.json();
  assert.equal(statusBody.paid, true);
  assert.equal(statusBody.totalCents, 1500);

  const listed = await api(new Request(`${origin}/api/admin/orders`, { headers: { Authorization: `Bearer ${env.ORDERS_ADMIN_TOKEN}` } }), env);
  assert.equal(listed.status, 200);
  const orders = (await listed.json()).orders;
  assert.equal(orders.length, 1);
  assert.equal(orders[0].paypalCaptureId, captureId);
  assert.equal(records.filter(record => record.url.endsWith('/v2/checkout/orders')).length, 1);
});

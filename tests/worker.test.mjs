import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createWorker, normalizeCart, validateProject, verifyStripeSignature } from '../worker/index.mjs';

const origin = 'https://foggylayers.com';
const business = { url: origin, contactEmail: 'studio@example.com' };
const catalog = [{ id: 'test-print', name: 'Test print', priceCents: 1500, status: 'available' }, { id: 'unpriced', name: 'Unpriced print', priceCents: null, status: 'inquiry' }];
const sessionId = 'cs_test_foggylayers123456789';
const sessionURL = `https://checkout.stripe.com/c/pay/${sessionId}`;
const signatureSecret = 'whsec_test_only';
class TestDB {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8')); }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    const wrapper = values => ({
      bind: (...next) => wrapper(next),
      first: async () => statement.get(...values) || null,
      run: async () => ({ meta: { changes: Number(statement.run(...values).changes) } }),
      execute: () => ({ meta: { changes: Number(statement.run(...values).changes) } })
    });
    return wrapper([]);
  }
  async batch(statements) {
    this.db.exec('BEGIN');
    try { const result = statements.map(statement => statement.execute()); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
function environment() {
  const uploaded = new Map();
  return { DB: new TestDB(), UPLOADS: { async put(key, body) { uploaded.set(key, await new Response(body).arrayBuffer()); }, async delete(key) { uploaded.delete(key); } }, uploaded, REQUESTS_ENABLED: 'true', COMMERCE_ENABLED: 'true', TURNSTILE_SECRET_KEY: 'test-secret', TURNSTILE_SITE_KEY: 'test-site', STRIPE_SECRET_KEY: 'sk_test_placeholder', STRIPE_WEBHOOK_SECRET: signatureSecret, STRIPE_SHIPPING_RATE_ID: 'shr_TestShipping123', SITE_URL: origin, SHIPPING_COUNTRIES: 'US' };
}
function projectForm(type = 'design') {
  const form = new FormData();
  for (const [key, value] of Object.entries({ type, name: 'Test Customer', email: 'Customer@example.com', description: 'A custom printed part for a desk project.', quantity: '2', fulfillment: 'pickup', consent: 'yes', 'cf-turnstile-response': 'test-token' })) form.set(key, value);
  return form;
}
function request(path, data, headers = {}) {
  return new Request(`${origin}${path}`, { method: 'POST', headers: { Origin: origin, ...(data instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: data instanceof FormData ? data : JSON.stringify(data) });
}
async function signedEvent(body, timestamp = Math.floor(Date.now() / 1000), secret = signatureSecret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`));
  return `t=${timestamp},v1=${Buffer.from(signature).toString('hex')}`;
}
async function deliver(worker, env, event, ctx = {}) {
  const body = JSON.stringify(event);
  return worker.fetch(new Request(`${origin}/api/stripe/webhook`, { method: 'POST', headers: { 'Stripe-Signature': await signedEvent(body) }, body }), env, ctx);
}
function eventFor(orderId, overrides = {}) {
  return { id: 'evt_test_paid_1', type: 'checkout.session.completed', data: { object: { id: sessionId, mode: 'payment', payment_status: 'paid', currency: 'usd', amount_subtotal: 3000, metadata: { order_id: orderId }, customer_details: { email: 'customer@example.com' }, ...overrides } } };
}

test('unconfigured deployments expose no secrets and cannot accept requests or payments', async () => {
  const worker = createWorker();
  const config = await (await worker.fetch(new Request(`${origin}/api/config`), {})).json();
  assert.equal(config.requestsEnabled, false); assert.equal(config.checkoutEnabled, false); assert.equal(config.turnstileSiteKey, null);
  assert.equal((await worker.fetch(request('/api/requests', projectForm()), {})).status, 503);
  assert.equal((await worker.fetch(request('/api/checkout', {}), {})).status, 503);
});
test('an empty business email keeps configured services closed', async () => {
  const worker = createWorker({ business: { ...business, contactEmail: '' } });
  const config = await (await worker.fetch(new Request(`${origin}/api/config`), environment())).json();
  assert.equal(config.requestsEnabled, false); assert.equal(config.checkoutEnabled, false);
});
test('cross-origin writes are rejected before storing anything', async () => {
  const worker = createWorker({ business }); const env = environment();
  assert.equal((await worker.fetch(request('/api/requests', projectForm(), { Origin: 'https://elsewhere.example' }), env)).status, 403);
  assert.equal(env.uploaded.size, 0);
});
test('request validation requires a model for print work and valid product selection', () => {
  assert.throws(() => validateProject(projectForm('print')), /attach a model/);
  const product = projectForm('product'); product.set('productId', 'unknown');
  assert.throws(() => validateProject(product, catalog), /Choose a print/);
  product.set('productId', 'test-print'); assert.equal(validateProject(product, catalog).payload.productId, 'test-print');
});
test('request validation rejects missing consent, invalid email, honeypots, and unsupported files', () => {
  const form = projectForm(); form.delete('consent'); assert.throws(() => validateProject(form), /privacy/);
  form.set('consent', 'yes'); form.set('email', 'invalid'); assert.throws(() => validateProject(form), /email/);
  form.set('email', 'valid@example.com'); form.set('website', 'spam'); assert.throws(() => validateProject(form), /accept/);
  form.set('website', ''); form.append('files', new File(['bad'], 'script.html')); assert.throws(() => validateProject(form), /supported files/);
});
test('request validation enforces individual and aggregate file limits', () => {
  const form = projectForm(); form.append('files', new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.stl'));
  assert.throws(() => validateProject(form), /10 MB/);
  const multiple = projectForm(); for (let i = 0; i < 3; i++) multiple.append('files', new File([new Uint8Array(7 * 1024 * 1024)], `${i}.stl`));
  assert.throws(() => validateProject(multiple), /20 MB/);
});
test('a failed verification writes neither request records nor files', async () => {
  const worker = createWorker({ business, fetcher: async () => Response.json({ success: false }) }); const env = environment();
  const form = projectForm('print'); form.append('files', new File(['solid model'], 'part.stl'));
  const response = await worker.fetch(request('/api/requests', form, { 'X-Request-ID': crypto.randomUUID() }), env);
  assert.equal(response.status, 400); assert.equal(env.uploaded.size, 0); assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 0);
});
test('project files are private, records are durable, and retries do not duplicate uploads', async () => {
  const worker = createWorker({ business, fetcher: async () => Response.json({ success: true, action: 'project_request', hostname: 'foggylayers.com' }) }); const env = environment(); const id = crypto.randomUUID();
  const make = () => { const form = projectForm('print'); form.append('files', new File(['solid part'], '../../part.stl')); return request('/api/requests', form, { 'X-Request-ID': id }); };
  const first = await worker.fetch(make(), env); assert.equal(first.status, 201); const result = await first.json(); assert.match(result.reference, /^FL-/); assert.equal(env.uploaded.size, 1);
  const row = env.DB.db.prepare('SELECT * FROM requests WHERE id = ?').get(id); assert.equal(JSON.parse(row.payload_json).email, 'customer@example.com');
  const file = JSON.parse(row.files_json)[0]; assert.ok(file.key.startsWith(`requests/${id}/`)); assert.equal(file.key.includes('../'), false); assert.equal('url' in file, false);
  assert.equal((await worker.fetch(make(), env)).status, 200); assert.equal(env.uploaded.size, 1); assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, 1);
});
test('unsupported host or action from Turnstile cannot create a request', async () => {
  for (const result of [{ success: true, action: 'other', hostname: 'foggylayers.com' }, { success: true, action: 'project_request', hostname: 'other.example' }]) {
    const worker = createWorker({ business, fetcher: async () => Response.json(result) });
    assert.equal((await worker.fetch(request('/api/requests', projectForm(), { 'X-Request-ID': crypto.randomUUID() }), environment())).status, 400);
  }
});
test('cart validation ignores browser-supplied prices and rejects unknown or unpriced products', () => {
  const cart = normalizeCart([{ id: 'test-print', quantity: 2, priceCents: 1, name: 'Fake' }], catalog);
  assert.equal(cart[0].priceCents, 1500); assert.equal(cart[0].name, 'Test print');
  for (const items of [[{ id: 'unpriced', quantity: 1 }], [{ id: 'missing', quantity: 1 }], [{ id: 'test-print', quantity: -1 }], [{ id: 'test-print', quantity: 1.5 }], [{ id: 'test-print', quantity: 1 }, { id: 'test-print', quantity: 1 }]]) assert.throws(() => normalizeCart(items, catalog));
});
test('checkout uses trusted catalog prices, omits shipping charges for pickup, and reuses retries', async () => {
  const env = environment(); let calls = 0;
  const worker = createWorker({ business, catalog, fetcher: async (url, init) => {
    calls++; assert.equal(url, 'https://api.stripe.com/v1/checkout/sessions');
    assert.equal(init.body.get('line_items[0][price_data][unit_amount]'), '1500');
    assert.equal(init.body.get('line_items[0][quantity]'), '2');
    assert.equal(init.body.has('shipping_options[0][shipping_rate]'), false);
    assert.equal(init.body.get('automatic_tax[enabled]'), 'true');
    return Response.json({ id: sessionId, url: sessionURL });
  } });
  const data = { items: [{ id: 'test-print', quantity: 2, priceCents: 1 }], fulfillment: 'pickup', checkoutKey: crypto.randomUUID() };
  assert.equal((await worker.fetch(request('/api/checkout', data), env)).status, 200);
  assert.equal((await worker.fetch(request('/api/checkout', data), env)).status, 200); assert.equal(calls, 1);
  data.items[0].quantity = 1; assert.equal((await worker.fetch(request('/api/checkout', data), env)).status, 409);
});
test('shipping checkout adds the configured rate and destination restrictions', async () => {
  const env = environment();
  const worker = createWorker({ business, catalog, fetcher: async (_url, init) => {
    assert.equal(init.body.get('shipping_options[0][shipping_rate]'), 'shr_TestShipping123');
    assert.equal(init.body.get('shipping_address_collection[allowed_countries][0]'), 'US');
    return Response.json({ id: sessionId, url: sessionURL });
  } });
  const data = { items: [{ id: 'test-print', quantity: 1 }], fulfillment: 'shipping', checkoutKey: crypto.randomUUID() };
  assert.equal((await worker.fetch(request('/api/checkout', data), env)).status, 200);
  delete env.STRIPE_SHIPPING_RATE_ID; data.checkoutKey = crypto.randomUUID();
  assert.equal((await worker.fetch(request('/api/checkout', data), env)).status, 503);
});
test('webhook signatures reject tampering and expired signatures while allowing rotation', async () => {
  const body = '{"test":true}'; const signature = await signedEvent(body);
  assert.equal(await verifyStripeSignature(body, signature, signatureSecret), true);
  assert.equal(await verifyStripeSignature(`${body} `, signature, signatureSecret), false);
  assert.equal(await verifyStripeSignature(body, await signedEvent(body, Math.floor(Date.now() / 1000) - 301), signatureSecret), false);
  assert.equal(await verifyStripeSignature(body, `${signature},v1=${'0'.repeat(64)}`, signatureSecret), true);
});
test('paid webhooks are idempotent and late failures cannot downgrade a paid order', async () => {
  const env = environment(); const worker = createWorker({ business, catalog, fetcher: async () => Response.json({ id: sessionId, url: sessionURL }) }); const id = crypto.randomUUID();
  await worker.fetch(request('/api/checkout', { items: [{ id: 'test-print', quantity: 2 }], fulfillment: 'pickup', checkoutKey: id }), env);
  const paid = eventFor(id); assert.equal((await deliver(worker, env, paid)).status, 200); assert.equal((await deliver(worker, env, paid)).status, 200);
  const failed = eventFor(id, { payment_status: 'unpaid' }); failed.id = 'evt_test_late_failure'; failed.type = 'checkout.session.async_payment_failed';
  await deliver(worker, env, failed);
  assert.equal(env.DB.db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'paid');
  assert.equal(env.DB.db.prepare('SELECT COUNT(*) AS n FROM stripe_events').get().n, 2);
  const result = await (await worker.fetch(new Request(`${origin}/api/orders/status?session_id=${sessionId}`), env)).json();
  assert.deepEqual(result, { status: 'paid', fulfillment: 'pickup' }); assert.equal('customer_json' in result, false);
});
test('an early webhook is preserved when Stripe responds before checkout saves its session', async () => {
  const env = environment(); const id = crypto.randomUUID(); let worker;
  worker = createWorker({ business, catalog, fetcher: async () => {
    assert.equal((await deliver(worker, env, eventFor(id))).status, 200);
    return Response.json({ id: sessionId, url: sessionURL });
  } });
  assert.equal((await worker.fetch(request('/api/checkout', { items: [{ id: 'test-print', quantity: 2 }], fulfillment: 'pickup', checkoutKey: id }), env)).status, 200);
  assert.equal(env.DB.db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'paid');
});
test('a return-page query or mismatched payment amount cannot mark an order paid', async () => {
  const env = environment(); const worker = createWorker({ business, catalog, fetcher: async () => Response.json({ id: sessionId, url: sessionURL }) }); const id = crypto.randomUUID();
  await worker.fetch(request('/api/checkout', { items: [{ id: 'test-print', quantity: 2 }], fulfillment: 'pickup', checkoutKey: id }), env);
  assert.equal((await deliver(worker, env, eventFor(id, { amount_subtotal: 1 }))).status, 400);
  assert.equal(env.DB.db.prepare('SELECT status FROM orders WHERE id = ?').get(id).status, 'pending');
  const response = await worker.fetch(new Request(`${origin}/api/orders/status?session_id=cs_test_notareal123456789`), env); assert.equal(response.status, 404);
});

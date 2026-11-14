import defaultProducts from '../src/data/products.json' with { type: 'json' };
import defaultBusiness from '../src/data/site.json' with { type: 'json' };
import { applyBundlePricing, cartItemTotal } from '../src/scripts/pricing.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYPAL_ID = /^[A-Za-z0-9]{10,64}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ADMIN_TOKEN = /^[A-Za-z0-9_-]{32,256}$/;
const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};
const ORDER_STATES = new Set(['new', 'printing', 'ready', 'shipped', 'completed', 'cancelled']);

export class PayPalError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
const referenceFor = id => `FL-${id.slice(0, 8).toUpperCase()}`;
const money = cents => `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;

function parseMoney(value) {
  if (typeof value !== 'string' || !/^\d{1,9}\.\d{2}$/.test(value)) return null;
  const [whole, decimal] = value.split('.');
  const cents = Number(whole) * 100 + Number(decimal);
  return Number.isSafeInteger(cents) ? cents : null;
}

function integerSetting(value, fallback, { min = 0, max = 1000000 } = {}) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function paypalEnvironment(env) {
  return String(env.PAYPAL_ENVIRONMENT || 'sandbox').toLowerCase() === 'live' ? 'live' : 'sandbox';
}

function paypalBase(env) {
  return paypalEnvironment(env) === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}

function sdkBase(env) {
  return paypalEnvironment(env) === 'live' ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com';
}

export function paypalConfiguration(env = {}, business = defaultBusiness) {
  const environment = paypalEnvironment(env);
  const minimumOrderCents = integerSetting(env.MINIMUM_ORDER_CENTS, 500, { min: 50, max: 100000 });
  const flatShippingCents = integerSetting(env.FLAT_SHIPPING_CENTS, 800, { min: 0, max: 100000 });
  const configured = Boolean(env.DB && env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
  const checkoutEnabled = env.PAYPAL_COMMERCE_ENABLED === 'true' && configured;
  return {
    checkoutEnabled,
    environment,
    clientId: checkoutEnabled ? env.PAYPAL_CLIENT_ID : null,
    sdkUrl: checkoutEnabled ? `${sdkBase(env)}/web-sdk/v6/core` : null,
    currency: 'USD',
    countryCode: 'US',
    minimumOrderCents,
    flatShippingCents,
    shippingEnabled: checkoutEnabled && flatShippingCents > 0,
    pickupLabel: `${business.pickupCity || 'Everett'}, ${business.pickupState || 'WA'} pickup`,
    notificationsEnabled: Boolean(env.RESEND_API_KEY && env.MAIL_FROM && EMAIL.test(business.contactEmail || ''))
  };
}

export function normalizePayPalCart(items, catalog = defaultProducts) {
  if (!Array.isArray(items) || !items.length || items.length > 50) {
    throw new PayPalError(400, 'Choose between 1 and 50 different prints for your order.');
  }
  const seen = new Set();
  const normalized = items.map(item => {
    if (!item || typeof item.id !== 'string') throw new PayPalError(400, 'Please check the items in your bag.');
    const product = catalog.find(candidate => candidate.id === item.id || candidate.legacyIds?.includes(item.id));
    if (!product || product.status !== 'available' || !Number.isSafeInteger(product.priceCents) || product.priceCents < 50 || product.priceCents > 1000000) {
      throw new PayPalError(400, 'One of these prints is not available for online checkout. Please request a quote.');
    }
    const variant = product.variants?.find(candidate => candidate.id === item.variantId);
    if ((product.variants?.length && !variant) || (!product.variants?.length && item.variantId)) {
      throw new PayPalError(400, 'Choose an available design for each print.');
    }
    const key = `${product.id}:${variant?.id || ''}`;
    if (seen.has(key)) throw new PayPalError(400, 'Please check the items in your bag.');
    seen.add(key);
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) {
      throw new PayPalError(400, 'Choose a quantity between 1 and 20 per print.');
    }
    return {
      id: product.id,
      name: variant ? `${product.name} - ${variant.name}` : product.name,
      quantity: item.quantity,
      priceCents: product.priceCents,
      ...(variant ? { variantId: variant.id } : {})
    };
  }).sort((a, b) => a.id.localeCompare(b.id) || (a.variantId || '').localeCompare(b.variantId || ''));
  return applyBundlePricing(normalized, new Map(catalog.map(product => [product.id, product])));
}

async function limitedBody(request, limit = 24 * 1024) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > limit) throw new PayPalError(413, 'This request is too large.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new PayPalError(413, 'This request is too large.');
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function readJSON(request, allowedKeys, limit) {
  const type = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new PayPalError(415, 'Send application/json.');
  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(await limitedBody(request, limit)));
  } catch (error) {
    if (error instanceof PayPalError) throw error;
    throw new PayPalError(400, 'Send valid JSON.');
  }
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowedKeys.includes(key))) {
    throw new PayPalError(400, 'Unsupported request fields.');
  }
  return value;
}

function requireSameOrigin(request) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  if (origin !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new PayPalError(403, 'This request must be sent from the Foggy Layers website.');
  }
}

async function ensureSchema(env) {
  if (!env.DB) throw new PayPalError(503, 'Order storage is not available.');
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'created',
    cart_json TEXT NOT NULL,
    fulfillment TEXT NOT NULL CHECK (fulfillment IN ('shipping', 'pickup')),
    stripe_session_id TEXT UNIQUE,
    checkout_url TEXT,
    customer_json TEXT,
    payment_provider TEXT,
    paypal_order_id TEXT,
    paypal_capture_id TEXT,
    subtotal_cents INTEGER,
    shipping_cents INTEGER,
    total_cents INTEGER,
    paid_at TEXT,
    fulfillment_status TEXT NOT NULL DEFAULT 'new'
  )`).run();
  const info = await env.DB.prepare('PRAGMA table_info(orders)').all();
  const names = new Set((info.results || []).map(column => column.name));
  const additions = [
    ['payment_provider', 'TEXT'],
    ['paypal_order_id', 'TEXT'],
    ['paypal_capture_id', 'TEXT'],
    ['subtotal_cents', 'INTEGER'],
    ['shipping_cents', 'INTEGER'],
    ['total_cents', 'INTEGER'],
    ['paid_at', 'TEXT'],
    ['fulfillment_status', "TEXT NOT NULL DEFAULT 'new'"]
  ];
  for (const [name, definition] of additions) {
    if (!names.has(name)) {
      try { await env.DB.prepare(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`).run(); }
      catch (error) { if (!/duplicate column/i.test(String(error?.message || error))) throw error; }
    }
  }
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS orders_paypal_order_id ON orders(paypal_order_id)').run();
  await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS orders_paypal_capture_id ON orders(paypal_capture_id)').run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS orders_provider_status_created ON orders(payment_provider, status, created_at)').run();
}

function basicAuth(clientId, secret) {
  const bytes = new TextEncoder().encode(`${clientId}:${secret}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function paypalAccessToken(env, fetcher) {
  const response = await fetcher(`${paypalBase(env)}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth(env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: 'grant_type=client_credentials',
    redirect: 'manual',
    signal: AbortSignal.timeout(12000)
  });
  let data;
  try { data = await response.json(); } catch { throw new PayPalError(502, 'PayPal returned an unreadable authentication response.'); }
  if (!response.ok || typeof data.access_token !== 'string' || data.access_token.length < 20) {
    throw new PayPalError(502, 'PayPal authentication failed. Check the configured API credentials.');
  }
  return data.access_token;
}

async function paypalRequest(env, fetcher, accessToken, path, init = {}) {
  const response = await fetcher(`${paypalBase(env)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init.method === 'GET' ? {} : { 'PayPal-Request-Id': init.requestId || crypto.randomUUID() }),
      Prefer: 'return=representation',
      ...(init.headers || {})
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15000)
  });
  let data;
  try { data = await response.json(); } catch { throw new PayPalError(502, 'PayPal returned an unreadable response.'); }
  if (!response.ok) {
    const retryable = response.status >= 500 || response.status === 429;
    throw new PayPalError(retryable ? 502 : 409, retryable ? 'PayPal could not complete the request. Please try again.' : 'PayPal rejected this checkout. Please review the payment details and try again.', 'PAYPAL_REQUEST_FAILED');
  }
  return data;
}

function orderItems(items) {
  return items.map(item => {
    const bundled = Number.isInteger(item.lineTotalCents);
    return {
      name: (bundled ? `${item.name} x ${item.quantity}` : item.name).slice(0, 127),
      sku: `${item.id}${item.variantId ? `:${item.variantId}` : ''}`.slice(0, 127),
      quantity: String(bundled ? 1 : item.quantity),
      category: 'PHYSICAL_GOODS',
      unit_amount: {
        currency_code: 'USD',
        value: money(bundled ? cartItemTotal(item) : item.priceCents)
      }
    };
  });
}

function createOrderPayload({ items, checkoutKey, subtotalCents, shippingCents, fulfillment, paymentMethod, env, business }) {
  const totalCents = subtotalCents + shippingCents;
  const siteURL = new URL(env.SITE_URL || business.url).origin;
  const experience = {
    brand_name: business.name || 'Foggy Layers',
    locale: 'en-US',
    user_action: 'PAY_NOW',
    shipping_preference: fulfillment === 'shipping' ? 'GET_FROM_FILE' : 'NO_SHIPPING',
    return_url: `${siteURL}/order/thanks/?order_id=${encodeURIComponent(checkoutKey)}`,
    cancel_url: `${siteURL}/cart/?checkout=cancelled`
  };
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: checkoutKey,
      custom_id: checkoutKey,
      invoice_id: `FL-${checkoutKey.toUpperCase()}`,
      description: 'Foggy Layers 3D printed goods',
      items: orderItems(items),
      amount: {
        currency_code: 'USD',
        value: money(totalCents),
        breakdown: {
          item_total: { currency_code: 'USD', value: money(subtotalCents) },
          shipping: { currency_code: 'USD', value: money(shippingCents) }
        }
      }
    }],
    payment_source: { [paymentMethod]: { experience_context: experience } }
  };
}

function assertPayPalOrder(order, localOrder, expectedStatus) {
  if (!order || !PAYPAL_ID.test(order.id || '') || order.intent !== 'CAPTURE') {
    throw new PayPalError(502, 'PayPal returned an invalid order.');
  }
  if (expectedStatus && !expectedStatus.includes(order.status)) {
    throw new PayPalError(409, 'This PayPal order is not ready to be captured. Please reopen checkout.');
  }
  const unit = order.purchase_units?.[0];
  if (!unit || unit.custom_id !== localOrder.id || unit.reference_id !== localOrder.id || unit.amount?.currency_code !== 'USD' || parseMoney(unit.amount?.value) !== localOrder.total_cents) {
    throw new PayPalError(409, 'The PayPal amount does not match the Foggy Layers order.');
  }
  if (localOrder.fulfillment === 'shipping') {
    const country = unit.shipping?.address?.country_code;
    if (country && country !== 'US') throw new PayPalError(409, 'Shipping checkout is currently limited to United States addresses.');
  }
  return unit;
}

function completedCapture(order) {
  for (const unit of order.purchase_units || []) {
    for (const capture of unit.payments?.captures || []) {
      if (capture.status === 'COMPLETED') return capture;
    }
  }
  return null;
}

function customerRecord(order, unit) {
  return {
    payer: order.payer ? {
      payerId: order.payer.payer_id || null,
      email: order.payer.email_address || null,
      name: [order.payer.name?.given_name, order.payer.name?.surname].filter(Boolean).join(' ') || null
    } : null,
    shipping: unit.shipping || null
  };
}

function orderSummary(order, business) {
  const items = JSON.parse(order.cart_json || '[]');
  const customer = order.customer_json ? JSON.parse(order.customer_json) : null;
  const lines = items.map(item => `- ${item.name} x ${item.quantity}: $${money(cartItemTotal(item))}`);
  const destination = order.fulfillment === 'pickup'
    ? `${business.pickupCity || 'Everett'}, ${business.pickupState || 'WA'} pickup`
    : customer?.shipping?.address
      ? [customer.shipping.name?.full_name, customer.shipping.address.address_line_1, customer.shipping.address.address_line_2, `${customer.shipping.address.admin_area_2 || ''}, ${customer.shipping.address.admin_area_1 || ''} ${customer.shipping.address.postal_code || ''}`.trim()].filter(Boolean).join('\n')
      : 'Shipping address recorded by PayPal';
  return `${referenceFor(order.id)}\n${lines.join('\n')}\n\nSubtotal: $${money(order.subtotal_cents || 0)}\nShipping: $${money(order.shipping_cents || 0)}\nTotal: $${money(order.total_cents || 0)}\nFulfillment: ${order.fulfillment}\n\n${destination}`;
}

async function sendEmail(env, fetcher, { to, subject, text }) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM || !EMAIL.test(to || '')) return false;
  const response = await fetcher('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: subject.replace(/[\r\n]/g, ' '), text }),
    redirect: 'manual',
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('NotificationDeliveryFailed');
  return true;
}

function queueNotifications(env, ctx, fetcher, order, business) {
  const summary = orderSummary(order, business);
  const customer = order.customer_json ? JSON.parse(order.customer_json) : null;
  const customerEmail = customer?.payer?.email;
  const promises = [];
  if (EMAIL.test(business.contactEmail || '')) {
    promises.push(sendEmail(env, fetcher, {
      to: business.contactEmail,
      subject: `Paid Foggy Layers order ${referenceFor(order.id)}`,
      text: `A PayPal payment has been captured.\n\n${summary}\n\nPayPal capture: ${order.paypal_capture_id}`
    }));
  }
  if (EMAIL.test(customerEmail || '')) {
    promises.push(sendEmail(env, fetcher, {
      to: customerEmail,
      subject: `Foggy Layers order ${referenceFor(order.id)} confirmed`,
      text: `Thanks for your Foggy Layers order. Your payment is confirmed.\n\n${summary}\n\nWe will follow up when your order is ready for pickup or has shipped.`
    }));
  }
  if (!promises.length) return;
  const work = Promise.allSettled(promises).then(results => {
    if (results.some(result => result.status === 'rejected')) console.error('Foggy Layers: one or more order notification emails failed.');
  });
  if (ctx?.waitUntil) ctx.waitUntil(work);
}

async function createOrder(request, env, fetcher, now, catalog, business) {
  requireSameOrigin(request);
  const config = paypalConfiguration(env, business);
  if (!config.checkoutEnabled) throw new PayPalError(503, 'PayPal checkout is not open yet.');
  await ensureSchema(env);
  const data = await readJSON(request, ['items', 'fulfillment', 'checkoutKey', 'paymentMethod']);
  if (!UUID.test(data.checkoutKey || '')) throw new PayPalError(400, 'Please refresh your bag and try again.');
  if (!['pickup', 'shipping'].includes(data.fulfillment)) throw new PayPalError(400, 'Choose shipping or Everett pickup.');
  if (data.fulfillment === 'shipping' && !config.shippingEnabled) throw new PayPalError(503, 'Shipping checkout is not available yet.');
  if (!['paypal', 'venmo'].includes(data.paymentMethod)) throw new PayPalError(400, 'Choose an available payment method.');
  const items = normalizePayPalCart(data.items, catalog);
  const subtotalCents = items.reduce((sum, item) => sum + cartItemTotal(item), 0);
  if (subtotalCents < config.minimumOrderCents) {
    throw new PayPalError(400, `Online orders have a $${money(config.minimumOrderCents)} minimum.`, 'MINIMUM_ORDER');
  }
  const shippingCents = data.fulfillment === 'shipping' ? config.flatShippingCents : 0;
  const totalCents = subtotalCents + shippingCents;
  const cart = JSON.stringify(items);
  const time = new Date(now()).toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO orders
    (id, created_at, updated_at, status, cart_json, fulfillment, payment_provider, subtotal_cents, shipping_cents, total_cents, fulfillment_status)
    VALUES (?, ?, ?, 'created', ?, ?, 'paypal', ?, ?, ?, 'new')`)
    .bind(data.checkoutKey, time, time, cart, data.fulfillment, subtotalCents, shippingCents, totalCents).run();
  let order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(data.checkoutKey).first();
  if (!order || order.payment_provider !== 'paypal' || order.cart_json !== cart || order.fulfillment !== data.fulfillment || order.total_cents !== totalCents) {
    throw new PayPalError(409, 'Your bag changed. Please refresh and try again.');
  }
  if (order.status === 'paid') throw new PayPalError(409, 'That order has already been paid.', 'CHECKOUT_ENDED');
  if (order.paypal_order_id) return json({ id: order.paypal_order_id, orderId: order.paypal_order_id, reference: referenceFor(order.id) });

  const accessToken = await paypalAccessToken(env, fetcher);
  const payload = createOrderPayload({
    items,
    checkoutKey: data.checkoutKey,
    subtotalCents,
    shippingCents,
    fulfillment: data.fulfillment,
    paymentMethod: data.paymentMethod,
    env,
    business
  });
  const created = await paypalRequest(env, fetcher, accessToken, '/v2/checkout/orders', {
    method: 'POST',
    body: JSON.stringify(payload),
    requestId: `foggylayers-create-${data.checkoutKey}`
  });
  if (!PAYPAL_ID.test(created.id || '') || !['CREATED', 'PAYER_ACTION_REQUIRED'].includes(created.status)) throw new PayPalError(502, 'PayPal returned an invalid new order.');
  assertPayPalOrder(created, { ...order, total_cents: totalCents }, ['CREATED', 'PAYER_ACTION_REQUIRED']);
  const saved = await env.DB.prepare("UPDATE orders SET paypal_order_id = ?, status = 'pending', updated_at = ? WHERE id = ? AND paypal_order_id IS NULL")
    .bind(created.id, time, data.checkoutKey).run();
  if (!saved.meta?.changes) {
    order = await env.DB.prepare('SELECT paypal_order_id FROM orders WHERE id = ?').bind(data.checkoutKey).first();
    if (order?.paypal_order_id !== created.id) throw new PayPalError(409, 'A different checkout already exists for this bag.');
  }
  return json({ id: created.id, orderId: created.id, reference: referenceFor(data.checkoutKey) }, 201);
}

async function markPaid(env, localOrder, paypalOrder, unit, capture, now) {
  if (!PAYPAL_ID.test(capture?.id || '') || capture.status !== 'COMPLETED' || capture.amount?.currency_code !== 'USD' || parseMoney(capture.amount?.value) !== localOrder.total_cents) {
    throw new PayPalError(409, 'PayPal did not confirm the expected payment amount.');
  }
  const time = new Date(now()).toISOString();
  const customer = JSON.stringify(customerRecord(paypalOrder, unit));
  await env.DB.prepare(`UPDATE orders SET
    status = 'paid', paypal_capture_id = ?, customer_json = ?, paid_at = COALESCE(paid_at, ?), updated_at = ?, fulfillment_status = COALESCE(fulfillment_status, 'new')
    WHERE id = ? AND (status != 'paid' OR paypal_capture_id IS NULL)`)
    .bind(capture.id, customer, time, time, localOrder.id).run();
  return env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(localOrder.id).first();
}

async function captureOrder(request, env, ctx, fetcher, now, paypalOrderId, business) {
  requireSameOrigin(request);
  const config = paypalConfiguration(env, business);
  if (!config.checkoutEnabled) throw new PayPalError(503, 'PayPal checkout is not open yet.');
  if (!PAYPAL_ID.test(paypalOrderId || '')) throw new PayPalError(404, 'Order not found.');
  await ensureSchema(env);
  const data = await readJSON(request, ['checkoutKey']);
  if (!UUID.test(data.checkoutKey || '')) throw new PayPalError(400, 'Please refresh your bag and try again.');
  const localOrder = await env.DB.prepare('SELECT * FROM orders WHERE id = ? AND paypal_order_id = ?').bind(data.checkoutKey, paypalOrderId).first();
  if (!localOrder) throw new PayPalError(404, 'Order not found.');
  if (localOrder.status === 'paid' && localOrder.paypal_capture_id) {
    return json({ status: 'paid', reference: referenceFor(localOrder.id), fulfillment: localOrder.fulfillment, captureId: localOrder.paypal_capture_id });
  }

  const accessToken = await paypalAccessToken(env, fetcher);
  let paypalOrder = await paypalRequest(env, fetcher, accessToken, `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}`, {
    method: 'GET',
    requestId: `foggylayers-show-${data.checkoutKey}`
  });
  let unit = assertPayPalOrder(paypalOrder, localOrder, ['APPROVED', 'COMPLETED']);
  let capture = completedCapture(paypalOrder);
  if (!capture) {
    paypalOrder = await paypalRequest(env, fetcher, accessToken, `/v2/checkout/orders/${encodeURIComponent(paypalOrderId)}/capture`, {
      method: 'POST',
      body: '{}',
      requestId: `foggylayers-capture-${data.checkoutKey}`
    });
    unit = assertPayPalOrder(paypalOrder, localOrder, ['COMPLETED']);
    capture = completedCapture(paypalOrder);
  }
  const paidOrder = await markPaid(env, localOrder, paypalOrder, unit, capture, now);
  queueNotifications(env, ctx, fetcher, paidOrder, business);
  return json({
    status: 'paid',
    reference: referenceFor(paidOrder.id),
    fulfillment: paidOrder.fulfillment,
    captureId: paidOrder.paypal_capture_id
  });
}

async function orderStatus(request, env) {
  await ensureSchema(env);
  const id = new URL(request.url).searchParams.get('order_id');
  if (!UUID.test(id || '')) throw new PayPalError(404, 'Order not found.');
  const order = await env.DB.prepare('SELECT id, status, fulfillment, fulfillment_status, total_cents, paypal_capture_id FROM orders WHERE id = ? AND payment_provider = ?').bind(id, 'paypal').first();
  if (!order) throw new PayPalError(404, 'Order not found.');
  return json({
    status: order.status,
    fulfillment: order.fulfillment,
    fulfillmentStatus: order.fulfillment_status || 'new',
    reference: referenceFor(order.id),
    totalCents: order.total_cents,
    paid: order.status === 'paid' && Boolean(order.paypal_capture_id)
  });
}

async function authorizeAdmin(request, env) {
  const expected = env.ORDERS_ADMIN_TOKEN || env.FACEBOOK_ADMIN_TOKEN || '';
  const provided = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1] || '';
  if (!ADMIN_TOKEN.test(expected)) throw new PayPalError(503, 'The orders dashboard is not configured yet.', 'ORDERS_SETUP_REQUIRED');
  const encoder = new TextEncoder();
  const [left, right] = await Promise.all([provided, expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let mismatch = provided ? 0 : 1;
  for (let index = 0; index < a.length; index++) mismatch |= a[index] ^ b[index];
  if (mismatch) throw new PayPalError(401, 'Enter a valid orders admin token.', 'ORDERS_UNAUTHORIZED');
}

function publicOrder(row) {
  let items = [];
  let customer = null;
  try { items = JSON.parse(row.cart_json || '[]'); } catch { /* Keep malformed legacy data out of the response. */ }
  try { customer = row.customer_json ? JSON.parse(row.customer_json) : null; } catch { /* Keep malformed legacy data out of the response. */ }
  return {
    id: row.id,
    reference: referenceFor(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    paidAt: row.paid_at,
    status: row.status,
    fulfillmentStatus: row.fulfillment_status || 'new',
    fulfillment: row.fulfillment,
    subtotalCents: row.subtotal_cents,
    shippingCents: row.shipping_cents,
    totalCents: row.total_cents,
    paypalOrderId: row.paypal_order_id,
    paypalCaptureId: row.paypal_capture_id,
    items,
    customer
  };
}

async function listOrders(request, env) {
  await authorizeAdmin(request, env);
  await ensureSchema(env);
  const status = new URL(request.url).searchParams.get('status');
  const allowed = new Set(['all', 'paid', ...ORDER_STATES]);
  if (status && !allowed.has(status)) throw new PayPalError(400, 'Choose a supported order filter.');
  let sql = "SELECT * FROM orders WHERE payment_provider = 'paypal'";
  const bindings = [];
  if (status === 'paid') sql += " AND status = 'paid'";
  else if (status && status !== 'all') { sql += ' AND fulfillment_status = ?'; bindings.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT 100';
  const result = await env.DB.prepare(sql).bind(...bindings).all();
  return json({ orders: (result.results || []).map(publicOrder) });
}

async function updateOrder(request, env, id) {
  requireSameOrigin(request);
  await authorizeAdmin(request, env);
  await ensureSchema(env);
  if (!UUID.test(id || '')) throw new PayPalError(404, 'Order not found.');
  const data = await readJSON(request, ['fulfillmentStatus']);
  if (!ORDER_STATES.has(data.fulfillmentStatus)) throw new PayPalError(400, 'Choose a supported fulfillment status.');
  const time = new Date().toISOString();
  const result = await env.DB.prepare("UPDATE orders SET fulfillment_status = ?, updated_at = ? WHERE id = ? AND payment_provider = 'paypal'")
    .bind(data.fulfillmentStatus, time, id).run();
  if (!result.meta?.changes) throw new PayPalError(404, 'Order not found.');
  const row = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
  return json({ order: publicOrder(row) });
}

export function createPayPalAPI({
  catalog = defaultProducts,
  business = defaultBusiness,
  fetcher = (...args) => fetch(...args),
  now = () => Date.now()
} = {}) {
  return async function paypalAPI(request, env = {}, ctx = {}) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/paypal/config' && request.method === 'GET') return json(paypalConfiguration(env, business));
      if (url.pathname === '/api/paypal/orders' && request.method === 'POST') return await createOrder(request, env, fetcher, now, catalog, business);
      const capture = url.pathname.match(/^\/api\/paypal\/orders\/([A-Za-z0-9]{10,64})\/capture$/);
      if (capture && request.method === 'POST') return await captureOrder(request, env, ctx, fetcher, now, capture[1], business);
      if (url.pathname === '/api/paypal/orders/status' && request.method === 'GET') return await orderStatus(request, env);
      if (url.pathname === '/api/admin/orders' && request.method === 'GET') return await listOrders(request, env);
      const adminOrder = url.pathname.match(/^\/api\/admin\/orders\/([0-9a-f-]{36})$/i);
      if (adminOrder && request.method === 'PATCH') return await updateOrder(request, env, adminOrder[1]);
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      if (error instanceof PayPalError) {
        return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
      }
      console.error(`Foggy Layers PayPal API failed: ${error?.name || 'Error'}`);
      return json({ error: 'We could not complete that request. Please try again.' }, 500);
    }
  };
}

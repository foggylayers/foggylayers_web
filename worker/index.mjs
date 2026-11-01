import defaultProducts from '../src/data/products.json' with { type: 'json' };
import defaultBusiness from '../src/data/site.json' with { type: 'json' };
import { createFacebookAPI } from './facebook.mjs';

const MiB = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION = /^cs_(?:test_|live_)?[A-Za-z0-9_]{10,240}$/;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
const textField = (form, name, max, required = false) => {
  const value = form.get(name);
  if (value != null && typeof value !== 'string') throw new HttpError(400, 'Please check the form fields.');
  const result = (value || '').trim();
  if ((required && !result) || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(result)) throw new HttpError(400, 'Please check the form fields and try again.');
  return result;
};

export function validateProject(form, catalog = defaultProducts) {
  const type = textField(form, 'type', 20, true);
  if (!['print', 'design', 'product'].includes(type)) throw new HttpError(400, 'Choose a supported project type.');
  if (textField(form, 'website', 200)) throw new HttpError(400, 'We could not accept this request.');
  const name = textField(form, 'name', 100, true);
  const email = textField(form, 'email', 254, true).toLowerCase();
  if (!EMAIL.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  const description = textField(form, 'description', 5000, true);
  if (description.length < 15) throw new HttpError(400, 'Please add a little more detail about your project.');
  const quantity = Number(textField(form, 'quantity', 4, true));
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new HttpError(400, 'Choose a quantity between 1 and 999.');
  const fulfillment = textField(form, 'fulfillment', 10, true);
  if (!['shipping', 'pickup'].includes(fulfillment)) throw new HttpError(400, 'Choose shipping or Everett pickup.');
  if (form.get('consent') !== 'yes') throw new HttpError(400, 'Please confirm the permission and privacy checkbox.');
  const productId = type === 'product' ? textField(form, 'productId', 100, true) : '';
  if (type === 'product' && !catalog.some(product => product.id === productId)) throw new HttpError(400, 'Choose a print from the collection.');
  const files = form.getAll('files').filter(file => typeof file !== 'string' && file.name);
  if (files.length > 3 || files.some(file => file.size === 0 || file.size > 10 * MiB || !/\.(stl|3mf|obj|step|stp|png|jpe?g|pdf)$/i.test(file.name)) || files.reduce((sum, file) => sum + file.size, 0) > 20 * MiB) {
    throw new HttpError(400, 'Attach up to 3 supported files, no larger than 10 MB each or 20 MB in total.');
  }
  if (type === 'print' && !files.some(file => /\.(stl|3mf|obj|step|stp)$/i.test(file.name))) throw new HttpError(400, 'Please attach a model file for your print request.');
  return { payload: { type, name, email, description, quantity, fulfillment, productId, preferences: textField(form, 'preferences', 250), timeline: textField(form, 'timeline', 150) }, files };
}

export function normalizeCart(items, catalog = defaultProducts) {
  if (!Array.isArray(items) || !items.length || items.length > 50) throw new HttpError(400, 'Choose between 1 and 50 different prints for your order.');
  const seen = new Set();
  return items.map(item => {
    if (!item || typeof item.id !== 'string') throw new HttpError(400, 'Please check the items in your bag.');
    const product = catalog.find(product => product.id === item.id);
    if (!product || product.status !== 'available' || !Number.isSafeInteger(product.priceCents) || product.priceCents < 50 || product.priceCents > 1000000) throw new HttpError(400, 'One of these prints is not available for online checkout. Please request a quote.');
    const variant = product.variants?.find(variant => variant.id === item.variantId);
    if ((product.variants?.length && !variant) || (!product.variants?.length && item.variantId)) throw new HttpError(400, 'Choose an available design for each print.');
    const key = `${product.id}:${variant?.id || ''}`;
    if (seen.has(key)) throw new HttpError(400, 'Please check the items in your bag.');
    seen.add(key);
    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) throw new HttpError(400, 'Choose a quantity between 1 and 20 per print.');
    // Prices and names come only from the server's catalog, never from the browser.
    return { id: product.id, name: variant ? `${product.name} — ${variant.name}` : product.name, quantity: item.quantity, priceCents: product.priceCents, ...(variant ? { variantId: variant.id } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id) || (a.variantId || '').localeCompare(b.variantId || ''));
}

async function limitedBody(request, limit) {
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > limit) throw new HttpError(413, 'This request is too large. Please use smaller files.');
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'This request is too large. Please use smaller files.'); }
    chunks.push(value);
  }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function verifyStripeSignature(body, signature, secret, now = Date.now()) {
  if (!signature || !secret) return false;
  const parts = signature.split(',').map(part => part.trim());
  const timestamp = parts.find(part => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter(part => part.startsWith('v1=')).map(part => part.slice(3));
  if (!/^\d+$/.test(timestamp || '') || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  for (const candidate of signatures) {
    if (!/^[0-9a-f]{64}$/i.test(candidate)) continue;
    const bytes = Uint8Array.from(candidate.match(/.{2}/g), pair => Number.parseInt(pair, 16));
    if (await crypto.subtle.verify('HMAC', key, bytes, encoder.encode(`${timestamp}.${body}`))) return true;
  }
  return false;
}

export function createWorker({ catalog = defaultProducts, business = defaultBusiness, fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const facebookAPI = createFacebookAPI({ business, fetcher, now });
  function readiness(env) {
    const contactReady = EMAIL.test(business.contactEmail || '');
    const requestsEnabled = env.REQUESTS_ENABLED === 'true' && contactReady && Boolean(env.DB && env.UPLOADS && env.TURNSTILE_SECRET_KEY && env.TURNSTILE_SITE_KEY);
    const checkoutEnabled = env.COMMERCE_ENABLED === 'true' && contactReady && Boolean(env.DB && env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
    return { requestsEnabled, checkoutEnabled, shippingEnabled: checkoutEnabled && /^shr_[A-Za-z0-9]+$/.test(env.STRIPE_SHIPPING_RATE_ID || ''), turnstileSiteKey: requestsEnabled ? env.TURNSTILE_SITE_KEY : null, contactEmail: business.contactEmail || null };
  }
  async function notify(env, subject, text) {
    if (!env.RESEND_API_KEY || !env.MAIL_FROM || !business.contactEmail) return;
    const response = await fetcher('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to: [business.contactEmail], subject: subject.replace(/[\r\n]/g, ' '), text }) });
    if (!response.ok) throw new Error('NotificationDeliveryFailed');
  }
  function queueNotification(env, ctx, subject, text) {
    const promise = notify(env, subject, text).catch(() => console.error('Foggy Layers: notification delivery failed; the record is stored in D1.'));
    if (ctx?.waitUntil) ctx.waitUntil(promise);
  }
  async function submitProject(request, env, ctx) {
    if (!readiness(env).requestsEnabled) throw new HttpError(503, 'Online project requests are not open yet. Please check back soon.');
    const id = request.headers.get('X-Request-ID');
    if (!UUID.test(id || '')) throw new HttpError(400, 'Please refresh the form and try again.');
    if (!(request.headers.get('Content-Type') || '').startsWith('multipart/form-data;')) throw new HttpError(415, 'Please submit your request using the project form.');
    const bytes = await limitedBody(request, 21 * MiB);
    let form;
    try { form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': request.headers.get('Content-Type') }, body: bytes }).formData(); } catch { throw new HttpError(400, 'We could not read that form. Please try again.'); }
    const { payload, files } = validateProject(form, catalog);
    const reference = `FL-${id.slice(0, 8).toUpperCase()}`;
    const existing = await env.DB.prepare('SELECT id FROM requests WHERE id = ?').bind(id).first();
    if (existing) return json({ reference }, 200);
    const token = textField(form, 'cf-turnstile-response', 2048, true);
    const verification = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(request.headers.get('CF-Connecting-IP') ? { remoteip: request.headers.get('CF-Connecting-IP') } : {}) }) });
    const result = await verification.json();
    if (!verification.ok || !result.success || result.action !== 'project_request' || result.hostname !== new URL(request.url).hostname) throw new HttpError(400, 'The verification check expired or failed. Please try again.');
    const stored = []; const uploadGroup = crypto.randomUUID();
    try {
      for (const [index, file] of files.entries()) {
        const filename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-120);
        const key = `requests/${id}/${uploadGroup}/${index}-${filename}`;
        await env.UPLOADS.put(key, file.stream(), { httpMetadata: { contentType: 'application/octet-stream', contentDisposition: 'attachment' }, customMetadata: { requestId: id } });
        stored.push({ key, name: filename, size: file.size });
      }
      const saved = await env.DB.prepare('INSERT OR IGNORE INTO requests (id, created_at, payload_json, files_json) VALUES (?, ?, ?, ?)').bind(id, new Date(now()).toISOString(), JSON.stringify(payload), JSON.stringify(stored)).run();
      if (!saved.meta?.changes) {
        await Promise.allSettled(stored.map(file => env.UPLOADS.delete(file.key)));
        return json({ reference }, 200);
      }
    } catch (error) {
      await Promise.allSettled(stored.map(file => env.UPLOADS.delete(file.key)));
      throw error;
    }
    queueNotification(env, ctx, `New Foggy Layers request ${reference}`, `${reference}\nType: ${payload.type}\nName: ${payload.name}\nEmail: ${payload.email}\nQuantity: ${payload.quantity}\nDelivery: ${payload.fulfillment}\nProduct: ${payload.productId || 'Custom'}\nPreferences: ${payload.preferences}\nTimeline: ${payload.timeline}\n\n${payload.description}\n\n${stored.length} private file(s) stored with this request in Cloudflare. Review the request record in D1 and its files in R2.`);
    return json({ reference }, 201);
  }
  async function checkout(request, env) {
    if (!readiness(env).checkoutEnabled) throw new HttpError(503, 'Online checkout is not open yet. Please ask about your print through a project request.');
    let data;
    try { data = JSON.parse(new TextDecoder().decode(await limitedBody(request, 16 * 1024))); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Please check your bag and try again.'); }
    if (!data || typeof data !== 'object') throw new HttpError(400, 'Please check your bag and try again.');
    const items = normalizeCart(data.items, catalog);
    if (!UUID.test(data.checkoutKey || '')) throw new HttpError(400, 'Please refresh your bag and try again.');
    if (!['shipping', 'pickup'].includes(data.fulfillment)) throw new HttpError(400, 'Choose shipping or Everett pickup.');
    if (data.fulfillment === 'shipping' && !readiness(env).shippingEnabled) throw new HttpError(503, 'Shipping checkout is not available yet. Please ask about shipping through a project request.');
    const id = data.checkoutKey; const cart = JSON.stringify(items); const time = new Date(now()).toISOString();
    await env.DB.prepare('INSERT OR IGNORE INTO orders (id, created_at, updated_at, cart_json, fulfillment) VALUES (?, ?, ?, ?, ?)').bind(id, time, time, cart, data.fulfillment).run();
    const existing = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(id).first();
    if (existing.cart_json !== cart || existing.fulfillment !== data.fulfillment) throw new HttpError(409, 'Your bag changed. Please refresh and try again.');
    if (['expired', 'failed', 'paid'].includes(existing.status)) throw new HttpError(409, 'That checkout has ended. Please try again to start a new checkout.', 'CHECKOUT_EXPIRED');
    if (existing.checkout_url) return json({ url: existing.checkout_url });
    const siteURL = new URL(env.SITE_URL || business.url).origin;
    const parameters = new URLSearchParams({ mode: 'payment', success_url: `${siteURL}/order/thanks/?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${siteURL}/cart/?checkout=cancelled`, client_reference_id: id, 'metadata[order_id]': id, 'metadata[fulfillment]': data.fulfillment, 'automatic_tax[enabled]': env.STRIPE_AUTOMATIC_TAX === 'false' ? 'false' : 'true', billing_address_collection: 'required' });
    items.forEach((item, index) => {
      parameters.set(`line_items[${index}][price_data][currency]`, 'usd');
      parameters.set(`line_items[${index}][price_data][product_data][name]`, item.name);
      parameters.set(`line_items[${index}][price_data][unit_amount]`, String(item.priceCents));
      parameters.set(`line_items[${index}][quantity]`, String(item.quantity));
    });
    if (data.fulfillment === 'shipping') {
      const countries = (env.SHIPPING_COUNTRIES || 'US').split(',').map(country => country.trim()).filter(Boolean);
      if (!countries.length || countries.some(country => !/^[A-Z]{2}$/.test(country))) throw new HttpError(503, 'Shipping checkout is not available yet.');
      countries.forEach((country, index) => parameters.set(`shipping_address_collection[allowed_countries][${index}]`, country));
      parameters.set('shipping_options[0][shipping_rate]', env.STRIPE_SHIPPING_RATE_ID);
    }
    const response = await fetcher('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Stripe-Version': '2026-10-28.endive', 'Idempotency-Key': `foggylayers-${id}` }, body: parameters });
    const session = await response.json();
    if (!response.ok || !SESSION.test(session.id || '') || typeof session.url !== 'string') throw new HttpError(502, 'Checkout could not be opened. Please try again.');
    const destination = new URL(session.url);
    if (destination.protocol !== 'https:' || destination.hostname !== 'checkout.stripe.com') throw new HttpError(502, 'Checkout could not be opened. Please try again.');
    await env.DB.prepare("UPDATE orders SET stripe_session_id = ?, checkout_url = ?, status = CASE WHEN status = 'created' THEN 'pending' ELSE status END, updated_at = ? WHERE id = ?").bind(session.id, session.url, time, id).run();
    return json({ url: session.url });
  }
  async function webhook(request, env, ctx) {
    if (!env.DB || !env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, 'Payment confirmation is not available.');
    const body = new TextDecoder().decode(await limitedBody(request, MiB));
    if (!await verifyStripeSignature(body, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET, now())) throw new HttpError(400, 'Invalid payment event signature.');
    let event;
    try { event = JSON.parse(body); } catch { throw new HttpError(400, 'Invalid payment event.'); }
    if (typeof event.id !== 'string' || !event.id.startsWith('evt_')) throw new HttpError(400, 'Invalid payment event.');
    const supported = ['checkout.session.completed', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed', 'checkout.session.expired'];
    if (!supported.includes(event.type)) return json({ received: true });
    const session = event.data?.object;
    const orderId = session?.metadata?.order_id;
    if (!UUID.test(orderId || '') || !SESSION.test(session.id || '') || session.mode !== 'payment') return json({ received: true });
    const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(orderId).first();
    if (!order || (order.stripe_session_id && order.stripe_session_id !== session.id)) return json({ received: true });
    const paid = session.payment_status === 'paid' && ['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type);
    if (paid) {
      const expected = JSON.parse(order.cart_json).reduce((sum, item) => sum + item.priceCents * item.quantity, 0);
      if (session.currency !== 'usd' || session.amount_subtotal !== expected) throw new HttpError(400, 'Payment amount does not match the order.');
    }
    const state = paid ? 'paid' : event.type.endsWith('async_payment_failed') ? 'failed' : event.type.endsWith('expired') ? 'expired' : 'pending';
    const time = new Date(now()).toISOString();
    const results = await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO stripe_events (id, created_at, type) VALUES (?, ?, ?)').bind(event.id, time, event.type),
      // The order exists before Stripe is called. Accept an early webhook without losing it to a checkout-creation race.
      env.DB.prepare("UPDATE orders SET status = ?, stripe_session_id = ?, updated_at = ?, customer_json = ? WHERE id = ? AND (stripe_session_id = ? OR stripe_session_id IS NULL) AND status != 'paid'").bind(state, session.id, time, paid ? JSON.stringify({ contact: session.customer_details || null, shipping: session.collected_information?.shipping_details || session.shipping_details || null }) : order.customer_json, orderId, session.id)
    ]);
    if (paid && results[1]?.meta?.changes) queueNotification(env, ctx, `Paid Foggy Layers order FL-${orderId.slice(0, 8).toUpperCase()}`, `Order ${orderId}\nDelivery: ${order.fulfillment}\n\nA payment has been confirmed. Review the order details in Cloudflare D1 and the payment in Stripe before preparing the order.`);
    return json({ received: true });
  }
  return {
    async fetch(request, env = {}, ctx = {}) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
      try {
        if (url.pathname.startsWith('/api/admin/facebook/')) return await facebookAPI(request, env);
        if (url.pathname === '/api/config' && request.method === 'GET') return json(readiness(env));
        if (url.pathname === '/api/stripe/webhook' && request.method === 'POST') return await webhook(request, env, ctx);
        if (request.method === 'POST' && request.headers.get('Origin') !== url.origin) throw new HttpError(403, 'This request must be sent from the Foggy Layers website.');
        if (url.pathname === '/api/requests' && request.method === 'POST') return await submitProject(request, env, ctx);
        if (url.pathname === '/api/checkout' && request.method === 'POST') return await checkout(request, env);
        if (url.pathname === '/api/orders/status' && request.method === 'GET') {
          const id = url.searchParams.get('session_id');
          if (!SESSION.test(id || '') || !env.DB) throw new HttpError(404, 'Order not found.');
          const order = await env.DB.prepare('SELECT status, fulfillment FROM orders WHERE stripe_session_id = ?').bind(id).first();
          if (!order) throw new HttpError(404, 'Order not found.');
          return json(order);
        }
        return json({ error: 'Not found.' }, 404);
      } catch (error) {
        if (error instanceof HttpError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
        console.error(`Foggy Layers API failed: ${error?.name || 'Error'}`);
        return json({ error: 'We could not complete that request. Please try again.' }, 500);
      }
    }
  };
}

export default createWorker();

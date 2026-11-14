const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAYPAL_ID = /^[A-Za-z0-9]{10,64}$/;
const ORDER_STATES = new Set(['new', 'printing', 'ready', 'shipped', 'completed', 'cancelled']);
const COLUMNS = [
  'id', 'created_at', 'updated_at', 'status', 'cart_json', 'fulfillment',
  'stripe_session_id', 'checkout_url', 'customer_json', 'payment_provider',
  'paypal_order_id', 'paypal_capture_id', 'subtotal_cents', 'shipping_cents',
  'total_cents', 'paid_at', 'fulfillment_status'
];
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: HEADERS });
const normalizeSQL = sql => String(sql).replace(/\s+/g, ' ').trim();

class OrderDatabaseError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

async function storeRequest(namespace, path, init = {}) {
  const stub = namespace.get(namespace.idFromName('foggylayers-orders'));
  const response = await stub.fetch(new Request(`https://orders.internal${path}`, {
    ...init,
    headers: init.body ? { 'Content-Type': 'application/json' } : undefined
  }));
  let data;
  try { data = await response.json(); }
  catch { throw new OrderDatabaseError('Order storage returned an unreadable response.'); }
  if (!response.ok) throw new OrderDatabaseError(data.error || 'Order storage could not complete the request.', response.status);
  return data;
}

function orderFromInsert(bindings) {
  if (bindings.length === 8) {
    const [id, createdAt, updatedAt, cartJSON, fulfillment, subtotalCents, shippingCents, totalCents] = bindings;
    return {
      id,
      created_at: createdAt,
      updated_at: updatedAt,
      status: 'created',
      cart_json: cartJSON,
      fulfillment,
      stripe_session_id: null,
      checkout_url: null,
      customer_json: null,
      payment_provider: 'paypal',
      paypal_order_id: null,
      paypal_capture_id: null,
      subtotal_cents: subtotalCents,
      shipping_cents: shippingCents,
      total_cents: totalCents,
      paid_at: null,
      fulfillment_status: 'new'
    };
  }
  if (bindings.length === 11) {
    const [id, createdAt, updatedAt, status, cartJSON, fulfillment, paymentProvider, subtotalCents, shippingCents, totalCents, fulfillmentStatus] = bindings;
    return {
      id,
      created_at: createdAt,
      updated_at: updatedAt,
      status,
      cart_json: cartJSON,
      fulfillment,
      stripe_session_id: null,
      checkout_url: null,
      customer_json: null,
      payment_provider: paymentProvider,
      paypal_order_id: null,
      paypal_capture_id: null,
      subtotal_cents: subtotalCents,
      shipping_cents: shippingCents,
      total_cents: totalCents,
      paid_at: null,
      fulfillment_status: fulfillmentStatus
    };
  }
  throw new OrderDatabaseError('Unsupported order insert.');
}

function validateOrder(order) {
  if (!order || !UUID.test(order.id || '') || typeof order.created_at !== 'string' || typeof order.updated_at !== 'string' ||
      !['created', 'pending', 'paid'].includes(order.status) || typeof order.cart_json !== 'string' ||
      !['pickup', 'shipping'].includes(order.fulfillment) || order.payment_provider !== 'paypal' ||
      !Number.isSafeInteger(order.subtotal_cents) || !Number.isSafeInteger(order.shipping_cents) || !Number.isSafeInteger(order.total_cents)) {
    throw new OrderDatabaseError('Order storage received an invalid order.', 400);
  }
  return order;
}

class Statement {
  constructor(namespace, sql, bindings = []) {
    this.namespace = namespace;
    this.sql = normalizeSQL(sql);
    this.bindings = bindings;
  }

  bind(...bindings) { return new Statement(this.namespace, this.sql, bindings); }

  async run() {
    if (/^(?:CREATE TABLE|CREATE (?:UNIQUE )?INDEX|ALTER TABLE) /i.test(this.sql)) return { meta: { changes: 0 } };

    if (/^INSERT OR IGNORE INTO orders /i.test(this.sql)) {
      const order = validateOrder(orderFromInsert(this.bindings));
      const data = await storeRequest(this.namespace, '/orders/insert', { method: 'POST', body: JSON.stringify({ order }) });
      return { meta: { changes: data.inserted ? 1 : 0 } };
    }

    if (/^UPDATE orders SET paypal_order_id = \?, status = 'pending'/i.test(this.sql)) {
      const [paypalOrderId, updatedAt, id] = this.bindings;
      const data = await storeRequest(this.namespace, `/orders/${encodeURIComponent(id)}/paypal`, {
        method: 'POST', body: JSON.stringify({ paypalOrderId, updatedAt })
      });
      return { meta: { changes: data.changed ? 1 : 0 } };
    }

    if (/^UPDATE orders SET status = 'paid'/i.test(this.sql)) {
      const [captureId, customerJSON, paidAt, updatedAt, id] = this.bindings;
      const data = await storeRequest(this.namespace, `/orders/${encodeURIComponent(id)}/paid`, {
        method: 'POST', body: JSON.stringify({ captureId, customerJSON, paidAt, updatedAt })
      });
      return { meta: { changes: data.changed ? 1 : 0 } };
    }

    if (/^UPDATE orders SET fulfillment_status = \?, updated_at = \?/i.test(this.sql)) {
      const [fulfillmentStatus, updatedAt, id] = this.bindings;
      const data = await storeRequest(this.namespace, `/orders/${encodeURIComponent(id)}/fulfillment`, {
        method: 'PATCH', body: JSON.stringify({ fulfillmentStatus, updatedAt })
      });
      return { meta: { changes: data.changed ? 1 : 0 } };
    }

    throw new OrderDatabaseError(`Unsupported order database write: ${this.sql.slice(0, 80)}`);
  }

  async first() {
    if (/^SELECT (?:\*|paypal_order_id|id, status, fulfillment, fulfillment_status, total_cents, paypal_capture_id) FROM orders WHERE id = \?/i.test(this.sql)) {
      const [id, second] = this.bindings;
      const data = await storeRequest(this.namespace, `/orders/${encodeURIComponent(id)}`);
      const order = data.order || null;
      if (!order) return null;
      if (this.sql.includes('paypal_order_id = ?') && order.paypal_order_id !== second) return null;
      if (this.sql.includes('payment_provider = ?') && order.payment_provider !== second) return null;
      return order;
    }
    throw new OrderDatabaseError(`Unsupported order database read: ${this.sql.slice(0, 80)}`);
  }

  async all() {
    if (/^PRAGMA table_info\(orders\)$/i.test(this.sql)) {
      return { results: COLUMNS.map((name, index) => ({ cid: index, name })) };
    }
    if (/^SELECT \* FROM orders WHERE payment_provider = 'paypal'/i.test(this.sql)) {
      let status = 'all';
      if (this.sql.includes("status = 'paid'")) status = 'paid';
      else if (this.sql.includes('fulfillment_status = ?')) status = this.bindings[0];
      const data = await storeRequest(this.namespace, `/orders?status=${encodeURIComponent(status)}`);
      return { results: data.orders || [] };
    }
    throw new OrderDatabaseError(`Unsupported order database query: ${this.sql.slice(0, 80)}`);
  }
}

// D1-compatible surface for the existing PayPal order code. It keeps the initial launch
// self-contained by using a private Durable Object when no D1 binding is configured.
export function createOrderDatabase(namespace) {
  if (!namespace?.get || !namespace?.idFromName) throw new OrderDatabaseError('Order storage is not available.', 503);
  return { prepare: sql => new Statement(namespace, sql) };
}

function storeFailure(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return json({ error: status >= 500 ? 'Order storage could not complete the request.' : error.message }, status);
}

export class OrderStore {
  constructor(ctx) { this.ctx = ctx; }

  async fetch(request) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/orders/insert' && request.method === 'POST') {
        const { order: raw } = await request.json();
        const proposed = validateOrder(raw);
        const key = `order:${proposed.id}`;
        const result = await this.ctx.storage.transaction(async transaction => {
          const existing = await transaction.get(key);
          if (existing) return { order: existing, inserted: false };
          await transaction.put(key, proposed);
          return { order: proposed, inserted: true };
        });
        return json(result, result.inserted ? 201 : 200);
      }

      if (url.pathname === '/orders' && request.method === 'GET') {
        const status = url.searchParams.get('status') || 'all';
        if (!new Set(['all', 'paid', ...ORDER_STATES]).has(status)) throw new OrderDatabaseError('Choose a supported order filter.', 400);
        const stored = await this.ctx.storage.list({ prefix: 'order:' });
        let orders = [...stored.values()].filter(order => order?.payment_provider === 'paypal');
        if (status === 'paid') orders = orders.filter(order => order.status === 'paid');
        else if (status !== 'all') orders = orders.filter(order => (order.fulfillment_status || 'new') === status);
        orders.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
        return json({ orders: orders.slice(0, 100) });
      }

      const match = url.pathname.match(/^\/orders\/([0-9a-f-]{36})(?:\/(paypal|paid|fulfillment))?$/i);
      if (!match || !UUID.test(match[1])) return json({ error: 'Order not found.' }, 404);
      const id = match[1];
      const action = match[2];
      const key = `order:${id}`;

      if (!action && request.method === 'GET') {
        return json({ order: await this.ctx.storage.get(key) || null });
      }

      if (action === 'paypal' && request.method === 'POST') {
        const { paypalOrderId, updatedAt } = await request.json();
        if (!PAYPAL_ID.test(paypalOrderId || '') || typeof updatedAt !== 'string') throw new OrderDatabaseError('Invalid PayPal order details.', 400);
        const result = await this.ctx.storage.transaction(async transaction => {
          const existing = await transaction.get(key);
          if (!existing) return { order: null, changed: false };
          if (existing.paypal_order_id) return { order: existing, changed: false };
          const owner = await transaction.get(`paypal:${paypalOrderId}`);
          if (owner && owner !== id) return { order: existing, changed: false };
          const order = { ...existing, paypal_order_id: paypalOrderId, status: 'pending', updated_at: updatedAt };
          await transaction.put(`paypal:${paypalOrderId}`, id);
          await transaction.put(key, order);
          return { order, changed: true };
        });
        return json(result);
      }

      if (action === 'paid' && request.method === 'POST') {
        const { captureId, customerJSON, paidAt, updatedAt } = await request.json();
        if (!PAYPAL_ID.test(captureId || '') || typeof customerJSON !== 'string' || typeof paidAt !== 'string' || typeof updatedAt !== 'string') {
          throw new OrderDatabaseError('Invalid payment capture details.', 400);
        }
        const result = await this.ctx.storage.transaction(async transaction => {
          const existing = await transaction.get(key);
          if (!existing) return { order: null, changed: false };
          if (existing.paypal_capture_id) {
            if (existing.paypal_capture_id !== captureId) throw new OrderDatabaseError('A different capture is already recorded.', 409);
            return { order: existing, changed: false };
          }
          const owner = await transaction.get(`capture:${captureId}`);
          if (owner && owner !== id) throw new OrderDatabaseError('That capture is already linked to another order.', 409);
          const order = {
            ...existing,
            status: 'paid',
            paypal_capture_id: captureId,
            customer_json: customerJSON,
            paid_at: existing.paid_at || paidAt,
            updated_at: updatedAt,
            fulfillment_status: existing.fulfillment_status || 'new'
          };
          await transaction.put(`capture:${captureId}`, id);
          await transaction.put(key, order);
          return { order, changed: true };
        });
        return json(result);
      }

      if (action === 'fulfillment' && request.method === 'PATCH') {
        const { fulfillmentStatus, updatedAt } = await request.json();
        if (!ORDER_STATES.has(fulfillmentStatus) || typeof updatedAt !== 'string') throw new OrderDatabaseError('Choose a supported fulfillment status.', 400);
        const result = await this.ctx.storage.transaction(async transaction => {
          const existing = await transaction.get(key);
          if (!existing || existing.payment_provider !== 'paypal') return { order: null, changed: false };
          const order = { ...existing, fulfillment_status: fulfillmentStatus, updated_at: updatedAt };
          await transaction.put(key, order);
          return { order, changed: true };
        });
        return json(result);
      }

      return json({ error: 'Method not allowed.' }, 405);
    } catch (error) {
      return storeFailure(error);
    }
  }
}

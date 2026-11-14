import { DurableObject } from 'cloudflare:workers';
import worker from './index.mjs';
import { FacebookPublisher as Publisher } from './facebook.mjs';
import { createPayPalAPI } from './paypal.mjs';
import { createOrderDatabase, OrderStore as Store } from './order-database.mjs';

const paypalAPI = createPayPalAPI();

// Keep Cloudflare's runtime base classes at the entry point so the cores stay testable in Node.
export class FacebookPublisher extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.publisher = new Publisher(ctx, env);
  }
  fetch(request) { return this.publisher.fetch(request); }
}

export class OrderStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new Store(ctx, env);
  }
  fetch(request) { return this.store.fetch(request); }
}

export default {
  fetch(request, env, ctx) {
    const runtime = { ...env, FACEBOOK_PUBLISHER: ctx.exports.FacebookPublisher };
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/api/paypal/') || pathname === '/api/admin/orders' || pathname.startsWith('/api/admin/orders/')) {
      return paypalAPI(request, {
        ...runtime,
        DB: env.DB || createOrderDatabase(ctx.exports.OrderStore)
      }, ctx);
    }
    return worker.fetch(request, runtime, ctx);
  }
};

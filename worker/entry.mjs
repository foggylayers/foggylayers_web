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
  async fetch(request, env, ctx) {
    const runtime = { ...env, FACEBOOK_PUBLISHER: ctx.exports.FacebookPublisher };
    const pathname = new URL(request.url).pathname;
    if (pathname.startsWith('/api/paypal/') || pathname === '/api/admin/orders' || pathname.startsWith('/api/admin/orders/')) {
      const orderDatabase = env.DB || createOrderDatabase(ctx.exports.OrderStore);
      const apiEnvironment = { ...runtime, DB: orderDatabase };
      const response = await paypalAPI(request, apiEnvironment, ctx);
      if (pathname === '/api/paypal/config' && request.method === 'GET') {
        const data = await response.json();
        data.readiness = {
          commerceEnabled: env.PAYPAL_COMMERCE_ENABLED === 'true',
          orderStorageConfigured: Boolean(orderDatabase),
          clientIdConfigured: Boolean(env.PAYPAL_CLIENT_ID),
          clientSecretConfigured: Boolean(env.PAYPAL_CLIENT_SECRET),
          adminTokenConfigured: Boolean(env.ORDERS_ADMIN_TOKEN || env.FACEBOOK_ADMIN_TOKEN),
          emailProviderConfigured: Boolean(env.RESEND_API_KEY && env.MAIL_FROM)
        };
        return new Response(JSON.stringify(data), {
          status: response.status,
          headers: response.headers
        });
      }
      return response;
    }
    return worker.fetch(request, runtime, ctx);
  }
};

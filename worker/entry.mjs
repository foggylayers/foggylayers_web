import { DurableObject } from 'cloudflare:workers';
import worker from './index.mjs';
import { FacebookPublisher as Publisher } from './facebook.mjs';

// Keep Cloudflare's runtime base class at the entry point so the core stays testable in Node.
export class FacebookPublisher extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.publisher = new Publisher(ctx, env);
  }
  fetch(request) { return this.publisher.fetch(request); }
}

export default {
  fetch(request, env, ctx) {
    // A loopback namespace avoids an env binding to an unprovisioned class during
    // version uploads. Cloudflare provisions its storage on the first deployment.
    return worker.fetch(request, { ...env, FACEBOOK_PUBLISHER: ctx.exports.FacebookPublisher }, ctx);
  }
};

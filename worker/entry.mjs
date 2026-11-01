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

export default worker;

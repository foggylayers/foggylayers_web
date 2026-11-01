import business from '../src/data/site.json' with { type: 'json' };

const BASE = '/api/admin/facebook/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADMIN_TOKEN = /^[A-Za-z0-9_-]{43,128}$/;
const VERSION = /^v[1-9][0-9]?\.[0-9]{1,2}$/;
const ID = /^[0-9]+(?:_[0-9]+)?$/;
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
class FacebookError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: HEADERS });
function failure(error) {
  if (error instanceof FacebookError) return json({ error: error.message, code: error.code || 'FACEBOOK_REQUEST_FAILED' }, error.status);
  // Provider responses and exception messages can contain credentials. Never echo or log them.
  return json({ error: 'The publishing service could not complete that request.', code: 'FACEBOOK_SERVICE_ERROR' }, 500);
}
const text = (value, max, required = false) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new FacebookError(400, 'Check the post fields.');
  const result = value.trim();
  if (required && !result) throw new FacebookError(400, 'Add a message before reviewing the post.');
  return result;
};
function objectWithKeys(value, allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowed.includes(key))) throw new FacebookError(400, 'Unsupported request fields.');
  return value;
}
async function readJSON(request) {
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() !== 'application/json') throw new FacebookError(415, 'Send application/json.');
  if (Number(request.headers.get('Content-Length') || 0) > 24 * 1024) throw new FacebookError(413, 'This post request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new FacebookError(400, 'Send a JSON request body.');
  let size = 0; const chunks = [];
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > 24 * 1024) { await reader.cancel(); throw new FacebookError(413, 'This post request is too large.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new FacebookError(400, 'Send valid JSON.'); }
}
export function facebookConfiguration(env, site = business) {
  let pageId = '';
  try { pageId = new URL(site.facebookUrl).searchParams.get('id') || ''; } catch { /* Report an invalid public Page URL as missing configuration. */ }
  const missing = [];
  if (!ADMIN_TOKEN.test(env.FACEBOOK_ADMIN_TOKEN || '')) missing.push('FACEBOOK_ADMIN_TOKEN');
  if (!env.FACEBOOK_PAGE_ACCESS_TOKEN || /[\r\n]/.test(env.FACEBOOK_PAGE_ACCESS_TOKEN)) missing.push('FACEBOOK_PAGE_ACCESS_TOKEN');
  if (!env.FACEBOOK_APP_SECRET) missing.push('FACEBOOK_APP_SECRET');
  if (!VERSION.test(env.FACEBOOK_API_VERSION || '')) missing.push('FACEBOOK_API_VERSION');
  if (!/^[0-9]{5,30}$/.test(pageId)) missing.push('Page ID in src/data/site.json');
  if (!env.FACEBOOK_PUBLISHER) missing.push('FACEBOOK_PUBLISHER binding');
  return { pageId, pageUrl: site.facebookUrl, apiVersion: env.FACEBOOK_API_VERSION, configured: missing.length === 0, publishingEnabled: env.FACEBOOK_PUBLISHING_ENABLED === 'true', missing };
}
async function authorize(request, env) {
  const url = new URL(request.url);
  if (url.search) throw new FacebookError(400, 'Keep authentication in the Authorization header.');
  const origin = request.headers.get('Origin');
  if ((origin && origin !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') throw new FacebookError(403, 'Cross-site publishing requests are not accepted.');
  if (!ADMIN_TOKEN.test(env.FACEBOOK_ADMIN_TOKEN || '')) throw new FacebookError(503, 'Facebook publishing is not configured yet.', 'FACEBOOK_SETUP_REQUIRED');
  const provided = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/)?.[1] || '';
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([provided, env.FACEBOOK_ADMIN_TOKEN].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b); let mismatch = 0;
  for (let i = 0; i < aa.length; i++) mismatch |= aa[i] ^ bb[i];
  if (!provided || mismatch) throw new FacebookError(401, 'Enter a valid publishing admin token.', 'FACEBOOK_UNAUTHORIZED');
}
function requireConfigured(env, site = business) {
  const config = facebookConfiguration(env, site);
  if (!config.configured) throw new FacebookError(503, 'Finish the Facebook publishing setup before continuing.', 'FACEBOOK_SETUP_REQUIRED');
  return config;
}
function websiteURL(value, site, image = false) {
  if (value === '') return '';
  const raw = text(value, 2048); let url;
  try { url = new URL(raw); } catch { throw new FacebookError(400, 'Use a complete HTTPS website URL.'); }
  if (url.protocol !== 'https:' || url.origin !== new URL(site.url).origin || url.username || url.password || url.hash || url.search) throw new FacebookError(400, 'Use an HTTPS URL from foggylayers.com without query parameters.');
  if (image && (!url.pathname.startsWith('/images/') || !/\.(?:jpe?g|png)$/i.test(url.pathname))) throw new FacebookError(400, 'Choose a JPG or PNG photo from the website images folder.');
  return url.href;
}
export function validateFacebookDraft(input, site = business) {
  const data = objectWithKeys(input, ['requestId', 'message', 'imageUrl', 'linkUrl']);
  if (!UUID.test(data.requestId || '')) throw new FacebookError(400, 'Use a new request ID for this draft.');
  const message = text(data.message, 5000, true);
  const imageUrl = websiteURL(data.imageUrl === undefined ? '' : data.imageUrl, site, true);
  const linkUrl = websiteURL(data.linkUrl === undefined ? '' : data.linkUrl, site);
  if (imageUrl && linkUrl) throw new FacebookError(400, 'For a photo post, put the website link in the message instead of the link field.');
  return { id: data.requestId.toLowerCase(), message, imageUrl, linkUrl };
}
async function appSecretProof(env) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.FACEBOOK_APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(env.FACEBOOK_PAGE_ACCESS_TOKEN));
  return Array.from(new Uint8Array(signature), n => n.toString(16).padStart(2, '0')).join('');
}
async function graph(env, path, parameters, method, fetcher) {
  const proof = await appSecretProof(env);
  const url = new URL(`https://graph.facebook.com/${env.FACEBOOK_API_VERSION}/${path}`);
  const body = new URLSearchParams({ ...parameters, appsecret_proof: proof });
  const init = { method, redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${env.FACEBOOK_PAGE_ACCESS_TOKEN}` } };
  if (method === 'GET') url.search = body.toString();
  else { init.headers['Content-Type'] = 'application/x-www-form-urlencoded'; init.body = body; }
  const response = await fetcher(url.href, init);
  let data;
  try { data = await response.json(); } catch { throw new FacebookError(502, 'Facebook returned an unreadable response.', 'FACEBOOK_UNCERTAIN'); }
  if (!response.ok || data?.error) {
    // Only an explicit, client-side Graph rejection establishes that no post was accepted.
    const rejected = response.status >= 400 && response.status < 500 && data?.error && Number.isInteger(data.error.code);
    const code = Number.isInteger(data?.error?.code) ? data.error.code : undefined;
    throw new FacebookError(502, code ? `Facebook rejected the request (code ${code}). Check the Page token and app permissions.` : 'Facebook could not confirm that request.', rejected ? 'FACEBOOK_REJECTED' : 'FACEBOOK_UNCERTAIN');
  }
  return data;
}
export async function verifyFacebookPage(env, site = business, fetcher = (...args) => fetch(...args)) {
  const config = requireConfigured(env, site);
  let page;
  try { page = await graph(env, 'me', { fields: 'id,name' }, 'GET', fetcher); }
  catch (error) { if (error instanceof FacebookError) throw error; throw new FacebookError(502, 'Facebook could not verify the Page connection.', 'FACEBOOK_CONNECTION_FAILED'); }
  if (page?.id !== config.pageId) throw new FacebookError(403, 'This token does not belong to the Foggy Layers Page.', 'FACEBOOK_WRONG_PAGE');
  return { id: page.id, name: typeof page.name === 'string' ? page.name.slice(0, 200) : 'Foggy Layers', url: config.pageUrl };
}
export function createFacebookAPI({ business: site = business, fetcher = (...args) => fetch(...args) } = {}) {
  return async function facebookAPI(request, env) {
    try {
      await authorize(request, env);
      const path = new URL(request.url).pathname.slice(BASE.length);
      if (path === 'status' && request.method === 'GET') return json(facebookConfiguration(env, site));
      if (path === 'connection' && request.method === 'GET') return json({ page: await verifyFacebookPage(env, site, fetcher) });
      requireConfigured(env, site);
      if (path === 'drafts' && request.method === 'POST') {
        const draft = validateFacebookDraft(await readJSON(request), site);
        const stub = env.FACEBOOK_PUBLISHER.get(env.FACEBOOK_PUBLISHER.idFromName(draft.id));
        return await stub.fetch(new Request('https://publisher.internal/draft', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) }));
      }
      const match = path.match(/^drafts\/([0-9a-f-]+)(\/publish)?$/i);
      if (!match || !UUID.test(match[1])) return json({ error: 'Publishing route not found.' }, 404);
      const id = match[1].toLowerCase();
      const stub = env.FACEBOOK_PUBLISHER.get(env.FACEBOOK_PUBLISHER.idFromName(id));
      if (!match[2] && request.method === 'GET') return await stub.fetch(new Request('https://publisher.internal/draft'));
      if (match[2] && request.method === 'POST') {
        if (env.FACEBOOK_PUBLISHING_ENABLED !== 'true') throw new FacebookError(503, 'Publishing is disabled. Review the setup before enabling it.', 'FACEBOOK_DISABLED');
        const data = objectWithKeys(await readJSON(request), ['confirm']);
        if (data.confirm !== true) throw new FacebookError(400, 'Confirm the reviewed draft before publishing.');
        return await stub.fetch(new Request('https://publisher.internal/publish', { method: 'POST' }));
      }
      return json({ error: 'Method not allowed.' }, 405);
    } catch (error) { return failure(error); }
  };
}

// A private, persistent object per draft. The public Worker authenticates every request
// before it forwards anything here. Neither access tokens nor admin tokens enter storage.
export class FacebookPublisher {
  constructor(ctx, env, { fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
    this.ctx = ctx; this.env = env; this.fetcher = fetcher; this.now = now;
  }
  async fetch(request) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/draft' && request.method === 'POST') {
        const input = await request.json();
        const normalized = validateFacebookDraft({ requestId: input.id, message: input.message, imageUrl: input.imageUrl, linkUrl: input.linkUrl });
        const draft = await this.ctx.storage.transaction(async txn => {
          const previous = await txn.get('draft');
          if (previous) {
            if (JSON.stringify(previous.content) !== JSON.stringify(normalized)) throw new FacebookError(409, 'This draft ID already has different content. Create a new draft.');
            return previous;
          }
          const value = { content: normalized, state: 'draft', createdAt: new Date(this.now()).toISOString() };
          await txn.put('draft', value); return value;
        });
        return json({ draft }, 201);
      }
      if (path === '/draft' && request.method === 'GET') {
        const draft = await this.ctx.storage.get('draft');
        if (!draft) throw new FacebookError(404, 'Draft not found.');
        return json({ draft });
      }
      if (path === '/publish' && request.method === 'POST') return await this.publish();
      return json({ error: 'Not found.' }, 404);
    } catch (error) { return failure(error); }
  }
  async publish() {
    if (this.env.FACEBOOK_PUBLISHING_ENABLED !== 'true') throw new FacebookError(503, 'Publishing is disabled.', 'FACEBOOK_DISABLED');
    requireConfigured(this.env);
    const existing = await this.ctx.storage.get('draft');
    if (!existing) throw new FacebookError(404, 'Draft not found.');
    if (existing.state === 'published') return json({ draft: existing, replayed: true });
    if (existing.state !== 'draft') throw new FacebookError(409, 'This draft was already attempted. Check its status and Facebook before creating another post.', 'FACEBOOK_ATTEMPT_EXISTS');
    // Checking identity is read-only. Do it before claiming the draft or writing to Facebook.
    await verifyFacebookPage(this.env, business, this.fetcher);
    const claimed = await this.ctx.storage.transaction(async txn => {
      const draft = await txn.get('draft');
      if (!draft) throw new FacebookError(404, 'Draft not found.');
      if (draft.state === 'published') return draft;
      if (draft.state !== 'draft') throw new FacebookError(409, 'This draft was already attempted. Check its status and Facebook before creating another post.', 'FACEBOOK_ATTEMPT_EXISTS');
      if (this.now() - Date.parse(draft.createdAt) > 24 * 60 * 60 * 1000) throw new FacebookError(409, 'This draft is more than a day old. Review a new draft.');
      const value = { ...draft, state: 'publishing', attemptedAt: new Date(this.now()).toISOString() };
      await txn.put('draft', value); return value;
    });
    if (claimed.state === 'published') return json({ draft: claimed, replayed: true });
    let result;
    try {
      const config = facebookConfiguration(this.env);
      const { message, imageUrl, linkUrl } = claimed.content;
      result = await graph(this.env, `${config.pageId}/${imageUrl ? 'photos' : 'feed'}`, imageUrl ? { message, url: imageUrl, published: 'true' } : { message, ...(linkUrl ? { link: linkUrl } : {}), published: 'true' }, 'POST', this.fetcher);
      if (!ID.test(result?.id || '') || (result.post_id !== undefined && !ID.test(result.post_id))) throw new FacebookError(502, 'Facebook did not return a valid publishing receipt.', 'FACEBOOK_UNCERTAIN');
    } catch (error) {
      const state = error instanceof FacebookError && error.code === 'FACEBOOK_REJECTED' ? 'rejected' : 'uncertain';
      await this.ctx.storage.put('draft', { ...claimed, state });
      throw new FacebookError(502, state === 'rejected' ? 'Facebook rejected the post. Check app permissions and the Page token before reviewing a new draft.' : 'Facebook may have received this post. Check the Page before creating another draft; this draft will not be sent again.', state === 'rejected' ? 'FACEBOOK_REJECTED' : 'FACEBOOK_UNCERTAIN');
    }
    const postId = result.post_id || result.id;
    const draft = { ...claimed, state: 'published', publishedAt: new Date(this.now()).toISOString(), receipt: { id: result.id, postId, url: `https://www.facebook.com/${postId}` } };
    // A failed receipt write leaves the persisted publishing lock in place. Never retry the post.
    try { await this.ctx.storage.put('draft', draft); }
    catch { throw new FacebookError(502, 'Facebook accepted the post, but its receipt could not be saved. Check the Page; do not send a new draft.', 'FACEBOOK_UNCERTAIN'); }
    return json({ draft });
  }
}

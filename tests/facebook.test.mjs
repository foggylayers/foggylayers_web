import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWorker } from '../worker/index.mjs';
import { createFacebookAPI, FacebookPublisher, validateFacebookDraft } from '../worker/facebook.mjs';

const origin = 'https://foggylayers.com';
const pageId = '61596052263830';
const adminToken = 'test_admin_'.padEnd(64, 'a');
const pageToken = 'test_page_secret_only';
const appSecret = 'test_app_secret_only';
const draftId = 'bc09c08c-2478-4177-99c3-6bbd935c0438';
const content = { requestId: draftId, message: 'Tiny desk companions, $2 each. Find your favorite at Foggy Layers!' };
const copy = value => structuredClone(value);
const response = (data, status = 200) => Response.json(data, { status });

// Cloning and serial transactions model Durable Object storage without network calls.
class Storage {
  records = new Map(); queue = Promise.resolve(); failPublishedWrite = false;
  async get(key) { return copy(this.records.get(key)); }
  async put(key, value) {
    if (this.failPublishedWrite && value.state === 'published') throw new Error('Receipt write failed');
    this.records.set(key, copy(value));
  }
  transaction(callback) {
    const task = this.queue.then(async () => {
      const next = new Map(copy([...this.records]));
      const result = await callback({ get: async key => copy(next.get(key)), put: async (key, value) => next.set(key, copy(value)) });
      this.records = next; return result;
    });
    this.queue = task.catch(() => {}); return task;
  }
}
function setup({ graphPost = () => response({ id: `${pageId}_12345` }), identity = pageId, enabled = true } = {}) {
  const calls = [], stores = new Map(), objects = new Map();
  let currentTime = Date.parse('2026-11-01T12:00:00Z');
  const fetcher = async (url, init) => {
    calls.push({ url, method: init.method, redirect: init.redirect, headers: init.headers, body: init.body ? new URLSearchParams(init.body) : null });
    return init.method === 'GET' ? response({ id: identity, name: 'Foggy Layers' }) : graphPost(url, init);
  };
  const env = { FACEBOOK_ADMIN_TOKEN: adminToken, FACEBOOK_PAGE_ACCESS_TOKEN: pageToken, FACEBOOK_APP_SECRET: appSecret, FACEBOOK_API_VERSION: 'v26.0', FACEBOOK_PUBLISHING_ENABLED: String(enabled) };
  env.FACEBOOK_PUBLISHER = {
    idFromName: id => id,
    get(id) {
      if (!stores.has(id)) stores.set(id, new Storage());
      if (!objects.has(id)) objects.set(id, new FacebookPublisher({ storage: stores.get(id) }, env, { fetcher, now: () => currentTime }));
      return objects.get(id);
    }
  };
  const api = createFacebookAPI({ fetcher });
  const call = async (path, method = 'GET', body, headers = {}) => api(new Request(`${origin}/api/admin/facebook/${path}`, {
    method, headers: { Authorization: `Bearer ${adminToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) })
  }), env);
  const save = data => call('drafts', 'POST', { ...content, ...data });
  const publish = (data = { confirm: true }) => call(`drafts/${draftId}/publish`, 'POST', data);
  return { env, api, calls, stores, call, save, publish, restart: () => objects.clear(), age: ms => { currentTime += ms; }, postCount: () => calls.filter(call => call.method === 'POST').length };
}

test('publishing routes require a configured strong admin token and reject cross-site or URL authentication', async () => {
  const s = setup();
  for (const [headers, code] of [[{ Authorization: '' }, 401], [{ Authorization: `Bearer ${'b'.repeat(64)}` }, 401], [{ Origin: 'https://other.example' }, 403], [{ 'Sec-Fetch-Site': 'cross-site' }, 403]]) {
    assert.equal((await s.call('status', 'GET', undefined, headers)).status, code);
  }
  assert.equal((await s.call('status?access_token=not-a-real-token')).status, 400);
  s.env.FACEBOOK_ADMIN_TOKEN = 'short';
  assert.equal((await s.call('status')).status, 503);
  assert.equal(s.calls.length, 0);
});

test('status reports only setting names and public config never exposes publishing credentials', async () => {
  const s = setup({ enabled: false });
  const status = await (await s.call('status')).json();
  assert.equal(status.configured, true); assert.equal(status.publishingEnabled, false);
  delete s.env.FACEBOOK_APP_SECRET;
  assert.deepEqual((await (await s.call('status')).json()).missing, ['FACEBOOK_APP_SECRET']);
  const publicConfig = await (await createWorker().fetch(new Request(`${origin}/api/config`), s.env)).text();
  assert.equal(JSON.parse(publicConfig).checkoutEnabled, false);
  for (const secret of [adminToken, pageToken, appSecret]) {
    assert.equal(JSON.stringify(status).includes(secret), false); assert.equal(publicConfig.includes(secret), false);
  }
  assert.equal((await s.save()).status, 503);
});

test('validates draft content, strict types, and website-only link and photo URLs', () => {
  const invalid = [
    { message: '' }, { message: 'x'.repeat(5001) }, { message: 'Bad\u0000message' }, { requestId: 'not-a-uuid' },
    { pageId: '12345' }, { imageUrl: false }, { imageUrl: null }, { linkUrl: 0 },
    { imageUrl: 'https://elsewhere.example/photo.jpg' }, { imageUrl: `${origin}/images/photo.svg` },
    { imageUrl: `${origin}/outside.jpg` }, { imageUrl: `${origin}/images/../outside.jpg` },
    { imageUrl: `${origin}/images/photo.jpg?key=value` }, { imageUrl: `http://foggylayers.com/images/photo.jpg` },
    { linkUrl: 'javascript:alert(1)' }, { linkUrl: `${origin}/shop/#section` },
    { linkUrl: 'https://user:password@foggylayers.com/shop/' },
    { imageUrl: `${origin}/images/photo.jpg`, linkUrl: `${origin}/shop/` }
  ];
  for (const extra of invalid) assert.throws(() => validateFacebookDraft({ ...content, ...extra }), undefined, JSON.stringify(extra));
  assert.deepEqual(validateFacebookDraft({ ...content, message: '  Hello!  ', linkUrl: `${origin}/shop/` }), { id: draftId, message: 'Hello!', imageUrl: '', linkUrl: `${origin}/shop/` });
});

test('limits streamed request bodies without relying on Content-Length and enforces JSON media type', async () => {
  const s = setup();
  assert.equal((await s.call('drafts', 'POST', ' '.repeat(25 * 1024))).status, 413);
  assert.equal((await s.call('drafts', 'POST', content, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await s.call('drafts', 'POST', content, { 'Content-Type': 'application/json-not-really' })).status, 415);
  assert.equal((await s.call('drafts', 'POST', '{broken')).status, 400);
  assert.equal(s.stores.size, 0); assert.equal(s.calls.length, 0);
});

test('connection verification works while disabled and signs requests without putting the Page token in a URL', async () => {
  const s = setup({ enabled: false });
  const result = await s.call('connection'); assert.equal(result.status, 200);
  assert.equal((await result.json()).page.id, pageId); assert.equal(s.postCount(), 0);
  const [call] = s.calls, url = new URL(call.url);
  assert.equal(url.origin, 'https://graph.facebook.com'); assert.equal(url.pathname, '/v26.0/me');
  assert.equal(url.searchParams.get('fields'), 'id,name'); assert.equal(call.headers.Authorization, `Bearer ${pageToken}`);
  assert.equal(call.redirect, 'manual');
  assert.equal(url.searchParams.get('appsecret_proof'), createHmac('sha256', appSecret).update(pageToken).digest('hex'));
  assert.equal(call.url.includes(pageToken), false); assert.equal(call.url.includes(appSecret), false);
});

test('draft creation is immutable and replayable, and review does not call Facebook', async () => {
  const s = setup({ enabled: false });
  assert.equal((await s.save()).status, 201);
  assert.equal((await s.save()).status, 201);
  assert.equal((await s.save({ message: 'Different post' })).status, 409);
  const saved = await (await s.call(`drafts/${draftId}`)).json();
  assert.equal(saved.draft.state, 'draft'); assert.equal(saved.draft.content.message, content.message);
  assert.equal(s.calls.length, 0);
  const stored = JSON.stringify([...s.stores.get(draftId).records]);
  for (const secret of [adminToken, pageToken, appSecret]) assert.equal(stored.includes(secret), false);
  assert.equal((await s.publish()).status, 503);
});

test('publish requires explicit confirmation and rejects a token for a different Page', async () => {
  const s = setup({ identity: '9999999999999' }); await s.save();
  for (const body of [{}, { confirm: false }, { confirm: true, message: 'Sneak in new content' }]) assert.equal((await s.publish(body)).status, 400);
  const result = await s.publish(); assert.equal(result.status, 403);
  assert.equal((await result.json()).code, 'FACEBOOK_WRONG_PAGE'); assert.equal(s.postCount(), 0);
  assert.equal((await (await s.call(`drafts/${draftId}`)).json()).draft.state, 'draft');
});

test('publishes the saved text and link to the Page feed and returns a persistent receipt', async () => {
  const s = setup(); await s.save({ linkUrl: `${origin}/shop/` });
  const result = await s.publish(); assert.equal(result.status, 200);
  const { draft } = await result.json();
  assert.equal(draft.state, 'published'); assert.equal(draft.receipt.postId, `${pageId}_12345`);
  const call = s.calls.find(call => call.method === 'POST');
  assert.equal(new URL(call.url).pathname, `/v26.0/${pageId}/feed`);
  assert.equal(call.body.get('message'), content.message); assert.equal(call.body.get('link'), `${origin}/shop/`);
  assert.equal(call.body.get('published'), 'true'); assert.ok(call.body.get('appsecret_proof'));
  assert.equal(call.body.has('access_token'), false);
  s.restart();
  const replay = await (await s.publish()).json();
  assert.equal(replay.replayed, true); assert.deepEqual(replay.draft.receipt, draft.receipt);
  assert.equal(s.calls.length, 2); assert.equal(s.postCount(), 1);
});

test('publishes a website photo using the photos endpoint and stores the returned post ID', async () => {
  const s = setup({ graphPost: () => response({ id: '12345', post_id: `${pageId}_56789` }) });
  await s.save({ imageUrl: `${origin}/images/fox-figure.jpeg` });
  const { draft } = await (await s.publish()).json();
  const call = s.calls.find(call => call.method === 'POST');
  assert.equal(new URL(call.url).pathname, `/v26.0/${pageId}/photos`);
  assert.equal(call.body.get('url'), `${origin}/images/fox-figure.jpeg`);
  assert.equal(call.body.get('message'), content.message); assert.equal(call.body.has('link'), false);
  assert.equal(draft.receipt.postId, `${pageId}_56789`);
});

test('concurrent publish requests can make only one Facebook write', async () => {
  const s = setup(); await s.save();
  const results = await Promise.all([s.publish(), s.publish(), s.publish()]);
  assert.ok(results.some(result => result.status === 200));
  assert.ok(results.every(result => [200, 409].includes(result.status))); assert.equal(s.postCount(), 1);
});

test('timeouts, server errors, unreadable results, and malformed receipts never automatically resend', async () => {
  const cases = [
    () => { throw new Error(`Network failed ${pageToken} ${appSecret}`); },
    () => response({ error: { code: 2, message: pageToken } }, 503),
    () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example/' } }),
    () => new Response('not JSON'), () => response({ id: 'malformed' }), () => response({ id: '12345', post_id: '<script>' })
  ];
  for (const graphPost of cases) {
    const s = setup({ graphPost }); await s.save(); const result = await s.publish();
    assert.equal(result.status, 502); const body = await result.text(); assert.equal(body.includes(pageToken), false); assert.equal(body.includes(appSecret), false);
    assert.equal((await (await s.call(`drafts/${draftId}`)).json()).draft.state, 'uncertain');
    s.restart(); assert.equal((await s.publish()).status, 409); assert.equal(s.postCount(), 1);
  }
});

test('an explicit Graph rejection is recorded and cannot be automatically resent', async () => {
  const s = setup({ graphPost: () => response({ error: { code: 200, message: `Permission denied ${pageToken}` } }, 403) });
  await s.save(); const result = await s.publish(); assert.equal(result.status, 502);
  assert.equal((await result.json()).code, 'FACEBOOK_REJECTED');
  assert.equal((await (await s.call(`drafts/${draftId}`)).json()).draft.state, 'rejected');
  assert.equal((await s.publish()).status, 409); assert.equal(s.postCount(), 1);
});

test('a failed receipt write leaves a permanent attempted lock through an object restart', async () => {
  const s = setup(); await s.save(); s.stores.get(draftId).failPublishedWrite = true;
  const result = await s.publish(); assert.equal(result.status, 502); assert.equal((await result.json()).code, 'FACEBOOK_UNCERTAIN');
  assert.equal((await (await s.call(`drafts/${draftId}`)).json()).draft.state, 'publishing');
  s.restart(); assert.equal((await s.publish()).status, 409); assert.equal(s.postCount(), 1);
});

test('old or missing drafts cannot be published', async () => {
  const s = setup(); assert.equal((await s.publish()).status, 404);
  await s.save(); s.age(25 * 60 * 60 * 1000);
  assert.equal((await s.publish()).status, 409); assert.equal(s.postCount(), 0);
});

test('existing Worker routes dispatch authenticated publishing clients without requiring a browser Origin', async () => {
  const s = setup(); const worker = createWorker();
  const request = new Request(`${origin}/api/admin/facebook/drafts`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(content) });
  assert.equal((await worker.fetch(request, s.env)).status, 201);
  assert.equal(s.postCount(), 0);
});

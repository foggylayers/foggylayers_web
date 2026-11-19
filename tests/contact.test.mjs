import test from 'node:test';
import assert from 'node:assert/strict';
import { createContactAPI } from '../worker/contact.mjs';
const env = { RESEND_API_KEY: 'test-key', MAIL_FROM: 'Foggy Layers <orders@foggylayers.com>' };
const data = { name: 'Test Customer', email: 'customer@example.com', subject: 'Custom print', message: 'Can you print a custom figure?', website: '' };
const request = (body = data, origin = 'https://foggylayers.com') => new Request('https://foggylayers.com/api/contact', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
test('contact mail has fixed recipient and customer reply-to; reports provider acceptance', async () => {
  let mail;
  const api = createContactAPI({ fetcher: async (url, options) => { assert.equal(url, 'https://api.resend.com/emails'); mail = JSON.parse(options.body); return new Response('{}'); } });
  assert.equal((await api(request(), env)).status, 200);
  assert.deepEqual(mail.to, ['orders@foggylayers.com']);
  assert.equal(mail.reply_to, data.email);
  assert.match(mail.text, /Test Customer/);
});
test('missing setup, invalid fields, spam, cross-origin and oversized requests never send mail', async () => {
  const api = createContactAPI({ fetcher: () => { throw new Error('must not send'); } });
  assert.equal((await api(request(), {})).status, 503);
  for (const invalid of [{ ...data, email: 'bad' }, { ...data, subject: 'hello\r\nbcc: other' }, { ...data, website: 'spam' }, { ...data, message: '' }]) assert.equal((await api(request(invalid), env)).status, 400);
  assert.equal((await api(request(data, 'https://example.com'), env)).status, 403);
  assert.equal((await api(request({ ...data, message: 'a'.repeat(17000) }), env)).status, 413);
});
test('provider failure never reports success and repeated submissions are throttled', async () => {
  const api = createContactAPI({ fetcher: async () => new Response('{}', { status: 500 }) });
  for (let i = 0; i < 3; i++) assert.equal((await api(request(), env)).status, 502);
  assert.equal((await api(request(), env)).status, 429);
});

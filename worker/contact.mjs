const recipient = 'orders@foggylayers.com';
const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

export function createContactAPI({ fetcher = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  const attempts = new Map();
  return async function contact(request, env) {
    const url = new URL(request.url);
    const enabled = Boolean(env.RESEND_API_KEY && env.MAIL_FROM);
    if (request.method === 'GET') return json({ enabled });
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (request.headers.get('Origin') !== url.origin) return json({ error: 'Please send your message from the Foggy Layers website.' }, 403);
    if (!enabled) return json({ error: 'The form is not available yet. Please email orders@foggylayers.com.' }, 503);
    if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) return json({ error: 'Please use the contact form.' }, 415);
    try {
      // Bound the streamed body before parsing, even if Content-Length is absent.
      const reader = request.body?.getReader();
      if (!reader) return json({ error: 'Please complete the contact form.' }, 400);
      const chunks = []; let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16384) { await reader.cancel(); return json({ error: 'Your message is too long.' }, 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let data;
      try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch { return json({ error: 'Please check your message and try again.' }, 400); }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'Please complete the contact form.' }, 400);
      const field = (key, max) => typeof data[key] === 'string' && data[key].trim().length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(data[key]) ? data[key].trim() : '';
      const name = field('name', 100), email = field('email', 254), subject = field('subject', 150), message = field('message', 5000);
      if (data.website) return json({ error: 'We could not accept this message.' }, 400);
      if (!name || !subject || !message || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || /[\r\n]/.test(name + subject + email)) return json({ error: 'Please enter your name, a valid email address, a subject, and a message.' }, 400);
      // Best-effort per-isolate throttling; no customer data or IP addresses are persisted.
      const time = now();
      for (const [key, entry] of attempts) if (time - entry.start >= 600000) attempts.delete(key);
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      const entry = attempts.get(ip) || { start: time, count: 0 };
      if (entry.count >= 3 || attempts.size >= 5000) return json({ error: 'Please wait a few minutes before sending another message.' }, 429);
      entry.count++; attempts.set(ip, entry);
      const response = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.MAIL_FROM, to: [recipient], reply_to: email, subject: `Foggy Layers contact: ${subject}`, text: `Name: ${name}\nEmail: ${email}\n\n${message}` }),
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) return json({ error: 'Your message could not be sent. Please try again or email orders@foggylayers.com.' }, 502);
      return json({ sent: true });
    } catch { return json({ error: 'Your message could not be sent. Please try again or email orders@foggylayers.com.' }, 502); }
  };
}

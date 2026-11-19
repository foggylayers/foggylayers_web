const form = document.querySelector('#contact-form');
if (form) {
  const submit = form.querySelector('button[type="submit"]');
  const notice = form.querySelector('[data-contact-availability]');
  const error = form.querySelector('[data-contact-error]');
  let enabled = false;
  fetch('/api/contact', { cache: 'no-store' }).then(response => response.ok ? response.json() : {}).then(config => {
    enabled = Boolean(config.enabled);
    submit.disabled = !enabled;
    notice.hidden = enabled;
    notice.textContent = 'The contact form is opening soon. You can email orders@foggylayers.com or message us on Facebook now.';
  }).catch(() => { notice.textContent = 'The contact form is unavailable. Please email orders@foggylayers.com.'; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (!enabled || !form.reportValidity()) return;
    error.hidden = true; submit.disabled = true; submit.textContent = 'Sending…';
    try {
      const response = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok || !result.sent) throw new Error(result.error || 'We could not send your message. Please try again.');
      form.hidden = true;
      const success = document.querySelector('[data-contact-success]'); success.hidden = false; success.focus();
    } catch (reason) {
      error.textContent = reason.name === 'TimeoutError' ? 'Delivery is taking longer than expected. Please email orders@foggylayers.com if you need help.' : reason.message || 'We could not send your message. Please try again.';
      error.hidden = false; submit.disabled = false; submit.textContent = 'Send message';
    }
  });
}

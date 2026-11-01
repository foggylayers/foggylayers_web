const root = document.querySelector('[data-facebook-admin]');
if (root) {
  const find = selector => root.querySelector(selector);
  const fields = find('[data-compose-fields]');
  const message = find('#post-message'), image = find('#post-image'), link = find('#post-link');
  const confirm = find('[data-confirm]'), publish = find('[data-publish]');
  let token = '', configured = false, enabled = false, verified = false, busy = false, draft = null;
  function status(message, error = false) {
    find('[data-status]').textContent = message;
    find('[data-status]').dataset.error = String(error);
  }
  function controls() {
    fields.disabled = busy || !configured || !verified;
    const ready = !busy && configured && verified && enabled && draft?.state === 'draft';
    confirm.disabled = !ready;
    publish.disabled = !ready || !confirm.checked;
    find('[data-connect] button[type=submit]').disabled = busy;
    find('[data-recover-button]').disabled = busy || !configured;
    find('[data-disconnect]').disabled = busy;
  }
  async function api(path, method = 'GET', body) {
    const response = await fetch(`/api/admin/facebook/${path}`, {
      method, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000)
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('The publisher could not read the response. Check an existing draft before trying to publish again.'); }
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }
  function showDraft(value) {
    draft = value; confirm.checked = false;
    find('[data-empty-preview]').hidden = true; find('[data-preview]').hidden = false;
    find('[data-preview-message]').textContent = value.content.message;
    const photo = find('[data-preview-image]'); photo.hidden = !value.content.imageUrl;
    if (value.content.imageUrl) photo.src = value.content.imageUrl; else photo.removeAttribute('src');
    const website = find('[data-preview-link]'); website.hidden = !value.content.linkUrl;
    if (value.content.linkUrl) { website.href = value.content.linkUrl; website.textContent = value.content.linkUrl; } else { website.removeAttribute('href'); website.textContent = ''; }
    find('[data-draft-id]').textContent = value.content.id;
    find('#recover-id').value = value.content.id;
    const stateMessages = {
      draft: 'Saved for review. No post has been sent.', published: 'Published to Facebook.',
      publishing: 'A publish attempt is in progress or its result is unconfirmed. Check the Facebook Page before creating another draft.',
      uncertain: 'Facebook may have received this post. Check the Page before creating another draft. This draft will not be sent again.',
      rejected: 'Facebook rejected this post. Fix the Page connection or app permissions before reviewing a new draft.'
    };
    find('[data-draft-state]').textContent = stateMessages[value.state] || 'Check the draft status before continuing.';
    const receipt = find('[data-receipt]'); receipt.hidden = !value.receipt;
    if (value.receipt) receipt.href = value.receipt.url; else receipt.removeAttribute('href');
    controls();
  }
  function invalidate() {
    draft = null; confirm.checked = false;
    find('[data-preview]').hidden = true; find('[data-empty-preview]').hidden = false;
    controls();
  }
  for (const input of [message, image, link]) input.addEventListener('input', invalidate);
  confirm.addEventListener('change', controls);
  find('[data-connect]').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    token = find('#admin-token').value.trim(); find('#admin-token').value = '';
    configured = false; verified = false; enabled = false; busy = true; controls();
    status('Checking publishing settings…');
    try {
      const config = await api('status'); configured = config.configured; enabled = config.publishingEnabled;
      find('[data-disconnect]').hidden = false;
      if (!configured) { status(`Setup is incomplete. Add: ${config.missing.join(', ')}.`, true); return; }
      const { page } = await api('connection'); verified = true;
      status(`Connected to ${page.name}. ${enabled ? 'Review a draft before publishing.' : 'Publishing is disabled. You can prepare and review drafts.'}`);
    } catch (error) { token = ''; configured = false; status(error.message || 'Could not connect.', true); }
    finally { busy = false; controls(); }
  });
  find('[data-disconnect]').addEventListener('click', () => {
    token = ''; configured = false; verified = false; enabled = false;
    find('#admin-token').value = ''; find('[data-disconnect]').hidden = true;
    invalidate(); status('Disconnected. Connect again to continue.');
  });
  find('[data-composer]').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !verified || !configured) return;
    busy = true; controls(); status('Saving a draft for review…');
    try {
      const result = await api('drafts', 'POST', { requestId: crypto.randomUUID(), message: message.value, imageUrl: image.value, linkUrl: link.value });
      showDraft(result.draft); status(enabled ? 'Review the saved draft and confirm when you are ready to publish.' : 'Draft saved. Publishing stays disabled until you enable it in Cloudflare.');
    } catch (error) { status(error.message || 'Could not save the draft.', true); }
    finally { busy = false; controls(); }
  });
  publish.addEventListener('click', async () => {
    if (busy || !verified || !enabled || draft?.state !== 'draft' || !confirm.checked) return;
    const id = draft.content.id; busy = true; controls(); status('Publishing the reviewed post…');
    // Disable this local copy immediately. A lost response must be reconciled with storage.
    draft = { ...draft, state: 'publishing' };
    try {
      const result = await api(`drafts/${id}/publish`, 'POST', { confirm: true });
      showDraft(result.draft); status('Published. Use “View published post” to open it.');
    } catch (error) {
      try { const result = await api(`drafts/${id}`); showDraft(result.draft); }
      catch { showDraft(draft); }
      status(draft.state === 'published' ? 'Published. The saved receipt confirms the post.' : `${error.message} Check this draft's status and the Facebook Page before creating another post.`, draft.state !== 'published');
    } finally { busy = false; confirm.checked = false; controls(); }
  });
  find('[data-recover]').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !configured) return;
    const id = find('#recover-id').value.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) { status('Enter a valid draft ID.', true); return; }
    busy = true; controls();
    try {
      const result = await api(`drafts/${id.toLowerCase()}`); showDraft(result.draft);
      message.value = draft.content.message; image.value = draft.content.imageUrl; link.value = draft.content.linkUrl;
      status('Draft status loaded. Review its saved content and status before continuing.');
    } catch (error) { status(error.message || 'Could not check the draft.', true); }
    finally { busy = false; controls(); }
  });
  window.addEventListener('pagehide', () => { token = ''; });
  window.addEventListener('pageshow', event => { if (event.persisted) { configured = false; verified = false; enabled = false; controls(); status('Connect again to continue.'); } });
  controls();
}

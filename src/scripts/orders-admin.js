const root = document.querySelector('[data-orders-admin]');

if (root) {
  const authForm = root.querySelector('[data-orders-auth]');
  const dashboard = root.querySelector('[data-orders-dashboard]');
  const list = root.querySelector('[data-orders-list]');
  const filter = root.querySelector('[data-orders-filter]');
  const refresh = root.querySelector('[data-orders-refresh]');
  const error = root.querySelector('[data-orders-error]');
  const tokenInput = root.querySelector('[name="token"]');
  const storageKey = 'foggy-layers-orders-token';
  const currency = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents || 0) / 100);
  const date = value => value ? new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Not available';
  const states = [
    ['new', 'New'],
    ['printing', 'Printing'],
    ['ready', 'Ready for pickup'],
    ['shipped', 'Shipped'],
    ['completed', 'Completed'],
    ['cancelled', 'Cancelled']
  ];
  let token = sessionStorage.getItem(storageKey) || '';

  function showError(text) {
    error.textContent = text || '';
    error.hidden = !text;
  }

  async function api(path, init = {}) {
    const response = await fetch(path, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {})
      },
      cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        sessionStorage.removeItem(storageKey);
        token = '';
        authForm.hidden = false;
        dashboard.hidden = true;
      }
      throw new Error(data.error || 'The order dashboard could not complete that request.');
    }
    return data;
  }

  function appendText(parent, label, value) {
    const line = document.createElement('span');
    const strong = document.createElement('strong'); strong.textContent = `${label}: `;
    line.append(strong, document.createTextNode(value || 'Not available'));
    parent.append(line);
  }

  function addressText(order) {
    if (order.fulfillment === 'pickup') return 'Everett, WA pickup';
    const shipping = order.customer?.shipping;
    const address = shipping?.address;
    if (!address) return 'Shipping address is available in PayPal.';
    return [
      shipping.name?.full_name,
      address.address_line_1,
      address.address_line_2,
      [address.admin_area_2, address.admin_area_1, address.postal_code].filter(Boolean).join(', ').replace(', ,', ','),
      address.country_code
    ].filter(Boolean).join('\n');
  }

  function renderOrder(order) {
    const card = document.createElement('article'); card.className = 'order-card';
    const details = document.createElement('div');
    const heading = document.createElement('h2'); heading.textContent = order.reference;
    const status = document.createElement('span'); status.className = 'order-status'; status.textContent = order.status === 'paid' ? 'Payment captured' : order.status;
    const meta = document.createElement('div'); meta.className = 'order-card-meta';
    appendText(meta, 'Placed', date(order.createdAt));
    appendText(meta, 'Delivery', order.fulfillment === 'pickup' ? 'Everett pickup' : 'US shipping');
    appendText(meta, 'PayPal order', order.paypalOrderId);
    appendText(meta, 'Capture', order.paypalCaptureId);

    const items = document.createElement('ul'); items.className = 'order-card-items';
    for (const item of order.items || []) {
      const row = document.createElement('li');
      const total = Number.isInteger(item.lineTotalCents) ? item.lineTotalCents : item.priceCents * item.quantity;
      row.textContent = `${item.name} x ${item.quantity} - ${currency(total)}`;
      items.append(row);
    }

    const total = document.createElement('div'); total.className = 'order-card-total';
    appendText(total, 'Subtotal', currency(order.subtotalCents));
    appendText(total, 'Shipping', order.shippingCents ? currency(order.shippingCents) : 'Free');
    appendText(total, 'Total', currency(order.totalCents));

    const customer = document.createElement('div'); customer.className = 'order-card-customer';
    appendText(customer, 'Customer', order.customer?.payer?.name);
    appendText(customer, 'Email', order.customer?.payer?.email);
    const address = document.createElement('pre'); address.textContent = addressText(order); customer.append(address);
    details.append(heading, status, meta, items, total, customer);

    const actions = document.createElement('div'); actions.className = 'order-card-actions';
    const label = document.createElement('label'); label.textContent = 'Fulfillment status';
    const select = document.createElement('select');
    for (const [value, text] of states) {
      const option = document.createElement('option'); option.value = value; option.textContent = text; option.selected = value === order.fulfillmentStatus; select.append(option);
    }
    const save = document.createElement('button'); save.type = 'button'; save.className = 'button'; save.textContent = 'Save status';
    const result = document.createElement('p'); result.setAttribute('role', 'status');
    save.addEventListener('click', async () => {
      save.disabled = true; result.textContent = 'Saving...';
      try {
        const data = await api(`/api/admin/orders/${encodeURIComponent(order.id)}`, { method: 'PATCH', body: JSON.stringify({ fulfillmentStatus: select.value }) });
        result.textContent = `${data.order.reference} updated to ${select.options[select.selectedIndex].text}.`;
      } catch (reason) { result.textContent = reason.message; }
      finally { save.disabled = false; }
    });
    label.append(select); actions.append(label, save, result); card.append(details, actions);
    return card;
  }

  async function loadOrders() {
    showError('');
    refresh.disabled = true;
    list.replaceChildren();
    const loading = document.createElement('p'); loading.textContent = 'Loading orders...'; list.append(loading);
    try {
      const data = await api(`/api/admin/orders?status=${encodeURIComponent(filter.value)}`);
      list.replaceChildren();
      if (!data.orders?.length) {
        const empty = document.createElement('p'); empty.className = 'orders-empty'; empty.textContent = 'No orders match this view.'; list.append(empty);
      } else data.orders.forEach(order => list.append(renderOrder(order)));
    } catch (reason) {
      list.replaceChildren();
      showError(reason.message || 'The orders could not be loaded.');
    } finally { refresh.disabled = false; }
  }

  async function openDashboard() {
    authForm.hidden = true;
    dashboard.hidden = false;
    await loadOrders();
  }

  authForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (!authForm.reportValidity()) return;
    token = tokenInput.value.trim();
    sessionStorage.setItem(storageKey, token);
    await openDashboard();
  });
  filter.addEventListener('change', loadOrders);
  refresh.addEventListener('click', loadOrders);
  if (token) openDashboard();
}

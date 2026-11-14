import products from '../data/products.json';
import { newId } from './ids.js';
import { normalizeBag } from './bag.mjs';
import { applyBundlePricing, cartItemTotal } from './pricing.mjs';

const catalog = new Map(products.map(product => [product.id, product]));
const storageKey = 'foggy-layers-bag-v1';
const currency = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format((cents || 0) / 100);

function readBag() {
  try { return normalizeBag(JSON.parse(localStorage.getItem(storageKey) || '[]'), catalog); }
  catch { return []; }
}

function pricedBag() {
  return applyBundlePricing(readBag(), catalog);
}

function subtotalCents() {
  return pricedBag().reduce((sum, item) => sum + cartItemTotal(item), 0);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (window.paypal) resolve();
      else existing.addEventListener('load', resolve, { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', resolve, { once: true });
    script.addEventListener('error', () => reject(new Error('PayPal checkout could not load.')), { once: true });
    document.head.append(script);
  });
}

function message(element, text, error = false) {
  if (!element) return;
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('is-error', error);
}

async function initCheckout() {
  const root = document.querySelector('[data-paypal-checkout]');
  if (!root) return;
  const notice = root.querySelector('[data-paypal-notice]');
  const error = root.querySelector('[data-paypal-error]');
  const paypalButton = root.querySelector('[data-paypal-button]');
  const venmoButton = root.querySelector('[data-venmo-button]');
  const shippingAmount = document.querySelector('[data-cart-shipping]');
  const totalAmount = document.querySelector('[data-cart-total]');
  const minimumNote = root.querySelector('[data-minimum-note]');
  let checkoutKey = newId();
  let config = null;
  let ready = false;
  let busy = false;
  let paypalEligible = false;
  let venmoEligible = false;

  const fulfillment = () => document.querySelector('[name="cart-fulfillment"]:checked')?.value || 'pickup';
  const resetCheckout = () => { checkoutKey = newId(); };

  function totals() {
    const subtotal = subtotalCents();
    const shipping = fulfillment() === 'shipping' ? (config?.flatShippingCents || 0) : 0;
    if (shippingAmount) shippingAmount.textContent = shipping ? currency(shipping) : 'Free';
    if (totalAmount) totalAmount.textContent = currency(subtotal + shipping);
    if (minimumNote && config) minimumNote.textContent = `Online checkout has a ${currency(config.minimumOrderCents)} merchandise minimum.`;
    return { subtotal, shipping, total: subtotal + shipping };
  }

  function updateState() {
    const bag = readBag();
    const { subtotal } = totals();
    const enough = Boolean(config && bag.length && subtotal >= config.minimumOrderCents);
    const enabled = ready && enough && !busy;
    paypalButton?.toggleAttribute('hidden', !(enabled && paypalEligible));
    venmoButton?.toggleAttribute('hidden', !(enabled && venmoEligible));
    root.classList.toggle('checkout-ready', enabled);
    if (!config?.checkoutEnabled) return;
    if (!bag.length) message(notice, 'Add a print to your bag to open PayPal checkout.');
    else if (!enough) message(notice, `Add ${currency(config.minimumOrderCents - subtotal)} more to reach the online-order minimum.`);
    else if (!ready) message(notice, 'Loading secure PayPal checkout...');
    else if (!paypalEligible && !venmoEligible) message(notice, 'PayPal checkout is not available in this browser. Message us on Facebook for help.');
    else message(notice, config.environment === 'sandbox' ? 'Sandbox checkout is enabled. No real money will move during testing.' : 'Pay securely with PayPal or an eligible Venmo account.');
  }

  try {
    const response = await fetch('/api/paypal/config', { cache: 'no-store' });
    config = response.ok ? await response.json() : null;
    if (!config?.checkoutEnabled || !config.clientId || !config.sdkUrl) {
      message(notice, 'Online checkout is not open yet. Message Foggy Layers on Facebook with the print names and quantities in your bag.');
      totals();
      return;
    }
    const shippingInput = document.querySelector('[name="cart-fulfillment"][value="shipping"]');
    const pickupInput = document.querySelector('[name="cart-fulfillment"][value="pickup"]');
    if (!config.shippingEnabled && shippingInput) {
      shippingInput.disabled = true;
      if (pickupInput) pickupInput.checked = true;
    }
    totals();
    await loadScript(config.sdkUrl);
    if (!window.paypal?.createInstance) throw new Error('PayPal checkout could not initialize.');
    const sdk = await window.paypal.createInstance({
      clientId: config.clientId,
      components: ['paypal-payments', 'venmo-payments'],
      pageType: 'checkout',
      locale: 'en-US',
      clientMetadataId: crypto.randomUUID()
    });
    const current = totals();
    const methods = await sdk.findEligibleMethods({ currencyCode: 'USD', countryCode: 'US', amount: (current.total / 100).toFixed(2) });
    paypalEligible = methods.isEligible('paypal');
    venmoEligible = methods.isEligible('venmo');

    async function createOrder(paymentMethod) {
      const response = await fetch('/api/paypal/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: readBag(), fulfillment: fulfillment(), checkoutKey, paymentMethod })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (data.code === 'CHECKOUT_ENDED') resetCheckout();
        throw new Error(data.error || 'PayPal checkout could not be opened. Please try again.');
      }
      return { orderId: data.id };
    }

    async function approve({ orderId }) {
      message(error, '');
      message(notice, 'Confirming your payment...');
      const response = await fetch(`/api/paypal/orders/${encodeURIComponent(orderId)}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkoutKey })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.status !== 'paid') throw new Error(data.error || 'Your payment could not be confirmed. Please check PayPal before trying again.');
      const completedOrder = checkoutKey;
      sessionStorage.setItem('foggy-layers-last-order', completedOrder);
      window.location.assign(`/order/thanks/?order_id=${encodeURIComponent(completedOrder)}`);
      return data;
    }

    function cancelled() {
      busy = false;
      resetCheckout();
      message(error, '');
      message(notice, 'Checkout was cancelled. Your bag is still here when you are ready.');
      updateState();
    }

    function failed() {
      busy = false;
      resetCheckout();
      message(error, 'PayPal could not complete checkout. No order is confirmed unless the success page says payment was captured.', true);
      updateState();
    }

    const options = { onApprove: approve, onCancel: cancelled, onError: failed };
    const paypalSession = paypalEligible ? sdk.createPayPalOneTimePaymentSession(options) : null;
    const venmoSession = venmoEligible ? sdk.createVenmoOneTimePaymentSession(options) : null;

    async function start(paymentMethod, session) {
      if (!session || busy) return;
      const subtotal = subtotalCents();
      if (!readBag().length || subtotal < config.minimumOrderCents) { updateState(); return; }
      busy = true;
      message(error, '');
      message(notice, `Opening ${paymentMethod === 'venmo' ? 'Venmo' : 'PayPal'}...`);
      try {
        const orderPromise = createOrder(paymentMethod);
        await session.start({ presentationMode: 'auto' }, orderPromise);
      } catch (reason) {
        busy = false;
        resetCheckout();
        message(error, reason?.message || 'PayPal checkout could not be opened. Please try again.', true);
        updateState();
      }
    }

    paypalButton?.addEventListener('click', () => start('paypal', paypalSession));
    venmoButton?.addEventListener('click', () => start('venmo', venmoSession));
    ready = true;
    updateState();
  } catch (reason) {
    message(error, reason?.message || 'PayPal checkout could not load. Please try again.', true);
    message(notice, 'You can still message Foggy Layers on Facebook to place your order.');
  }

  document.querySelectorAll('[name="cart-fulfillment"]').forEach(input => input.addEventListener('change', () => {
    resetCheckout();
    updateState();
  }));
  window.addEventListener('storage', event => { if (event.key === storageKey) { resetCheckout(); updateState(); } });
  const items = document.querySelector('[data-cart-items]');
  if (items) new MutationObserver(() => { resetCheckout(); updateState(); }).observe(items, { childList: true, subtree: true, characterData: true });
  if (new URLSearchParams(window.location.search).get('checkout') === 'cancelled') message(notice, 'Checkout was cancelled. Your bag is still here when you are ready.');
}

async function initOrderResult() {
  const root = document.querySelector('[data-paypal-order-result]');
  if (!root) return;
  const heading = root.querySelector('[data-order-heading]');
  const messageNode = root.querySelector('[data-order-message]');
  const referenceNode = root.querySelector('[data-order-reference]');
  const id = new URLSearchParams(window.location.search).get('order_id') || sessionStorage.getItem('foggy-layers-last-order');

  async function check(attempt = 0) {
    try {
      if (!id) throw new Error('missing');
      const response = await fetch(`/api/paypal/orders/status?order_id=${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error('missing');
      const order = await response.json();
      if (referenceNode) referenceNode.textContent = order.reference || '';
      if (order.paid) {
        heading.textContent = 'Good things are on the way.';
        messageNode.textContent = order.fulfillment === 'pickup'
          ? 'Your PayPal payment is confirmed. We will let you know when your print is ready and share Everett pickup instructions.'
          : 'Your PayPal payment is confirmed. We will follow up when your order ships.';
        localStorage.removeItem(storageKey);
        sessionStorage.removeItem('foggy-layers-last-order');
        window.dispatchEvent(new StorageEvent('storage', { key: storageKey, newValue: null }));
        return;
      }
      if (attempt < 4 && ['created', 'pending'].includes(order.status)) {
        window.setTimeout(() => check(attempt + 1), 2000);
        return;
      }
      heading.textContent = 'Your payment is still being confirmed.';
      messageNode.textContent = 'Check your PayPal confirmation before placing another order. Contact Foggy Layers with the order reference below if you need help.';
    } catch {
      heading.textContent = 'We could not confirm that order.';
      messageNode.textContent = 'This page alone does not confirm payment. Check PayPal or contact Foggy Layers before placing the order again.';
    }
  }
  check();
}

initCheckout();
initOrderResult();

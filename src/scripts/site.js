import products from '../data/products.json';
import { newId } from './ids.js';
import { sellable, variantFor, lineKey, normalizeBag } from './bag.mjs';

const catalog = new Map(products.map(product => [product.id, product]));
const storageKey = 'foggy-layers-bag-v1';
const currency = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const configPromise = fetch('/api/config', { cache: 'no-store' }).then(response => response.ok ? response.json() : {}).catch(() => ({}));

function readBag() {
  try {
    const items = JSON.parse(localStorage.getItem(storageKey) || '[]');
    return normalizeBag(items, catalog);
  } catch { return []; }
}
let bag = readBag();
let checkoutKey = newId();
function saveBag() {
  try { localStorage.setItem(storageKey, JSON.stringify(bag)); } catch { /* The current tab still works if browser storage is unavailable. */ }
  checkoutKey = newId();
  updateBagCount();
}
function updateBagCount() {
  const count = bag.reduce((total, item) => total + item.quantity, 0);
  document.querySelectorAll('[data-cart-count]').forEach(node => { node.textContent = String(count); node.hidden = count === 0; });
  document.querySelector('.cart-link')?.setAttribute('aria-label', `Shopping bag, ${count} ${count === 1 ? 'item' : 'items'}`);
}
updateBagCount();
window.addEventListener('storage', event => { if (event.key === storageKey) { bag = readBag(); updateBagCount(); renderCart(); } });

const menuButton = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#primary-nav');
function closeMenu() { navigation?.removeAttribute('data-open'); menuButton?.setAttribute('aria-expanded', 'false'); menuButton?.setAttribute('aria-label', 'Open menu'); }
menuButton?.addEventListener('click', () => {
  const open = menuButton.getAttribute('aria-expanded') !== 'true';
  menuButton.setAttribute('aria-expanded', String(open));
  menuButton.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  navigation?.toggleAttribute('data-open', open);
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeMenu(); });
document.addEventListener('click', event => { if (event.target instanceof Element && !event.target.closest('.site-header')) closeMenu(); });

let category = 'all';
const searchInput = document.querySelector('[data-shop-search]');
function filterProducts() {
  let visible = 0;
  const search = searchInput?.value.trim().toLowerCase() || '';
  document.querySelectorAll('[data-product-grid] .product-card').forEach(card => {
    const match = (category === 'all' || card.dataset.category === category) && card.dataset.name.includes(search);
    card.hidden = !match;
    if (match) visible++;
  });
  document.querySelectorAll('[data-product-group]').forEach(group => { group.hidden = !group.querySelector('.product-card:not([hidden])'); });
  const empty = document.querySelector('[data-catalog-empty]');
  if (empty) empty.hidden = visible > 0;
}
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  category = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  filterProducts();
}));
searchInput?.addEventListener('input', filterProducts);

const mainPhoto = document.querySelector('[data-main-photo]');
const detailProduct = catalog.get(document.querySelector('[data-product-detail]')?.dataset.productDetail);
const variantSelect = document.querySelector('[data-product-variant]');
function showPhoto(src) {
  if (!mainPhoto) return;
  const settings = detailProduct?.variants?.find(variant => variant.image === src) || detailProduct;
  mainPhoto.src = src;
  mainPhoto.alt = settings?.name || detailProduct?.name || 'Product photograph';
  mainPhoto.style.objectPosition = settings?.imagePosition || '50% 50%';
  mainPhoto.style.objectFit = settings?.imageFit || 'cover';
  mainPhoto.style.transformOrigin = settings?.imageOrigin || settings?.imagePosition || '50% 50%';
  mainPhoto.style.setProperty('--photo-scale', settings?.imageScale || 1);
  document.querySelectorAll('[data-photo-src]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.photoSrc === src)));
}
function updateVariant() {
  const variant = variantFor(detailProduct, variantSelect?.value);
  if (variant) showPhoto(variant.image);
  const caption = document.querySelector('[data-selected-design]');
  if (caption) caption.textContent = variant?.name || detailProduct.color;
  const inquiry = document.querySelector('[data-product-inquiry]');
  if (inquiry) {
    const params = new URLSearchParams({ type: 'product', product: detailProduct.id });
    if (variant) params.set('variant', variant.id);
    inquiry.href = `/project/?${params}`;
  }
}
variantSelect?.addEventListener('change', updateVariant);
document.querySelectorAll('[data-photo-src]').forEach(button => button.addEventListener('click', () => {
  if (button.dataset.photoVariant && variantSelect) { variantSelect.value = button.dataset.photoVariant; updateVariant(); }
  else showPhoto(button.dataset.photoSrc);
}));
const zoomDialog = document.querySelector('[data-zoom-dialog]');
document.querySelector('[data-photo-zoom]')?.addEventListener('click', () => {
  const photo = document.querySelector('[data-zoom-photo]');
  if (mainPhoto && photo && zoomDialog) { photo.src = mainPhoto.src; zoomDialog.showModal(); }
});
document.querySelector('[data-close-zoom]')?.addEventListener('click', () => zoomDialog?.close());
zoomDialog?.addEventListener('click', event => { if (event.target === zoomDialog) zoomDialog.close(); });
document.querySelectorAll('[data-quantity-step]').forEach(button => button.addEventListener('click', () => {
  const input = document.querySelector('#product-quantity');
  if (input) input.value = String(Math.max(1, Math.min(20, (Number(input.value) || 1) + Number(button.dataset.quantityStep))));
}));
document.querySelector('[data-add-product]')?.addEventListener('click', event => {
  const button = event.currentTarget;
  const id = button.dataset.addProduct;
  if (!sellable(catalog.get(id))) return;
  if (variantSelect && !variantSelect.reportValidity()) return;
  const variant = variantFor(catalog.get(id), variantSelect?.value);
  const quantity = Number(document.querySelector('#product-quantity')?.value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) { document.querySelector('#product-quantity')?.reportValidity(); return; }
  const next = { id, quantity, ...(variant ? { variantId: variant.id } : {}) };
  const item = bag.find(item => lineKey(item) === lineKey(next));
  if (item) item.quantity = Math.min(20, item.quantity + quantity); else bag.push(next);
  saveBag();
  const status = document.querySelector('[data-add-status]');
  if (status) {
    status.replaceChildren(document.createTextNode('Added to your bag. '));
    const link = document.createElement('a'); link.href = '/cart/'; link.textContent = 'View your bag →'; link.className = 'text-link'; status.append(link);
  }
});

function renderCart() {
  const container = document.querySelector('[data-cart-items]');
  if (!container) return;
  container.replaceChildren();
  document.querySelector('[data-cart-empty]').hidden = bag.length > 0;
  document.querySelector('[data-cart-layout]').hidden = bag.length === 0;
  let subtotal = 0;
  for (const item of bag) {
    const product = catalog.get(item.id);
    const variant = variantFor(product, item.variantId);
    subtotal += product.priceCents * item.quantity;
    const row = document.createElement('article'); row.className = 'cart-row';
    const image = document.createElement('img'); image.src = variant?.image || product.images[0]; image.alt = variant?.name || product.name; image.style.objectPosition = variant?.imagePosition || product.imagePosition;
    const details = document.createElement('div');
    const heading = document.createElement('h2');
    const link = document.createElement('a'); link.href = `/shop/${product.id}/`; link.textContent = product.name; heading.append(link);
    const line = document.createElement('p'); line.textContent = `Quantity: ${item.quantity} · ${currency(product.priceCents)} each`;
    const design = document.createElement('p'); design.textContent = variant?.name || product.color;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'cart-remove'; remove.textContent = 'Remove'; remove.setAttribute('aria-label', `Remove ${variant?.name || product.name}`);
    remove.addEventListener('click', () => { bag = bag.filter(entry => lineKey(entry) !== lineKey(item)); saveBag(); renderCart(); });
    details.append(heading, design, line, remove);
    const amount = document.createElement('span'); amount.textContent = currency(product.priceCents * item.quantity); amount.style.fontSize = '12px';
    row.append(image, details, amount); container.append(row);
  }
  document.querySelector('[data-cart-subtotal]').textContent = currency(subtotal);
}
renderCart();
const checkoutButton = document.querySelector('[data-checkout]');
if (checkoutButton) {
  configPromise.then(config => {
    checkoutButton.disabled = !config.checkoutEnabled;
    const notice = document.querySelector('[data-checkout-availability]');
    notice.hidden = Boolean(config.checkoutEnabled);
    notice.textContent = 'Online checkout is opening soon. You can ask about a print using the project request form.';
    if (config.checkoutEnabled && !config.shippingEnabled) {
      document.querySelector('[name="cart-fulfillment"][value="shipping"]').disabled = true;
      document.querySelector('[name="cart-fulfillment"][value="pickup"]').checked = true;
    }
  });
  document.querySelectorAll('[name="cart-fulfillment"]').forEach(input => input.addEventListener('change', () => { checkoutKey = newId(); }));
  checkoutButton.addEventListener('click', async () => {
    const error = document.querySelector('[data-cart-error]'); error.hidden = true;
    checkoutButton.disabled = true;
    const originalText = checkoutButton.textContent; checkoutButton.textContent = 'Opening checkout…';
    try {
      const response = await fetch('/api/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: bag, fulfillment: document.querySelector('[name="cart-fulfillment"]:checked')?.value, checkoutKey }) });
      const data = await response.json();
      if (!response.ok) { if (data.code === 'CHECKOUT_EXPIRED') checkoutKey = newId(); throw new Error(data.error || 'Checkout could not be opened. Please try again.'); }
      const url = new URL(data.url);
      if (url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com') throw new Error('Checkout could not be opened. Please try again.');
      window.location.assign(url.href);
    } catch (reason) { error.textContent = reason.message || 'Checkout could not be opened. Please try again.'; error.hidden = false; checkoutButton.disabled = false; checkoutButton.textContent = originalText; }
  });
}

const form = document.querySelector('#project-form');
if (form) {
  const type = form.querySelector('[name="type"]');
  const fileInput = form.querySelector('[name="files"]');
  const productSelect = form.querySelector('[name="productId"]');
  const params = new URLSearchParams(window.location.search);
  if (['print', 'design', 'product'].includes(params.get('type'))) type.value = params.get('type');
  if (catalog.has(params.get('product'))) productSelect.value = params.get('product');
  const requestedVariant = variantFor(catalog.get(params.get('product')), params.get('variant'));
  if (requestedVariant) form.querySelector('[name="preferences"]').value = requestedVariant.name;
  function updateType() {
    form.querySelector('[data-product-field]').hidden = type.value !== 'product';
    productSelect.required = type.value === 'product';
    fileInput.required = type.value === 'print';
    form.querySelector('[data-file-required]').hidden = type.value !== 'print';
  }
  updateType(); type.addEventListener('change', updateType);
  fileInput.addEventListener('change', () => {
    const list = form.querySelector('[data-file-list]'); list.replaceChildren();
    [...fileInput.files].forEach(file => { const item = document.createElement('li'); item.textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`; list.append(item); });
  });
  let turnstileToken = ''; let widgetId; let requestEnabled = false; const requestId = newId();
  const submit = form.querySelector('[data-submit-request]');
  const notice = form.querySelector('[data-request-availability]');
  const error = form.querySelector('[data-form-error]');
  configPromise.then(config => {
    requestEnabled = Boolean(config.requestsEnabled && config.turnstileSiteKey);
    if (!requestEnabled) { notice.textContent = 'Online project requests are opening soon. You can explore the form and browse the collection in the meantime.'; return; }
    notice.hidden = true;
    const script = document.createElement('script'); script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; script.async = true;
    script.onload = () => {
      widgetId = window.turnstile.render('#turnstile-container', {
        sitekey: config.turnstileSiteKey, action: 'project_request',
        callback: token => { turnstileToken = token; submit.disabled = false; },
        'expired-callback': () => { turnstileToken = ''; submit.disabled = true; },
        'error-callback': () => { submit.disabled = true; error.textContent = 'The verification check could not load. Please refresh and try again.'; error.hidden = false; }
      });
    };
    script.onerror = () => { error.textContent = 'The verification check could not load. Please refresh and try again.'; error.hidden = false; };
    document.head.append(script);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); error.hidden = true;
    if (!requestEnabled || !turnstileToken) { error.textContent = 'Please complete the verification check before sending your request.'; error.hidden = false; return; }
    if (!form.reportValidity()) return;
    const files = [...fileInput.files];
    const allowed = /\.(stl|3mf|obj|step|stp|png|jpe?g|pdf)$/i;
    if (files.length > 3 || files.some(file => file.size > 10 * 1024 * 1024 || file.size === 0 || !allowed.test(file.name)) || files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) {
      error.textContent = 'Please choose up to 3 supported files, each no larger than 10 MB and no more than 20 MB in total.'; error.hidden = false; return;
    }
    const data = new FormData(form); data.set('cf-turnstile-response', turnstileToken);
    submit.disabled = true; const originalText = submit.textContent; submit.textContent = 'Sending your request…';
    try {
      const response = await fetch('/api/requests', { method: 'POST', headers: { 'X-Request-ID': requestId }, body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'We could not send your request. Please try again.');
      form.hidden = true; const success = document.querySelector('[data-form-success]'); success.hidden = false;
      success.querySelector('[data-request-reference]').textContent = `Your reference: ${result.reference}`; success.focus();
    } catch (reason) {
      error.textContent = reason.message || 'We could not send your request. Please try again.'; error.hidden = false;
      submit.textContent = originalText; turnstileToken = ''; window.turnstile?.reset(widgetId);
    }
  });
}

if (document.querySelector('[data-order-result]')) {
  const heading = document.querySelector('[data-order-heading]'); const message = document.querySelector('[data-order-message]');
  const session = new URLSearchParams(window.location.search).get('session_id');
  async function checkOrder(attempt = 0) {
    try {
      if (!session) throw new Error();
      const response = await fetch(`/api/orders/status?session_id=${encodeURIComponent(session)}`, { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const order = await response.json();
      if (order.status === 'paid') {
        heading.textContent = 'Good things are on the way.';
        message.textContent = order.fulfillment === 'pickup' ? 'Your payment is confirmed. We’ll let you know when your print is ready and share your Everett pickup instructions.' : 'Your payment is confirmed. We’ll follow up with the preparation and shipping details for your order.';
        bag = []; saveBag(); return;
      }
      if (attempt < 3 && ['created', 'pending'].includes(order.status)) { window.setTimeout(() => checkOrder(attempt + 1), 2000); return; }
      heading.textContent = order.status === 'failed' ? 'Your payment wasn’t completed.' : 'Your payment is still being confirmed.';
      message.textContent = 'Please check your payment provider’s confirmation before placing another order. If you need help, send a project request with your order details.';
    } catch { heading.textContent = 'We couldn’t confirm that order.'; message.textContent = 'Please check your checkout confirmation or contact us through a project request. This page alone does not confirm a payment.'; }
  }
  checkOrder();
}

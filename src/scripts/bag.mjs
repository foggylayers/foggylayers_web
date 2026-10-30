export const sellable = product => product && product.status === 'available' && Number.isInteger(product.priceCents) && product.priceCents >= 50;
export const variantFor = (product, id) => product?.variants?.find(variant => variant.id === id);
export const lineKey = item => `${item.id}:${item.variantId || ''}`;

export function normalizeBag(items, catalog) {
  if (!Array.isArray(items)) return [];
  const merged = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== 'string') continue;
    const product = catalog.get(item.id);
    if (!sellable(product) || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) continue;
    const variant = variantFor(product, item.variantId);
    if ((product.variants?.length && !variant) || (!product.variants?.length && item.variantId)) continue;
    const clean = { id: product.id, quantity: item.quantity, ...(variant ? { variantId: variant.id } : {}) };
    const key = lineKey(clean);
    if (merged.has(key)) merged.get(key).quantity = Math.min(20, merged.get(key).quantity + clean.quantity);
    else if (merged.size < 50) merged.set(key, clean);
  }
  return [...merged.values()];
}

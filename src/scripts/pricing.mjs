// Call with normalized items and the trusted catalog in both the bag and checkout.
export function applyBundlePricing(items, catalog) {
  const priced = items.map(item => ({ ...item, priceCents: catalog.get(item.id).priceCents }));
  const groups = new Map();
  for (const item of priced) {
    delete item.lineTotalCents;
    const bundle = catalog.get(item.id).bundlePricing;
    if (!bundle) continue;
    const key = `${bundle.group}:${bundle.quantity}:${bundle.priceCents}:${item.priceCents}`;
    if (!groups.has(key)) groups.set(key, { bundle, items: [] });
    groups.get(key).items.push(item);
  }
  for (const { bundle, items: group } of groups.values()) {
    const quantity = group.reduce((sum, item) => sum + item.quantity, 0);
    if (quantity < bundle.quantity) continue;
    const total = Math.floor(quantity / bundle.quantity) * bundle.priceCents + (quantity % bundle.quantity) * group[0].priceCents;
    // Allocate whole cents consistently, even across different designs or listings.
    group.sort((a, b) => a.id.localeCompare(b.id) || (a.variantId || '').localeCompare(b.variantId || ''));
    let count = 0;
    let allocated = 0;
    for (const item of group) {
      count += item.quantity;
      const cumulative = Math.floor(total * count / quantity);
      item.lineTotalCents = cumulative - allocated;
      allocated = cumulative;
    }
  }
  return priced;
}

export const cartItemTotal = item => item.lineTotalCents ?? item.priceCents * item.quantity;

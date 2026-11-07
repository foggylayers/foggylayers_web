import test from 'node:test';
import assert from 'node:assert/strict';
import products from '../src/data/products.json' with { type: 'json' };
import { normalizeBag } from '../src/scripts/bag.mjs';
import { applyBundlePricing, cartItemTotal } from '../src/scripts/pricing.mjs';
import { normalizeCart } from '../worker/index.mjs';
const catalog = new Map(products.map(product => [product.id, product]));

test('different designs stay distinct and use the confirmed mini pet price', () => {
  const input = [{id:'mini-animal-figures',variantId:'fox-figure',quantity:2,priceCents:1}, {id:'mini-animal-figures',variantId:'tiger-figure',quantity:1}];
  const bag = normalizeBag(input,catalog);
  assert.equal(bag.length,2);
  const cart = normalizeCart(bag);
  assert.equal(cart.reduce((total,item)=>total+cartItemTotal(item),0),150);
  assert.match(cart[0].name,/Fox/);
  assert.match(cart[1].name,/Tiger/);
  assert.deepEqual(normalizeBag([...input,input[0]],catalog).map(item=>item.quantity),[4,1]);
});
test('mini pet pairs, dozens, and remainders use the advertised prices', () => {
  for (const [quantity, expected] of [[1,50],[2,100],[11,550],[12,500],[13,550],[20,900]]) {
    const input = [{id:'mini-animal-figures',variantId:'fox-figure',quantity,priceCents:1,lineTotalCents:1}];
    const bag = applyBundlePricing(normalizeBag(input,catalog),catalog);
    const cart = normalizeCart(input);
    assert.equal(bag.reduce((sum,item)=>sum+cartItemTotal(item),0),expected);
    assert.equal(cart.reduce((sum,item)=>sum+cartItemTotal(item),0),expected);
  }
});
test('mixed animals and dragons share bundle savings with exact cent totals', () => {
  const input = [
    {id:'mini-dragon-figures',variantId:'black-winged-dragon',quantity:7},
    {id:'mini-animal-figures',variantId:'fox-figure',quantity:5},
    {id:'animal-charms',variantId:'fox-keychain',quantity:1}
  ];
  const bag = applyBundlePricing(normalizeBag(input,catalog),catalog);
  const cart = normalizeCart(input);
  assert.equal(bag.reduce((sum,item)=>sum+cartItemTotal(item),0),700);
  assert.equal(cart.reduce((sum,item)=>sum+cartItemTotal(item),0),700);
  for (const item of cart) {
    const same = bag.find(line=>line.id===item.id && line.variantId===item.variantId);
    assert.equal(cartItemTotal(same),cartItemTotal(item));
  }
  const reordered = normalizeCart([...input].reverse());
  assert.deepEqual(reordered,cart);
});
test('multiple dozens are discounted across separate designs', () => {
  const cart = normalizeCart([
    {id:'mini-animal-figures',variantId:'fox-figure',quantity:12},
    {id:'mini-animal-figures',variantId:'tiger-figure',quantity:12}
  ]);
  assert.equal(cart.reduce((sum,item)=>sum+cartItemTotal(item),0),1000);
});
test('missing, unknown, and injected designs cannot be purchased', () => {
  for(const variantId of [undefined,'fake-design']) {
    const item={id:'mini-animal-figures',quantity:1,variantId};
    assert.deepEqual(normalizeBag([item],catalog),[]);
    assert.throws(()=>normalizeCart([item]),/available design/);
  }
  assert.throws(()=>normalizeCart([{id:'gold-dragon',quantity:1,variantId:'fake-design'}]),/available design/);
  assert.throws(()=>normalizeCart([{id:'forest-vase',quantity:1}]),/not available/);
});

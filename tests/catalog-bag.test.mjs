import test from 'node:test';
import assert from 'node:assert/strict';
import products from '../src/data/products.json' with { type: 'json' };
import { normalizeBag } from '../src/scripts/bag.mjs';
import { normalizeCart } from '../worker/index.mjs';
const catalog = new Map(products.map(product => [product.id, product]));

test('different designs stay distinct and use the confirmed $2 catalog price', () => {
  const input = [{id:'mini-animal-figures',variantId:'fox-figure',quantity:2,priceCents:1}, {id:'mini-animal-figures',variantId:'tiger-figure',quantity:1}];
  const bag = normalizeBag(input,catalog);
  assert.equal(bag.length,2);
  const cart = normalizeCart(bag);
  assert.equal(cart.reduce((total,item)=>total+item.priceCents*item.quantity,0),600);
  assert.match(cart[0].name,/Fox/);
  assert.match(cart[1].name,/Tiger/);
  assert.deepEqual(normalizeBag([...input,input[0]],catalog).map(item=>item.quantity),[4,1]);
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

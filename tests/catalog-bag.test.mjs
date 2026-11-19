import test from 'node:test';
import assert from 'node:assert/strict';
import products from '../src/data/products.json' with { type: 'json' };
import { normalizeBag } from '../src/scripts/bag.mjs';
import { applyBundlePricing, cartItemTotal } from '../src/scripts/pricing.mjs';
import { normalizeCart } from '../worker/index.mjs';
import { normalizePayPalCart } from '../worker/paypal.mjs';
const catalog = new Map(products.map(product => [product.id, product]));

test('different designs stay distinct and use the confirmed mini pet price', () => {
  const input = [{id:'mini-animal-figures',variantId:'fox-figure',quantity:2,priceCents:1}, {id:'mini-animal-figures',variantId:'tiger-figure',quantity:1}];
  const bag = normalizeBag(input,catalog);
  assert.equal(bag.length,2);
  const cart = normalizeCart(bag);
  assert.equal(cart.reduce((total,item)=>total+cartItemTotal(item),0),900);
  assert.match(cart[0].name,/Fox/);
  assert.match(cart[1].name,/Tiger/);
  assert.deepEqual(normalizeBag([...input,input[0]],catalog).map(item=>item.quantity),[4,1]);
});
test('mini pet singles, five-packs, and remainders use the requested prices in every checkout', () => {
  for (const [quantity, expected] of [[1,300],[2,600],[4,1200],[5,2000],[6,2300],[10,4000],[11,4300],[12,4600],[13,4900],[20,8000]]) {
    const input = [{id:'mini-animal-figures',variantId:'fox-figure',quantity,priceCents:1,lineTotalCents:1}];
    const bag = applyBundlePricing(normalizeBag(input,catalog),catalog);
    const cart = normalizeCart(input);
    assert.equal(bag.reduce((sum,item)=>sum+cartItemTotal(item),0),expected);
    assert.equal(cart.reduce((sum,item)=>sum+cartItemTotal(item),0),expected);
    assert.equal(normalizePayPalCart(input).reduce((sum,item)=>sum+cartItemTotal(item),0),expected);
  }
});
test('legacy dragon bags and combined pet designs share bundle pricing with exact cent totals', () => {
  const input = [
    {id:'mini-dragon-figures',variantId:'black-winged-dragon',quantity:7},
    {id:'mini-animal-figures',variantId:'fox-figure',quantity:5},
    {id:'animal-charms',variantId:'fox-keychain',quantity:1}
  ];
  const bag = applyBundlePricing(normalizeBag(input,catalog),catalog);
  const cart = normalizeCart(input);
  assert.equal(bag.reduce((sum,item)=>sum+cartItemTotal(item),0),4800);
  assert.equal(cart.reduce((sum,item)=>sum+cartItemTotal(item),0),4800);
  for (const item of cart) {
    const same = bag.find(line=>line.id===item.id && line.variantId===item.variantId);
    assert.equal(cartItemTotal(same),cartItemTotal(item));
  }
  const reordered = normalizeCart([...input].reverse());
  assert.deepEqual(reordered,cart);
});
test('saved dragon selections move into Mini Pets without losing quantities or bundle pricing', () => {
  const bag = normalizeBag([
    {id:'mini-dragon-figures',variantId:'black-winged-dragon',quantity:3},
    {id:'mini-animal-figures',variantId:'black-winged-dragon',quantity:4},
    {id:'mini-animal-figures',variantId:'fox-figure',quantity:5}
  ],catalog);
  assert.deepEqual(bag.map(item=>[item.id,item.variantId,item.quantity]),[
    ['mini-animal-figures','black-winged-dragon',7],
    ['mini-animal-figures','fox-figure',5]
  ]);
  assert.equal(normalizeCart(bag).reduce((sum,item)=>sum+cartItemTotal(item),0),4600);
});
test('multiple five-packs are priced across separate designs', () => {
  const cart = normalizeCart([
    {id:'mini-animal-figures',variantId:'fox-figure',quantity:12},
    {id:'mini-animal-figures',variantId:'tiger-figure',quantity:12}
  ]);
  assert.equal(cart.reduce((sum,item)=>sum+cartItemTotal(item),0),9200);
});
test('clickers and Holiday Minis apply their own five-pack prices across designs', () => {
  const input = [
    {id:'clicky-fidgets',variantId:'smiling-face',quantity:3,priceCents:1,lineTotalCents:1},
    {id:'clicky-fidgets',variantId:'gift-box-keychain',quantity:2},
    {id:'holiday-minis',variantId:'reindeer',quantity:3},
    {id:'holiday-minis',variantId:'snowman',quantity:2},
    {id:'spiral-fidgets',variantId:'round-cylinder',quantity:2},
    {id:'planetary-gear-fidgets',variantId:'green',quantity:1},
    {id:'gear-cube-fidget',quantity:1}
  ];
  const bag = applyBundlePricing(normalizeBag(input,catalog),catalog);
  const stripe = normalizeCart(input);
  const paypal = normalizePayPalCart(input);
  for (const items of [bag,stripe,paypal]) {
    assert.equal(items.reduce((sum,item)=>sum+cartItemTotal(item),0),4800);
  }
  for (const item of stripe) {
    const browser = bag.find(line=>line.id===item.id && line.variantId===item.variantId);
    const payment = paypal.find(line=>line.id===item.id && line.variantId===item.variantId);
    assert.equal(cartItemTotal(item),cartItemTotal(browser));
    assert.equal(cartItemTotal(item),cartItemTotal(payment));
  }
});
test('separate collections keep their own quantities for bundle pricing', () => {
  const input = [
    {id:'clicky-fidgets',variantId:'smiling-face',quantity:3},
    {id:'holiday-minis',variantId:'reindeer',quantity:2}
  ];
  assert.equal(normalizeCart(input).reduce((sum,item)=>sum+cartItemTotal(item),0),1500);
  assert.equal(normalizePayPalCart(input).reduce((sum,item)=>sum+cartItemTotal(item),0),1500);
});
test('the complete ornament set costs $5 and individual ornaments remain $1 each', () => {
  for (const normalize of [normalizeCart,normalizePayPalCart]) {
    assert.equal(normalize([{id:'grinch-ornament-set',quantity:1}]).reduce((sum,item)=>sum+cartItemTotal(item),0),500);
    assert.equal(normalize([{id:'grinch-star-ornament',quantity:6}]).reduce((sum,item)=>sum+cartItemTotal(item),0),600);
  }
});
test('missing, unknown, and injected designs cannot be purchased', () => {
  for(const variantId of [undefined,'fake-design']) {
    const item={id:'mini-animal-figures',quantity:1,variantId};
    assert.deepEqual(normalizeBag([item],catalog),[]);
    assert.throws(()=>normalizeCart([item]),/available design/);
  }
  assert.throws(()=>normalizeCart([{id:'gold-dragon',quantity:1,variantId:'fake-design'}]),/available design/);
  assert.throws(()=>normalizeCart([{id:'missing-print',quantity:1}]),/not available/);
});
test('every catalog listing has a price and can be added to the bag and both checkouts', () => {
  for (const product of products) {
    assert.ok(Number.isInteger(product.priceCents) && product.priceCents >= 50,product.id);
    const input = [{id:product.id,quantity:1,...(product.variants?.length ? {variantId:product.variants[0].id} : {})}];
    const bag = normalizeBag(input,catalog);
    assert.equal(bag.length,1,product.id);
    for (const normalize of [normalizeCart,normalizePayPalCart]) {
      assert.equal(normalize(bag).reduce((sum,item)=>sum+cartItemTotal(item),0),product.priceCents,product.id);
    }
  }
});

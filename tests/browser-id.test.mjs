import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '../src/scripts/ids.js';
test('the local HTTP preview can generate secure version 4 request IDs without randomUUID', () => {
  const fallback = { getRandomValues: bytes => crypto.getRandomValues(bytes) };
  const id = newId(fallback);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(id, newId(fallback));
});

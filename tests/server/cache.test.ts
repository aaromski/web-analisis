import test from 'node:test';
import assert from 'node:assert/strict';
import { TtlCache, checkRateLimit } from '../../src/lib/server/cache.ts';

test('TtlCache purga entradas caducadas antes de expulsar la más antigua', async () => {
  const cache = new TtlCache<number>(10, 2);
  cache.set('a', 1);
  cache.set('b', 2);
  await new Promise((resolve) => setTimeout(resolve, 25));
  cache.set('c', 3);
  assert.equal(cache.size, 1);
  assert.equal(cache.get('c'), 3);
});

test('TtlCache respeta el máximo cuando no hay caducadas', () => {
  const cache = new TtlCache<number>(60_000, 2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), null);
  assert.equal(cache.get('c'), 3);
});

test('checkRateLimit bloquea al superar el límite y calcula la espera', () => {
  const key = `test:${Date.now()}:${Math.random()}`;
  assert.equal(checkRateLimit(key, 2, 1_000).allowed, true);
  assert.equal(checkRateLimit(key, 2, 1_000).allowed, true);
  const blocked = checkRateLimit(key, 2, 1_000);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1);
});

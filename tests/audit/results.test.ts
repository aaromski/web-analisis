import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadResults, withResult } from '../../src/lib/audit/results.ts';
import type { AggregatedResponse } from '../../src/lib/types/api.ts';

function loadFixture(name: string): AggregatedResponse {
  const path = new URL(`../fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as AggregatedResponse;
}

test('sin archivo de resultados el mapa queda vacío', () => {
  assert.equal(loadResults('data/no-existe.json').size, 0);
});

test('el resultado se inyecta sin cambiar el estado del snapshot', () => {
  const response = loadFixture('derby.json');
  const results = new Map([[response.match.match_id, { home: 2, away: 1 }]]);
  const patched = withResult(response, results);
  assert.deepEqual(patched.match.score, { home: 2, away: 1 });
  assert.equal(patched.match.status, response.match.status);
  assert.equal(withResult(response, new Map()), response);
});

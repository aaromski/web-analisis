import test from 'node:test';
import assert from 'node:assert/strict';
import { requireJson } from '../../src/lib/server/http.ts';

test('requireJson acepta application/json con parámetros', async () => {
  const request = new Request('http://localhost/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: '{}',
  });
  assert.equal(requireJson(request), null);
});

test('requireJson rechaza otros tipos de contenido', async () => {
  const request = new Request('http://localhost/api/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hola',
  });
  const response = requireJson(request);
  assert.ok(response);
  assert.equal(response.status, 415);
  const payload = (await response.json()) as { error?: { code?: string } };
  assert.equal(payload.error?.code, 'UNSUPPORTED_MEDIA_TYPE');
});

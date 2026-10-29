import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMarkdown } from '../../src/lib/server/gemini.ts';

test('cleanMarkdown quita cercas, LaTeX y conserva el markdown', () => {
  assert.equal(cleanMarkdown('```markdown\n## Lectura\n\nTexto\n```'), '## Lectura\n\nTexto');
  assert.equal(cleanMarkdown('$\\lambda$ = 1,51'), 'λ = 1,51');
  assert.equal(cleanMarkdown('2 $\\times$ 1,77'), '2 × 1,77');
});

test('cleanMarkdown deja intacto el markdown ya limpio', () => {
  const input = '## Informe\n\n- Over 1.5 al 84,9 %.\n- Riesgo medio.';
  assert.equal(cleanMarkdown(input), input);
});

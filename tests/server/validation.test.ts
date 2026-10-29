import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMatchInput } from '../../src/lib/server/validation.ts';
import { ValidationError } from '../../src/lib/server/errors.ts';

test('parseMatchInput acepta búsquedas por ID y por equipos', () => {
  assert.deepEqual(parseMatchInput({ matchId: 'espn:401874795' }), { matchId: 'espn:401874795' });
  assert.deepEqual(
    parseMatchInput({ home: ' Inter ', away: 'Milan', date: '2026-10-25', league: 'ita.1' }),
    { home: 'Inter', away: 'Milan', date: '2026-10-25', league: 'ita.1' },
  );
});

test('parseMatchInput rechaza entradas inválidas', () => {
  assert.throws(() => parseMatchInput(null), ValidationError);
  assert.throws(() => parseMatchInput({ home: 'Inter' }), /local y el visitante/);
  assert.throws(() => parseMatchInput({ home: 'Inter', away: 'inter' }), /mismo equipo/);
  assert.throws(
    () => parseMatchInput({ home: 'Inter', away: 'Milan', league: 'Serie A' }),
    /slug/,
  );
  assert.throws(
    () => parseMatchInput({ home: 'Inter', away: 'Milan', date: '2026-02-31' }),
    /fecha/,
  );
  assert.throws(() => parseMatchInput({ matchId: 'id con espacios' }), /caracteres/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PostMatchConflict, PostMatchOutput } from '../../src/lib/types/api.ts';
import { ValidationError } from '../../src/lib/server/errors.ts';
import {
  acceptance,
  canonicalPostPayload,
  completenessOf,
  deriveResult,
  hashPayload,
  isExtraTime,
  parsePostIngestBody,
  sanitizeConflicts,
  stableStringify,
} from '../../src/lib/server/post-ingest.ts';

type FixtureName = 'complete' | 'partial' | 'unavailable';

function load(name: FixtureName): PostMatchOutput {
  const path = fileURLToPath(new URL(`../fixtures/post-match/${name}.json`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as PostMatchOutput;
}

function clone(value: PostMatchOutput): PostMatchOutput {
  return JSON.parse(JSON.stringify(value)) as PostMatchOutput;
}

test('deriveResult deriva 1, X, 2 y el total desde score.ft', () => {
  const draw = deriveResult(load('complete'));
  assert.deepEqual(draw, { home: 4, away: 4, result: 'draw', total: 8 });

  const home = clone(load('complete'));
  home.score.ft = { home: 2, away: 0 };
  assert.deepEqual(deriveResult(home), { home: 2, away: 0, result: 'home', total: 2 });

  const away = clone(load('complete'));
  away.score.ft = { home: 0, away: 3 };
  assert.deepEqual(deriveResult(away), { home: 0, away: 3, result: 'away', total: 3 });
});

test('deriveResult rechaza marcadores ausentes o no enteros', () => {
  const unavailable = load('unavailable');
  assert.equal(deriveResult(unavailable), null);

  const missing = clone(load('complete'));
  missing.score.ft = null;
  assert.equal(deriveResult(missing), null);

  const fractional = clone(load('complete'));
  fractional.score.ft = { home: 1.5, away: 0 };
  assert.equal(deriveResult(fractional), null);

  const negative = clone(load('complete'));
  negative.score.ft = { home: -1, away: 0 };
  assert.equal(deriveResult(negative), null);
});

test('partial con marcador final se acepta y avisa de calibración limitada', () => {
  const partial = load('partial');
  assert.equal(partial.status, 'partial');
  assert.deepEqual(deriveResult(partial), { home: 2, away: 1, result: 'home', total: 3 });

  const check = acceptance(partial);
  assert.equal(check.accepted, true);
  assert.equal(check.calibration, 'limited');
  assert.deepEqual(check.missing, ['xg', 'halves']);
  assert.match(check.reason ?? '', /calibración fina/);
  assert.equal(completenessOf(partial), 'partial');
});

test('unavailable se rechaza', () => {
  const unavailable = load('unavailable');
  const check = acceptance(unavailable);
  assert.equal(check.accepted, false);
  assert.match(check.reason ?? '', /unavailable/);
  assert.equal(deriveResult(unavailable), null);
  assert.equal(completenessOf(unavailable), 'partial');
});

test('un bloque con solo marcador se acepta aunque falten xg y halves', () => {
  const onlyScore = clone(load('complete'));
  onlyScore.status = 'partial';
  onlyScore.totals = null;
  onlyScore.periods = null;
  onlyScore.timeline = [];
  onlyScore.lineups = null;
  onlyScore.players = { home: [], away: [] };
  onlyScore.meta.coverage = {
    sections: { score: true, halves: false, timeline: false, lineups: false, players: false, xg: false },
    available: 1,
    total: 6,
  };

  const check = acceptance(onlyScore);
  assert.equal(check.accepted, true);
  assert.equal(check.calibration, 'limited');
  assert.deepEqual(deriveResult(onlyScore), { home: 4, away: 4, result: 'draw', total: 8 });
});

test('el hash ignora generated_at, deadline, latencias y el orden de sources', () => {
  const base = canonicalPostPayload(load('complete'));
  const baseHash = hashPayload(base);
  assert.match(baseHash, /^[0-9a-f]{64}$/);
  assert.equal('generated_at' in base, false);
  assert.equal('deadline_ms' in base, false);
  assert.equal('timed_out' in base, false);

  const drift = clone(load('complete'));
  drift.generated_at = '2027-01-01T00:00:00.000Z';
  drift.meta.deadline_ms = 3000;
  drift.meta.timed_out = true;
  drift.meta.sources = [...drift.meta.sources].reverse().map((run) => ({
    ...run,
    duration_ms: run.duration_ms + 500,
    detail: 'latencia distinta',
    sections: [...run.sections].reverse(),
  }));

  assert.equal(hashPayload(canonicalPostPayload(drift)), baseHash);

  const changed = clone(load('complete'));
  changed.score.ft = { home: 4, away: 5 };
  assert.notEqual(hashPayload(canonicalPostPayload(changed)), baseHash);
});

test('hashPayload es estable con claves ordenadas y null explícito', () => {
  assert.equal(
    stableStringify({ b: 1, a: undefined, c: [{ z: 1, y: null }] }),
    '{"a":null,"b":1,"c":[{"y":null,"z":1}]}',
  );
  assert.equal(hashPayload({ a: 1, b: 2 }), hashPayload({ b: 2, a: 1 }));
});

test('detecta prórroga para excluir el partido de los modelos a 90 minutos', () => {
  const regular = load('complete');
  assert.equal(isExtraTime(regular), false);
  assert.equal(canonicalPostPayload(regular).extra_time, false);

  const extra = clone(load('complete'));
  extra.timeline = [
    ...extra.timeline,
    { ...extra.timeline[0], minute: 105, period: 'extra_time', score_after: { home: 5, away: 4 } },
  ];
  assert.equal(isExtraTime(extra), true);
  assert.equal(canonicalPostPayload(extra).extra_time, true);
});

test('un conflicto de marcador al descanso se marca y no se persiste', () => {
  const conflict: PostMatchConflict = {
    field: 'score.ht',
    chosen_source: 'fotmob',
    chosen_value: '3-2',
    alternatives: { espn: '2-2' },
  };
  const withConflict = clone(load('complete'));
  withConflict.meta.conflicts = [conflict];
  withConflict.meta.warnings = ['Conflicto de descanso entre fuentes.'];

  const sanitized = sanitizeConflicts(withConflict);
  assert.deepEqual(sanitized.dropped, ['score.ht']);
  assert.equal(sanitized.post.score.ht, null);
  assert.equal(sanitized.post.score.ft?.home, 4);
  assert.ok(
    sanitized.post.meta.warnings.some((warning) => warning.includes('score.ht')),
    'el conflicto debe reportarse como warning',
  );

  const payload = canonicalPostPayload(sanitized.post);
  assert.equal(payload.score.ht, null);
  assert.ok(payload.warnings.some((warning) => warning.includes('score.ht')));
  assert.deepEqual(deriveResult(sanitized.post), { home: 4, away: 4, result: 'draw', total: 8 });
});

test('un conflicto de marcador final deja el bloque sin resultado', () => {
  const withConflict = clone(load('complete'));
  withConflict.meta.conflicts = [
    {
      field: 'score.ft',
      chosen_source: 'fotmob',
      chosen_value: '4-4',
      alternatives: { espn: '4-5' },
    },
  ];

  const sanitized = sanitizeConflicts(withConflict);
  assert.deepEqual(sanitized.dropped, ['score.ft']);
  assert.equal(deriveResult(sanitized.post), null);
});

test('la proyección canónica ordena jugadores, warnings y redondea métricas', () => {
  const post = clone(load('complete'));
  post.players.home = [...post.players.home].reverse();
  post.meta.warnings = ['b warning', 'a warning', 'b warning'];
  post.totals = { home: { xg: 3.88142, xga: 1.94731 }, away: { xg: 1.94731, xga: 3.88142 } };
  post.periods = post.periods
    ? {
        first_half: post.periods.first_half
          ? {
              home: { ...post.periods.first_half.home, possession_pct: 46.3849 },
              away: post.periods.first_half.away,
            }
          : null,
        second_half: post.periods.second_half,
      }
    : null;

  const payload = canonicalPostPayload(post);
  assert.deepEqual(
    payload.players.home.map((player) => player.player_id),
    ['fotmob:204087', 'fotmob:248871'],
  );
  assert.deepEqual(payload.warnings, ['a warning', 'b warning']);
  assert.equal(payload.totals?.home.xg, 3.881);
  assert.equal(payload.totals?.home.xga, 1.947);
  assert.equal(payload.periods?.first_half?.home.possession_pct, 46.38);
  assert.equal(payload.sources[0].source, 'espn');
  assert.equal(payload.sources[1].source, 'fotmob');
});

test('parsePostIngestBody exige un id válido', () => {
  assert.deepEqual(parsePostIngestBody({ id: 'espn:401874972' }), { matchId: 'espn:401874972' });
  assert.deepEqual(parsePostIngestBody({ id: '  espn:401874972  ' }), { matchId: 'espn:401874972' });
  assert.throws(() => parsePostIngestBody(null), ValidationError);
  assert.throws(() => parsePostIngestBody([]), ValidationError);
  assert.throws(() => parsePostIngestBody({}), /campo "id"/);
  assert.throws(() => parsePostIngestBody({ id: '   ' }), /campo "id"/);
  assert.throws(() => parsePostIngestBody({ id: 'id con espacios' }), /caracteres/);
});

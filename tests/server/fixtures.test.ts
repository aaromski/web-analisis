import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isFixtureDate,
  madridDayKey,
  madridToday,
  mapScoreboard,
} from '../../src/lib/server/espn-fixtures.ts';

function loadFixture(): unknown {
  const path = new URL('../fixtures/espn-scoreboard.json', import.meta.url);
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

test('mapScoreboard filtra por fecha de Madrid y normaliza los partidos', () => {
  const matches = mapScoreboard(loadFixture(), '2026-11-07');
  assert.deepEqual(
    matches.map((match) => match.id),
    ['espn:401878758', 'espn:401878760', 'espn:401878700', 'espn:401878799'],
  );

  const finished = matches.find((match) => match.id === 'espn:401878758');
  assert.ok(finished);
  assert.equal(finished.home, 'Leeds United');
  assert.equal(finished.away, 'Tottenham Hotspur');
  assert.equal(finished.status, 'finished');
  assert.equal(finished.statusLabel, 'Finalizado');
  assert.equal(finished.homeScore, 2);
  assert.equal(finished.awayScore, 1);
  assert.equal(finished.venue, 'Elland Road');

  const scheduled = matches.find((match) => match.id === 'espn:401878760');
  assert.ok(scheduled);
  assert.equal(scheduled.status, 'scheduled');
  assert.equal(scheduled.statusLabel, 'Programado');

  const postponed = matches.find((match) => match.id === 'espn:401878799');
  assert.ok(postponed);
  assert.equal(postponed.status, 'other');
  assert.equal(postponed.statusLabel, 'PPD');
});

test('mapScoreboard descarta eventos de otra jornada y sin ambos equipos', () => {
  const matches = mapScoreboard(loadFixture(), '2026-11-07');
  assert.ok(!matches.some((match) => match.home === 'Late Home'));
  assert.ok(!matches.some((match) => match.home === 'Solo Home'));
});

test('mapScoreboard tolera payloads inválidos', () => {
  assert.deepEqual(mapScoreboard(null, '2026-11-07'), []);
  assert.deepEqual(mapScoreboard({}, '2026-11-07'), []);
  assert.deepEqual(mapScoreboard({ events: 'nope' }, '2026-11-07'), []);
});

test('madridDayKey respeta el cambio de día en Madrid', () => {
  assert.equal(madridDayKey('2026-11-06T23:30:00Z'), '2026-11-07');
  assert.equal(madridDayKey('2026-11-07T22:59:59Z'), '2026-11-07');
  assert.equal(madridDayKey('2026-11-07T23:00:00Z'), '2026-11-08');
  assert.equal(madridDayKey('no-es-fecha'), null);
});

test('madridToday usa la fecha de Madrid', () => {
  assert.equal(madridToday(new Date('2026-11-07T23:30:00Z')), '2026-11-08');
  assert.equal(madridToday(new Date('2026-11-07T10:00:00Z')), '2026-11-07');
});

test('isFixtureDate valida fechas de calendario', () => {
  assert.equal(isFixtureDate('2026-11-07'), true);
  assert.equal(isFixtureDate('2026-02-31'), false);
  assert.equal(isFixtureDate('07/11/2026'), false);
});

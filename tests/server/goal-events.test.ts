import test from 'node:test';
import assert from 'node:assert/strict';
import {
  goalEventRows,
  goalEventsFromTimeline,
  type GoalTeams,
} from '../../src/lib/server/goal-events.ts';
import type { PostMatchEvent } from '../../src/lib/types/api.ts';

const TEAMS: GoalTeams = {
  homeTeamId: 'team-home',
  awayTeamId: 'team-away',
  homeName: 'Local FC',
  awayName: 'Visitante FC',
};

function event(partial: Partial<PostMatchEvent> & Pick<PostMatchEvent, 'minute' | 'type'>): PostMatchEvent {
  return {
    added_time: null,
    period: 'first_half',
    side: 'home',
    player_id: null,
    player_name: null,
    assist_id: null,
    assist_name: null,
    player_in_id: null,
    player_in_name: null,
    player_out_id: null,
    player_out_name: null,
    score_after: null,
    detail: null,
    ...partial,
  };
}

test('extrae solo goles y conserva la posición original del timeline', () => {
  const timeline: PostMatchEvent[] = [
    event({ minute: 8, type: 'yellow_card', side: 'away' }),
    event({
      minute: 23,
      type: 'goal',
      side: 'home',
      player_id: 'p1',
      player_name: 'Ana',
      assist_name: 'Bea',
      score_after: { home: 1, away: 0 },
    }),
    event({ minute: 30, type: 'substitution', side: 'home' }),
    event({
      minute: 67,
      type: 'penalty_goal',
      side: 'away',
      score_after: { home: 1, away: 1 },
    }),
  ];

  const rows = goalEventsFromTimeline(timeline, TEAMS);
  assert.equal(rows.length, 2);

  assert.deepEqual(
    { seq: rows[0].seq, minute: rows[0].minute, event_type: rows[0].event_type },
    { seq: 1, minute: 23, event_type: 'goal' },
  );
  assert.equal(rows[0].credited_side, 'home');
  assert.equal(rows[0].team_id, 'team-home');
  assert.equal(rows[0].opponent_team_id, 'team-away');
  assert.equal(rows[0].team_name, 'Local FC');
  assert.deepEqual(
    { home: rows[0].score_home_after, away: rows[0].score_away_after },
    { home: 1, away: 0 },
  );
  assert.equal(rows[0].player_name, 'Ana');
  assert.equal(rows[0].assist_name, 'Bea');

  assert.deepEqual(
    { seq: rows[1].seq, minute: rows[1].minute, event_type: rows[1].event_type },
    { seq: 3, minute: 67, event_type: 'penalty_goal' },
  );
  assert.equal(rows[1].credited_side, 'away');
  assert.equal(rows[1].team_id, 'team-away');
  assert.equal(rows[1].team_name, 'Visitante FC');
});

test('el gol en propia se acredita al lado del evento aunque score_after venga invertido', () => {
  const rows = goalEventsFromTimeline(
    [
      event({
        minute: 12,
        type: 'own_goal',
        side: 'home',
        player_name: 'Defensa Local',
        score_after: { home: 0, away: 1 },
      }),
    ],
    TEAMS,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].side, 'home');
  assert.equal(rows[0].event_type, 'own_goal');
  assert.equal(rows[0].credited_side, 'home');
  assert.equal(rows[0].team_id, 'team-home');
  assert.equal(rows[0].opponent_team_id, 'team-away');
  assert.equal(rows[0].team_name, 'Local FC');
  assert.deepEqual(
    { home: rows[0].score_home_after, away: rows[0].score_away_after },
    { home: 1, away: 0 },
  );
});

test('un gol en propia sin marcador conserva el lado del evento', () => {
  const rows = goalEventsFromTimeline(
    [event({ minute: 55, type: 'own_goal', side: 'away', player_name: 'Defensa Visita' })],
    TEAMS,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].side, 'away');
  assert.equal(rows[0].credited_side, 'away');
  assert.equal(rows[0].team_id, 'team-away');
  assert.equal(rows[0].team_name, 'Visitante FC');
  assert.deepEqual(
    { home: rows[0].score_home_after, away: rows[0].score_away_after },
    { home: 0, away: 1 },
  );
});

test('un evento sin lado ni marcador se descarta', () => {
  const rows = goalEventsFromTimeline(
    [event({ minute: 33, type: 'own_goal', side: null })],
    TEAMS,
  );

  assert.deepEqual(rows, []);
});

test('acumula el marcador aunque un gol intermedio no traiga score_after', () => {
  const rows = goalEventsFromTimeline(
    [
      event({ minute: 12, type: 'goal', side: 'home' }),
      event({
        minute: 40,
        type: 'goal',
        side: 'away',
        score_after: { home: 1, away: 1 },
      }),
    ],
    TEAMS,
  );

  assert.equal(rows.length, 2);
  assert.equal(rows[0].credited_side, 'home');
  assert.deepEqual(
    { home: rows[0].score_home_after, away: rows[0].score_away_after },
    { home: 1, away: 0 },
  );
  assert.equal(rows[1].credited_side, 'away');
  assert.deepEqual(
    { home: rows[1].score_home_after, away: rows[1].score_away_after },
    { home: 1, away: 1 },
  );
});

test('un evento sin lado resuelve el crédito por el delta del marcador', () => {
  const rows = goalEventsFromTimeline(
    [event({ minute: 71, type: 'goal', side: null, score_after: { home: 0, away: 1 } })],
    TEAMS,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].credited_side, 'away');
  assert.equal(rows[0].side, 'away');
  assert.equal(rows[0].team_id, 'team-away');
});

test('descarta minutos inválidos y conserva la prórroga con su periodo', () => {
  const rows = goalEventsFromTimeline(
    [
      event({ minute: 0, type: 'goal', side: 'home' }),
      event({
        minute: 105,
        type: 'goal',
        side: 'away',
        period: 'extra_time',
        added_time: 2,
        score_after: { home: 0, away: 1 },
      }),
    ],
    TEAMS,
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].minute, 105);
  assert.equal(rows[0].period, 'extra_time');
  assert.equal(rows[0].added_time, 2);
  assert.equal(rows[0].credited_side, 'away');
});

test('un timeline vacío o nulo no genera filas', () => {
  assert.deepEqual(goalEventsFromTimeline([], TEAMS), []);
  assert.deepEqual(goalEventsFromTimeline(null, TEAMS), []);
  assert.deepEqual(goalEventsFromTimeline(undefined, TEAMS), []);
});

test('goalEventRows añade el snapshot y el partido a cada fila', () => {
  const rows = goalEventRows({
    snapshotId: '11111111-1111-4111-8111-111111111111',
    matchId: 'test:900001',
    timeline: [
      event({ minute: 5, type: 'goal', side: 'away', score_after: { home: 0, away: 1 } }),
    ],
    ...TEAMS,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].snapshot_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(rows[0].match_id, 'test:900001');
  assert.equal(rows[0].credited_side, 'away');
});

test('sin team_id el crédito se conserva y los campos de equipo quedan nulos', () => {
  const rows = goalEventsFromTimeline(
    [event({ minute: 5, type: 'goal', side: 'home', score_after: { home: 1, away: 0 } })],
    { homeName: 'Local FC', awayName: 'Visitante FC' },
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].credited_side, 'home');
  assert.equal(rows[0].team_id, null);
  assert.equal(rows[0].opponent_team_id, null);
  assert.equal(rows[0].team_name, 'Local FC');
});

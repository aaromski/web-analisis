import type { AggregatedResponse, PreMatchTeam } from '../types/api';
import type { LineupInfo, MatchContext, TeamStanding } from '../types/analysis';
import { lineupAverageRating, pointsPerMatch } from './adjustments';
import { americanToNoVig, extractSpreadMarket, extractTotalsMarket, extractWinMarket } from './odds';

function lineupInfo(team: PreMatchTeam | undefined): LineupInfo | null {
  const lineup = team?.lineup;
  if (!lineup) return null;
  return {
    status: lineup.status ?? null,
    starters: lineup.starters?.length ?? null,
    unavailable: lineup.unavailable?.length ?? 0,
    averageRating: lineupAverageRating(team),
  };
}

function standingInfo(team: PreMatchTeam | undefined): TeamStanding | null {
  const standings = team?.standings;
  if (!standings) return null;
  return {
    rank: standings.rank ?? null,
    points: standings.points ?? null,
    played: standings.played ?? null,
    ppg: pointsPerMatch(team),
  };
}

function normalizedPredictionResult(
  result: { home: number | null; draw: number | null; away: number | null } | null | undefined,
): { home: number | null; draw: number | null; away: number | null } {
  if (!result) return { home: null, draw: null, away: null };
  const values = [result.home, result.draw, result.away];
  if (values.some((value) => value === null || !Number.isFinite(value) || (value as number) < 0)) {
    return { home: result.home, draw: result.draw, away: result.away };
  }
  const total = values.reduce<number>((sum, value) => sum + (value as number), 0);
  if (total <= 0) return { home: result.home, draw: result.draw, away: result.away };
  return {
    home: (result.home as number) / total,
    draw: (result.draw as number) / total,
    away: (result.away as number) / total,
  };
}

export function buildContext(response: AggregatedResponse): MatchContext {
  const pre = response.pre_match ?? null;
  const win = extractWinMarket(pre);
  const totals = extractTotalsMarket(pre);
  const spread = extractSpreadMarket(pre);
  const prediction = pre?.prediction ?? null;

  const homeRecent = pre?.teams?.home?.recent_form?.results;
  const awayRecent = pre?.teams?.away?.recent_form?.results;
  const homeFormEntries = pre?.teams?.home?.form ?? [];
  const awayFormEntries = pre?.teams?.away?.form ?? [];
  const homeFormString =
    homeRecent?.form ??
    (homeFormEntries.length > 0 ? homeFormEntries.map((entry) => entry.result ?? '?').join('') : null);
  const awayFormString =
    awayRecent?.form ??
    (awayFormEntries.length > 0 ? awayFormEntries.map((entry) => entry.result ?? '?').join('') : null);

  const injuries: MatchContext['injuries'] = [];
  for (const side of ['home', 'away'] as const) {
    const unavailable = pre?.teams?.[side]?.lineup?.unavailable ?? [];
    for (const player of unavailable) {
      injuries.push({
        side,
        name: player.name,
        status: player.status ?? 'unavailable',
        reason: player.reason ?? player.unavailability_type ?? null,
      });
    }
  }

  return {
    referee: pre?.referee
      ? { name: pre.referee.name, cardsPerMatch: pre.referee.yellow_cards_per_match ?? null }
      : null,
    weather: pre?.weather
      ? {
          description: pre.weather.description,
          temperatureC: pre.weather.temperature_c,
          precipitationPct: pre.weather.precipitation_chance_pct,
          windSpeed: pre.weather.wind_speed ?? null,
        }
      : null,
    prediction: prediction
      ? {
          model: prediction.model ?? null,
          confidence: prediction.confidence ?? null,
          result: normalizedPredictionResult(prediction.match_result),
          expectedGoals: {
            home: prediction.expected_goals?.home ?? null,
            away: prediction.expected_goals?.away ?? null,
          },
          mostLikelyScore: prediction.most_likely_score ?? null,
          bttsYes: prediction.btts?.yes ?? null,
          overUnder: (prediction.over_under ?? []).map((entry) => ({
            line: entry.line,
            probability: entry.probability,
          })),
          corners: (prediction.corners ?? []).map((entry) => ({
            line: entry.line,
            probability: entry.probability,
          })),
        }
      : null,
    lineups:
      pre?.teams?.home?.lineup || pre?.teams?.away?.lineup
        ? { home: lineupInfo(pre?.teams?.home), away: lineupInfo(pre?.teams?.away) }
        : null,
    rest:
      pre?.teams?.home?.rest_days || pre?.teams?.away?.rest_days
        ? {
            home: pre?.teams?.home?.rest_days ?? null,
            away: pre?.teams?.away?.rest_days ?? null,
          }
        : null,
    standings:
      pre?.teams?.home?.standings || pre?.teams?.away?.standings
        ? { home: standingInfo(pre?.teams?.home), away: standingInfo(pre?.teams?.away) }
        : null,
    recentForm:
      homeRecent || awayRecent || homeFormEntries.length > 0 || awayFormEntries.length > 0
        ? {
            home: {
              form: homeFormString,
              goalsFor: homeRecent?.goals_for ?? null,
              goalsAgainst: homeRecent?.goals_against ?? null,
              matches: homeRecent?.matches ?? null,
            },
            away: {
              form: awayFormString,
              goalsFor: awayRecent?.goals_for ?? null,
              goalsAgainst: awayRecent?.goals_against ?? null,
              matches: awayRecent?.matches ?? null,
            },
          }
        : null,
    injuries: injuries.slice(0, 10),
    h2h: pre?.h2h
      ? {
          summary: pre.h2h.summary ?? null,
          totalMatches: pre.h2h.aggregate?.total_matches ?? null,
        }
      : null,
    odds: pre?.odds
      ? {
          provider: pre.odds.provider ?? null,
          providerCount: pre.odds.provider_count ?? null,
          capturedAt: pre.odds.captured_at ?? null,
          moneylineNoVig:
            win && win.source === 'odds' ? { home: win.home, draw: win.draw, away: win.away } : null,
          totalsLine: totals.line,
          totalsOverNoVig: totals.over,
          spreadLine: spread.line,
          openTotalLine: pre.odds.open?.total ?? null,
          openMoneylineNoVig: americanToNoVig(pre.odds.open),
          movement: pre.odds.movement
            ? {
                home: pre.odds.movement.home ?? null,
                draw: pre.odds.movement.draw ?? null,
                away: pre.odds.movement.away ?? null,
              }
            : null,
        }
      : null,
    venue: pre?.venue || response.match?.venue
      ? {
          name: pre?.venue?.name ?? response.match?.venue ?? null,
          city: pre?.venue?.city ?? null,
          country: pre?.venue?.country ?? null,
        }
      : null,
    insights: (pre?.insights ?? []).slice(0, 6).map((insight) => insight.text),
  };
}

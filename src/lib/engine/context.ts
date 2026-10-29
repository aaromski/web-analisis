import type { AggregatedResponse } from '../types/api';
import type { MatchContext } from '../types/analysis';
import { extractSpreadMarket, extractTotalsMarket, extractWinMarket } from './odds';

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
        }
      : null,
    prediction: prediction
      ? {
          model: prediction.model ?? null,
          result: normalizedPredictionResult(prediction.match_result),
          expectedGoals: {
            home: prediction.expected_goals?.home ?? null,
            away: prediction.expected_goals?.away ?? null,
          },
          mostLikelyScore: prediction.most_likely_score ?? null,
          bttsYes: prediction.btts?.yes ?? null,
        }
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
          capturedAt: pre.odds.captured_at ?? null,
          moneylineNoVig:
            win && win.source === 'odds' ? { home: win.home, draw: win.draw, away: win.away } : null,
          totalsLine: totals.line,
          totalsOverNoVig: totals.over,
          spreadLine: spread.line,
        }
      : null,
    insights: (pre?.insights ?? []).slice(0, 6).map((insight) => insight.text),
  };
}

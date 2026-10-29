import type { PreMatchPayload, OddsPrice } from '../types/api';
import { clamp } from './poisson';

function priceProbability(price: OddsPrice | null | undefined): number | null {
  if (!price) return null;
  const value = price.no_vig_probability ?? price.implied_probability;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function normalize(values: Array<number | null>): number[] | null {
  if (values.some((value) => value === null || !Number.isFinite(value) || value <= 0)) return null;
  const total = values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  if (total <= 0) return null;
  return values.map((value) => clamp((value ?? 0) / total, 0, 1));
}

export interface WinMarket {
  home: number;
  draw: number;
  away: number;
  source: 'odds' | 'prediction';
}

/** 1X2 de referencia: cuotas sin vig (preferido) o predicción externa. */
export function extractWinMarket(preMatch?: PreMatchPayload | null): WinMarket | null {
  const moneyline = preMatch?.odds?.moneyline;
  if (moneyline) {
    const normalized = normalize([
      priceProbability(moneyline.home),
      priceProbability(moneyline.draw),
      priceProbability(moneyline.away),
    ]);
    if (normalized) {
      return { home: normalized[0], draw: normalized[1], away: normalized[2], source: 'odds' };
    }
  }

  const prediction = preMatch?.prediction?.match_result;
  if (prediction) {
    const values = [prediction.home, prediction.draw, prediction.away];
    const normalized = normalize(values);
    if (normalized) {
      return { home: normalized[0], draw: normalized[1], away: normalized[2], source: 'prediction' };
    }
  }
  return null;
}

export interface TotalsMarket {
  line: number | null;
  over: number | null;
  under: number | null;
}

export function extractTotalsMarket(preMatch?: PreMatchPayload | null): TotalsMarket {
  const totals = preMatch?.odds?.totals;
  if (!totals) return { line: null, over: null, under: null };
  const over = priceProbability(totals.over);
  const under = priceProbability(totals.under);
  if (over !== null && under !== null) {
    const normalized = normalize([over, under]);
    if (normalized) return { line: totals.line, over: normalized[0], under: normalized[1] };
  }
  return { line: totals.line, over, under };
}

export interface SpreadMarket {
  line: number | null;
  home: number | null;
  away: number | null;
}

export function extractSpreadMarket(preMatch?: PreMatchPayload | null): SpreadMarket {
  const spread = preMatch?.odds?.spread;
  if (!spread) return { line: null, home: null, away: null };
  const home = priceProbability(spread.home);
  const away = priceProbability(spread.away);
  if (home !== null && away !== null) {
    const normalized = normalize([home, away]);
    if (normalized) return { line: spread.line, home: normalized[0], away: normalized[1] };
  }
  return { line: spread.line, home, away };
}

export function extractCornersLine(preMatch?: PreMatchPayload | null): number | null {
  const market = preMatch?.odds?.extra_markets?.find((item) => item.market === 'corners');
  return market?.line ?? null;
}

export function hasOdds(preMatch?: PreMatchPayload | null): boolean {
  const odds = preMatch?.odds;
  if (!odds) return false;
  return Boolean(odds.moneyline || odds.totals || odds.spread || odds.extra_markets?.length);
}

/** Acuerdo 0–1 entre el 1X2 del modelo y la referencia externa. */
export function modelAgreement(
  model: { home: number; draw: number; away: number },
  external: WinMarket | null,
): number {
  if (!external) return 0.5;
  const mad =
    (Math.abs(model.home - external.home) +
      Math.abs(model.draw - external.draw) +
      Math.abs(model.away - external.away)) /
    3;
  return clamp(1 - mad / 0.18, 0, 1);
}

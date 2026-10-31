import type { PreMatchPayload, OddsPrice, PreMatchPredictionLine } from '../types/api';
import type { MarketSignal } from '../types/analysis';
import { clamp } from './poisson';

/** Cuota americana a probabilidad implícita. */
export function americanToProbability(american: number | null | undefined): number | null {
  if (american === null || american === undefined || !Number.isFinite(american) || american === 0) return null;
  const probability = american > 0 ? 100 / (american + 100) : -american / (-american + 100);
  return Number.isFinite(probability) && probability > 0 ? probability : null;
}

export function americanToNoVig(
  open: { home_american: number | null; draw_american: number | null; away_american: number | null } | null | undefined,
): { home: number; draw: number; away: number } | null {
  if (!open) return null;
  const normalized = normalize([
    americanToProbability(open.home_american),
    americanToProbability(open.draw_american),
    americanToProbability(open.away_american),
  ]);
  if (!normalized) return null;
  return { home: normalized[0], draw: normalized[1], away: normalized[2] };
}

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

/** Línea de la predicción externa cuya probabilidad está más cerca de 50 %. */
export function pickBalancedLine(lines: PreMatchPredictionLine[] | null | undefined): PreMatchPredictionLine | null {
  if (!lines || lines.length === 0) return null;
  let best: PreMatchPredictionLine | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (typeof line.line !== 'number' || line.probability === null) continue;
    if (!Number.isFinite(line.probability) || line.probability <= 0 || line.probability >= 1) continue;
    const distance = Math.abs(line.probability - 0.5);
    if (distance < bestDistance) {
      best = line;
      bestDistance = distance;
    }
  }
  return best;
}

export interface ExtraMarketOutcome {
  label: string;
  probability: number | null;
  decimal: number | null;
}

export interface ExtraMarket {
  market: string;
  line: number | null;
  outcomes: ExtraMarketOutcome[];
}

/**
 * Mercados extra normalizados (BTTS, doble oportunidad, córners, etc.). Las
 * probabilidades se normalizan por mercado para eliminar el margen.
 */
export function extractExtraMarkets(preMatch?: PreMatchPayload | null): ExtraMarket[] {
  const markets = preMatch?.odds?.extra_markets ?? [];
  return markets.map((market) => {
    const raw = market.outcomes.map((outcome) => {
      const probability =
        typeof outcome.implied_probability === 'number' &&
        Number.isFinite(outcome.implied_probability) &&
        outcome.implied_probability > 0
          ? outcome.implied_probability
          : null;
      return { label: outcome.label, probability, decimal: outcome.decimal ?? null };
    });
    const normalized = normalize(raw.map((outcome) => outcome.probability));
    return {
      market: market.market,
      line: market.line,
      outcomes: raw.map((outcome, index) => ({
        label: outcome.label,
        probability: normalized ? normalized[index] : outcome.probability,
        decimal: outcome.decimal,
      })),
    };
  });
}

/** Señal vacía para partidos sin datos de apertura ni movimiento. */
export const EMPTY_MARKET_SIGNAL: MarketSignal = {
  openTotalLine: null,
  currentTotalLine: null,
  totalLineDrift: null,
  openMoneylineNoVig: null,
  currentMoneylineNoVig: null,
  moneylineDrift: null,
  movement: null,
  providerCount: null,
};

/**
 * Señal de movimiento: apertura vs estado actual. Un drift grande o varios
 * proveedores indican un precio más informativo y justifican dar algo más de
 * peso al ancla.
 */
export function buildMarketSignal(preMatch?: PreMatchPayload | null): MarketSignal | null {
  const odds = preMatch?.odds;
  if (!odds) return null;
  const totals = extractTotalsMarket(preMatch);
  const openTotalLine = odds.open?.total ?? null;
  const openMoneyline = americanToNoVig(odds.open);
  const current = extractWinMarket(preMatch);
  const currentMoneyline =
    current && current.source === 'odds' ? { home: current.home, draw: current.draw, away: current.away } : null;
  const totalLineDrift =
    openTotalLine !== null && totals.line !== null ? Math.round((totals.line - openTotalLine) * 100) / 100 : null;
  const moneylineDrift =
    openMoneyline && currentMoneyline
      ? {
          home: Math.round((currentMoneyline.home - openMoneyline.home) * 1000) / 1000,
          draw: Math.round((currentMoneyline.draw - openMoneyline.draw) * 1000) / 1000,
          away: Math.round((currentMoneyline.away - openMoneyline.away) * 1000) / 1000,
        }
      : null;
  if (openMoneyline === null && openTotalLine === null && !odds.movement && !odds.provider_count) return null;
  return {
    openTotalLine,
    currentTotalLine: totals.line,
    totalLineDrift,
    openMoneylineNoVig: openMoneyline,
    currentMoneylineNoVig: currentMoneyline,
    moneylineDrift,
    movement: odds.movement
      ? {
          home: odds.movement.home ?? null,
          draw: odds.movement.draw ?? null,
          away: odds.movement.away ?? null,
        }
      : null,
    providerCount: odds.provider_count ?? null,
  };
}

/** Multiplicador del peso del ancla según movimiento y proveedores. */
export function movementWeightScale(signal: MarketSignal | null): number {
  if (!signal) return 1;
  const drift = Math.abs(signal.totalLineDrift ?? 0);
  const providerBoost = (signal.providerCount ?? 0) >= 3 ? 0.05 : 0;
  return clamp(1 + clamp(drift * 0.12, 0, 0.1) + providerBoost, 0.95, 1.12);
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Busca un mercado extra por alias y devuelve la probabilidad normalizada de la
 * selección cuyo alias aparezca en su nombre. Tolera variantes de proveedor.
 */
export function extraMarketProbability(
  markets: ExtraMarket[],
  marketAliases: string[],
  labelAliases: string[],
): number | null {
  const normalizedMarket = marketAliases.map(normalizeLabel);
  const target = markets.find((market) => {
    const name = normalizeLabel(market.market.replace(/_/g, ' '));
    return normalizedMarket.some((alias) => name.includes(alias));
  });
  if (!target) return null;
  const normalizedLabels = labelAliases.map(normalizeLabel);
  const outcome = target.outcomes.find((candidate) => {
    const label = normalizeLabel(candidate.label);
    return normalizedLabels.some((alias) => label.includes(alias));
  });
  return outcome?.probability ?? null;
}

/** Línea del mercado extra de córners, si existe. */
export function extraCornersMarket(preMatch?: PreMatchPayload | null): { line: number | null; over: number | null; under: number | null } {
  const markets = extractExtraMarkets(preMatch);
  const target = markets.find((market) => normalizeLabel(market.market).includes('corner'));
  if (!target) return { line: null, over: null, under: null };
  const over = extraMarketProbability([target], ['corner'], ['over', 'mas', 'more']);
  const under = extraMarketProbability([target], ['corner'], ['under', 'menos', 'less']);
  return { line: target.line, over, under };
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

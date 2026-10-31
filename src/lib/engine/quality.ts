import type { AggregatedResponse, CanonicalStat, StatStatus, TeamPayload } from '../types/api';
import type { DataQuality } from '../types/analysis';
import { clamp } from './poisson';

export interface StatDetail {
  value: number | null;
  /** 0–1: observed=1, projected=0.65, missing=0; derivada resta 15 %. */
  confidence: number;
  status: StatStatus;
  source: string | null;
  derived: boolean;
}

export const KEY_STATS = [
  'xg',
  'xga',
  'goals_scored',
  'goals_conceded',
  'shots_on_target',
  'corners',
  'big_chances_created',
  'possession_pct',
] as const;

export function statDetail(team: TeamPayload | undefined, key: string): StatDetail {
  const stat: CanonicalStat | undefined = team?.stats?.[key];
  if (!stat || stat.status === 'missing') {
    return { value: null, confidence: 0, status: 'missing', source: stat?.source ?? null, derived: Boolean(stat?.derived) };
  }
  if (typeof stat.value !== 'number' || !Number.isFinite(stat.value)) {
    return { value: null, confidence: 0, status: stat.status, source: stat.source ?? null, derived: Boolean(stat.derived) };
  }
  const base = stat.status === 'observed' ? 1 : stat.status === 'projected' ? 0.65 : 0;
  return {
    value: stat.value,
    confidence: base * (stat.derived ? 0.85 : 1),
    status: stat.status,
    source: stat.source ?? null,
    derived: Boolean(stat.derived),
  };
}

export function statNumber(team: TeamPayload | undefined, key: string): number | null {
  return statDetail(team, key).value;
}

export function teamConfidence(team: TeamPayload | undefined): { confidence: number; observedShare: number } {
  let confidence = 0;
  let observed = 0;
  for (const key of KEY_STATS) {
    const detail = statDetail(team, key);
    confidence += detail.confidence;
    if (detail.status === 'observed') observed += 1;
  }
  return { confidence: confidence / KEY_STATS.length, observedShare: observed / KEY_STATS.length };
}

export function teamSample(team: TeamPayload | undefined): number | null {
  const sample = team?.sample ?? team?.projection?.sample_size ?? null;
  return typeof sample === 'number' && Number.isFinite(sample) && sample > 0 ? sample : null;
}

function present(team: TeamPayload | undefined, key: string): boolean {
  return statNumber(team, key) !== null;
}

export function assessQuality(response: AggregatedResponse): DataQuality {
  const home = response.teams?.home;
  const away = response.teams?.away;
  let presentCount = 0;
  let confidenceSum = 0;
  let observedCount = 0;
  for (const key of KEY_STATS) {
    for (const team of [home, away]) {
      if (present(team, key)) presentCount += 1;
      const detail = statDetail(team, key);
      confidenceSum += detail.confidence;
      if (detail.status === 'observed') observedCount += 1;
    }
  }
  const total = KEY_STATS.length * 2;
  const coverage = presentCount / total;
  const confidenceCoverage = confidenceSum / total;
  const observedShare = observedCount / total;

  const homeSample = teamSample(home);
  const awaySample = teamSample(away);
  const sample = homeSample === null || awaySample === null ? (homeSample ?? awaySample) : Math.min(homeSample, awaySample);
  const sampleScore = sample === null ? 0.25 : clamp(sample / 10, 0, 1);

  const preMatch = response.pre_match ?? null;
  const hasPrediction = Boolean(preMatch?.prediction?.expected_goals?.home && preMatch?.prediction?.expected_goals?.away);
  const odds = Boolean(preMatch?.odds);
  const recentHome = preMatch?.teams?.home?.recent_form;
  const recentAway = preMatch?.teams?.away?.recent_form;
  const hasForm = Boolean(
    (recentHome?.matches ?? 0) >= 5 ||
      (recentAway?.matches ?? 0) >= 5 ||
      (preMatch?.teams?.home?.form?.length ?? 0) >= 3 ||
      (preMatch?.teams?.away?.form?.length ?? 0) >= 3,
  );

  const score = clamp(
    0.45 * confidenceCoverage +
      0.25 * sampleScore +
      0.15 * (hasPrediction ? 1 : 0) +
      0.1 * (odds ? 1 : 0) +
      0.05 * (hasForm ? 1 : 0),
    0,
    1,
  );

  const signals: string[] = [
    `${presentCount}/${total} estadísticas clave disponibles`,
    `Estadísticas observadas: ${Math.round(observedShare * 100)} %`,
    sample !== null ? `Muestra de ${sample} partido${sample === 1 ? '' : 's'}` : 'Muestra no declarada',
  ];
  if (hasPrediction) signals.push('Predicción externa disponible');
  if (odds) signals.push('Cuotas de mercado disponibles');
  if (hasForm) signals.push('Forma reciente disponible');
  if (preMatch?.meta?.coverage) {
    signals.push(`Contexto pre-partido ${preMatch.meta.coverage.available}/${preMatch.meta.coverage.total}`);
  }

  const caveats: string[] = [];
  if (coverage < 0.5) caveats.push('Cobertura de estadísticas baja: las probabilidades descansan en medias de liga.');
  if (confidenceCoverage < coverage - 0.15) {
    caveats.push('Parte de las estadísticas son proyectadas, no observadas: la confianza se reduce.');
  }
  if (sample !== null && sample < 5) caveats.push(`Muestra corta (${sample} partidos): mayor incertidumbre en las tasas.`);
  if (!hasPrediction) caveats.push('Sin predicción externa para contrastar el modelo.');
  if (!odds) caveats.push('Sin cuotas: no se puede medir valor frente al mercado.');
  if (!hasForm) caveats.push('Sin forma reciente: no se ajusta el momento de los equipos.');
  if (!preMatch) caveats.push('Contexto pre-partido no disponible; el análisis usa solo proyecciones de temporada.');
  else if (preMatch.status === 'partial') {
    caveats.push(`Contexto pre-partido parcial${preMatch.meta?.timed_out ? ' (fuente agotó el plazo)' : ''}.`);
  }
  if (response.match?.status === 'finished') {
    caveats.push('El partido ya finalizó: el análisis es retrospectivo y usa estadísticas observadas, no una proyección previa.');
  }
  if (response.match?.status === 'live') {
    caveats.push('El partido está en juego: las estadísticas pueden cambiar y la proyección pierde sentido.');
  }

  const label: DataQuality['label'] = score >= 0.75 ? 'Alta' : score >= 0.5 ? 'Media' : 'Baja';
  return {
    score,
    label,
    coverage,
    confidenceCoverage,
    observedShare,
    sample,
    signals,
    caveats,
    insufficient: score < 0.35 || coverage < 0.3,
  };
}

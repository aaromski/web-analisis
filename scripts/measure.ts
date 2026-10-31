import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateResponse, type EvaluatedVariant } from '../src/lib/audit/evaluate';
import {
  aggregateMetrics,
  applyIsotonic,
  expectedCalibrationError,
  fitIsotonic,
  type AggregateMetrics,
  type CalibrationSample,
  type MatchMetrics,
} from '../src/lib/audit/metrics';
import { loadResults, withResult, type MatchResults } from '../src/lib/audit/results';
import { AnalysisError, analyzeMatch } from '../src/lib/engine/analyze';
import type { AnalysisResult } from '../src/lib/types/analysis';
import type { AggregatedResponse } from '../src/lib/types/api';

interface SnapshotResult {
  label: string;
  league: string;
  date: string;
  marketTotal: number | null;
  marketLine: number | null;
  motor: EvaluatedVariant;
  anclado: EvaluatedVariant;
}

function pp(value: number | null): string {
  if (value === null) return '—';
  const points = value * 100;
  return `${points >= 0 ? '+' : '−'}${Math.abs(points).toFixed(1)} pp`;
}

function goals(value: number | null): string {
  if (value === null) return '—';
  return value.toFixed(2);
}

function delta(value: number | null): string {
  if (value === null) return '—';
  return `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)}`;
}

function analyzeSafely(response: AggregatedResponse): AnalysisResult | null {
  try {
    return analyzeMatch(response);
  } catch (error) {
    if (error instanceof AnalysisError) return null;
    throw error;
  }
}

function variantLine(result: SnapshotResult, variant: EvaluatedVariant): string {
  const metrics = variant.metrics;
  const anchor =
    variant.variant === 'anclado' && variant.anchor && variant.anchor.applied
      ? ` · ancla ${Math.round(variant.anchor.weight * 100)} % (${variant.anchor.source})`
      : '';
  return [
    `  ${variant.variant.padEnd(7)}`,
    `λ ${variant.lambdaTotal.toFixed(2)}`,
    `Δtotal ${delta(metrics.totalDelta)}`,
    `MAE 1X2 ${pp(metrics.mae1x2)}`,
    `favorito ${pp(metrics.favoriteDelta)}`,
    `línea rec. ${metrics.totalsLineGap === null ? '—' : delta(metrics.totalsLineGap)}`,
    `valor ${metrics.edgesComputed}/${metrics.markets}`,
  ].join(' · ') + anchor;
}

function printAggregate(title: string, aggregate: AggregateMetrics): void {
  console.log(
    `${title}: MAE 1X2 ${pp(aggregate.meanMae1x2)} · |Δtotal| ${goals(aggregate.meanAbsTotalDelta)} · ` +
      `|sesgo favorito| ${pp(aggregate.meanAbsFavoriteDelta)} · valor ${aggregate.edgesComputed}/${aggregate.markets}` +
      (aggregate.meanBrier === null ? '' : ` · Brier ${aggregate.meanBrier.toFixed(3)}`),
  );
}

function calibrationSamples(results: SnapshotResult[], variant: EvaluatedVariant['variant']): CalibrationSample[] {
  const samples: CalibrationSample[] = [];
  for (const result of results) {
    const evaluated = variant === 'motor' ? result.motor : result.anclado;
    if (!evaluated.outcome) continue;
    for (const side of ['home', 'draw', 'away'] as const) {
      samples.push({ probability: evaluated.winProbabilities[side], hit: evaluated.outcome === side });
    }
  }
  return samples;
}

function printCalibration(results: SnapshotResult[], variant: EvaluatedVariant['variant']): void {
  const samples = calibrationSamples(results, variant);
  if (samples.length === 0) {
    console.log(`Calibración (${variant}): sin resultados reales. Añade data/results.json.`);
    return;
  }
  const ece = expectedCalibrationError(samples);
  const isotonic = fitIsotonic(samples);
  const recalibrated = samples.map((sample) => ({
    probability: applyIsotonic(isotonic, sample.probability),
    hit: sample.hit,
  }));
  const eceAfter = expectedCalibrationError(recalibrated);
  console.log(
    `Calibración (${variant}, ${samples.length} muestras): ECE ${ece === null ? '—' : (ece * 100).toFixed(1)} pp · ` +
      `isotónica ECE ${eceAfter === null ? '—' : (eceAfter * 100).toFixed(1)} pp · ${isotonic.knots.length} tramos`,
  );
}

function loadSnapshots(results: MatchResults): { response: AggregatedResponse; file: string }[] {
  const directory = join(process.cwd(), 'data', 'snapshots');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => ({
      file,
      response: withResult(
        JSON.parse(readFileSync(join(directory, file), 'utf8')) as AggregatedResponse,
        results,
      ),
    }));
}

function main(): void {
  const directory = join(process.cwd(), 'data', 'snapshots');
  if (!existsSync(directory)) {
    console.error('No hay snapshots. Ejecuta: npm run snapshot -- --home ... --away ... --date ...');
    process.exitCode = 1;
    return;
  }
  const results = loadResults(join(process.cwd(), 'data', 'results.json'));
  const snapshots = loadSnapshots(results);
  if (snapshots.length === 0) {
    console.error('data/snapshots está vacío. Captura al menos un partido antes de medir.');
    process.exitCode = 1;
    return;
  }

  const rows: SnapshotResult[] = [];
  for (const { response, file } of snapshots) {
    if (!response.match || !response.teams?.home || !response.teams?.away) {
      console.warn(`Snapshot ignorado (sin partido o equipos): ${file}`);
      continue;
    }
    const analysis = analyzeSafely(response);
    const motor = evaluateResponse(response, 'motor', null);
    const anclado = evaluateResponse(response, 'anclado', analysis);
    const totals = analysis?.markets.find((market) => market.key === 'totals');
    rows.push({
      label: `${response.teams.home.name} – ${response.teams.away.name}`,
      league: response.match.league?.name ?? response.match.league?.id ?? 'Liga',
      date: response.match.date,
      marketTotal: motor.marketTotal,
      marketLine: totals?.marketLine ?? null,
      motor,
      anclado,
    });
  }

  if (rows.length === 0) {
    console.error('Ningún snapshot válido para medir.');
    process.exitCode = 1;
    return;
  }

  for (const result of rows) {
    console.log(`\n${result.label} · ${result.league} · ${result.date.slice(0, 10)}`);
    console.log(
      `  mercado: total implícito ${goals(result.marketTotal)} · línea ${result.marketLine === null ? '—' : result.marketLine.toFixed(2)}`,
    );
    console.log(variantLine(result, result.motor));
    console.log(variantLine(result, result.anclado));
  }

  const rowsFor = (variant: EvaluatedVariant['variant']): MatchMetrics[] =>
    rows.map((result) => (variant === 'motor' ? result.motor.metrics : result.anclado.metrics));

  const motorAggregate = aggregateMetrics(rowsFor('motor'));
  const anchoredAggregate = aggregateMetrics(rowsFor('anclado'));

  console.log(`\nAgregado (${rows.length} partidos con cuotas)`);
  printAggregate('motor  ', motorAggregate);
  printAggregate('anclado', anchoredAggregate);
  if (results.size > 0) {
    printCalibration(rows, 'motor');
    printCalibration(rows, 'anclado');
  }

  const favoriteOk =
    anchoredAggregate.meanAbsFavoriteDelta !== null && anchoredAggregate.meanAbsFavoriteDelta * 100 <= 2.5;
  const totalOk = anchoredAggregate.meanAbsTotalDelta !== null && anchoredAggregate.meanAbsTotalDelta <= 0.2;
  const maeOk = anchoredAggregate.meanMae1x2 !== null && anchoredAggregate.meanMae1x2 * 100 <= 2.5;
  console.log(
    `\nCriterios (anclado): |sesgo favorito| ≤ 2.5 pp ${favoriteOk ? 'OK' : 'FALLA'} · ` +
      `|Δtotal| ≤ 0.20 ${totalOk ? 'OK' : 'FALLA'} · MAE 1X2 ≤ 2.5 pp ${maeOk ? 'OK' : 'FALLA'}`,
  );
  console.log(
    'Nota: MAE y sesgo se miden contra el mismo mercado que alimenta el ancla; sirven para verificar coherencia, no para batir a la casa.',
  );
}

main();

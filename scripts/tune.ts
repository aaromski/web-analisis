import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateResponse } from '../src/lib/audit/evaluate';
import { applyIsotonic, expectedCalibrationError, fitIsotonic, mean, type CalibrationSample } from '../src/lib/audit/metrics';
import { loadResults, withResult } from '../src/lib/audit/results';
import type { AggregatedResponse } from '../src/lib/types/api';

const SCALES: number[] = Array.from({ length: 9 }, (_, index) => Math.round((0.8 + index * 0.05) * 100) / 100);
const OUTPUT = join(process.cwd(), 'data', 'tuning.json');

interface Row {
  brier: number | null;
  logLoss: number | null;
}

function average(rows: Row[], key: keyof Row): number | null {
  return mean(rows.map((row) => row[key]).filter((value): value is number => value !== null));
}

function readSnapshots(results: ReturnType<typeof loadResults>): AggregatedResponse[] {
  const directory = join(process.cwd(), 'data', 'snapshots');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) =>
      withResult(JSON.parse(readFileSync(join(directory, file), 'utf8')) as AggregatedResponse, results),
    )
    .filter((response) => Boolean(response.match && response.teams?.home && response.teams?.away));
}

function main(): void {
  const results = loadResults(join(process.cwd(), 'data', 'results.json'));
  const snapshots = readSnapshots(results);
  if (snapshots.length === 0) {
    console.error('No hay snapshots en data/snapshots.');
    process.exitCode = 1;
    return;
  }
  const scored = snapshots.filter((response) => results.has(response.match.match_id));
  if (scored.length === 0) {
    console.error('Ningún snapshot tiene resultado en data/results.json; no se puede ajustar.');
    process.exitCode = 1;
    return;
  }

  console.log(`Ajuste sobre ${scored.length} de ${snapshots.length} snapshots con resultado real.`);
  const rows: Array<{ scale: number; brier: number | null; logLoss: number | null }> = [];
  for (const scale of SCALES) {
    const evaluated = scored.map((response) => evaluateResponse(response, 'anclado', null, { weightScale: scale }));
    const brier = average(evaluated.map((item) => item.metrics), 'brier');
    const logLoss = average(evaluated.map((item) => item.metrics), 'logLoss');
    rows.push({ scale, brier, logLoss });
    console.log(
      `  escala ${scale.toFixed(2)} · Brier ${brier === null ? '—' : brier.toFixed(4)} · log-loss ${logLoss === null ? '—' : logLoss.toFixed(4)}`,
    );
  }

  const ranked = rows
    .filter((row) => row.brier !== null)
    .sort((left, right) => (left.brier as number) - (right.brier as number));
  if (ranked.length === 0) {
    console.error('Sin métricas calculables.');
    process.exitCode = 1;
    return;
  }

  const best = ranked[0];
  const samples: CalibrationSample[] = [];
  for (const response of scored) {
    const evaluated = evaluateResponse(response, 'anclado', null, { weightScale: best.scale });
    if (!evaluated.outcome) continue;
    for (const side of ['home', 'draw', 'away'] as const) {
      samples.push({ probability: evaluated.winProbabilities[side], hit: evaluated.outcome === side });
    }
  }
  const isotonic = fitIsotonic(samples);
  const eceBefore = expectedCalibrationError(samples);
  const eceAfter = expectedCalibrationError(
    samples.map((sample) => ({ probability: applyIsotonic(isotonic, sample.probability), hit: sample.hit })),
  );

  const payload = {
    generatedAt: new Date().toISOString(),
    matches: scored.length,
    weightScale: best.scale,
    brier: best.brier,
    logLoss: best.logLoss,
    ece: eceBefore,
    eceIsotonic: eceAfter,
    isotonic: isotonic.knots,
    grid: rows,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  console.log(
    `\nMejor escala ${best.scale.toFixed(2)}: Brier ${best.brier === null ? '—' : best.brier.toFixed(4)} · ` +
      `log-loss ${best.logLoss === null ? '—' : best.logLoss.toFixed(4)}`,
  );
  console.log(
    `ECE ${eceBefore === null ? '—' : (eceBefore * 100).toFixed(1)} pp · ` +
      `tras isotónica ${eceAfter === null ? '—' : (eceAfter * 100).toFixed(1)} pp (${isotonic.knots.length} tramos)`,
  );
  console.log(`Resultado guardado en ${OUTPUT}`);
  if (scored.length < 20) {
    console.log('Aviso: con menos de 20 partidos el ajuste es indicativo, no definitivo.');
  }
}

main();

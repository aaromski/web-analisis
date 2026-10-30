'use client';

import type { AnalysisResult } from '@/lib/types/analysis';
import { formatLine, formatPct, qualityTone } from '@/lib/ui/format';

interface Props {
  analysis: AnalysisResult;
}

function roundedPercent(value: number): string {
  return `${Math.round(value * 100)}`;
}

export default function SummaryStrip({ analysis }: Props) {
  const { lambdas, winProbabilities, dataQuality, model } = analysis;
  const tone = qualityTone(dataQuality.score);

  return (
    <section className="summary-strip" aria-label="Resumen del modelo">
      <div className="metric">
        <span className="metric-label">Goles esperados (λ)</span>
        <span className="metric-value">
          {formatLine(lambdas.home)} – {formatLine(lambdas.away)}
        </span>
        <span className="metric-sub">Total {formatLine(lambdas.total)}</span>
      </div>

      <div className="metric">
        <span className="metric-label">Probabilidad 1X2</span>
        <span className="metric-value">
          {roundedPercent(winProbabilities.home)} / {roundedPercent(winProbabilities.draw)} /{' '}
          {roundedPercent(winProbabilities.away)} %
        </span>
        <span className="metric-sub">Local · Empate · Visitante</span>
      </div>

      <div className="metric">
        <span className="metric-label">Calidad de datos</span>
        <span className="metric-value" data-tone={tone}>
          {dataQuality.label} {Math.round(dataQuality.score * 100)}
        </span>
        <span className="metric-sub">Cobertura {formatPct(dataQuality.coverage, 0)}</span>
      </div>

      <div className="metric">
        <span className="metric-label">Umbral base</span>
        <span className="metric-value">{formatPct(model.thresholds.default, 0)}</span>
        <span className="metric-sub">
          Totales {formatPct(model.thresholds.totals, 0)} · Hándicap {formatPct(model.thresholds.handicap, 0)} · Base{' '}
          {formatLine(model.baseTotalLine)}
        </span>
      </div>
    </section>
  );
}

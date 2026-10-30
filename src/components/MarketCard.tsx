'use client';

import { useId, useState } from 'react';
import type { MarketOption, MarketResult } from '@/lib/types/analysis';
import { confidenceTone, formatEdge, formatLine, formatOdds, formatPct, riskTone } from '@/lib/ui/format';
import CalibrationChart from './CalibrationChart';

interface Props {
  market: MarketResult;
  index: number;
}

interface BarRow {
  label: string;
  probability: number;
  fairOdds: number | null;
  selected: boolean;
}

function unitFor(key: MarketResult['key']): 'goles' | 'córners' | 'hándicap' {
  if (key === 'corners') return 'córners';
  if (key === 'handicap') return 'hándicap';
  return 'goles';
}

function sideFor(code: string): 'over' | 'under' | 'home' | 'away' {
  if (code === 'over' || code === 'under') return code;
  if (code === 'home' || code === 'away') return code;
  return 'over';
}

function toRows(market: MarketResult): BarRow[] {
  if (market.combos && market.combos.length > 0) {
    return market.combos.map((combo) => ({
      label: combo.label,
      probability: combo.probability,
      fairOdds: null,
      selected: false,
    }));
  }
  if (market.scores && market.scores.length > 0) {
    return market.scores.map((score) => ({
      label: score.score,
      probability: score.probability,
      fairOdds: null,
      selected: false,
    }));
  }
  return market.alternatives.map((option: MarketOption) => ({
    label: option.label,
    probability: option.probability,
    fairOdds: option.fairOdds,
    selected: Boolean(option.selected),
  }));
}

export default function MarketCard({ market, index }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const detailId = useId();
  const tone = riskTone(market.risk);
  const hasCurve = market.curve.length > 0;
  const rows = toRows(market);
  const maxProbability = Math.max(0.01, ...rows.map((row) => row.probability));
  const edgeText = formatEdge(market.edge);

  const stateLabel = !market.available
    ? 'Mercado no disponible'
    : hasCurve
      ? market.calibrated
        ? 'Línea calibrada'
        : 'Sin línea sobre umbral'
      : 'Selección del modelo';

  return (
    <article
      className="market-card"
      data-available={market.available}
      data-expanded={expanded}
      style={{ ['--tone' as string]: `var(--${tone})` }}
      id={`mercado-${market.key}`}
    >
      <button
        type="button"
        className="market-head"
        aria-expanded={expanded}
        aria-controls={detailId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="market-eyebrow">
          <span>
            {String(index).padStart(2, '0')} · {market.name}
          </span>
          {market.key === 'corners' ? <span className="chip">Extendido</span> : null}
        </span>
        <span className="market-tagline">{market.tagline}</span>
      </button>

      <div className="market-body">
        <div className="market-selection-row">
          <h3 className="market-selection">{market.selection}</h3>
          {market.line !== null ? (
            <span className="chip" data-tone="lime">
              Línea {formatLine(market.line)}
            </span>
          ) : null}
          {hasCurve && !market.calibrated && market.available ? (
            <span className="chip" data-tone="amber">
              Sin línea sobre umbral
            </span>
          ) : null}
        </div>

        <div className="prob-row">
          <span className="prob-value" data-calibrated={hasCurve ? market.calibrated : undefined}>
            {formatPct(market.probability)}
          </span>
          <span className="prob-meta">
            <span>Cuota justa</span>
            <strong>{formatOdds(market.fairOdds)}</strong>
          </span>
        </div>

        <div className="confidence">
          <div className="confidence-row">
            <span>Confianza {market.confidence} / 100</span>
            <span>
              Riesgo{' '}
              <span className="chip" data-tone={tone}>
                {market.risk}
              </span>
            </span>
          </div>
          <div className="confidence-bar" role="presentation">
            <span style={{ width: `${Math.min(100, Math.max(0, market.confidence))}%` }} />
          </div>
        </div>

        <div className="market-selection-row">
          {edgeText ? (
            <span className="chip" data-tone={edgeText.startsWith('−') ? 'amber' : 'lime'}>
              Valor {edgeText}
            </span>
          ) : (
            <span className="chip">Sin cuota comparable</span>
          )}
          <span className="chip">{stateLabel}</span>
        </div>

        {hasCurve && !expanded ? (
          <CalibrationChart
            points={market.curve}
            threshold={market.threshold}
            side={sideFor(market.selectionCode)}
            unit={unitFor(market.key)}
            variant="spark"
            selection={market.selection}
          />
        ) : null}
      </div>

      <div className="market-foot">
        <span>
          {hasCurve
            ? market.baseLine !== null
              ? `Base ${formatLine(market.baseLine)}`
              : 'Hándicap'
            : market.key === 'corners'
              ? 'Córners'
              : 'Ranking'}
        </span>
        <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} aria-controls={detailId}>
          {expanded ? 'Ocultar detalle' : 'Ver detalle'}
        </button>
      </div>

      <div className="market-detail" id={detailId} hidden={!expanded}>
        <div className="detail-grid">
          {hasCurve ? (
            <div>
              <CalibrationChart
                points={market.curve}
                threshold={market.threshold}
                side={sideFor(market.selectionCode)}
                unit={unitFor(market.key)}
                variant="full"
                selection={market.selection}
              />
              <button
                type="button"
                className="table-toggle"
                aria-expanded={showTable}
                aria-controls={`${detailId}-table`}
                onClick={() => setShowTable((value) => !value)}
              >
                {showTable ? 'Ocultar tabla' : 'Ver tabla'}
              </button>
              {showTable ? (
                <table className="data-table" id={`${detailId}-table`}>
                  <caption>Línea, probabilidad y umbral</caption>
                  <thead>
                    <tr>
                      <th scope="col">Línea</th>
                      <th scope="col">Probabilidad</th>
                      <th scope="col">Umbral</th>
                    </tr>
                  </thead>
                  <tbody>
                    {market.curve.map((point) => (
                      <tr key={point.line} data-selected={point.selected}>
                        <td>{formatLine(point.line)}</td>
                        <td>{formatPct(point.probability)}</td>
                        <td>{point.meetsThreshold ? 'Cumple' : 'No cumple'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </div>
          ) : (
            <ul className="alt-list">
              {rows.map((row) => (
                <li
                  key={`${row.label}-${row.probability}`}
                  className="alt-row"
                  data-selected={row.selected}
                >
                  <span className="alt-label">
                    <span>{row.label}</span>
                    {row.selected ? <span className="chip" data-tone="lime">Elegida</span> : null}
                  </span>
                  <span className="alt-bar" role="presentation">
                    <span style={{ width: `${(row.probability / maxProbability) * 100}%` }} />
                  </span>
                  <span className="alt-prob">
                    {formatPct(row.probability)}
                    {row.fairOdds !== null ? (
                      <>
                        <br />
                        <span style={{ color: 'var(--text-dim)', fontSize: '10px' }}>{formatOdds(row.fairOdds)}</span>
                      </>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div>
            <p className="detail-text">{market.explanation}</p>
            {market.note ? <p className="detail-note">{market.note}</p> : null}
            <div className="detail-meta">
              {hasCurve ? (
                <>
                  <span className="chip">Umbral {formatPct(market.threshold, 0)}</span>
                  {market.baseLine !== null ? <span className="chip">Base {formatLine(market.baseLine)}</span> : null}
                  <span className="chip" data-tone={market.calibrated ? 'lime' : 'amber'}>
                    {market.calibrated ? 'Calibrada' : 'No calibrada'}
                  </span>
                </>
              ) : (
                <span className="chip">Sin línea dinámica</span>
              )}
              {market.marketLine !== null ? (
                <span className="chip">Mercado {formatLine(market.marketLine)}</span>
              ) : null}
              {market.marketProbability !== null ? (
                <span className="chip">Cuota implícita {formatPct(market.marketProbability)}</span>
              ) : null}
              {market.marketModelProbability !== null ? (
                <span className="chip">Modelo en mercado {formatPct(market.marketModelProbability)}</span>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
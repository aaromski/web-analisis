'use client';

import type { CalibrationPoint } from '@/lib/types/analysis';
import { formatLine, formatPct, formatSignedLine } from '@/lib/ui/format';

type Side = 'over' | 'under' | 'home' | 'away';

interface Props {
  points: CalibrationPoint[];
  threshold: number;
  side: Side;
  unit: 'goles' | 'córners' | 'hándicap';
  variant: 'spark' | 'full';
  selection: string;
}

const W = 560;
const H = 248;
const PAD = { top: 30, right: 18, bottom: 36, left: 44 };

function formatAxisLine(line: number, unit: Props['unit']): string {
  if (unit === 'hándicap') return formatSignedLine(line);
  return formatLine(line);
}

function seriesValue(point: CalibrationPoint, side: Side): number {
  if (side === 'over' || side === 'under') return point.probability;
  return point.probability;
}

export default function CalibrationChart({ points, threshold, side, unit, variant, selection }: Props) {
  if (points.length === 0) return null;

  const values = points.map((point) => seriesValue(point, side));
  const opposite =
    side === 'over' || side === 'under'
      ? points.map((point) => (side === 'over' ? point.under : point.over))
      : null;
  const hasOpposite = opposite?.every((value) => typeof value === 'number') ?? false;
  const maxProb = Math.max(1, ...values.map((value) => value), threshold);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const step = points.length > 1 ? innerW / (points.length - 1) : innerW;
  const x = (index: number) => PAD.left + index * step;
  const y = (probability: number) => PAD.top + innerH * (1 - probability / maxProb);

  const oppositePath =
    hasOpposite && opposite
      ? opposite
          .map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(value ?? 0).toFixed(1)}`)
          .join(' ')
      : null;

  const path = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' ');
  const thresholdY = y(threshold);

  const labelEvery = points.length > 14 ? 4 : points.length > 8 ? 2 : 1;
  const selected = points.find((point) => point.selected);

  if (variant === 'spark') {
    return (
      <svg
        className="sparkline"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={thresholdY}
          y2={thresholdY}
          stroke="var(--line-strong)"
          strokeWidth="1"
          strokeDasharray="4 5"
        />
        <path d={path} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
        {points.map((point, index) =>
          point.meetsThreshold ? (
            <circle
              key={point.line}
              cx={x(index)}
              cy={y(values[index])}
              r={3}
              fill={point.selected ? 'var(--lime)' : 'var(--text-muted)'}
            />
          ) : null,
        )}
        {selected ? (
          <circle
            cx={x(points.indexOf(selected))}
            cy={y(seriesValue(selected, side))}
            r="6"
            fill="none"
            stroke="var(--lime)"
            strokeWidth="1.5"
          />
        ) : null}
      </svg>
    );
  }

  return (
    <div className="chart-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Curva de calibración ${unit}: ${selection}`}
      >
        <title>Curva de calibración de {unit}</title>
        <desc>
          Probabilidad de cada línea candidata frente al umbral del {formatPct(threshold, 0)}. La selección
          publicada es {selection}.
        </desc>
        {[0, 0.5, 1].map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={y(tick * maxProb)}
              y2={y(tick * maxProb)}
              stroke="var(--line)"
              strokeWidth="1"
            />
            <text
              x={PAD.left - 8}
              y={y(tick * maxProb) + 4}
              textAnchor="end"
              fill="var(--text-dim)"
              fontSize="10"
              fontFamily="var(--mono)"
            >
              {Math.round(tick * maxProb * 100)} %
            </text>
          </g>
        ))}
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={thresholdY}
          y2={thresholdY}
          stroke="var(--amber)"
          strokeWidth="1"
          strokeDasharray="5 5"
        />
        <text
          x={PAD.left + 2}
          y={thresholdY - 6}
          textAnchor="start"
          fill="var(--amber)"
          fontSize="10"
          fontFamily="var(--mono)"
        >
          umbral {formatPct(threshold, 0)}
        </text>
        <path d={path} fill="none" stroke="var(--line-strong)" strokeWidth="2" />
        {oppositePath ? (
          <path d={oppositePath} fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeDasharray="3 4" />
        ) : null}
        {points.map((point, index) => {
          const value = values[index];
          return (
            <g key={point.line}>
              <circle
                cx={x(index)}
                cy={y(value)}
                r={point.selected ? 5 : 3.2}
                fill={point.meetsThreshold ? 'var(--lime)' : 'var(--surface-3)'}
                stroke={point.meetsThreshold ? 'var(--lime)' : 'var(--line-strong)'}
                strokeWidth="1"
              />
              {point.selected ? (
                <circle cx={x(index)} cy={y(value)} r="9" fill="none" stroke="var(--lime)" strokeWidth="1.5" />
              ) : null}
              {index % labelEvery === 0 || point.selected ? (
                <text
                  x={x(index)}
                  y={H - 12}
                  textAnchor="middle"
                  fill={point.selected ? 'var(--lime)' : 'var(--text-dim)'}
                  fontSize="10"
                  fontFamily="var(--mono)"
                >
                  {formatAxisLine(point.line, unit)}
                </text>
              ) : null}
            </g>
          );
        })}
        {selected ? (
          <text
            x={Math.min(Math.max(x(points.indexOf(selected)), PAD.left + 26), W - PAD.right - 26)}
            y={
              y(seriesValue(selected, side)) - PAD.top < 22
                ? y(seriesValue(selected, side)) + 18
                : y(seriesValue(selected, side)) - 14
            }
            textAnchor="middle"
            fill="var(--lime)"
            fontSize="10"
            fontFamily="var(--mono)"
          >
            {formatAxisLine(selected.line, unit)}
          </text>
        ) : null}
      </svg>
      <div className="chart-legend">
        <span data-kind="lime">Cumple el umbral</span>
        <span>Fuera del umbral</span>
        <span data-kind="dash">Umbral de calibración</span>
        {hasOpposite ? <span data-kind="dash">Serie contraria</span> : null}
      </div>
    </div>
  );
}

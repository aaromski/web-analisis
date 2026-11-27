'use client';

import type { GoalBands, GoalComparison, GoalMetrics } from '@/lib/types/goal-comparison';
import { GOAL_BANDS } from '@/lib/types/goal-comparison';
import { formatMatchDate } from '@/lib/ui/format';

export type GoalCompareState = 'idle' | 'loading' | 'ready' | 'empty' | 'error';

interface GoalComparisonPanelProps {
  state: GoalCompareState;
  comparison: GoalComparison | null;
  homeName: string;
  awayName: string;
  onRetry: () => void;
}

const BAND_LABELS: Record<(typeof GOAL_BANDS)[number], string> = {
  '1_15': '1–15',
  '16_30': '16–30',
  '31_45': '31–45',
  '46_60': '46–60',
  '61_75': '61–75',
  '76_90': '76–90',
};

const oneDecimal = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 });
const integer = new Intl.NumberFormat('es-ES');

function count(value: number): string {
  return integer.format(value);
}

function avg(value: number | null): string {
  return value === null ? '—' : oneDecimal.format(value);
}

function pct(value: number | null): string {
  return value === null ? '—' : `${oneDecimal.format(value)} %`;
}

function minutes(value: number | null): string {
  return value === null ? '—' : `${oneDecimal.format(value)}'`;
}

interface MetricRow {
  label: string;
  home: { main: string; sub?: string };
  away: { main: string; sub?: string };
}

function metricRows(
  home: GoalMetrics,
  away: GoalMetrics,
  condition: 'global' | 'venue',
): MetricRow[] {
  const sampleSub = (team: GoalMetrics, side: 'home' | 'away'): string => {
    if (condition === 'venue') return side === 'home' ? 'en casa' : 'fuera';
    const venueMatches = 'venueMatches' in team ? team.venueMatches : null;
    if (team.matches === 0) return 'sin muestra';
    return typeof venueMatches === 'number'
      ? `${count(venueMatches)} ${side === 'home' ? 'en casa' : 'fuera'}`
      : '—';
  };

  return [
    {
      label: 'Partidos previos',
      home: { main: count(home.matches), sub: sampleSub(home, 'home') },
      away: { main: count(away.matches), sub: sampleSub(away, 'away') },
    },
    {
      label: 'Goles a favor / en contra',
      home: { main: `${count(home.goalsFor)} / ${count(home.goalsAgainst)}`, sub: `${avg(home.goalsForAvg)} / ${avg(home.goalsAgainstAvg)} por partido` },
      away: { main: `${count(away.goalsFor)} / ${count(away.goalsAgainst)}`, sub: `${avg(away.goalsForAvg)} / ${avg(away.goalsAgainstAvg)} por partido` },
    },
    {
      label: 'Minutos por gol (F / C)',
      home: { main: `${minutes(home.minutesPerGoalFor)} / ${minutes(home.minutesPerGoalAgainst)}` },
      away: { main: `${minutes(away.minutesPerGoalFor)} / ${minutes(away.minutesPerGoalAgainst)}` },
    },
    {
      label: '1ª / 2ª mitad · a favor',
      home: {
        main: `${count(home.firstHalfGoalsFor)} / ${count(home.secondHalfGoalsFor)}`,
        sub: `${pct(home.firstHalfPctFor)} / ${pct(home.secondHalfPctFor)}`,
      },
      away: {
        main: `${count(away.firstHalfGoalsFor)} / ${count(away.secondHalfGoalsFor)}`,
        sub: `${pct(away.firstHalfPctFor)} / ${pct(away.secondHalfPctFor)}`,
      },
    },
    {
      label: '1ª / 2ª mitad · en contra',
      home: {
        main: `${count(home.firstHalfGoalsAgainst)} / ${count(home.secondHalfGoalsAgainst)}`,
        sub: `${pct(home.firstHalfPctAgainst)} / ${pct(home.secondHalfPctAgainst)}`,
      },
      away: {
        main: `${count(away.firstHalfGoalsAgainst)} / ${count(away.secondHalfGoalsAgainst)}`,
        sub: `${pct(away.firstHalfPctAgainst)} / ${pct(away.secondHalfPctAgainst)}`,
      },
    },
    {
      label: 'Marcó / recibió primero',
      home: {
        main: `${count(home.firstGoals)} / ${count(home.firstGoalsConceded)}`,
        sub: `mediana ${minutes(home.firstGoalMinuteMedian)}`,
      },
      away: {
        main: `${count(away.firstGoals)} / ${count(away.firstGoalsConceded)}`,
        sub: `mediana ${minutes(away.firstGoalMinuteMedian)}`,
      },
    },
    {
      label: 'Porterías a cero / sin marcar',
      home: { main: `${count(home.cleanSheets)} / ${count(home.failedToScore)}` },
      away: { main: `${count(away.cleanSheets)} / ${count(away.failedToScore)}` },
    },
    {
      label: 'BTTS / Over 2.5',
      home: { main: `${pct(home.bttsPct)} / ${pct(home.over25Pct)}` },
      away: { main: `${pct(away.bttsPct)} / ${pct(away.over25Pct)}` },
    },
  ];
}

function ComparisonTable({
  home,
  away,
  homeName,
  awayName,
  condition,
}: {
  home: GoalMetrics;
  away: GoalMetrics;
  homeName: string;
  awayName: string;
  condition: 'global' | 'venue';
}) {
  return (
    <div className="goal-compare-table-wrap">
      <table className="goal-compare-table">
        <thead>
          <tr>
            <th scope="col">Métrica</th>
            <th scope="col">
              <span className="goal-team-dot goal-team-dot-home" aria-hidden="true" />
              {homeName}
            </th>
            <th scope="col">
              <span className="goal-team-dot goal-team-dot-away" aria-hidden="true" />
              {awayName}
            </th>
          </tr>
        </thead>
        <tbody>
          {metricRows(home, away, condition).map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>
                <span className="goal-metric-main">{row.home.main}</span>
                {row.home.sub ? <span className="goal-metric-sub">{row.home.sub}</span> : null}
              </td>
              <td>
                <span className="goal-metric-main">{row.away.main}</span>
                {row.away.sub ? <span className="goal-metric-sub">{row.away.sub}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BandChart({
  title,
  home,
  away,
  homeName,
  awayName,
}: {
  title: string;
  home: GoalBands;
  away: GoalBands;
  homeName: string;
  awayName: string;
}) {
  const max = Math.max(1, ...GOAL_BANDS.map((band) => Math.max(home[band], away[band])));

  return (
    <div className="goal-band-chart">
      <h3 className="goal-band-title">{title}</h3>
      <div className="goal-band-head">
        <span />
        <span>
          <i className="goal-team-dot goal-team-dot-home" /> {homeName}
        </span>
        <span>
          <i className="goal-team-dot goal-team-dot-away" /> {awayName}
        </span>
      </div>
      {GOAL_BANDS.map((band) => (
        <div className="goal-band-row" key={band}>
          <span className="goal-band-label">{BAND_LABELS[band]}</span>
          <span className="goal-band-bar-wrap">
            <span className="goal-band-track">
              <span
                className="goal-band-fill goal-band-fill-home"
                style={{ width: `${(home[band] / max) * 100}%` }}
              />
            </span>
            <span className="goal-band-value">{home[band]}</span>
          </span>
          <span className="goal-band-bar-wrap">
            <span className="goal-band-track">
              <span
                className="goal-band-fill goal-band-fill-away"
                style={{ width: `${(away[band] / max) * 100}%` }}
              />
            </span>
            <span className="goal-band-value">{away[band]}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export default function GoalComparisonPanel({
  state,
  comparison,
  homeName,
  awayName,
  onRetry,
}: GoalComparisonPanelProps) {
  if (state === 'idle') return null;

  const title = (
    <div className="section-head">
      <h2 className="section-title" id="goles-title">
        Perfil goleador · previo
      </h2>
      {comparison ? (
        <span className="section-count">
          Historial guardado anterior a {comparison.kickoffAt ? formatMatchDate(comparison.kickoffAt) : 'este partido'} · goles a 90&apos;
        </span>
      ) : null}
    </div>
  );

  if (state === 'loading') {
    return (
      <section id="goles" className="goal-compare" aria-busy="true" aria-labelledby="goles-title">
        {title}
        <div className="goal-compare-card goal-compare-message" role="status">
          Cargando el historial previo de ambos equipos…
        </div>
      </section>
    );
  }

  if (state === 'empty' || state === 'error') {
    const message =
      state === 'empty'
        ? 'No hay partidos anteriores con datos para este partido. La muestra crece a medida que se cierran resultados.'
        : 'No se pudo cargar el perfil goleador. El análisis principal sigue disponible.';
    return (
      <section id="goles" className="goal-compare" aria-labelledby="goles-title">
        {title}
        <div className="goal-compare-card goal-compare-message">
          <p>{message}</p>
          <button type="button" className="btn btn-ghost" onClick={onRetry}>
            {state === 'empty' ? 'Actualizar' : 'Reintentar'}
          </button>
        </div>
      </section>
    );
  }

  if (!comparison) return null;

  const resolvedHome = comparison.homeTeamName || homeName;
  const resolvedAway = comparison.awayTeamName || awayName;
  const noSample = comparison.home.matches === 0 && comparison.away.matches === 0;

  return (
    <section id="goles" className="goal-compare" aria-labelledby="goles-title">
      {title}
      <div className="goal-compare-card">
        {noSample ? (
          <p className="goal-compare-message">
            Ambos equipos llegan sin partidos anteriores con datos. La muestra crece a medida que se
            cierran resultados.
          </p>
        ) : (
          <>
            <ComparisonTable
              home={comparison.home}
              away={comparison.away}
              homeName={resolvedHome}
              awayName={resolvedAway}
              condition="global"
            />
            <div className="goal-bands">
              <BandChart
                title="Goles marcados por franja"
                home={comparison.home.bandsFor}
                away={comparison.away.bandsFor}
                homeName={resolvedHome}
                awayName={resolvedAway}
              />
              <BandChart
                title="Goles recibidos por franja"
                home={comparison.home.bandsAgainst}
                away={comparison.away.bandsAgainst}
                homeName={resolvedHome}
                awayName={resolvedAway}
              />
            </div>
            <details className="goal-venue">
              <summary>Desglose en su localía</summary>
              <p className="goal-venue-caption">
                El local en sus partidos en casa y el visitante en sus partidos fuera.
              </p>
              {comparison.home.venue && comparison.away.venue ? (
                <ComparisonTable
                  home={comparison.home.venue}
                  away={comparison.away.venue}
                  homeName={resolvedHome}
                  awayName={resolvedAway}
                  condition="venue"
                />
              ) : (
                <p className="goal-compare-message">
                  Sin muestra en localía para uno de los equipos. La tabla superior ya compara todo
                  el historial guardado.
                </p>
              )}
            </details>
          </>
        )}
      </div>
    </section>
  );
}

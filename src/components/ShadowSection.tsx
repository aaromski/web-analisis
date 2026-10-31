import type { ReactNode } from 'react';
import type {
  LabBaseline,
  LabCalibration,
  LabDataHealth,
  LabLearningState,
  LabLearningVersion,
  LabMarketRow,
  LabScoring,
  LabSummary,
  LabTrackRow,
  LearningRunRow,
} from '@/lib/server/db';
import { formatPct } from '@/lib/ui/format';
import ShadowRetry from './ShadowRetry';

/** Versión del motor de producción que la sombra compara. Fija por contrato. */
const PRODUCTION_VERSION = '1.2.0';

const decimal = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const metric = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
});

/** deltaPp llega en puntos porcentuales: 1.4 → "Sombra +1,4 pp". */
function signedPp(value: number | null): string | null {
  if (value === null || Number.isNaN(value)) return null;
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${decimal.format(Math.abs(value))} pp`;
}

/** interval llega en fracción 0–1, como el resto de probabilidades. */
function intervalCompact(interval: [number, number] | null): string | null {
  if (!interval) return null;
  const [low, high] = interval;
  if (Number.isNaN(low) || Number.isNaN(high)) return null;
  return `${decimal.format(low * 100)} – ${decimal.format(high * 100)}`;
}

function intervalSpoken(interval: [number, number] | null): string | null {
  if (!interval) return null;
  const [low, high] = interval;
  if (Number.isNaN(low) || Number.isNaN(high)) return null;
  return `Intervalo de confianza del 95 %: del ${decimal.format(low * 100)} % al ${decimal.format(high * 100)} %.`;
}

interface RowState {
  label: string;
  tone: 'amber' | null;
}

/** La compuerta manda: sin N partidos con resultado no existe revisión ni recomendación. */
function rowState(row: LabMarketRow, gateReached: boolean): RowState {
  const hasPromotion = row.promotion === 'pending' && gateReached;
  if (hasPromotion) return { label: 'Pendiente de revisión', tone: 'amber' };
  if (row.production === null && row.shadow === null) return { label: 'Sin lectura', tone: null };
  if (row.shadow === null) return { label: 'Sin sombra', tone: null };
  return { label: 'Observación', tone: null };
}

interface ShadowRowProps {
  row: LabMarketRow;
  gateReached: boolean;
  showMissing: boolean;
}

function ShadowRow({ row, gateReached, showMissing }: ShadowRowProps) {
  const delta = signedPp(row.deltaPp);
  const interval = intervalCompact(row.interval);
  const intervalLabel = intervalSpoken(row.interval);
  const state = rowState(row, gateReached);
  // Sombra con otra línea o selección: el contrato no trae delta comparable.
  const otherReading = delta === null && row.production !== null && row.shadow !== null;
  const sampleLabel = `Muestra: ${row.n} ${row.n === 1 ? 'partido' : 'partidos'} con resultado.${
    intervalLabel ? ` ${intervalLabel}` : ''
  }`;

  return (
    <li className="shadow-row">
      <div className="shadow-cell shadow-market">
        <span className="shadow-market-label">{row.label}</span>
      </div>

      <div className="shadow-cell shadow-production">
        <span className="shadow-cell-label" aria-hidden="true">
          Producción
        </span>
        <span className="visually-hidden">Producción: </span>
        <span
          className="shadow-value shadow-value-production"
          data-empty={row.production === null ? 'true' : undefined}
        >
          {formatPct(row.production)}
        </span>
      </div>

      <div className="shadow-cell shadow-shadow">
        <span className="shadow-cell-label" aria-hidden="true">
          Sombra
        </span>
        <span className="visually-hidden">Sombra: </span>
        <span
          className="shadow-value shadow-value-shadow"
          data-empty={row.shadow === null ? 'true' : undefined}
        >
          {formatPct(row.shadow)}
        </span>
        {showMissing && row.shadow === null ? (
          <span className="shadow-sub">Sin sombra para este mercado</span>
        ) : null}
      </div>

      <div className="shadow-cell shadow-delta">
        <span className="shadow-cell-label" aria-hidden="true">
          Delta
        </span>
        <span className="visually-hidden">Diferencia: </span>
        {delta !== null ? (
          <span className="shadow-delta-value">Sombra {delta}</span>
        ) : otherReading ? (
          <span className="shadow-delta-value">Sombra: {formatPct(row.shadow)}</span>
        ) : (
          <>
            <span className="shadow-delta-value" data-empty="true" aria-hidden="true">
              —
            </span>
            <span className="visually-hidden">sin delta comparable.</span>
          </>
        )}
      </div>

      <div className="shadow-cell shadow-sample">
        <span className="visually-hidden">{sampleLabel}</span>
        <span className="shadow-sample-line" aria-hidden="true">
          n {row.n}
        </span>
        {interval ? (
          <span className="shadow-sample-line" aria-hidden="true">
            IC 95 % {interval}
          </span>
        ) : null}
      </div>

      <div className="shadow-cell shadow-status">
        <span className="visually-hidden">Estado: </span>
        <span className="chip" data-tone={state.tone ?? undefined}>
          {state.label}
        </span>
      </div>
    </li>
  );
}

interface Props {
  summary: LabSummary;
}

const runDate = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Madrid',
});

function runDateLabel(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return runDate.format(date);
}

const REASON_LABELS: Record<string, string> = {
  promoted: 'Nueva versión promovida',
  'rolled-back': 'Reversión a la versión anterior',
  drifted: 'Deriva detectada: vuelta a defaults',
  'candidate-kept': 'Candidata retenida sin señal suficiente',
  'candidate-accumulating': 'Candidata acumulando muestra',
  'candidate-not-better': 'Ninguna escala supera al motor actual',
  'promotion-cooldown': 'Enfriamiento de promoción activo',
  'control-accumulating': 'Control heredado en acumulación',
  'low-coverage': 'Cobertura de totales insuficiente',
  'insufficient-data': 'Aún no hay 100 partidos con resultado',
  'insufficient-dataset': 'Muestra insuficiente para el walk-forward',
  'no-signal': 'Sin señal estable en el walk-forward',
  budget: 'Presupuesto del cron agotado',
  'no-promoted': 'Sin versión promovida todavía',
  disabled: 'Persistencia desactivada',
  unexpected: 'Error inesperado del ciclo',
  'query-failed': 'Falló la consulta de datos',
};

function reasonLabel(reason: string | null): string {
  if (!reason) return 'Sin decisión registrada';
  if (REASON_LABELS[reason]) return REASON_LABELS[reason];
  if (reason.endsWith('-failed')) return 'No se pudo completar la escritura';
  return reason;
}function nextAction(run: LearningRunRow | null): string {
  if (!run) return 'La próxima pasada del cron quedará registrada aquí.';
  if (run.status === 'error') return 'Revisar el evento de ingesta; producción no se tocó.';
  const reason = run.reason ?? '';
  if (reason === 'promoted') return 'La versión nueva medirá su deriva frente a la referencia.';
  if (reason === 'rolled-back' || reason === 'drifted') {
    return 'La referencia sigue midiendo la vuelta a los defaults.';
  }
  if (reason === 'low-coverage') return 'Se reanudará cuando vuelva la línea de totales.';
  if (reason === 'candidate-accumulating') return 'Faltan partidos para llegar a 50 pares.';
  if (reason === 'control-accumulating') {
    return 'El control heredado se retirará al llegar a 100 partidos.';
  }
  if (reason === 'promotion-cooldown') return 'Esperará a que venza el enfriamiento de 30 días.';
  if (reason === 'insufficient-data' || reason === 'insufficient-dataset') {
    return 'Se activará al completar la compuerta de 100 partidos.';
  }
  if (reason === 'budget') return 'El próximo cron reanudará el ajuste.';
  if (reason === 'candidate-not-better' || reason === 'no-signal') {
    return 'Seguirá observando: producción no se toca.';
  }
  if (reason === 'disabled') return 'Activa la persistencia para registrar el ciclo.';
  return 'Seguirá observando en la próxima pasada.';
}

function statusLabel(status: LearningRunRow['status']): string {
  if (status === 'ok') return 'Completada';
  if (status === 'skipped') return 'Omitida';
  if (status === 'error') return 'Error';
  return 'Duplicada';
}

function statusTone(status: LearningRunRow['status']): 'lime' | 'amber' | 'coral' | null {
  if (status === 'ok') return 'lime';
  if (status === 'skipped') return null;
  if (status === 'error') return 'coral';
  return 'amber';
}

const VERSION_STATUS_LABELS: Record<string, string> = {
  promoted: 'Activa',
  shadow: 'Candidata',
  retired: 'Retirada',
};

function versionStatusLabel(status: string): string {
  return VERSION_STATUS_LABELS[status] ?? status;
}

function VersionRow({ version }: { version: LabLearningVersion }) {
  const dates = [
    version.promotedAt ? `promovida ${runDateLabel(version.promotedAt)}` : null,
    version.retiredAt ? `retirada ${runDateLabel(version.retiredAt)}` : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join(' · ');

  return (
    <li className="shadow-memory-version" title={version.notes ?? undefined}>
      <span className="shadow-memory-version-name">{version.version}</span>
      <span className="shadow-memory-version-status">{versionStatusLabel(version.status)}</span>
      <span className="shadow-memory-version-date">{dates || `creada ${runDateLabel(version.createdAt)}`}</span>
    </li>
  );
}

function LearningMemory({ learning }: { learning: LabLearningState }) {
  const lastRun = learning.runs[0] ?? null;
  const previousRuns = learning.runs.slice(1, 5);
  const versions = learning.versions.slice(0, 4);

  return (
    <div className="shadow-memory" aria-labelledby="shadow-memory-title">
      <div className="shadow-memory-head">
        <div>
          <p className="shadow-memory-kicker">Memoria del ciclo</p>
          <h3 className="shadow-memory-title" id="shadow-memory-title">
            Qué aprendió el sistema
          </h3>
        </div>
        {lastRun ? (
          <span className="chip" data-tone={statusTone(lastRun.status) ?? undefined}>
            {statusLabel(lastRun.status)}
          </span>
        ) : null}
      </div>

      {lastRun ? (
        <dl className="shadow-memory-facts">
          <div>
            <dt>Última pasada</dt>
            <dd>{runDateLabel(lastRun.occurredAt)}</dd>
          </div>
          <div>
            <dt>Decisión</dt>
            <dd>{reasonLabel(lastRun.reason)}</dd>
          </div>
          <div>
            <dt>Próximo paso</dt>
            <dd>{nextAction(lastRun)}</dd>
          </div>
        </dl>
      ) : (
        <p className="shadow-memory-empty">
          Aún no hay pasadas registradas. El cron diario anotará aquí cada decisión del ciclo.
        </p>
      )}

      {previousRuns.length > 0 ? (
        <ol className="shadow-memory-runs" aria-label="Últimas pasadas del aprendizaje">
          {previousRuns.map((run, index) => (
            <li key={`${run.occurredAt}-${index}`} className="shadow-memory-run">
              <span className="shadow-memory-run-date">{runDateLabel(run.occurredAt)}</span>
              <span className="shadow-memory-run-reason">{reasonLabel(run.reason)}</span>
            </li>
          ))}
        </ol>
      ) : null}

      {versions.length > 0 ? (
        <ul className="shadow-memory-versions" aria-label="Historial de versiones del motor">
          {versions.map((version) => (
            <VersionRow key={version.version} version={version} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function brierLabel(value: number | null): string {
  return value === null ? '—' : metric.format(value);
}

/** Skill score: fracción 0–1 → porcentaje con signo. */
function skillLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const points = value * 100;
  const sign = points > 0 ? '+' : points < 0 ? '−' : '';
  return `${sign}${decimal.format(Math.abs(points))} %`;
}

function InsightCard({
  id,
  kicker,
  title,
  children,
}: {
  id: string;
  kicker: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="shadow-insight" aria-labelledby={id}>
      <p className="shadow-insight-kicker">{kicker}</p>
      <h3 className="shadow-insight-title" id={id}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function MarketBaselineCard({
  baseline,
  scoring,
}: {
  baseline: LabBaseline | null;
  scoring: LabScoring | null;
}) {
  return (
    <InsightCard id="shadow-baseline-title" kicker="Contraste externo" title="Frente al mercado">
      {baseline ? (
        <>
          <dl className="shadow-insight-facts">
            <div>
              <dt>Brier producción</dt>
              <dd>{brierLabel(baseline.productionBrier)}</dd>
            </div>
            <div>
              <dt>Brier sombra</dt>
              <dd>{brierLabel(baseline.shadowBrier)}</dd>
            </div>
            <div>
              <dt>Brier mercado</dt>
              <dd>{brierLabel(baseline.marketBrier)}</dd>
            </div>
            <div>
              <dt>Brier azar</dt>
              <dd>{brierLabel(baseline.naiveBrier)}</dd>
            </div>
            <div>
              <dt>Skill vs mercado</dt>
              <dd>{skillLabel(baseline.productionSkillVsMarket)}</dd>
            </div>
            <div>
              <dt>Skill vs azar</dt>
              <dd>{skillLabel(baseline.productionSkillVsNaive)}</dd>
            </div>
          </dl>
          <p className="shadow-insight-note">
            {baseline.matches} partidos con cuotas sin vig. Skill positivo significa mejor Brier que la
            referencia; skill negativo, peor.
          </p>
          <p className="shadow-insight-note">
            CLV:{' '}
            {baseline.clv.mean === null
              ? 'faltan recapturas cercanas al inicio.'
              : `${signedPp(baseline.clv.mean * 100)} de media en ${baseline.clv.matches} partidos (` +
                `${formatPct(baseline.clv.positiveShare ?? 0)} del pick se movió a favor).`}
          </p>
        </>
      ) : (
        <p className="shadow-insight-note">
          Se activará cuando haya cuotas de mercado guardadas en la traza de las predicciones.
        </p>
      )}

      {scoring ? (
        <ul className="shadow-insight-rows" aria-label="Brier por mercado en la línea exacta de la casa">
          {scoring.totals ? (
            <li className="shadow-insight-row">
              <span className="shadow-insight-metric">Totales @ línea</span>
              <span>Prod {brierLabel(scoring.totals.production)}</span>
              <span>Sombra {brierLabel(scoring.totals.shadow)}</span>
              <span>Mercado {brierLabel(scoring.totals.market)}</span>
            </li>
          ) : null}
          {scoring.handicap ? (
            <li className="shadow-insight-row">
              <span className="shadow-insight-metric">Hándicap @ línea</span>
              <span>Prod {brierLabel(scoring.handicap.production)}</span>
              <span>Sombra {brierLabel(scoring.handicap.shadow)}</span>
              <span>Mercado {brierLabel(scoring.handicap.market)}</span>
            </li>
          ) : null}
        </ul>
      ) : null}
    </InsightCard>
  );
}

function CalibrationCard({ calibration }: { calibration: LabCalibration | null }) {
  if (!calibration) return null;
  const bins = calibration.bins.filter((bin) => bin.count > 0);

  return (
    <InsightCard id="shadow-calibration-title" kicker="Fiabilidad" title="Calibración del 1X2">
      <dl className="shadow-insight-facts">
        <div>
          <dt>ECE producción</dt>
          <dd>{calibration.productionEce === null ? '—' : metric.format(calibration.productionEce)}</dd>
        </div>
        <div>
          <dt>ECE sombra</dt>
          <dd>{calibration.shadowEce === null ? '—' : metric.format(calibration.shadowEce)}</dd>
        </div>
        <div>
          <dt>Guardarraíl</dt>
          <dd>
            <span className="chip" data-tone={calibration.guard.ok ? 'lime' : 'coral'}>
              {calibration.guard.ok ? 'Dentro del margen' : 'Revisar calibración'}
            </span>
          </dd>
        </div>
      </dl>

      {bins.length > 0 ? (
        <table className="shadow-bins">
          <caption className="visually-hidden">
            Probabilidad media frente a frecuencia observada por tramo
          </caption>
          <thead>
            <tr>
              <th scope="col">Tramo</th>
              <th scope="col">Predicho</th>
              <th scope="col">Real</th>
              <th scope="col">n</th>
            </tr>
          </thead>
          <tbody>
            {bins.map((bin) => (
              <tr key={`${bin.low}-${bin.high}`}>
                <td>
                  {decimal.format(bin.low * 100)}–{decimal.format(bin.high * 100)} %
                </td>
                <td>{formatPct(bin.predicted)}</td>
                <td>{formatPct(bin.observed)}</td>
                <td>{bin.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <p className="shadow-insight-note">
        {calibration.matches} partidos. La sombra solo se bloquea si empeora el ECE más de{' '}
        {decimal.format(calibration.guard.margin * 100)} pp.
        {calibration.isotonic
          ? ` Isotónica de referencia con ${calibration.isotonic.knots.length} tramos; no altera producción.`
          : ''}
      </p>
    </InsightCard>
  );
}

function DataHealthCard({ health }: { health: LabDataHealth }) {
  const facts: Array<[string, number]> = [
    ['Pares', health.pairedMatches],
    ['Con cuotas', health.marketWin],
    ['Recapturados', health.recaptured],
    ['Sin traza', health.traceMissing],
    ['Totales @ línea', health.totalsAtLine],
    ['Hándicap @ línea', health.handicapAtLine],
  ];

  return (
    <InsightCard id="shadow-health-title" kicker="Instrumentación" title="Salud de los datos">
      <dl className="shadow-insight-facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="shadow-insight-note">
        Última captura pre: {runDateLabel(health.lastCaptureAt)}. Las filas sin traza son anteriores a la
        instrumentación y no entran en las métricas de mercado.
      </p>
    </InsightCard>
  );
}

function TrackRecordCard({ rows }: { rows: LabTrackRow[] }) {
  if (rows.length === 0) return null;
  const leagues = rows.filter((row) => row.kind === 'league');
  const markets = rows.filter((row) => row.kind === 'market');

  return (
    <InsightCard id="shadow-track-title" kicker="Historial" title="Rendimiento por liga y signo">
      <table className="shadow-bins">
        <caption className="visually-hidden">
          Brier de producción, sombra y mercado; menor es mejor
        </caption>
        <thead>
          <tr>
            <th scope="col">Grupo</th>
            <th scope="col">n</th>
            <th scope="col">Prod</th>
            <th scope="col">Sombra</th>
            <th scope="col">Mercado</th>
            <th scope="col">Δ</th>
          </tr>
        </thead>
        <tbody>
          {[...leagues, ...markets].map((row) => (
            <tr key={`${row.kind}-${row.key}`}>
              <th scope="row">
                {row.kind === 'league' ? row.label : `1X2 ${row.label}`}
              </th>
              <td>{row.matches}</td>
              <td>{brierLabel(row.productionBrier)}</td>
              <td>{brierLabel(row.shadowBrier)}</td>
              <td>{brierLabel(row.marketBrier)}</td>
              <td>{row.delta === null ? '—' : (row.delta < 0 ? '−' : '+') + metric.format(Math.abs(row.delta))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="shadow-insight-note">
        Δ es sombra − producción: negativo indica que la sombra mejora el Brier. Las ligas se ordenan por
        muestra y se muestran las ocho mayores.
      </p>
    </InsightCard>
  );
}

export default function ShadowSection({ summary }: Props) {
  const {
    state,
    matchesWithResult,
    required,
    markets,
    backtest,
    scoring,
    calibration,
    baseline,
    dataHealth,
    trackRecord,
    engine,
    learning,
  } = summary;
  const gateReached = required > 0 && matchesWithResult >= required;
  const covered = markets.filter((market) => market.shadow !== null).length;
  const totalMarkets = markets.length;
  const rawProgress = required > 0 ? (matchesWithResult / required) * 100 : 0;
  const progress = Math.round(Math.min(100, Math.max(0, rawProgress)) * 10) / 10;
  const showGauge = required > 0 && state !== 'disabled' && state !== 'error';
  const showRows = markets.length > 0 && state !== 'disabled' && state !== 'error';

  return (
    <section id="sombra" className="shadow-section" aria-labelledby="sombra-title">
      <div className="container">
        <div className="shadow-head">
          <div className="shadow-intro">
            <p className="eyebrow">Comparación experimental</p>
            <h2 className="shadow-title" id="sombra-title">
              Sombra vs. producción
            </h2>
            <p className="shadow-lead">
              La misma selección, calculada por dos motores. La sombra es experimental y no cambia la
              recomendación de producción.
            </p>
            <div className="shadow-engines">
              <span className="chip">Activo {engine.promoted ?? `v${PRODUCTION_VERSION}`}</span>
              <span className="chip">
                {engine.candidates.length > 0
                  ? `Candidata${engine.candidates.length > 1 ? 's' : ''} ${engine.candidates.join(' · ')}`
                  : 'Sin candidata'}
              </span>
              {engine.reference ? (
                <span className="chip" title="Control fijo: defaults de 1.2.0 como sombra permanente">
                  Referencia {engine.reference}
                </span>
              ) : null}
              <span className="chip shadow-experimental">Experimental</span>
            </div>
          </div>

          {showGauge ? (
            <div className="shadow-gauge">
              <p className="shadow-gauge-label">
                <strong>{matchesWithResult}</strong> de {required} partidos con resultado
              </p>
              <div
                className="shadow-gauge-track"
                role="progressbar"
                aria-label="Progreso de la sombra hacia la revisión"
                aria-valuemin={0}
                aria-valuemax={required}
                aria-valuenow={Math.min(matchesWithResult, required)}
                aria-valuetext={`${matchesWithResult} de ${required} partidos con resultado`}
              >
                <span
                  className="shadow-gauge-fill"
                  data-complete={gateReached}
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          ) : null}
        </div>

        {state === 'error' ? (
          <>
            <div className="shadow-state" data-state="error" role="status" aria-live="polite">
              <h3 className="shadow-state-title">No pudimos cargar la comparación</h3>
              <p className="shadow-state-body">
                El servicio de la sombra no respondió o devolvió datos incompletos. El análisis de
                producción sigue disponible.
              </p>
            </div>
            <ShadowRetry />
          </>
        ) : (
          <div className="shadow-state" data-state={state}>
            {state === 'disabled' ? (
              <>
                <h3 className="shadow-state-title">La variante sombra no está activa</h3>
                <p className="shadow-state-body">
                  Solo el motor de producción está calculando este partido. Cuando se habilite la
                  sombra, aquí verás la comparación por mercado sin alterar el análisis de arriba.
                </p>
              </>
            ) : null}

            {state === 'insufficient' ? (
              <>
                <h3 className="shadow-state-title">Observación en curso</h3>
                <p className="shadow-state-body">
                  La sombra se entrena con resultados post-partido. Necesita {required} partidos con
                  resultado para pasar a revisión; hasta entonces solo se observa y nunca se
                  recomienda.
                </p>
                {matchesWithResult === 0 ? (
                  <p className="shadow-state-foot">
                    Aún no hay partidos cerrados para la sombra. El contador empezará a subir con la
                    próxima jornada.
                  </p>
                ) : null}
              </>
            ) : null}

            {state === 'partial' ? (
              <>
                <h3 className="shadow-state-title">
                  <span className="chip shadow-partial-chip">
                    {totalMarkets > 0
                      ? `Sombra parcial · ${covered} de ${totalMarkets} mercados`
                      : 'Sombra parcial'}
                  </span>
                </h3>
                <p className="shadow-state-body">
                  La sombra todavía no cubre todos los mercados. Los que faltan muestran solo la
                  lectura de producción.
                </p>
              </>
            ) : null}

            {state === 'complete' ? (
              <>
                <h3 className="shadow-state-title">Umbral alcanzado</h3>
                <p className="shadow-state-body">
                  La sombra ya tiene {required} partidos con resultado y pasa a revisión. Mientras no
                  se promueva, las recomendaciones siguen saliendo de producción.
                </p>
              </>
            ) : null}
          </div>
        )}

        {state !== 'disabled' && state !== 'error' ? <LearningMemory learning={learning} /> : null}

        {backtest ? (
          <div className="shadow-backtest">
            <p className="shadow-backtest-title">
              Backtest · {backtest.matches} {backtest.matches === 1 ? 'partido' : 'partidos'} ·
              menor es mejor
            </p>
            <ul className="shadow-backtest-rows" aria-label="Exactitud por variante">
              <li className="shadow-backtest-row">
                <span className="shadow-backtest-metric">Brier</span>
                <span>Producción {metric.format(backtest.production.brier)}</span>
                <span>Sombra {metric.format(backtest.shadow.brier)}</span>
              </li>
              <li className="shadow-backtest-row">
                <span className="shadow-backtest-metric">Log-loss</span>
                <span>Producción {metric.format(backtest.production.logLoss)}</span>
                <span>Sombra {metric.format(backtest.shadow.logLoss)}</span>
              </li>
            </ul>
            <p className="shadow-backtest-note">
              Sobre el último análisis pre de cada partido cerrado; una métrica menor indica mejor
              calibración.
            </p>
          </div>
        ) : null}

        {state !== 'disabled' && state !== 'error' ? (
          <div className="shadow-insights">
            <MarketBaselineCard baseline={baseline} scoring={scoring} />
            <CalibrationCard calibration={calibration} />
            <DataHealthCard health={dataHealth} />
            <TrackRecordCard rows={trackRecord} />
          </div>
        ) : null}

        {showRows ? (
          <div className="shadow-table">
            <div className="shadow-table-head" aria-hidden="true">
              <span>Mercado</span>
              <span>Producción</span>
              <span>Sombra</span>
              <span>Delta</span>
              <span>Muestra</span>
              <span>Estado</span>
            </div>
            <ul className="shadow-rows" aria-label="Comparación por mercado">
              {markets.map((row) => (
                <ShadowRow
                  key={row.market}
                  row={row}
                  gateReached={gateReached}
                  showMissing={state === 'partial'}
                />
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  );
}

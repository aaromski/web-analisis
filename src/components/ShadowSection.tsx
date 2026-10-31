import type { LabMarketRow, LabSummary } from '@/lib/server/db';
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

export default function ShadowSection({ summary }: Props) {
  const { state, matchesWithResult, required, markets, backtest, engine } = summary;
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

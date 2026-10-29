'use client';

import type { DataQuality, MatchContext } from '@/lib/types/analysis';
import { formatLine, formatPct } from '@/lib/ui/format';

interface Props {
  context: MatchContext;
  quality: DataQuality;
}

function FormChips({ form }: { form: string | null }) {
  if (!form) return <span className="context-empty">Sin forma reciente.</span>;
  return (
    <span className="form-chips" aria-label={`Forma ${form.split('').join(' ')}`}>
      {form.split('').map((result, index) => (
        <span className="form-chip" data-result={result} key={`${result}-${index}`}>
          {result === 'W' ? 'V' : result === 'L' ? 'D' : 'E'}
        </span>
      ))}
    </span>
  );
}

export default function ContextPanel({ context, quality }: Props) {
  const { prediction, recentForm, h2h, injuries, odds, referee, weather, insights } = context;

  return (
    <aside className="context-card" id="contexto" aria-labelledby="contexto-title">
      <h2 className="parlay-title" id="contexto-title">
        Contexto del partido
      </h2>

      <div className="context-block">
        <h3>Predicción externa</h3>
        {prediction ? (
          <>
            <div className="context-line">
              <span>1X2</span>
              <strong>
                {formatPct(prediction.result.home, 0)} / {formatPct(prediction.result.draw, 0)} /{' '}
                {formatPct(prediction.result.away, 0)}
              </strong>
            </div>
            <div className="context-line">
              <span>Goles esperados</span>
              <strong>
                {formatLine(prediction.expectedGoals.home)} – {formatLine(prediction.expectedGoals.away)}
              </strong>
            </div>
            {prediction.mostLikelyScore ? (
              <div className="context-line">
                <span>Marcador más probable</span>
                <strong>{prediction.mostLikelyScore}</strong>
              </div>
            ) : null}
            {prediction.bttsYes !== null ? (
              <div className="context-line">
                <span>Ambos anotan</span>
                <strong>{formatPct(prediction.bttsYes, 0)}</strong>
              </div>
            ) : null}
            {prediction.model ? (
              <p className="context-empty" style={{ marginTop: '6px' }}>
                Modelo {prediction.model}
              </p>
            ) : null}
          </>
        ) : (
          <p className="context-empty">Sin predicción externa.</p>
        )}
      </div>

      <div className="context-block">
        <h3>Forma reciente</h3>
        {recentForm ? (
          <>
            <div className="context-line">
              <span>Local</span>
              <FormChips form={recentForm.home.form} />
            </div>
            <div className="context-line">
              <span>Visitante</span>
              <FormChips form={recentForm.away.form} />
            </div>
            <div className="context-line">
              <span>Goles a favor / contra</span>
              <strong>
                {recentForm.home.goalsFor ?? '—'} / {recentForm.home.goalsAgainst ?? '—'} ·{' '}
                {recentForm.away.goalsFor ?? '—'} / {recentForm.away.goalsAgainst ?? '—'}
              </strong>
            </div>
          </>
        ) : (
          <p className="context-empty">Sin forma reciente.</p>
        )}
      </div>

      <div className="context-block">
        <h3>Historial directo</h3>
        {h2h ? (
          <>
            {h2h.summary ? <p className="context-empty" style={{ color: 'var(--text-muted)' }}>{h2h.summary}</p> : null}
            {h2h.totalMatches !== null ? (
              <div className="context-line">
                <span>Partidos registrados</span>
                <strong>{h2h.totalMatches}</strong>
              </div>
            ) : null}
          </>
        ) : (
          <p className="context-empty">Sin historial directo.</p>
        )}
      </div>

      <div className="context-block">
        <h3>Bajas y dudas</h3>
        {injuries.length > 0 ? (
          injuries.slice(0, 8).map((injury, index) => (
            <div className="context-line" key={`${injury.name}-${index}`}>
              <span>
                {injury.name}
                {injury.reason ? <span style={{ color: 'var(--text-dim)' }}> · {injury.reason}</span> : null}
              </span>
              <strong style={{ color: injury.status.toLowerCase().includes('doubt') ? 'var(--amber)' : undefined }}>
                {injury.status}
              </strong>
            </div>
          ))
        ) : (
          <p className="context-empty">Sin bajas registradas.</p>
        )}
      </div>

      <div className="context-block">
        <h3>Cuotas de mercado</h3>
        {odds ? (
          <>
            {odds.moneylineNoVig ? (
              <div className="context-line">
                <span>1X2 sin margen</span>
                <strong>
                  {formatPct(odds.moneylineNoVig.home, 0)} / {formatPct(odds.moneylineNoVig.draw, 0)} /{' '}
                  {formatPct(odds.moneylineNoVig.away, 0)}
                </strong>
              </div>
            ) : null}
            {odds.totalsLine !== null ? (
              <div className="context-line">
                <span>Línea de goles</span>
                <strong>
                  {formatLine(odds.totalsLine)}
                  {odds.totalsOverNoVig !== null ? ` · Over ${formatPct(odds.totalsOverNoVig, 0)}` : ''}
                </strong>
              </div>
            ) : null}
            {odds.spreadLine !== null ? (
              <div className="context-line">
                <span>Hándicap</span>
                <strong>{formatLine(odds.spreadLine)}</strong>
              </div>
            ) : null}
            {odds.provider ? (
              <p className="context-empty" style={{ marginTop: '6px' }}>
                Fuente {odds.provider}
              </p>
            ) : null}
          </>
        ) : (
          <p className="context-empty">Sin cuotas de mercado.</p>
        )}
      </div>

      {(referee || weather) && (
        <div className="context-block">
          <h3>Árbitro y clima</h3>
          {referee ? (
            <div className="context-line">
              <span>{referee.name}</span>
              <strong>{referee.cardsPerMatch !== null ? `${formatLine(referee.cardsPerMatch)} tarjetas/partido` : '—'}</strong>
            </div>
          ) : null}
          {weather ? (
            <div className="context-line">
              <span>{weather.description ?? 'Clima'}</span>
              <strong>
                {weather.temperatureC !== null ? `${weather.temperatureC} °C` : '—'}
                {weather.precipitationPct !== null ? ` · ${weather.precipitationPct} % lluvia` : ''}
              </strong>
            </div>
          ) : null}
        </div>
      )}

      {(insights.length > 0 || quality.caveats.length > 0 || quality.signals.length > 0) && (
        <div className="context-block">
          <h3>Advertencias y señales</h3>
          {quality.caveats.length > 0 ? (
            <ul className="caveat-list">
              {quality.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          ) : null}
          {quality.signals.length > 0 ? (
            <ul className="caveat-list" style={{ marginTop: '8px' }}>
              {quality.signals.slice(0, 6).map((signal) => (
                <li key={signal}>{signal}</li>
              ))}
            </ul>
          ) : null}
          {insights.length > 0 ? (
            <ul className="caveat-list" style={{ marginTop: '8px', color: 'var(--text-muted)' }}>
              {insights.slice(0, 5).map((insight) => (
                <li key={insight}>{insight}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </aside>
  );
}

'use client';

import type { ParlaySuggestion } from '@/lib/types/analysis';
import { formatOdds, formatPct } from '@/lib/ui/format';

interface Props {
  parlay: ParlaySuggestion | null;
}

export default function ParlayCard({ parlay }: Props) {
  return (
    <section className="parlay-card" id="combinada" aria-labelledby="combinada-title">
      <div className="parlay-head">
        <h2 className="parlay-title" id="combinada-title">
          Combinada sugerida
        </h2>
        {parlay ? <span className="parlay-prob">{formatPct(parlay.probability)}</span> : null}
      </div>

      {parlay ? (
        <>
          <ul className="parlay-legs">
            {parlay.legs.map((leg) => (
              <li className="parlay-leg" key={leg.marketKey}>
                <span>
                  <small>{leg.market}</small>
                  {leg.selection}
                </span>
                <span className="leg-prob">{formatPct(leg.probability)}</span>
              </li>
            ))}
          </ul>

          <div className="parlay-totals">
            <div>
              <span>Probabilidad conjunta</span>
              <strong>{formatPct(parlay.probability)}</strong>
            </div>
            <div>
              <span>Cuota justa</span>
              <strong>{formatOdds(parlay.fairOdds)}</strong>
            </div>
          </div>

          <p className="parlay-note">
            Correlación incorporada. {parlay.correlationNote}
          </p>
        </>
      ) : (
        <div className="parlay-empty">
          <p style={{ color: 'var(--text)', fontSize: '15px', fontWeight: 600 }}>
            Sin combinada para este partido
          </p>
          <p>
            No hay al menos dos selecciones que cumplan probabilidad y conjunta mínima. Revisa los
            mercados individuales.
          </p>
        </div>
      )}
    </section>
  );
}

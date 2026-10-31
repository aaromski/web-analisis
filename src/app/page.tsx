import { Suspense } from 'react';
import ParleyApp from '@/components/ParleyApp';
import ShadowSection from '@/components/ShadowSection';
import { getLabSummary, type LabSummary } from '@/lib/server/db';

function BootFallback() {
  return (
    <div className="container">
      <div className="skeleton" aria-hidden="true">
        <div className="skeleton-block" data-variant="header" />
        <div className="skeleton-grid">
          <div className="skeleton-block" data-variant="card" />
          <div className="skeleton-block" data-variant="card" />
        </div>
      </div>
    </div>
  );
}

/** La sombra nunca debe tumbar el dashboard: si falla, se declara error de sección. */
function fallbackSummary(): LabSummary {
  return { state: 'error', matchesWithResult: 0, required: 100, markets: [], backtest: null, engine: { promoted: null, candidates: [], reference: null } };
}

export default async function HomePage() {
  let lab: LabSummary;
  try {
    lab = await getLabSummary();
  } catch {
    lab = fallbackSummary();
  }

  return (
    <Suspense fallback={<BootFallback />}>
      <ParleyApp shadow={<ShadowSection summary={lab} />} />
    </Suspense>
  );
}

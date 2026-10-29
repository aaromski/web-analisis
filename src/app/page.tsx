import { Suspense } from 'react';
import ParleyApp from '@/components/ParleyApp';

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

export default function HomePage() {
  return (
    <Suspense fallback={<BootFallback />}>
      <ParleyApp />
    </Suspense>
  );
}

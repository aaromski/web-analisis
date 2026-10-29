interface Props {
  variant?: 'dashboard' | 'markets' | 'ai';
}

export default function Skeleton({ variant = 'dashboard' }: Props) {
  if (variant === 'markets') {
    return (
      <div className="skeleton" aria-hidden="true">
        <div className="skeleton-grid">
          <div className="skeleton-block" data-variant="card" />
          <div className="skeleton-block" data-variant="card" />
          <div className="skeleton-block" data-variant="card" />
          <div className="skeleton-block" data-variant="card" />
        </div>
      </div>
    );
  }

  if (variant === 'ai') {
    return (
      <div className="skeleton" aria-hidden="true">
        <div className="skeleton-block" style={{ height: 160 }} />
      </div>
    );
  }

  return (
    <div className="skeleton" aria-hidden="true">
      <div className="skeleton-block" data-variant="header" />
      <div className="skeleton-grid">
        <div className="skeleton-block" data-variant="card" />
        <div className="skeleton-block" data-variant="card" />
      </div>
    </div>
  );
}

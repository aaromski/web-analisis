'use client';

import type { MatchSummary } from '@/lib/types/analysis';
import { formatKickoff, formatMatchDate, monogram } from '@/lib/ui/format';

interface Props {
  match: MatchSummary;
  onNewSearch: () => void;
}

function statusLabel(status: MatchSummary['status']): string {
  if (status === 'scheduled') return 'Programado';
  if (status === 'finished') return 'Finalizado';
  if (status === 'live') return 'En juego';
  return 'Estado no confirmado';
}

export default function MatchHeader({ match, onNewSearch }: Props) {
  const hasScore = match.score.home !== null && match.score.away !== null;

  return (
    <header className="match-header">
      <div className="match-meta">
        <span>{match.leagueName}</span>
        {match.season ? <span>{match.season}</span> : null}
        <span className="status-pill" data-status={match.status}>
          {statusLabel(match.status)}
        </span>
        <button type="button" className="btn btn-ghost" onClick={onNewSearch}>
          ← Nueva búsqueda
        </button>
      </div>

      <h1 className="visually-hidden" tabIndex={-1}>
        {match.homeName} contra {match.awayName}
      </h1>

      <div className="match-grid">
        <div className="team">
          <span className="monogram" aria-hidden="true">
            {monogram(match.homeName)}
          </span>
          <span className="team-name">{match.homeName}</span>
        </div>

        <div className="kickoff">
          {hasScore ? (
            <span className="kickoff-time">
              {match.score.home} – {match.score.away}
            </span>
          ) : (
            <span className="kickoff-time">{formatKickoff(match.date)}</span>
          )}
          <span className="kickoff-venue">
            {formatMatchDate(match.date)}
            {match.venue ? ` · ${match.venue}` : ''}
          </span>
        </div>

        <div className="team away">
          <span className="monogram" aria-hidden="true">
            {monogram(match.awayName)}
          </span>
          <span className="team-name">{match.awayName}</span>
        </div>
      </div>
    </header>
  );
}

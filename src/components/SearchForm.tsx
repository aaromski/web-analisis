'use client';

import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { displayDate, parseDisplayDate } from '@/lib/ui/format';

export type SearchMode = 'teams' | 'id';

export interface SearchPayload {
  matchId?: string;
  home?: string;
  away?: string;
  date?: string;
  league?: string;
}

interface Props {
  initial: {
    mode: SearchMode;
    home: string;
    away: string;
    date: string;
    league: string;
    matchId: string;
  };
  busy: boolean;
  onSubmit: (payload: SearchPayload) => void;
}

interface FieldErrors {
  home?: string;
  away?: string;
  date?: string;
  league?: string;
  matchId?: string;
}

const LEAGUE_SLUG = /^[a-z0-9._-]{1,50}$/;

export default function SearchForm({ initial, busy, onSubmit }: Props) {
  const [mode, setMode] = useState<SearchMode>(initial.mode);
  const [home, setHome] = useState(initial.home);
  const [away, setAway] = useState(initial.away);
  const [date, setDate] = useState(displayDate(initial.date));
  const [league, setLeague] = useState(initial.league);
  const [matchId, setMatchId] = useState(initial.matchId);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);

  function focusField(name: keyof FieldErrors) {
    const element = document.getElementById(`buscar-${name}`);
    element?.focus();
  }

  function switchMode(next: SearchMode) {
    setMode(next);
    setErrors({});
    setFormError(null);
  }

  function handleModeKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next: SearchMode = mode === 'teams' ? 'id' : 'teams';
    switchMode(next);
    document.getElementById(`modo-${next}`)?.focus();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const nextErrors: FieldErrors = {};

    if (mode === 'id') {
      const value = matchId.trim();
      if (!value) {
        nextErrors.matchId = 'Introduce el ID del partido.';
      } else if (!/^[A-Za-z0-9._:-]{1,300}$/.test(value)) {
        nextErrors.matchId = 'El ID contiene caracteres no permitidos.';
      }
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length > 0) {
        setFormError('Revisa los campos marcados.');
        focusField('matchId');
        return;
      }
      onSubmit({ matchId: value });
      return;
    }

    const homeValue = home.trim();
    const awayValue = away.trim();
    if (!homeValue) nextErrors.home = 'Escribe el equipo local.';
    if (!awayValue) nextErrors.away = 'Escribe el equipo visitante.';
    if (homeValue && awayValue && homeValue.toLowerCase() === awayValue.toLowerCase()) {
      nextErrors.away = 'El local y el visitante deben ser equipos distintos.';
    }
    if (date.trim()) {
      const iso = parseDisplayDate(date);
      if (!iso) nextErrors.date = 'Usa dd/mm/aaaa o deja el campo vacío.';
    }
    const leagueValue = league.trim().toLowerCase();
    if (leagueValue && !LEAGUE_SLUG.test(leagueValue)) {
      nextErrors.league = 'Usa el slug de la liga, por ejemplo ita.1.';
    }

    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      setFormError('Revisa los campos marcados.');
      const first = (['home', 'away', 'date', 'league'] as const).find((key) => nextErrors[key]);
      if (first) focusField(first);
      return;
    }

    onSubmit({
      home: homeValue,
      away: awayValue,
      ...(date.trim() ? { date: parseDisplayDate(date) ?? undefined } : {}),
      ...(leagueValue ? { league: leagueValue } : {}),
    });
  }

  return (
    <form className="search-panel" onSubmit={handleSubmit} noValidate aria-busy={busy}>
      <p className="panel-title" id="buscador-titulo">
        Buscar partido
      </p>

      <div
        className="segmented"
        role="radiogroup"
        aria-labelledby="buscador-titulo"
        onKeyDown={handleModeKey}
      >
        <button
          type="button"
          id="modo-teams"
          role="radio"
          aria-checked={mode === 'teams'}
          tabIndex={mode === 'teams' ? 0 : -1}
          onClick={() => switchMode('teams')}
        >
          Por equipos
        </button>
        <button
          type="button"
          id="modo-id"
          role="radio"
          aria-checked={mode === 'id'}
          tabIndex={mode === 'id' ? 0 : -1}
          onClick={() => switchMode('id')}
        >
          Por ID
        </button>
      </div>

      {mode === 'teams' ? (
        <div className="field-grid">
          <div className="field">
            <label htmlFor="buscar-home">Equipo local</label>
            <input
              id="buscar-home"
              name="home"
              type="text"
              autoComplete="off"
              placeholder="Ej. Milan"
              value={home}
              onChange={(event) => setHome(event.target.value)}
              aria-invalid={Boolean(errors.home)}
              aria-describedby={errors.home ? 'error-home' : undefined}
              disabled={busy}
              required
            />
            {errors.home ? (
              <p className="field-error" id="error-home">
                {errors.home}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="buscar-away">Equipo visitante</label>
            <input
              id="buscar-away"
              name="away"
              type="text"
              autoComplete="off"
              placeholder="Ej. Inter"
              value={away}
              onChange={(event) => setAway(event.target.value)}
              aria-invalid={Boolean(errors.away)}
              aria-describedby={errors.away ? 'error-away' : undefined}
              disabled={busy}
              required
            />
            {errors.away ? (
              <p className="field-error" id="error-away">
                {errors.away}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="buscar-date">Fecha</label>
            <input
              id="buscar-date"
              name="date"
              type="text"
              inputMode="numeric"
              placeholder="dd/mm/aaaa"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              aria-invalid={Boolean(errors.date)}
              aria-describedby={errors.date ? 'error-date' : 'ayuda-date'}
              disabled={busy}
            />
            {errors.date ? (
              <p className="field-error" id="error-date">
                {errors.date}
              </p>
            ) : (
              <p className="hint" id="ayuda-date">
                Opcional. Ayuda a resolver el partido correcto.
              </p>
            )}
          </div>

          <div className="field">
            <label htmlFor="buscar-league">Liga</label>
            <input
              id="buscar-league"
              name="league"
              type="text"
              autoComplete="off"
              placeholder="Ej. ita.1"
              value={league}
              onChange={(event) => setLeague(event.target.value)}
              aria-invalid={Boolean(errors.league)}
              aria-describedby={errors.league ? 'error-league' : 'ayuda-league'}
              disabled={busy}
            />
            {errors.league ? (
              <p className="field-error" id="error-league">
                {errors.league}
              </p>
            ) : (
              <p className="hint" id="ayuda-league">
                Opcional. Slug de la API: ita.1, eng.1, esp.1.
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="field-grid">
          <div className="field">
            <label htmlFor="buscar-matchId">ID del partido</label>
            <input
              id="buscar-matchId"
              name="matchId"
              type="text"
              autoComplete="off"
              placeholder="Pega el ID del partido"
              value={matchId}
              onChange={(event) => setMatchId(event.target.value)}
              aria-invalid={Boolean(errors.matchId)}
              aria-describedby={errors.matchId ? 'error-matchId' : 'ayuda-matchId'}
              disabled={busy}
            />
            {errors.matchId ? (
              <p className="field-error" id="error-matchId">
                {errors.matchId}
              </p>
            ) : (
              <p className="hint" id="ayuda-matchId">
                El identificador que devuelve la API de estadísticas.
              </p>
            )}
          </div>
        </div>
      )}

      {formError ? (
        <p className="form-error" role="alert">
          {formError}
        </p>
      ) : null}

      <div className="submit-row">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Analizando…' : 'Analizar partido'}
          <span aria-hidden="true">→</span>
        </button>
        <span className="method">Datos → matriz → línea calibrada</span>
      </div>
    </form>
  );
}

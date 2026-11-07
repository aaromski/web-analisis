'use client';

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { FixtureMatch, FixturesResponse } from '@/lib/types/fixtures';
import { formatKickoff } from '@/lib/ui/format';
import {
  CUSTOM_LEAGUES_KEY,
  KNOWN_LEAGUES,
  LAST_LEAGUE_KEY,
  isLeagueSlug,
  mergeLeagues,
} from '@/lib/ui/leagues';

type FixtureLoad =
  | { phase: 'loading' }
  | { phase: 'ready'; matches: FixtureMatch[]; date: string }
  | { phase: 'error'; message: string };

interface ApiErrorShape {
  error?: { message?: string };
}

const dayLabel = new Intl.DateTimeFormat('es-ES', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  timeZone: 'Europe/Madrid',
});

function formatDay(iso: string): string {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  const formatted = dayLabel.format(date);
  return formatted.charAt(0).toUpperCase() + formatted.slice(1);
}

function readCustomLeagues(): string[] {
  try {
    const raw = window.localStorage.getItem(CUSTOM_LEAGUES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === 'string' && isLeagueSlug(value));
  } catch {
    return [];
  }
}

function readLastLeague(): string | null {
  try {
    const value = window.localStorage.getItem(LAST_LEAGUE_KEY);
    return value && isLeagueSlug(value) ? value : null;
  } catch {
    return null;
  }
}

interface Props {
  initialLeague?: string;
  disabled?: boolean;
  onSelect: (matchId: string) => void;
}

export default function LeagueMatchPicker({ initialLeague, disabled = false, onSelect }: Props) {
  const [custom, setCustom] = useState<string[]>([]);
  const [active, setActive] = useState(initialLeague || KNOWN_LEAGUES[0].slug);
  const [hydrated, setHydrated] = useState(false);
  const [load, setLoad] = useState<FixtureLoad>({ phase: 'loading' });
  const [reload, setReload] = useState(0);
  const [draft, setDraft] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const leagues = useMemo(() => mergeLeagues(custom), [custom]);
  const activeLeague = leagues.find((league) => league.slug === active);
  const isCustom = custom.includes(active);

  useEffect(() => {
    const stored = readCustomLeagues();
    setCustom(stored);
    const known = new Set(mergeLeagues(stored).map((league) => league.slug));
    if (initialLeague) {
      if (!known.has(initialLeague)) {
        const next = [...stored, initialLeague];
        setCustom(next);
        persistCustom(next);
      }
      setActive(initialLeague);
    } else {
      const last = readLastLeague();
      if (last && known.has(last)) setActive(last);
    }
    setHydrated(true);
  }, [initialLeague]);

  useEffect(() => {
    if (!hydrated) return;
    const controller = new AbortController();
    setLoad({ phase: 'loading' });

    (async () => {
      try {
        const response = await fetch(`/api/fixtures?league=${encodeURIComponent(active)}`, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });
        const payload = (await response.json().catch(() => null)) as
          | (FixturesResponse & ApiErrorShape)
          | null;
        if (controller.signal.aborted) return;
        if (!response.ok || !payload?.matches) {
          setLoad({
            phase: 'error',
            message: payload?.error?.message ?? 'No pudimos cargar los partidos de esta liga.',
          });
          return;
        }
        setLoad({ phase: 'ready', matches: payload.matches, date: payload.date });
      } catch (caught) {
        if (controller.signal.aborted || (caught instanceof Error && caught.name === 'AbortError')) {
          return;
        }
        setLoad({
          phase: 'error',
          message: 'No pudimos conectar con la fuente del calendario. Vuelve a intentarlo.',
        });
      }
    })();

    return () => controller.abort();
  }, [hydrated, active, reload]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(LAST_LEAGUE_KEY, active);
    } catch {
      // Sin almacenamiento la selección funciona igual, solo no se recuerda.
    }
  }, [hydrated, active]);

  const changeLeague = useCallback((slug: string) => {
    setActive(slug);
    setAddError(null);
  }, []);

  function persistCustom(next: string[]) {
    try {
      window.localStorage.setItem(CUSTOM_LEAGUES_KEY, JSON.stringify(next));
    } catch {
      // La liga queda disponible en esta sesión aunque no se pueda persistir.
    }
  }

  function addLeague() {
    const slug = draft.trim().toLowerCase();
    if (!slug) {
      setAddError('Escribe el slug de la liga.');
      return;
    }
    if (!isLeagueSlug(slug)) {
      setAddError('Usa minúsculas, números, punto o guion. Ejemplo: usa.1.');
      return;
    }
    if (!custom.includes(slug) && !KNOWN_LEAGUES.some((league) => league.slug === slug)) {
      const next = [...custom, slug];
      setCustom(next);
      persistCustom(next);
    }
    setDraft('');
    setAddError(null);
    changeLeague(slug);
  }

  function removeLeague() {
    const next = custom.filter((slug) => slug !== active);
    setCustom(next);
    persistCustom(next);
    changeLeague(KNOWN_LEAGUES[0].slug);
  }

  function handleDraftKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addLeague();
  }

  return (
    <div className="league-picker">
      <div className="field">
        <label htmlFor="buscar-liga-select">Liga</label>
        <select
          id="buscar-liga-select"
          value={active}
          onChange={(event) => changeLeague(event.target.value)}
          disabled={disabled}
        >
          <optgroup label="Ligas que ya usas">
            {leagues
              .filter((league) => league.country !== 'Añadida')
              .map((league) => (
                <option key={league.slug} value={league.slug}>
                  {league.name} · {league.country}
                </option>
              ))}
          </optgroup>
          {leagues.some((league) => league.country === 'Añadida') ? (
            <optgroup label="Añadidas">
              {leagues
                .filter((league) => league.country === 'Añadida')
                .map((league) => (
                  <option key={league.slug} value={league.slug}>
                    {league.name}
                  </option>
                ))}
            </optgroup>
          ) : null}
        </select>
      </div>

      <div className="fixture-panel" aria-live="polite">
        {load.phase === 'loading' ? (
          <>
            <p className="fixture-head">
              <span>Cargando partidos…</span>
              <span className="fixture-count">Hoy</span>
            </p>
            <ul className="fixture-list" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <li key={index} className="fixture-row fixture-row-loading" />
              ))}
            </ul>
          </>
        ) : null}

        {load.phase === 'error' ? (
          <div className="fixture-empty">
            <p>{load.message}</p>
            <button type="button" className="btn btn-ghost" onClick={() => setReload((value) => value + 1)}>
              Reintentar
            </button>
          </div>
        ) : null}

        {load.phase === 'ready' ? (
          <>
            <p className="fixture-head">
              <span>{formatDay(load.date)}</span>
              <span className="fixture-count">
                {load.matches.length === 0
                  ? 'Sin partidos'
                  : `${load.matches.length} ${load.matches.length === 1 ? 'partido' : 'partidos'}`}
              </span>
            </p>
            {load.matches.length === 0 ? (
              <div className="fixture-empty">
                <p>
                  No hay partidos de {activeLeague?.name ?? active} hoy. Prueba otra liga o busca por
                  equipos.
                </p>
              </div>
            ) : (
              <ul className="fixture-list">
                {load.matches.map((match) => {
                  const playable = match.status === 'scheduled';
                  const showScore =
                    (match.status === 'live' || match.status === 'finished') &&
                    match.homeScore !== null &&
                    match.awayScore !== null;
                  return (
                    <li key={match.id}>
                      <button
                        type="button"
                        className="fixture-row"
                        onClick={() => onSelect(match.id)}
                        disabled={disabled || !playable}
                        title={
                          playable
                            ? `Analizar ${match.home} vs ${match.away}`
                            : 'El análisis es pre-partido; este encuentro ya no se puede proyectar.'
                        }
                      >
                        <span className="fixture-time">{formatKickoff(match.kickoff)}</span>
                        <span className="fixture-teams">
                          <span>{match.home}</span>
                          <span className="fixture-vs">vs</span>
                          <span>{match.away}</span>
                          {showScore ? (
                            <span className="fixture-score">
                              {match.homeScore}–{match.awayScore}
                            </span>
                          ) : null}
                        </span>
                        <span className="fixture-state" data-state={match.status}>
                          {match.statusLabel}
                        </span>
                        <span className="fixture-arrow" aria-hidden="true">
                          →
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : null}
      </div>

      <div className="league-add">
        <label htmlFor="buscar-liga-nueva">Añadir otra liga</label>
        <div className="league-add-row">
          <input
            id="buscar-liga-nueva"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="Slug de ESPN, ej. usa.1"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleDraftKey}
            aria-invalid={Boolean(addError)}
            aria-describedby={addError ? 'error-liga-nueva' : 'ayuda-liga-nueva'}
            disabled={disabled}
          />
          <button type="button" className="btn" onClick={addLeague} disabled={disabled}>
            Añadir
          </button>
        </div>
        {addError ? (
          <p className="field-error" id="error-liga-nueva" role="alert">
            {addError}
          </p>
        ) : (
          <p className="hint" id="ayuda-liga-nueva">
            Se guarda en este navegador. Ejemplos: eng.1, ned.1, uefa.champions.
          </p>
        )}
        {isCustom ? (
          <button type="button" className="league-remove" onClick={removeLeague} disabled={disabled}>
            Quitar «{active}» de mis ligas
          </button>
        ) : null}
      </div>
    </div>
  );
}

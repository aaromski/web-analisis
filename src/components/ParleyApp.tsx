'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  AiReport,
  AnalysisEnvelope,
  AnalysisResult,
} from '@/lib/types/analysis';
import { formatMatchDate } from '@/lib/ui/format';
import SearchForm, { type SearchMode, type SearchPayload } from './SearchForm';
import MatchHeader from './MatchHeader';
import SummaryStrip from './SummaryStrip';
import MarketCard from './MarketCard';
import ParlayCard from './ParlayCard';
import ContextPanel from './ContextPanel';
import AiPanel, { type AiState } from './AiPanel';
import ErrorState from './ErrorState';
import Skeleton from './Skeleton';

type Phase = 'idle' | 'loading' | 'ready' | 'error';

interface UiError {
  kind: 'api' | 'notfound' | 'not-projectable' | 'generic';
  title: string;
  message: string;
  meta?: string[];
}

interface ApiErrorShape {
  error?: { code?: string; message?: string; details?: unknown };
}

function requestFromParams(params: URLSearchParams): SearchPayload | null {
  const matchId = params.get('id')?.trim();
  if (matchId) return { matchId };
  const home = params.get('home')?.trim();
  const away = params.get('away')?.trim();
  if (!home || !away) return null;
  const date = params.get('date')?.trim();
  const league = params.get('league')?.trim();
  return {
    home,
    away,
    ...(date ? { date } : {}),
    ...(league ? { league } : {}),
  };
}

function mapError(status: number, payload: ApiErrorShape | null): UiError {
  const code = payload?.error?.code ?? '';
  const message = payload?.error?.message ?? '';
  const details = payload?.error?.details;

  if (code === 'MATCH_NOT_PROJECTABLE') {
    const data = (details ?? {}) as {
      status?: string;
      score?: { home?: number | null; away?: number | null };
      home?: string;
      away?: string;
      date?: string;
    };
    const live = data.status === 'live';
    const meta: string[] = [];
    if (data.home && data.away) meta.push(`${data.home} vs ${data.away}`);
    if (data.score && data.score.home !== null && data.score.home !== undefined) {
      meta.push(`${data.score.home} – ${data.score.away}`);
    }
    if (data.date) meta.push(formatMatchDate(data.date));
    return {
      kind: 'not-projectable',
      title: live ? 'El partido está en juego' : 'Este partido ya finalizó',
      message: 'El motor calibra líneas antes del inicio. Elige un partido programado para ver el análisis.',
      meta,
    };
  }

  if (status === 404 || code === 'MATCH_NOT_FOUND' || code === 'NOT_FOUND') {
    return {
      kind: 'notfound',
      title: 'No encontramos ese partido',
      message: 'Revisa los nombres, la fecha o la liga. Si conoces el ID, busca por esa vía.',
    };
  }

  if (code === 'STATS_API_DOWN' || code === 'STATS_API_TIMEOUT' || code === 'TIMEOUT') {
    return {
      kind: 'api',
      title: 'No pudimos conectar con la API',
      message:
        message ||
        'El servicio de estadísticas no respondió. Comprueba que esté activo y vuelve a intentarlo.',
    };
  }

  if (code === 'INVALID_INPUT') {
    return {
      kind: 'generic',
      title: 'Revisa la búsqueda',
      message: message || 'Los datos introducidos no son válidos para la API de estadísticas.',
    };
  }

  if (code === 'MISSING_TEAMS' || code === 'INVALID_RESPONSE') {
    return {
      kind: 'generic',
      title: 'La API devolvió datos incompletos',
      message:
        message ||
        'La respuesta no incluye los equipos o las estadísticas necesarias. Prueba con otro partido o un ID concreto.',
    };
  }

  return {
    kind: 'api',
    title: 'No pudimos completar el análisis',
    message: message || 'La API de estadísticas devolvió un error inesperado. Vuelve a intentarlo.',
  };
}

interface ParleyAppProps {
  /** Sección experimental renderizada en servidor; se coloca tras el análisis de producción. */
  shadow?: ReactNode;
}

export default function ParleyApp({ shadow }: ParleyAppProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();
  const request = useMemo(() => requestFromParams(new URLSearchParams(searchKey)), [searchKey]);

  const [phase, setPhase] = useState<Phase>(request ? 'loading' : 'idle');
  const [envelope, setEnvelope] = useState<AnalysisEnvelope | null>(null);
  const [error, setError] = useState<UiError | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [aiState, setAiState] = useState<AiState>('idle');
  const [aiReport, setAiReport] = useState<AiReport | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const aiControllerRef = useRef<AbortController | null>(null);
  const searchKeyRef = useRef(searchKey);

  // Al cambiar de partido se cancela cualquier informe en vuelo para que una
  // respuesta tardía no se aplique sobre el análisis nuevo.
  useEffect(() => {
    searchKeyRef.current = searchKey;
    return () => {
      aiControllerRef.current?.abort();
      aiControllerRef.current = null;
    };
  }, [searchKey]);

  useEffect(() => {
    if (!request) {
      setPhase('idle');
      setEnvelope(null);
      setError(null);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    setPhase('loading');
    setError(null);
    setEnvelope(null);
    setAiState('idle');
    setAiReport(null);
    setAiError(null);

    (async () => {
      try {
        const response = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(request),
          signal: controller.signal,
        });
        const payload = (await response.json().catch(() => null)) as
          | (AnalysisEnvelope & ApiErrorShape)
          | null;
        if (cancelled) return;
        if (!response.ok || !payload?.analysis) {
          setError(mapError(response.status, payload));
          setPhase('error');
          return;
        }
        setEnvelope(payload);
        setPhase('ready');
      } catch (caught) {
        if (cancelled || (caught instanceof Error && caught.name === 'AbortError')) return;
        setError({
          kind: 'api',
          title: 'No pudimos conectar con la API',
          message:
            'El servicio de estadísticas no respondió. Comprueba que esté activo y vuelve a intentarlo.',
        });
        setPhase('error');
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `request` se deriva de searchKey; attempt permite reintentar la misma consulta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchKey, attempt]);

  useEffect(() => {
    if (phase === 'ready') {
      document.querySelector<HTMLElement>('.match-header h1')?.focus();
    }
  }, [phase]);

  const handleSearch = useCallback(
    (payload: SearchPayload) => {
      const params = new URLSearchParams();
      if (payload.matchId) {
        params.set('id', payload.matchId);
      } else {
        if (payload.home) params.set('home', payload.home);
        if (payload.away) params.set('away', payload.away);
        if (payload.date) params.set('date', payload.date);
        if (payload.league) params.set('league', payload.league);
      }
      const nextKey = params.toString();
      window.scrollTo({ top: 0, behavior: 'auto' });
      if (nextKey === searchKey) {
        setAttempt((value) => value + 1);
        return;
      }
      router.replace(`/?${nextKey}`, { scroll: false });
    },
    [router, searchKey],
  );

  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const goHome = useCallback(() => router.push('/'), [router]);
  const goHomeById = useCallback(() => router.push('/?modo=id'), [router]);

  const generateAi = useCallback(async () => {
    if (!request) return;
    const key = searchKey;
    aiControllerRef.current?.abort();
    const controller = new AbortController();
    aiControllerRef.current = controller;
    setAiState('loading');
    setAiError(null);
    try {
      const response = await fetch('/api/ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as
        | (AiReport & ApiErrorShape)
        | null;
      if (controller.signal.aborted || searchKeyRef.current !== key) return;
      if (!response.ok || !payload?.report) {
        setAiError(
          payload?.error?.message ??
            'Gemini no respondió o devolvió un error. El análisis del motor sigue disponible.',
        );
        setAiState('error');
        return;
      }
      setAiReport(payload);
      setAiState('success');
    } catch (caught) {
      if (controller.signal.aborted || (caught instanceof Error && caught.name === 'AbortError')) return;
      if (searchKeyRef.current !== key) return;
      setAiError('No se pudo conectar con el servicio de IA. Revisa tu conexión y vuelve a intentarlo.');
      setAiState('error');
    } finally {
      if (aiControllerRef.current === controller) aiControllerRef.current = null;
    }
  }, [request, searchKey]);

  const mode: SearchMode = searchParams.get('modo') === 'id' || searchParams.get('id') ? 'id' : 'teams';
  const initialForm = {
    mode,
    home: searchParams.get('home') ?? '',
    away: searchParams.get('away') ?? '',
    date: searchParams.get('date') ?? '',
    league: searchParams.get('league') ?? '',
    matchId: searchParams.get('id') ?? '',
  };

  return (
    <>
      <header className="site-header">
        <div className="container">
          <a className="brand" href="/" onClick={(event) => { event.preventDefault(); goHome(); }}>
            Parley Lab
          </a>
          <div className="header-meta">
            <span className="motor">Motor v1.0.0 · Juego responsable</span>
            <span className="badge-18">18+</span>
          </div>
        </div>
      </header>

      <a className="skip-link" href="#contenido">
        Saltar al contenido
      </a>

      <main id="contenido">
        {!request ? (
          <div className="container">
            <section className="hero" aria-labelledby="hero-title">
              <span className="eyebrow">Análisis pre-partido</span>
              <h1 className="display" id="hero-title">
                La línea correcta, antes del pitido inicial.
              </h1>
              <p className="lead">
                Analiza el partido. El motor calcula los goles esperados, la matriz de marcadores y la
                línea que mejor sostiene la confianza.
              </p>
            </section>

            <SearchForm initial={initialForm} busy={false} onSubmit={handleSearch} />

            <p className="responsible" style={{ borderTop: 0, marginTop: '20px', paddingTop: 0 }}>
              Análisis estimativo. No garantiza resultados. Juego responsable · 18+
            </p>
          </div>
        ) : null}

        {request && phase === 'loading' ? (
          <div className="container dashboard">
            <p className="visually-hidden" role="status" aria-live="polite">
              Analizando el partido. Consultando estadísticas, calculando la matriz y calibrando líneas.
            </p>
            <div className="loading-panel" aria-busy="true">
              <p className="panel-title" style={{ margin: 0 }}>
                Analizando el partido
              </p>
              <ul className="stage-list">
                <li data-active="true">Consultando estadísticas…</li>
                <li>Ajustando forma y cuotas…</li>
                <li>Calculando λ y la matriz…</li>
                <li>Calibrando líneas y combinada…</li>
              </ul>
            </div>
            <Skeleton variant="dashboard" />
          </div>
        ) : null}

        {request && phase === 'error' && error ? (
          <div className="container dashboard">
            <ErrorState
              kind={error.kind}
              title={error.title}
              message={error.message}
              meta={error.meta}
              primary={
                error.kind === 'not-projectable'
                  ? { label: 'Elegir otro partido', onClick: goHome }
                  : { label: 'Reintentar', onClick: retry }
              }
              secondary={
                error.kind === 'not-projectable'
                  ? { label: 'Reintentar', onClick: retry }
                  : error.kind === 'notfound'
                    ? { label: 'Buscar por ID', onClick: goHomeById }
                    : { label: 'Cambiar búsqueda', onClick: goHome }
              }
            />
          </div>
        ) : null}

        {request && phase === 'ready' && envelope ? (
          <>
            <Dashboard
              envelope={envelope}
              aiState={aiState}
              aiReport={aiReport}
              aiError={aiError}
              onGenerate={generateAi}
              onNewSearch={goHome}
            />
            {shadow}
          </>
        ) : null}
      </main>

      <Footer />
    </>
  );
}

interface DashboardProps {
  envelope: AnalysisEnvelope;
  aiState: AiState;
  aiReport: AiReport | null;
  aiError: string | null;
  onGenerate: () => void;
  onNewSearch: () => void;
}

function Dashboard({ envelope, aiState, aiReport, aiError, onGenerate, onNewSearch }: DashboardProps) {
  const analysis: AnalysisResult = envelope.analysis;
  const { dataQuality, markets, parlay, context, model } = analysis;
  const objectiveMarkets = markets.filter((market) => market.key !== 'corners');
  const extendedMarkets = markets.filter((market) => market.key === 'corners');

  return (
    <div className="container dashboard">
      <div className="dash-top">
        <nav className="dash-nav" aria-label="Secciones del análisis">
          <a href="#mercados">Mercados</a>
          <a href="#combinada">Combinada</a>
          <a href="#ia">Análisis IA</a>
          <a href="#contexto">Contexto</a>
          <a className="dash-nav-muted" href="#sombra">
            Sombra
          </a>
        </nav>
        <span className="method">
          Modelo v{model.version} · ρ {model.rho} · {envelope.source.coverage ? `${envelope.source.coverage.available}/${envelope.source.coverage.total} secciones` : 'cobertura parcial'}
        </span>
      </div>

      <MatchHeader match={analysis.match} onNewSearch={onNewSearch} />
      <SummaryStrip analysis={analysis} />

      {dataQuality.insufficient ? (
        <div className="quality-band" role="status">
          <strong>Análisis limitado · Datos insuficientes para calibrar</strong>
          <p>
            La cobertura estadística es baja. Las probabilidades se apoyan en medias de liga y deben
            leerse como referencia.
          </p>
          <a href="#contexto">Ver datos</a>
        </div>
      ) : null}

      <div className="layout">
        <div className="area-markets">
          <section id="mercados" aria-labelledby="mercados-title">
            <div className="section-head">
              <h2 className="section-title" id="mercados-title">
                Mercados · 9 objetivos + córners
              </h2>
              <span className="section-count">{markets.length} mercados</span>
            </div>
            <div className="market-grid">
              {objectiveMarkets.map((market) => (
                <MarketCard key={market.key} market={market} index={market.index} />
              ))}
            </div>

            {extendedMarkets.length > 0 ? (
              <>
                <div className="extended-divider">Mercado extendido</div>
                <div className="market-grid extended">
                  {extendedMarkets.map((market) => (
                    <MarketCard key={market.key} market={market} index={market.index} />
                  ))}
                </div>
              </>
            ) : null}
          </section>
        </div>

        <div className="area-parlay">
          <ParlayCard parlay={parlay} />
        </div>

        <div className="area-ai">
          <AiPanel state={aiState} report={aiReport} error={aiError} onGenerate={onGenerate} />
        </div>

        <div className="area-context">
          <ContextPanel context={context} quality={dataQuality} />
        </div>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="site-footer">
      <div className="container">
        <p>
          Parley Lab es una herramienta de análisis estadístico. No es una casa de apuestas, no acepta
          apuestas y no ofrece consejo financiero. Las probabilidades son estimaciones del modelo y no
          garantizan ningún resultado. Si el juego deja de ser un entretenimiento, busca ayuda
          profesional.
        </p>
        <p>Datos → matriz → línea calibrada · Juego responsable · 18+</p>
      </div>
    </footer>
  );
}

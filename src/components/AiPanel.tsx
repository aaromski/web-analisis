'use client';

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AiReport } from '@/lib/types/analysis';

export type AiState = 'idle' | 'loading' | 'success' | 'error';

interface Props {
  state: AiState;
  report: AiReport | null;
  error: string | null;
  onGenerate: () => void;
}

export default function AiPanel({ state, report, error, onGenerate }: Props) {
  const busy = state === 'loading';

  return (
    <section className="ai-panel" id="ia" aria-labelledby="ia-title">
      <div className="ai-head">
        <div>
          <h2 className="ai-title" id="ia-title">
            Análisis IA · Gemini
          </h2>
          <p className="ai-sub">
            Un informe en español que explica la lectura del partido, la línea elegida y los riesgos.
            Usa solo los datos de este análisis.
          </p>
        </div>
        {state === 'idle' ? (
          <button type="button" className="btn btn-primary" onClick={onGenerate}>
            Generar informe
          </button>
        ) : null}
        {state === 'success' ? (
          <button type="button" className="btn" onClick={onGenerate} disabled={busy}>
            Regenerar informe
          </button>
        ) : null}
      </div>

      <div className="ai-body" aria-live="polite">
        {state === 'loading' ? (
          <div className="ai-loading">
            <span>
              <strong style={{ color: 'var(--text)' }}>Redactando el informe…</strong>
              <br />
              <span style={{ fontSize: '13px' }}>Gemini está leyendo el análisis del motor. Suele tardar entre 15 y 40 segundos.</span>
            </span>
          </div>
        ) : null}

        {state === 'error' ? (
          <div className="ai-error" role="alert">
            <strong>No pudimos generar el informe</strong>
            <p>{error ?? 'Gemini no respondió o devolvió un error. El análisis del motor sigue disponible.'}</p>
            <button type="button" className="btn" onClick={onGenerate}>
              Reintentar
            </button>
          </div>
        ) : null}

        {state === 'success' && report ? (
          <>
            <div className="markdown">
              <Markdown remarkPlugins={[remarkGfm]}>{report.report}</Markdown>
            </div>
            <p className="ai-foot">
              {report.model} · {(report.latencyMs / 1000).toFixed(1)} s · Informe generado por IA a partir
              del análisis del motor. Puede contener imprecisiones: contrasta siempre con las cifras.
            </p>
          </>
        ) : null}

        {state === 'idle' ? (
          <p className="ai-sub" style={{ margin: 0 }}>
            El análisis del motor ya está completo. El informe añade lectura cualitativa, no nuevas
            probabilidades.
          </p>
        ) : null}
      </div>
    </section>
  );
}

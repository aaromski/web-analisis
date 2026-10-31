'use client';

import { useId, useTransition } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Reintento aislado de la comparación: revalida el servidor sin recargar la
 * página ni el análisis de producción. No mueve el foco al responder.
 */
export default function ShadowRetry() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const noteId = useId();

  const retry = () => {
    startTransition(() => {
      router.refresh();
    });
  };

  return (
    <div className="shadow-retry">
      <button
        type="button"
        className="btn"
        onClick={retry}
        disabled={pending}
        aria-describedby={noteId}
      >
        {pending ? 'Reintentando…' : 'Reintentar'}
      </button>
      <p className="shadow-retry-note" id={noteId}>
        Solo se reintenta esta sección.
      </p>
      <p className="visually-hidden" role="status" aria-live="polite">
        {pending ? 'Actualizando la comparación de la sombra.' : ''}
      </p>
    </div>
  );
}

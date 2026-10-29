'use client';

import { useEffect, useRef } from 'react';

export interface ErrorAction {
  label: string;
  onClick: () => void;
}

interface Props {
  kind: 'api' | 'notfound' | 'not-projectable' | 'generic';
  title: string;
  message: string;
  meta?: string[];
  primary?: ErrorAction;
  secondary?: ErrorAction;
}

export default function ErrorState({ kind, title, message, meta, primary, secondary }: Props) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <section className="error-state" data-kind={kind} role="alert">
      <h2 ref={heading} tabIndex={-1}>
        {title}
      </h2>
      <p>{message}</p>
      {meta && meta.length > 0 ? (
        <div className="error-meta">
          {meta.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      ) : null}
      {(primary || secondary) && (
        <div className="error-actions">
          {primary ? (
            <button type="button" className="btn btn-primary" onClick={primary.onClick}>
              {primary.label}
            </button>
          ) : null}
          {secondary ? (
            <button type="button" className="btn" onClick={secondary.onClick}>
              {secondary.label}
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** Utilidades de presentación. No recalculan probabilidades: solo formatean. */

const decimal = new Intl.NumberFormat('es-ES', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatPct(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const pct = value * 100;
  if (digits === 1) return `${decimal.format(pct)} %`;
  return `${new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(pct)} %`;
}

export function formatOdds(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('es-ES', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/** La línea conserva el punto decimal del motor: 2.5, -0.25, +1.25. */
export function formatLine(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const fixed = Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2).replace(/0$/, '');
  return fixed;
}

export function formatSignedLine(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value > 0 ? `+${formatLine(value)}` : formatLine(value);
}

/** Diferencia en puntos porcentuales: 0.0042 → "+0,4 pts". */
export function formatEdge(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const points = value * 100;
  const sign = points > 0 ? '+' : points < 0 ? '−' : '';
  return `${sign}${decimal.format(Math.abs(points))} pts`;
}

export function formatPercentPoints(value: number): string {
  return `${decimal.format(value * 100)} %`;
}

export function monogram(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s.-]/gu, '')
    .split(/[\s.-]+/)
    .filter(Boolean);
  if (words.length === 0) return '??';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

const matchDate = new Intl.DateTimeFormat('es-ES', {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Madrid',
});

const matchTime = new Intl.DateTimeFormat('es-ES', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Madrid',
});

export function formatMatchDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'Fecha sin confirmar';
  return matchDate.format(date);
}

export function formatKickoff(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return matchTime.format(date);
}

export function qualityTone(score: number): 'lime' | 'amber' | 'coral' {
  if (score >= 0.74) return 'lime';
  if (score >= 0.62) return 'amber';
  return 'coral';
}

export function confidenceTone(confidence: number): 'lime' | 'amber' | 'coral' {
  if (confidence >= 74) return 'lime';
  if (confidence >= 62) return 'amber';
  return 'coral';
}

export function riskTone(risk: 'Bajo' | 'Medio' | 'Alto'): 'lime' | 'amber' | 'coral' {
  if (risk === 'Bajo') return 'lime';
  if (risk === 'Medio') return 'amber';
  return 'coral';
}

/** dd/mm/aaaa → YYYY-MM-DD; devuelve null si el formato no es reconocible. */
export function parseDisplayDate(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(trimmed);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]);
    const year = Number(match[3]);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month - 1 ||
      probe.getUTCDate() !== day
    ) {
      return null;
    }
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const probe = new Date(`${trimmed}T00:00:00Z`);
    if (Number.isNaN(probe.getTime())) return null;
    return trimmed;
  }
  return null;
}

/** YYYY-MM-DD → dd/mm/aaaa para el formulario. */
export function displayDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  return `${match[3]}/${match[2]}/${match[1]}`;
}

export const MODE_PARAM = 'modo';

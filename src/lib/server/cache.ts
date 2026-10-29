interface Entry<T> {
  value: T;
  expiresAt: number;
}

/** Caché TTL acotada para el proceso de Next. No se comparte entre instancias. */
export class TtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries: number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  private purgeExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    const now = Date.now();
    if (this.entries.size >= this.maxEntries) {
      // Primero se descartan las entradas caducadas; solo si sigue lleno se
      // evicta la más antigua.
      this.purgeExpired(now);
      if (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

interface RateEntry {
  count: number;
  resetAt: number;
}

const rateEntries = new Map<string, RateEntry>();
const RATE_ENTRIES_SOFT_LIMIT = 512;

function pruneRateEntries(now: number): void {
  if (rateEntries.size < RATE_ENTRIES_SOFT_LIMIT) return;
  for (const [key, entry] of rateEntries) {
    if (entry.resetAt <= now) rateEntries.delete(key);
  }
}

/** Límite simple en memoria para proteger la clave de Gemini. */
export function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  pruneRateEntries(now);
  const entry = rateEntries.get(key);
  if (!entry || entry.resetAt <= now) {
    rateEntries.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }
  if (entry.count >= limit) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
  entry.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

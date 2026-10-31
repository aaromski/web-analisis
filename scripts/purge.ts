/**
 * Retención de payloads post-partido: llama a `purge_post_payloads`, que vacía
 * el JSON de los snapshots `post` más antiguos que la ventana indicada. Las
 * filas, el hash y las predicciones se conservan; solo se libera el payload.
 *
 * Uso: npm run purge -- [--keep 90] [--dry-run]
 */
const DEFAULT_KEEP_DAYS = 90;
const MAX_KEEP_DAYS = 3650;

function argument(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  const value = process.argv[index + 1].trim();
  return value.length > 0 ? value : null;
}

function keepDays(): number {
  const raw = argument('keep');
  if (raw === null) return DEFAULT_KEEP_DAYS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_KEEP_DAYS) {
    console.error(`--keep debe ser un entero entre 0 y ${MAX_KEEP_DAYS}.`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const baseUrl = (process.env.SUPABASE_URL ?? '').trim().replace(/\/+$/, '');
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
  if (!baseUrl || !serviceKey) {
    console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (usa .env.local).');
    process.exit(1);
  }

  const days = keepDays();
  if (process.argv.includes('--dry-run')) {
    console.log(`Simulación: se purgarían los payloads post con más de ${days} días.`);
    return;
  }

  const started = Date.now();
  const response = await fetch(`${baseUrl}/rest/v1/rpc/purge_post_payloads`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ p_keep: `${days} days` }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error(`La purga falló (${response.status}): ${body.slice(0, 300)}`);
    process.exit(1);
  }

  const purged = Number(await response.json());
  const latency = Date.now() - started;

  await fetch(`${baseUrl}/rest/v1/ingestion_events`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      authorization: `Bearer ${serviceKey}`,
      'content-type': 'application/json',
      prefer: 'return=minimal',
    },
    body: JSON.stringify({
      operation: 'purge_payloads',
      status: 'ok',
      latency_ms: latency,
      request_id: 'purge-script',
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => undefined);

  console.log(`Payloads post purgados: ${Number.isFinite(purged) ? purged : 0} (ventana ${days} días, ${latency} ms).`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

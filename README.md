# Parley Lab

Web app ligera para analizar un partido de fútbol antes del inicio: calcula goles esperados, construye una matriz de marcadores, calibra las líneas de apuesta que sostienen un umbral de confianza y redacta un informe cualitativo con Gemini.

Consume exclusivamente la Aggregator API del repositorio hermano `../api`. Este proyecto no modifica esa carpeta.

## Requisitos

- Node.js 24+
- La API de estadísticas en marcha (`../api`, por defecto `http://localhost:3000`)
- Una clave de Google AI Studio para el informe IA (opcional: el análisis del motor funciona sin ella)

## Puesta en marcha

```bash
npm install
cp .env.example .env.local   # completa GEMINI_API_KEY
npm run dev                  # http://localhost:3100
```

La app escucha en el puerto **3100** para no chocar con la API en 3000. Si tu API usa otra URL:

```bash
STATS_API_BASE_URL=http://localhost:3000 npm run dev
```

## Variables de entorno

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `STATS_API_BASE_URL` | No | Base HTTP de la API. Por defecto `http://localhost:3000`. |
| `GEMINI_API_KEY` | Solo para IA | Clave de Google AI Studio. Se usa únicamente en el servidor. |
| `GEMINI_MODEL` | No | Modelo de Gemini. Por defecto `gemini-3.6-flash`. |
| `GEMINI_API_BASE_URL` | No | Base del endpoint de Gemini. Por defecto `.../v1`. |
| `SUPABASE_URL` | Para aprendizaje | URL del proyecto Supabase. Si falta, la persistencia queda desactivada. |
| `SUPABASE_SERVICE_ROLE_KEY` | Para aprendizaje | Clave `service_role`. Solo en servidor; salta RLS, nunca debe llegar al cliente. |
| `SUPABASE_PERSISTENCE_ENABLED` | No | `true` por defecto; `false` desactiva todas las escrituras. |
| `SUPABASE_TIMEOUT_MS` | No | Tiempo máximo por llamada a PostgREST. Por defecto `1200` (250–10000). |
| `INGEST_TOKEN` | Para ingesta post | Token de `x-ingest-token` en `POST /api/ingest/post`. Sin él, la ruta responde 503 en producción. |
| `CRON_SECRET` | Para cron | Secreto que Vercel Cron envía como `Authorization: Bearer …` a `GET /api/cron/ingest`. Sin él, la ruta responde 503 en producción. |

`.env.local` está ignorado por git. Nunca se envía la clave de Gemini ni la `service_role` al navegador.
La persistencia es fail-open: si Supabase falla o no está configurado, el análisis sigue funcionando.

## Scripts

```bash
npm run dev        # Next.js en 3100
npm run build      # build de producción
npm start          # servidor de producción en 3100
npm run typecheck  # TypeScript estricto
npm test           # 109 pruebas del motor, el arnés, la persistencia, el aprendizaje y el servidor con node:test
npm run snapshot -- --home "AC Milan" --away "Internazionale" --date 2026-10-31 --league ita.1
npm run audit      # métricas de los snapshots (y de data/results.json si existe)
npm run tune       # barrido del peso del ancla por Brier medio
npm run purge -- --keep 90   # vacía payloads post más antiguos que la ventana (acepta --dry-run)
```

## Cómo se usa

1. En `/`, busca por equipos (local, visitante; fecha y liga opcionales) o por ID (`espn:401874795`).
2. El panel muestra λ por equipo, probabilidad 1X2, calidad de datos, umbral y los mercados: 1X2, doble oportunidad, altas/bajas, hándicap, primer gol, impar/par, HT/FT, marcador exacto y BTTS; córners como mercado extendido.
3. Cada tarjeta expone la selección, la línea publicada, la probabilidad, la cuota justa, la confianza, el riesgo, el rango 10–90 cuando aplica y el valor frente al mercado. Al expandir aparece la curva de calibración, el umbral, la línea base, la línea de mercado y una tabla de líneas.
4. La combinada se calcula sobre la matriz (correlación incorporada), no multiplicando probabilidades.
5. «Generar informe» envía el análisis a Gemini y muestra el markdown en el panel IA.
6. Al final del panel aparece **Sombra vs. producción**: la compuerta de 100 partidos con resultado y, cuando exista, la comparación por mercado entre el motor de producción y la variante experimental. La sombra v1 es el mismo motor **sin ancla de mercado** (`engine-1.3.0-shadow-noanchor`): un brazo de control que compite contra la producción con resultados reales. Los chips muestran la versión **activa** (fila promovida de `engine_params`) y la **candidata**. El ciclo es automático: no hay pesos que configurar a mano.

Cada análisis pre-partido se guarda en Supabase al terminar la respuesta (sin bloquear ni romper la UI): partido, snapshot pre por hash de contenido y dos predicciones con `engine_version`/`params_version` — `production` (1.2.0) y `shadow` (parámetros `status = shadow` de `engine_params`). Reanalizar un partido solo añade snapshot si los datos cambiaron; el resto se detecta como duplicado. `/api/lab` empareja la última captura pre de cada partido finalizado que tenga ambas variantes y publica, por mercado, medias, delta en puntos porcentuales, muestra y un IC 95 % cuando hay al menos dos partidos; además calcula un backtest por variante (media del Brier multiclase y del log-loss, menor es mejor) que la sección muestra sobre los partidos cerrados. La ingesta post solo acepta partidos con captura pre: si no existe, responde 409 `POST_MATCH_WITHOUT_PRE` y no crea filas, y un trigger en la base bloquea la misma escritura por RPC. En Vercel, `vercel.json` programa un cron diario (06:00 UTC) en `GET /api/cron/ingest`: busca los partidos con captura pre y sin post, pide el marcador a la API y lo registra, de modo que la compuerta avanza sin intervención manual; es idempotente y no repite snapshots. `npm run purge` conserva filas y predicciones y solo vacía el JSON de los snapshots post antiguos.

### Mejora automática

El cron diario, tras cerrar resultados, ejecuta `runLearning` (`src/lib/server/learning.ts`). Con ≥ 100 partidos cerrados ajusta **una sola perilla** — la escala del ancla, con una rejilla de 0,7 a 1,1 — sobre una partición walk-forward 70/30 en orden cronológico, y solo crea una candidata (`auto-anchor-sNNN-YYYYMMDD`) si mejora el Brier de validación en al menos 0,004 sin empeorar el log-loss. La candidata se escribe como fila `shadow` y compite partido a partido contra la producción; se promueve cuando hay ≥ 50 partidos emparejados, la mejora media del Brier es ≥ 0,004 y el bootstrap determinista (2000 remuestreos) da ≥ 95 % de confianza en que es mejor. La promoción llama al RPC `set_promoted_params`, que retira la versión anterior en una transacción, con enfriamiento de 30 días. Si la versión promovida se degrada ≥ 0,01 de Brier con ≥ 95 % de confianza sobre ≥ 30 partidos posteriores a la promoción, se revierte automáticamente a la anterior. Las candidatas sin muestra se retiran a los 21 días; el brazo de control sin ancla deja de acumular al llegar a la compuerta. Producción lee la fila promovida con caché de 60 s y fail-open: si Supabase falla, usa los defaults de 1.2.0. Todo el estado se puede seguir en los chips de la sección sombra y en `learning` de la respuesta del cron.

La URL es la fuente de verdad: `/?id=…` o `/?home=…&away=…&date=YYYY-MM-DD&league=ita.1`. Recargar reproduce el análisis.

## Arquitectura

```text
src/
  app/
    api/analyze   POST  analiza un partido (valida, consulta la API, ejecuta el motor)
    api/ai        POST  genera el informe con Gemini (rate limit 6/5 min)
    api/health    GET   salud de la API de estadísticas y configuración de Gemini
    api/lab       GET   comparación producción/sombra, compuerta, backtest y versiones activa/candidata
    api/ingest/post POST registra el resultado post-partido (x-ingest-token)
    api/cron/ingest GET  cierra partidos pendientes y ejecuta el ciclo de mejora (Bearer CRON_SECRET)
    page.tsx            busca o muestra el dashboard según la URL
    globals.css         tokens, layout y componentes visuales
  components/          buscador, cabecera, resumen, mercados, curva, combinada, contexto, IA, sombra
  lib/
    engine/            motor puro: poisson, mercados, calibración, λ, liga, ancla, ajustes, incertidumbre, vivo, calidad, combinada, EngineParams y variante sombra
    server/            cliente HTTP, caché, validación, errores, Gemini, Supabase/PostgREST, ingesta post y aprendizaje
    types/             contrato canónico de la API y contrato de salida del motor
    ui/                formato de porcentajes, cuotas, líneas y fechas
docs/
  MOTOR_LINEAS.md      contrato del motor y decisiones de calibración
  MEDICION.md          arnés de snapshots y criterios de precisión
  PROTOTIPO_UX.md      diseño UX/UI y criterios de aceptación
  PROGRESS.md          bitácora de fases, QA y auditoría
scripts/
  snapshot.ts          captura una respuesta real de la API
  measure.ts           mide snapshots contra el mercado y los resultados
  tune.ts              barre el peso del ancla y guarda data/tuning.json
  purge.ts             retención: vacía payloads post antiguos vía RPC
supabase/
  migrations/          tablas, RLS, funciones y vista del ciclo de aprendizaje
  rollback/            desmontaje ordenado del esquema
vercel.json            cron diario de ingesta post (06:00 UTC)
data/snapshots/        capturas locales (ignoradas por git)
data/results.json      marcadores reales para backtest (local, ignorado por git)
```

### Motor en una frase

λ por equipo = fuerza multiplicativa relativa a la media de su liga (mezcla 62/38 de xG y goles ponderada por estado `observed`/`projected`, encogida hacia la media), ajustada por forma y contexto acotado (bajas, descanso, rival, clima, h2h) y blend 65/35 con la predicción externa; después se ancla al total y la supremacía implícitos en las cuotas (o en la predicción si no hay cuota). Matriz Poisson bivariada con corrección Dixon-Coles (`rho = -0.1`, hasta 12 goles); los mercados se derivan de la matriz, las líneas se calibran con un umbral propio por mercado y un Monte Carlo publica la banda p10–p90. En vivo se desplaza la matriz por el marcador y se proyectan solo los goles restantes.

`confidence = 100 · (0,7·p + 0,18·calidad + 0,12·acuerdo con el mercado)`. Riesgo Bajo ≥ 74 con calidad ≥ 0,6; Medio ≥ 62; Alto por debajo.

Todos los parámetros numéricos viven en `src/lib/engine/params.ts` (`EngineParams`, 141 ajustes en 8 dominios). Los valores por defecto reproducen 1.2.0 y una prueba de identidad verifica que pasarlos explícitamente no cambia ninguna salida.

## Seguridad y alcance

- Supabase solo almacena datos del ciclo de aprendizaje. RLS activo sin políticas: únicamente `service_role` escribe, y esa clave nunca sale del servidor.
- Sin autenticación de usuarios y sin apuestas: es una herramienta de análisis.
- La clave de Gemini solo se usa en `src/lib/server/gemini.ts`; `INGEST_TOKEN` se compara en tiempo constante.
- Caché y rate limit en memoria; para varias instancias habría que externalizarlos.
- No se publica ni se despliega desde este repositorio sin autorización explícita.

## Limitaciones

- Búsqueda por equipos sin fecha/liga puede devolver 404 según la API; por ID es determinista.
- Los partidos finalizados se rechazan; los partidos en vivo se analizan con los goles restantes y sin ancla de mercado.
- El informe IA tarda 15–40 s y depende de la cuota del plan de Gemini.
- Sin listado de partidos ni autocompletado.

Análisis estimativo. No garantiza resultados. Juego responsable · 18+.

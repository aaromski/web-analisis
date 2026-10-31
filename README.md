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

`.env.local` está ignorado por git. Nunca se envía la clave al navegador.

## Scripts

```bash
npm run dev        # Next.js en 3100
npm run build      # build de producción
npm start          # servidor de producción en 3100
npm run typecheck  # TypeScript estricto
npm test           # 57 pruebas del motor, el arnés y el servidor con node:test
npm run snapshot -- --home "AC Milan" --away "Internazionale" --date 2026-10-31 --league ita.1
npm run audit      # métricas de los snapshots (y de data/results.json si existe)
npm run tune       # barrido del peso del ancla por Brier medio
```

## Cómo se usa

1. En `/`, busca por equipos (local, visitante; fecha y liga opcionales) o por ID (`espn:401874795`).
2. El panel muestra λ por equipo, probabilidad 1X2, calidad de datos, umbral y los mercados: 1X2, doble oportunidad, altas/bajas, hándicap, primer gol, impar/par, HT/FT, marcador exacto y BTTS; córners como mercado extendido.
3. Cada tarjeta expone la selección, la línea publicada, la probabilidad, la cuota justa, la confianza, el riesgo, el rango 10–90 cuando aplica y el valor frente al mercado. Al expandir aparece la curva de calibración, el umbral, la línea base, la línea de mercado y una tabla de líneas.
4. La combinada se calcula sobre la matriz (correlación incorporada), no multiplicando probabilidades.
5. «Generar informe» envía el análisis a Gemini y muestra el markdown en el panel IA.

La URL es la fuente de verdad: `/?id=…` o `/?home=…&away=…&date=YYYY-MM-DD&league=ita.1`. Recargar reproduce el análisis.

## Arquitectura

```text
src/
  app/
    api/analyze   POST  analiza un partido (valida, consulta la API, ejecuta el motor)
    api/ai        POST  genera el informe con Gemini (rate limit 6/5 min)
    api/health    GET   salud de la API de estadísticas y configuración de Gemini
    page.tsx            busca o muestra el dashboard según la URL
    globals.css         tokens, layout y componentes visuales
  components/          buscador, cabecera, resumen, mercados, curva, combinada, contexto, IA
  lib/
    engine/            motor puro: poisson, mercados, calibración, λ, liga, ancla, ajustes, incertidumbre, vivo, calidad, combinada
    server/            cliente HTTP, caché, validación, errores y Gemini
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
data/snapshots/        capturas locales (ignoradas por git)
data/results.json      marcadores reales para backtest (local, ignorado por git)
```

### Motor en una frase

λ por equipo = fuerza multiplicativa relativa a la media de su liga (mezcla 62/38 de xG y goles ponderada por estado `observed`/`projected`, encogida hacia la media), ajustada por forma y contexto acotado (bajas, descanso, rival, clima, h2h) y blend 65/35 con la predicción externa; después se ancla al total y la supremacía implícitos en las cuotas (o en la predicción si no hay cuota). Matriz Poisson bivariada con corrección Dixon-Coles (`rho = -0.1`, hasta 12 goles); los mercados se derivan de la matriz, las líneas se calibran con un umbral propio por mercado y un Monte Carlo publica la banda p10–p90. En vivo se desplaza la matriz por el marcador y se proyectan solo los goles restantes.

`confidence = 100 · (0,7·p + 0,18·calidad + 0,12·acuerdo con el mercado)`. Riesgo Bajo ≥ 74 con calidad ≥ 0,6; Medio ≥ 62; Alto por debajo.

## Seguridad y alcance

- Sin base de datos, sin autenticación, sin apuestas: es una herramienta de análisis.
- La clave de Gemini solo se usa en `src/lib/server/gemini.ts`.
- Caché y rate limit en memoria; para varias instancias habría que externalizarlos.
- No se publica ni se despliega desde este repositorio sin autorización explícita.

## Limitaciones

- Búsqueda por equipos sin fecha/liga puede devolver 404 según la API; por ID es determinista.
- Los partidos finalizados se rechazan; los partidos en vivo se analizan con los goles restantes y sin ancla de mercado.
- El informe IA tarda 15–40 s y depende de la cuota del plan de Gemini.
- Sin listado de partidos ni autocompletado.

Análisis estimativo. No garantiza resultados. Juego responsable · 18+.

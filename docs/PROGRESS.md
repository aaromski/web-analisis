# Parley Lab · Bitácora de progreso

Proyecto: web app de análisis pre-partido y proyección de parleys.
Última actualización: 2026-10-30.
Alcance autorizado: solo `web-analisis`; la carpeta `../api` se consume por HTTP y permanece intacta (solo lectura).

## 1. Requerimiento y criterios de aceptación

- Consumir exclusivamente la Aggregator API de `../api` (`/api/v1/matches/{match_id}/stats` y búsqueda por equipos).
- Nueve mercados objetivo: 1X2, doble oportunidad, altas/bajas, hándicap asiático/europeo, primer gol, impar/par, HT/FT, marcador exacto y BTTS; córners como mercado extendido.
- Líneas dinámicas por umbral de confianza: partir de una línea base y publicar la línea más ambiciosa que mantenga el umbral.
- Motores híbridos: Poisson bivariado con corrección Dixon-Coles y blend de xG, goles, forma y predicción externa.
- UI minimalista de dos vistas (buscador y panel) con línea óptima, probabilidad, confianza y riesgo.
- Botón «Análisis IA» con Gemini, clave solo en servidor, estados de carga/error y markdown saneado.
- Sin commits, despliegues ni cambios en otras carpetas. `GEMINI_API_KEY` nunca se expone ni se registra.

## 2. Fases, responsables y estado

| Fase | Responsable | Entregable | Estado | Validación |
| --- | --- | --- | --- | --- |
| 1. Descubrimiento y arquitectura | PM/Orquestador + Arquitecto de datos | Contrato de la API, `docs/MOTOR_LINEAS.md` | Completada | Contrato v1.2.0 revisado; endpoints probados con `curl` |
| 1b. UX/UI | Diseñador de prototipos | `docs/PROTOTIPO_UX.md` | Completada | 14 criterios de aceptación documentados; revisados contra el motor |
| 2. Motor y backend | Backend/DB + PM | `src/lib/engine/*`, rutas `/api/analyze`, `/api/ai`, `/api/health` | Completada | 20 tests unitarios; `tsc` limpio; `next build` correcto |
| 3. Frontend | Frontend + PM | `src/app`, `src/components`, tokens CSS | Completada | Recorridos en navegador real; revisión visual 1440/1024/390 px |
| 4. QA | QA/PO + PM | Matriz de escenarios y correcciones | Completada | Ver §5 |
| 5. Auditoría | Auditor de código | Veredicto final | Completada | APROBADO CON OBSERVACIONES; ver §8 |
| 6. Cierre | PM | README y esta bitácora | Completada | Pendiente de auditoría final |

## 3. Decisiones técnicas

1. **Motor puro y determinista.** `src/lib/engine` no depende de React ni de red: recibe el JSON canónico y devuelve `AnalysisResult`. La UI solo formatea; nunca recalcula probabilidades ni cuotas.
2. **Calibración.** `threshold = clamp(0.74 + 0.08·(1−calidad) + 0.02·desacuerdo, 0.68, 0.86)`. Se publica la línea Over más alta (y Under más baja) que supera el umbral; en hándicap, la línea negativa más exigente que lo cumple. Si ninguna lo alcanza, se marca `calibrated: false` y se muestra «Sin línea sobre umbral».
3. **Línea base vs. línea publicada.** La base (`nearestHalfLine(λ total)`) y la línea de mercado se muestran en el detalle para transparentar el trade-off; el ejemplo del brief (Over 3.5 → Over 1.5 al 84,9 %) queda visible en el partido de prueba.
4. **Partidos no proyectables.** `finished` y `live` se rechazan con `MATCH_NOT_PROJECTABLE` (HTTP 422) y detalles de marcador/equipos/fecha. Calibrar después del pitido produce datos engañosos.
5. **Combinada con correlación exacta.** La probabilidad conjunta se suma sobre la matriz de marcadores (no se multiplican probabilidades). Máximo 3 selecciones, mercados distintos, p entre 0,66 y 0,93 y conjunta ≥ 0,45.
6. **Gemini.** Endpoint `v1` (el `v1beta` colgaba con modelos 3.x), modelo por defecto `gemini-3.6-flash` (≈25 s por informe) con respaldo automático `gemini-3.5-flash-lite` si el modelo no existe o está saturado. La clave se lee de `.env.local` en el servidor y se envía en `x-goog-api-key`.
7. **Liga como slug.** La API exige `^[a-z0-9._-]+$` (`ita.1`, `eng.1`), así que el formulario pide el slug, no el nombre visible. Se acepta fecha `dd/mm/aaaa` y se convierte a ISO antes de consultar.
8. **Estados de la UI desde la URL.** La URL es la fuente de verdad (`/?id=…` o `/?home=…&away=…`). Recargar reproduce el análisis; «Nueva búsqueda» limpia la consulta.
9. **Caché y límites en memoria.** Análisis con TTL de 3 min y 60 entradas; IA limitada a 6 peticiones por IP cada 5 min. Suficiente para uso local; no apto para multi-instancia sin un almacén compartido.

## 4. Entregables

- `docs/MOTOR_LINEAS.md`: contrato del motor (λ, matriz, calibración, mercados, confianza).
- `docs/PROTOTIPO_UX.md`: arquitectura de información, flujos, wireframes, tokens, textos y criterios.
- `src/lib/engine/`: `poisson`, `markets`, `calibration`, `odds`, `quality`, `lambdas`, `context`, `parlay`, `analyze`.
- `src/lib/server/`: cliente de la API, servicio con caché, Gemini, validación, errores y respuestas HTTP.
- `src/app/api/{analyze,ai,health}`: rutas Node.js con `no-store`.
- `src/app/`: layout, página y estilos globales con los tokens del prototipo.
- `src/components/`: buscador, cabecera, resumen, tarjetas de mercado con curva, combinada, contexto, panel IA, errores y esqueletos.
- `tests/`: 20 pruebas del motor con fixtures reales y sintéticos.

## 5. QA ejecutado

**Automatizado**

- `npm run typecheck` → sin errores.
- `npm test` → 20/20 en 1,5 s (matriz, calibración, combinada, HT/FT, partidos finalizados, respuesta vacía).
- `npm run build` → compilación de producción correcta; `/` estática de 57,9 kB y rutas API dinámicas.

**API y motor en vivo (Serie A, Milan vs Inter, `espn:401874795`)**

- `GET /api/health` → API alcanzable, contrato 1.2.0 y Gemini configurado.
- `POST /api/analyze` → 10 mercados, λ 1,51/1,77, umbral 76,2 %, Over 1.5 al 84,9 %, hándicap Inter +1.25 al 80,3 %, combinada Over 1.5 + 12 al 64,8 %.
- `POST /api/ai` → 200; informe en español de ~4.100 caracteres, 5 secciones, sin LaTeX residual.

**Navegador (Chrome headless + CDP)**

- Validación del buscador vacío: dos errores, foco en el primer campo inválido y URL intacta.
- Envío válido: URL actualizada antes de la respuesta, esqueleto de carga y dashboard completo.
- Tarjeta expandida: `aria-expanded`, curva con umbral y punto elegido, tabla conmutable de 7 líneas.
- IA: inactiva → cargando → éxito con markdown (5 `h2`) y pie con modelo y latencia.
- Partido finalizado (`espn:401874965`): estado «Este partido ya finalizó», marcador 0–0, foco en el titular.
- Partido inexistente: estado «No encontramos ese partido» y acceso directo a «Buscar por ID».
- Datos insuficientes (stub local con estadísticas vacías): banda ámbar «Análisis limitado», calidad Baja 6, 9 mercados sin córners.
- Sin desbordamiento horizontal a 390 px (`scrollWidth = 390`); 1024 y 1440 px revisados visualmente.

## 6. Correcciones relevantes

- TS2367 al comparar el estado del partido: se normaliza con `normalizeStatus` antes de tipar la salida.
- `gemini-2.5-flash` retirado para cuentas nuevas: se migró a `v1` + `gemini-3.6-flash` con respaldo y reintento ante 404/503.
- El atributo `hidden` no ocultaba el detalle de las tarjetas por conflicto de especificidad CSS; se añadió `.market-detail[hidden]`.
- LaTeX (`$\lambda$`) en el informe: se prohíbe en el prompt y se normaliza en el servidor.
- En móvil, el equipo visitante quedaba alineado a la derecha por `row-reverse`; se corrigió a flujo normal y se redujo la cifra 1X2 para evitar cortes.
- El gráfico de calibración solapaba etiquetas; se movió el umbral a la izquierda y la etiqueta elegida bajo el punto.
- La tarjeta expandida duplicaba minigráfico y gráfico completo; el minigráfico se oculta al expandir.

## 7. Limitaciones conocidas

- No hay listado ni autocompletado de partidos: se resuelve por equipos + fecha/liga o por ID. La búsqueda por equipos sin fecha/liga puede devolver 404 según la API.
- Las cuatro etapas de carga son una lista indicativa: el backend responde en una sola petición y no expone progreso parcial.
- El informe IA tarda 15–40 s y depende de la cuota de Gemini.
- Caché y rate limit viven en memoria del proceso.
- No se ha desplegado ni se han creado commits; queda a la espera de autorización.

## 8. Auditoría

**Fecha:** 2026-10-29. **Auditor:** Líder Técnico y Auditor de Calidad. **Alcance:** revisión independiente de `web-analisis` (motor, API interna, UI, contratos, configuración y documentación); `../api` solo se leyó por HTTP. **Veredicto:** APROBADO CON OBSERVACIONES (sin hallazgos bloqueantes ni altos).

### 8.1 Comprobaciones ejecutadas

- `npm run typecheck` sin errores; `npm test` 20/20; `npm run build` correcto (rutas API dinámicas, `/` estática).
- En vivo contra la API 1.2.0 local: `POST /api/analyze` 200 con `espn:401874795` (10 mercados, combinada de 2 patas); partido finalizado `espn:401874965` → 422 `MATCH_NOT_PROJECTABLE` con marcador/equipos; cuerpo `{}` → 400; ID con `../` → 400; `GET /api/health` 200.
- Secretos: `GEMINI_API_KEY` solo se lee en `src/lib/server/gemini.ts`; no hay variables `NEXT_PUBLIC_`; búsqueda del patrón de clave y de `GEMINI_API_KEY` en `.next/static` sin coincidencias. No se abrió `.env.local` ni se mostró su contenido.
- Contrato: rutas, estados (`scheduled/finished/live/unknown`), códigos 404/400 y campos opcionales alineados con `../api/docs/CONTRATO_API.md` y `../api/src/routes/stats.ts`.
- XSS/markdown: `react-markdown` sin `rehype-raw`; HTML crudo no se renderiza y las URLs pasan por el saneado por defecto. No se invocó `/api/ai` para no consumir cuota de Gemini.
- SQL: el proyecto no contiene scripts SQL ni `supabase_schema.sql`; no aplica validación con parser.

### 8.2 Hallazgos medios

1. **Carrera del informe IA.** `src/components/ParleyApp.tsx:225-252` no cancela ni identifica la petición; el reset de `:147-152` no impide que una respuesta tardía llame a `setAiReport` cuando el usuario ya cambió de partido. Impacto: se muestra el informe de otro partido bajo la cabecera nueva. Corrección: `AbortController` + token de `searchKey`/`envelope` antes de aplicar el resultado (o mover el estado IA al `Dashboard`).
2. **Etiqueta «Calibrada» en mercados no calibrados.** `src/lib/engine/analyze.ts:125` hace `calibrated: true` por defecto y los mercados discretos fijan `threshold: 0.5` (`:236`, `:295`, `:418`, `:445`, `:476`, `:499`, `:532`); `src/components/MarketCard.tsx:253-260` muestra «Umbral 50 %» y «Calibrada» en 1X2, BTTS, HT/FT, etc. Impacto: atribuye una calibración inexistente. Corrección: no publicar umbral ni estado de calibración cuando `curve` está vacío, o marcar `calibrated: false`.
3. **Rate limit espoofeable y mapa sin purga.** `src/app/api/ai/route.ts:11-15,18` confía en la primera IP de `x-forwarded-for`, controlada por el cliente; `src/lib/server/cache.ts:43-62` nunca elimina entradas caducadas. Impacto: rotando el header se evita el límite 6/5 min y se pueden acumular claves hasta agotar memoria/cuota. Corrección: IP de proxy confiable o límite por sesión, purga periódica/cota del mapa y exigir `application/json`.
4. **Patas anidadas en la combinada.** `src/lib/engine/parlay.ts:26-40` permite «Resultado local» y «1X» a la vez; la conjunta queda igual a la pata más estrecha y se presenta como 2–3 selecciones. Impacto: diversificación aparente y cuota conjunta engañosa. Corrección: descartar candidatos implicados/superconjunto de una pata ya elegida.

### 8.3 Hallazgos bajos

5. **Cuartos de hándicap.** `src/lib/engine/poisson.ts:125-152` promedia las coberturas de las dos semilíneas; no equivale a la probabilidad de cuota justa del cuarto (ej.: -0,25 con 34,9 % win y 30,3 % draw: 42,4 % vs 41,1 %). Desviación ~1 pp; documentar o calcular por EV.
6. **Primer gol vs. matriz DC.** `src/lib/engine/markets.ts:48-59` calcula «Sin goles» con Poisson independiente: 3,76 % frente al 4,77 % de 0-0 de la matriz corregida en el derbi. Corrección: derivar el reparto de la matriz.
7. **Exposición de infraestructura.** `src/app/api/health/route.ts:14` devuelve `baseUrl` y `src/lib/server/stats-client.ts:67` incluye la URL interna en el error; contradice `.env.example:1-3`. Además, health responde 200 con `ok:false`. Corrección: no publicar la URL, mensaje genérico y 503 si la dependencia no responde.
8. **Sin cabeceras de seguridad.** `next.config.ts:3-6` no define CSP, `X-Content-Type-Options` ni `Referrer-Policy`. El markdown actual es seguro, pero falta defensa en profundidad.
9. **Deriva documental.** `docs/MOTOR_LINEAS.md:58` dice 60/40 (código 65/35), `:149` calidad 0,65 (código 0,6) y `:159` conjunta 0,38 (código 0,45); `.env.example` omite `GEMINI_API_BASE_URL`; los textos UX «Saltar al contenido» y «Cambiar búsqueda» difieren de `docs/PROTOTIPO_UX.md`.
10. **Verificación incompleta.** `tests/` solo cubre el motor; no hay pruebas de `parseMatchInput`, `errorResponse`, rate limit ni render de markdown; no hay ESLint configurado. `npm audit`: 1 alta + 1 moderada (postcss transitivo de Next), de build y no explotable con CSS de usuario; el arreglo exige Next 16.

### 8.4 Pendientes de seguimiento

- Corregir 8.2.1–8.2.4 y revalidar (cambio de partido durante la IA, etiquetas, límite con XFF falso, combinada resultado+DC).
- Añadir pruebas de servidor/seguridad y ESLint; actualizar la documentación de 8.3.9.
- No se validó el respaldo `gemini-3.5-flash-lite` ni la cuota real de Gemini para no consumirla; no hay parser SQL local. Ambas comprobaciones quedan pendientes, no bloquean.
- Nota operativa: el build de producción se ejecutó en el proyecto y el servidor de desarrollo local (3100) se reinició después; no hubo cambios de código, commits ni despliegues, y `../api` no se modificó.

## 9. Correcciones tras la auditoría (2026-10-29)

**Responsable:** Project Manager & Orquestador. Se corrigieron los cuatro hallazgos medios y los bajos de exposición, cabeceras, deriva documental y pruebas.

### 9.1 Hallazgos medios

1. **Carrera del informe IA.** `src/components/ParleyApp.tsx`: `generateAi` crea un `AbortController` por petición, aborta la anterior y compara el `searchKey` capturado con el actual antes de aplicar `setAiReport`. Al cambiar de partido, un efecto cancela el informe en vuelo. Verificado en código y con typecheck.
2. **Etiquetas de calibración.** `src/components/MarketCard.tsx`: los chips «Umbral», «Base», «Calibrada/No calibrada» y el aviso «Sin línea sobre umbral» solo se muestran cuando el mercado tiene `curve`. Los mercados discretos indican «Selección del modelo» y «Sin línea dinámica». Verificado en navegador: 1X2 y Doble oportunidad ya no muestran umbral; Altas/Bajas y Hándicap conservan «Umbral 76 % · Calibrada».
3. **Rate limit y caché.** `src/app/api/ai/route.ts`: se añadió un tope global de 30 solicitudes/5 min además del límite por IP (6/5 min) para que un `x-forwarded-for` falsificado no agote la cuota; se documenta que el límite por IP es best-effort. `src/lib/server/cache.ts`: la caché purga entradas caducadas antes de evictar y el mapa de rate limit se poda al superar 512 claves. Ambas rutas POST exigen `Content-Type: application/json` (415 en caso contrario) mediante `requireJson`.
4. **Patas anidadas.** `src/lib/engine/parlay.ts`: `nestedLeg` compara la probabilidad conjunta con cada pata y descarta selecciones implicadas o superconjuntos (p. ej. «Resultado local» + «1X»). Prueba unitaria añadida.

### 9.2 Hallazgos bajos atendidos

- `src/lib/engine/markets.ts`: «Sin goles» usa la celda 0-0 de la matriz Dixon-Coles; en el derbi pasa de 3,76 % a 4,77 %, coherente con «Marcador exacto».
- `GET /api/health` ya no publica `baseUrl`, devuelve 503 cuando la API no responde y el error de conexión es genérico; `stats-client` tampoco incluye la URL interna.
- `next.config.ts`: CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options` y `Permissions-Policy`. En desarrollo la CSP permite `unsafe-eval` para HMR.
- `docs/MOTOR_LINEAS.md`: corregidos 65/35, calidad 0,6, conjunta 0,45, rango real del hándicap (-3,0…+2,0) y nota de patas anidadas. `.env.example` documenta `GEMINI_API_BASE_URL`.
- Pruebas nuevas: `tests/server/cache.test.ts` (purga TTL, cota y rate limit), `validation.test.ts`, `http.test.ts` (415), `markdown.test.ts` (cercas/LaTeX) y casos de combinada anidada y coherencia del primer gol. Total 30 pruebas.

### 9.3 Verificación tras las correcciones

- `npm run typecheck` sin errores; `npm test` 30/30; `npm run build` correcto con CSP activa.
- Producción en 3100 contra la API real: `/api/health` 200 sin `baseUrl`; `Content-Type: text/plain` en `/api/analyze` → 415; análisis `espn:401874795` con 10 mercados, combinada `Over 1.5 + 12` al 64,8 % y primer gol «sin goles» 4,77 %.
- Instancia temporal en 3101 con `STATS_API_BASE_URL` inalcanzable: `/api/health` 503 con mensaje genérico y `/api/analyze` 503.
- Informe IA real con `gemini-3.6-flash`: 4.041 caracteres, 5 secciones `h2`, 17,6 s, sin LaTeX ni dólares.
- Navegador (producción, CSP activa): página hidratada, sin errores de consola, 10 mercados y combinada visibles; mercados discretos sin etiqueta de calibración.
- No se modificó `../api`; no hubo commits ni despliegues.

### 9.4 Pendiente

- ESLint no está configurado (el proyecto no lo incluía) y `npm audit` mantiene 1 aviso alto y 1 moderado transitivos de Next/postcss, no explotables con CSS propio y resueltos solo con Next 16. No se añadieron dependencias para no ampliar el alcance.
- Queda solicitar el veredicto final del Auditor sobre estas correcciones.

## 10. Re-auditoría

**Fecha:** 2026-10-29. **Auditor:** Líder Técnico y Auditor de Calidad. **Alcance:** verificación independiente de las correcciones de §9 (carrera del informe IA, etiquetas de calibración, rate limit/caché/content-type, patas anidadas y hallazgos bajos), sin modificar código de producto; `../api` solo por HTTP de lectura. **Veredicto:** APROBADO CON OBSERVACIONES. No hay hallazgos críticos ni altos; los 4 medios de §8.2 se consideran cerrados y quedan 4 observaciones bajas no bloqueantes.

### 10.1 Correcciones verificadas

1. **Carrera del informe IA (`src/components/ParleyApp.tsx:237-274`).** `generateAi` aborta el controlador previo, crea uno por petición y descarta el resultado si `controller.signal.aborted` o si `searchKeyRef.current !== key` (`:255`, `:267-268`); el efecto `:140-146` aborta al cambiar `searchKey` y el efecto `:148-203` limpia `aiState`/`aiReport`. Trazado manual: no queda ruta en la que una respuesta tardía aplique un informe bajo otra cabecera; el caso residual (respuesta resuelta entre commit y efectos pasivos) lo limpia el reset de `:162-164`.
2. **Etiquetas engañosas (`src/components/MarketCard.tsx:62,67-73,107-111,150-159,253-263`).** Chips de umbral, base, calibrada y aviso de línea solo con `curve.length > 0`; los mercados discretos muestran «Selección del modelo» / «Sin línea dinámica». Confirmado en la respuesta real: `double_chance` llega con `curve: 0` y ya no publica umbral.
3. **Rate limit y caché (`src/app/api/ai/route.ts:11-21,42-50`, `src/lib/server/cache.ts:19-47,60-87`).** Tope global de 30/5 min antes del de IP (6/5 min) y purga TTL antes de evacuar; comentario de XFF correcto.
4. **Content-type (`src/lib/server/http.ts:29-37` en `src/app/api/analyze/route.ts:10-11` y `/api/ai`).** Verificado en producción: `text/plain` → 415 `UNSUPPORTED_MEDIA_TYPE` en ambas rutas; JSON inválido → 400.
5. **Patas anidadas (`src/lib/engine/parlay.ts:16,23-28,46`).** `nestedLeg` compara la conjunta con cada pata y descarta implicadas/superconjuntos; prueba `tests/engine/parlay.test.ts:67` pasa.
6. **«Sin goles» (`src/lib/engine/markets.ts:50-62`, llamada en `src/lib/engine/analyze.ts:402-406`).** La respuesta real devuelve 4,77 %, idéntico al 0-0 de la matriz.
7. **Health y errores (`src/app/api/health/route.ts:10-29`, `src/lib/server/stats-client.ts:64-68,126-135`).** Con `STATS_API_BASE_URL` inalcanzable (instancia temporal en 3102): `/api/health` → 503 sin `baseUrl`, `/api/analyze` → 503 con mensaje genérico.
8. **Cabeceras (`next.config.ts:5-35`).** En producción se sirven CSP sin `unsafe-eval`, `nosniff`, `Referrer-Policy`, `X-Frame-Options: DENY`, `Permissions-Policy`; sin `X-Powered-By`. No hay egress externo permitido por `connect-src 'self'`.
9. **Documentación y pruebas.** `docs/MOTOR_LINEAS.md:58,151,159,163` corregidos (65/35, calidad 0,6, conjunta 0,45, nota de anidamiento) y rango de hándicap `-3.0 … +2.0` en `:115`; `.env.example` incluye `GEMINI_API_BASE_URL`, que `src/lib/server/gemini.ts:52` consume. Las 30 pruebas de `tests/` (10 de motor + 4 archivos de servidor) pasan.

### 10.2 Comprobaciones ejecutadas

- `npm run typecheck` → sin errores. `npm test` → 30/30 en 2,4 s. `npm run build` → correcto con el servidor de 3100 activo (sin necesidad de detenerlo): `/` estática 58 kB y `/api/{ai,analyze,health}` dinámicas.
- Producción en 3100 contra la API real (3000 intacta y sin parar): `GET /api/health` 200 `ok:true`, contrato 1.2.0; `POST /api/analyze` 200 con 10 mercados, primer gol «sin goles» 4,77 %, combinada de 2 patas; partido finalizado → 422 `MATCH_NOT_PROJECTABLE`; ID `../health` → 400; `{}` → 400; `text/plain` → 415 en `/api/analyze` y `/api/ai`.
- Instancia temporal propia en 3102 con upstream inalcanzable para probar el 503; detenida al terminar. 3000 y 3100 siguen escuchando; no se reinició ni modificó `../api`.
- Secretos: sin `NEXT_PUBLIC_*`; búsqueda de `AIza…`, `GEMINI_API_KEY` y `generativelanguage` en `.next/static` y `.next/server` sin coincidencias; no se abrió `.env.local`.
- SQL: el proyecto no contiene `*.sql` ni `supabase_schema.sql`; no aplica parser.
- `npm audit` → 1 alto (postcss, transitivo) + 1 moderado (next, directo), coherente con §9.4.

### 10.3 Observaciones residuales (bajas, no bloqueantes)

1. `src/app/api/ai/route.ts:46-50`: el contador global se incrementa antes del límite por IP, así que un cliente ya bloqueado sigue consumiendo cupo global (30/5 min) y puede dejar sin IA a otros durante la ventana. Corrección: comprobar el límite por IP primero o incrementar el global solo si la petición va a ejecutarse.
2. `src/lib/engine/analyze.ts:125` mantiene `calibrated: true` (y `threshold: 0.5`) en mercados discretos, y `src/lib/prompt.ts:50` lo envía como `calibrada` al modelo sin `umbral_pct`; la UI ya no lo muestra, pero el informe IA podría afirmar una calibración inexistente. Corrección sugerida: `calibrated: curve.length > 0 ? draft.calibrated : false`, ajustando el estilo de `.prob-value` si se quiere conservar el color.
3. `next.config.ts:8-9`: CSP con `'unsafe-inline'` en `script-src` y `style-src` (necesario sin nonce/middleware); defensa en profundidad limitada. Asumible con markdown saneado.
4. `README.md:45` sigue citando «20 pruebas» (son 30); ESLint sigue sin configurar y persiste el aviso de `npm audit` que exige Next 16.

Nota externa (fuera de alcance, solo lectura): `GET http://localhost:3000/health` de `../api` publica `findings_document` con una ruta absoluta local; corresponde al equipo de la API, no a esta app.

## 11. Cierre de observaciones residuales (2026-10-29)

**Responsable:** Project Manager & Orquestador. Se atendieron las observaciones 1, 2 y 4 de §10.3; la 3 se acepta como decisión documentada.

1. **Cupo global.** `src/app/api/ai/route.ts`: el límite por cliente (6/5 min) se evalúa antes del global (30/5 min); una petición que ya va a rechazarse no consume cupo compartido.
2. **`calibrated` en mercados discretos.** `src/lib/engine/analyze.ts` usa `calibrated: draft.calibrated ?? false`; los mercados sin curva viajan como `calibrada: false` y sin `umbral_pct` en el digest de Gemini. `src/components/MarketCard.tsx` solo emite `data-calibrated` cuando hay curva, así que las cifras discretas conservan el color lima. Pruebas: `totals.calibrated === true`, `exact_score.calibrated === false`.
3. **CSP con `'unsafe-inline'`.** Se mantiene: sin nonce/middleware no hay alternativa práctica en Next; el markdown se renderiza sin HTML crudo y el resto de directivas restringe origen, objetos y frames.
4. **Documentación.** `README.md` indica 30 pruebas. ESLint y los avisos de `npm audit` siguen documentados como deuda de tooling/dependencias.

**Verificación:** `npm run typecheck` limpio, `npm test` 30/30, `npm run build` correcto. En producción (3100): payload real con `calibrated:false` y `curve:0` en los siete mercados discretos, `true` en totales/hándicap/córners; navegador sin errores de consola y cifras discretas en lima. `../api` intacta; sin commits ni despliegues.

## 12. Convención de signo del hándicap (2026-10-29)

**Motivo:** el análisis podía publicar al favorito con línea positiva (por ejemplo `-0.25` y +0.25 mezclados según el partido). En un parley real el favorito siempre entrega goles y aparece con valores negativos; el no favorito recibe el espejo positivo.

**Cambio:** `src/lib/engine/calibration.ts` limita las líneas del favorito a `-3.0 … -0.25` (`FAVORITE_HANDICAP_LINES`). Si ninguna alcanza el umbral se publica la menos exigente (`-0.25`) con `calibrated: false`; nunca se asigna una línea positiva ni una alternativa positiva. La curva y las alternativas quedan todas en negativo y la explicación ya no anticipa «riesgo alto», que sigue decidiéndolo el campo `risk`.

**Verificación:** `npm test` 30/30 con la prueba reemplazada «el favorito nunca recibe una línea positiva» y aserciones nuevas sobre el derbi; `npm run build` correcto. En vivo (3100, `espn:401874795`): `Internazionale -0.25`, curva `-3.00 … -0.25`, sin alternativas positivas. `docs/MOTOR_LINEAS.md` actualizado.

**Consecuencia:** con el umbral actual (≈76 %) el runline del favorito rara vez queda calibrado; se muestra como «Sin línea sobre umbral». Si se prefiere una pata jugable, la alternativa es recomendar el lado del no favorito con su línea positiva espejo.

## 13. Recalibración del motor y arnés de medición (2026-10-30)

**Motivo:** las probabilidades de la matriz completa se veían conservadoras y desajustadas frente al mercado. La causa principal era la λ aditiva: promediar ataque y defensa comprimía la supremacía y dejaba el total lejos de la expectativa de las cuotas (p. ej. Bayern 3,09 frente a 4,07 implícito).

### 13.1 Cambios

1. **Fase 1 — λ multiplicativa.** `src/lib/engine/lambdas.ts` calcula fuerzas relativas a la media de la liga (`attack/perTeam`, `defense/perTeam`), las encoge un 15 % hacia 1 (más con muestra corta) y multiplica: `λ_home = atk_home · def_away · league.home`. `src/lib/engine/league.ts` aporta el total por liga (15 ligas, 2,70 por defecto) y el reparto local 54,5 %. La forma reciente pasa a ratios contra la media por equipo y los ajustes siguen acotados.
2. **Fase 2 — ancla de mercado.** `src/lib/engine/anchor.ts` invierte la Poisson 1D para obtener el total implícito, reparte la supremacía por bisección con el moneyline, ajusta λ por descenso de coordenadas si solo hay 1X2 y mezcla mercado y modelo con peso 50–85 % según calidad, acuerdo y discrepancia de total. Si no hay cuotas, no se aplica.
3. **Fase 3 — umbrales por mercado y valor comparable.** `calibration.ts` acepta una base por mercado (0,74 referencia; 0,72 totales; 0,66 hándicap; 0,70 córners). El valor se mide **en la línea de mercado** para el lado recomendado y se expone como `marketModelProbability`; la UI muestra «Modelo en mercado» y una nota de valor a ±3 puntos.
4. **Fase 4 — arnés.** `scripts/snapshot.ts` congela respuestas reales en `data/snapshots/` (ignorado por git); `scripts/measure.ts` calcula MAE 1X2, Δtotal, sesgo del favorito, Brier/log-loss cuando hay marcador, brecha de línea y cobertura de valor. Documentado en `docs/MEDICION.md`.

### 13.2 Medición de referencia

Tres partidos programados capturados el 2026-10-30 contra `https://api-flame-chi-53.vercel.app`:

| Partido | Total mercado | Motor λ / Δ / MAE / sesgo | Anclado λ / Δ / MAE / sesgo | Peso |
|---|---|---|---|---|
| Bayern – Dortmund | 4,07 (línea 3,5) | 3,09 / −0,98 / 3,9 pp / −5,9 pp | 3,90 / −0,17 / 0,8 pp / −0,8 pp | 82 % |
| Milan – Inter | 3,02 (línea 2,5) | 3,66 / +0,64 / 2,3 pp / +2,9 pp | 3,22 / +0,20 / 1,0 pp / +1,3 pp | 69 % |
| Liverpool – Arsenal | 2,74 (línea 2,5) | 2,27 / −0,47 / 3,9 pp / +2,7 pp | 2,58 / −0,16 / 1,3 pp / +0,6 pp | 66 % |
| **Agregado** | — | **|Δ| 0,70 · MAE 3,4 · sesgo 3,8** | **|Δ| 0,18 · MAE 1,0 · sesgo 0,9** | 66–82 % |

Criterios (variante anclada): |Δtotal| ≤ 0,20 ✔ (0,18); |sesgo favorito| ≤ 2,5 pp ✔ (0,9); MAE 1X2 ≤ 2,5 pp ✔ (1,0). Cobertura de valor 12/30 mercados (1X2, doble oportunidad, altas/bajas y hándicap); los otros seis no tienen cuota comparable y no publican valor.

### 13.3 Verificación final

- `npm run typecheck` sin errores; `npm test` 40/40 en 2,6 s (motor, ancla, métricas, servidor); `npm run build` correcto (`/` estática 58,1 kB; `/api/{ai,analyze,health}` dinámicas).
- `npm run audit`: los tres criterios se cumplen y la tabla de §13.2 se reproduce.
- Producción local en 3200 (el 3100 lo ocupa ahora la API) contra la API desplegada: `/api/health` 200 `ok:true`, contrato 1.2.0; `POST /api/analyze` (`espn:401874795`) 200 con 10 mercados, λ 1,37/1,85 (3,22), umbrales 76,2/74,2/68,2/72,2 %, ancla 68,6 % (`moneyline+totals`), Over 1,5 al 84,15 %, modelo 62,43 % en la línea 2,5 (valor +4,36 pp), córners 11,5 calibrado, hándicap −0,25 sin calibrar y combinada de 2 patas al 64,5 %; partido finalizado → 422 `MATCH_NOT_PROJECTABLE`; `text/plain` → 415; `GET /` → 200. Servidor temporal detenido al terminar.
- `../api` intacta; sin commits, pushes ni despliegues.

### 13.4 Consecuencias y límites

- La λ anclada hace que 1X2, totales y hándicap sean coherentes con la expectativa agregada del mercado; el valor real se busca en la forma de la matriz (correlaciones, cuartos, marcadores), no en batir el 1X2.
- La línea recomendada **no** se fuerza a la de mercado: sigue siendo la más ambiciosa que sostiene el umbral. La tarjeta muestra ambas y la probabilidad del modelo en la línea de mercado.
- Tres partidos detectan sesgos gruesos, no certifican calibración; no hay resultados observados todavía, así que Brier y log-loss quedan vacíos.
- Sigue pendiente la acción del usuario en Vercel: añadir `STATS_API_BASE_URL` al proyecto web y redesplegar.

## 14. Uso completo de los datos, incertidumbre y modo en vivo (2026-10-30)

**Motivo:** el motor ya estaba anclado al mercado, pero ignoraba parte del contrato
de la API (estado de cada estadística, alineaciones, descanso, posiciones, clima,
h2h, mercados extra, apertura/movimiento) y no comunicaba cuánto podía moverse el
pronóstico. Tampoco analizaba partidos en juego. `MODEL_VERSION` pasa a `1.2.0`.

### 14.1 Cambios

1. **Ponderación por estado y contexto acotado.** `lambdas.ts` usa
   `observed` = 1, `projected` = 0,65 y derivadas ×0,85 para cada estadística.
   `adjustments.ts` aplica factores por alineación confirmada (ratings), descanso
   corto, nivel del rival, clima, temperatura y h2h; cada lado queda en ±15 % y el
   total en ±10 %, con `model.adjustments` y un caveat por ajuste.
2. **Forma por rol y nivel.** Se priorizan `splits.vs_stronger/vs_weaker`,
   `splits.home/away`, el agregado con muestra ≥ 5 y, por último, `form`.
3. **Ancla ampliada.** `anchor.ts` acepta `predictionTotal` y `predictionWin`
   cuando no hay cuota (`moneyline+prediction`, `prediction`), publica
   `totalSource` y escala el peso con la deriva apertura→cierre y el número de
   casas (`movementWeightScale`). `model.marketSignal` resume el movimiento.
4. **Valor con mercados extra.** `extra_markets` alimenta doble oportunidad, BTTS
   y córners (alias sin acentos); si no hay cuota se usa la predicción y se marca
   `comparisonSource: prediction`. Se corrigió el emparejamiento de la línea de
   córners: nunca se mezcla una línea de proveedor con la probabilidad de la
   predicción.
5. **Incertidumbre.** `uncertainty.ts` hace 240 muestras Monte Carlo
   (lognormal, semilla fija 20261030) y publica p10–p90 de λ, 1X2 y Over en la
   línea base; solo se adjunta a los mercados cuyo producto se muestreó.
6. **Modo en vivo.** `live.ts` estima el minuto desde el inicio, reparte λ
   restante y `shiftMatrix` desplaza la matriz por el marcador. Se retiran primer
   gol, HT/FT, córners y combinada; no se aplica el ancla ni se compara con
   cuotas previas al partido (el motor lo declara en un caveat).
7. **Backtest y tuning.** `results.ts` carga `data/results.json` (marcadores
   reales) sin cambiar el estado; `metrics.ts` añade fiabilidad por tramos, ECE e
   isotónica (PAVA); `scripts/tune.ts` barre el peso del ancla por Brier.
8. **UI y prompt.** `MarketCard` muestra rango 10–90 y la referencia de valor;
   `SummaryStrip` añade bandas a λ y 1X2; `ContextPanel` publica alineaciones,
   descanso, posiciones, apertura/movimiento y sede. `prompt.ts` envía señal,
   ajustes, incertidumbre, vivo y contexto.

### 14.2 Medición

Mismos tres snapshots; `npm run audit` con los cambios de §14:

| Partido | Total mercado | Motor λ / Δ / MAE / sesgo | Anclado λ / Δ / MAE / sesgo | Peso |
|---|---|---|---|---|
| Bayern – Dortmund | 4,07 (línea 3,5) | 3,04 / −1,03 / 4,6 pp / −6,9 pp | 3,92 / −0,15 / 0,8 pp / −0,9 pp | 85 % |
| Milan – Inter | 3,02 (línea 2,5) | 3,64 / +0,62 / 3,9 pp / +5,8 pp | 3,19 / +0,17 / 1,3 pp / +2,0 pp | 72 % |
| Liverpool – Arsenal | 2,74 (línea 2,5) | 2,26 / −0,48 / 4,7 pp / +3,9 pp | 2,59 / −0,15 / 1,4 pp / +0,9 pp | 69 % |
| **Agregado** | — | **|Δ| 0,71 · MAE 4,4 · sesgo 5,6** | **|Δ| 0,16 · MAE 1,2 · sesgo 1,2** | 69–85 % |

Los tres criterios se cumplen en la variante anclada. Cobertura de valor 16/30:
cuatro mercados con cuotas por partido y BTTS/córners con predicción en Milan y
Liverpool. Detalle en `docs/MEDICION.md`.

### 14.3 Verificación

- `npm run typecheck` sin errores; `npm test` 57/57 en ~6 s; `npm run build`
  correcto (`/` estática 59 kB, 162 kB de First Load JS).
- `npm run audit`: criterios OK (|Δ| 0,16 · sesgo 1,2 pp · MAE 1,2 pp).
- Producción local en 3300 contra la API desplegada (3100/3000 no se tocaron):
  `/api/health` 200 `ok:true`; `POST /api/analyze` (Bayern–Dortmund) 200 con
  `version 1.2.0`, λ 2,73/1,19 (3,92), ancla 85 % `moneyline+totals` con
  `totalSource: odds`, señal 4,5→3,5, cuatro ajustes (descanso y nivel del rival),
  banda total 3,16–4,68, resultado 69,2 % con rango 55–79 %, 10 mercados,
  referencia «Cuotas» en cuatro y combinada 79,0 %; `GET /` 200.
- Navegador (3300): versión 1.2.0 visible, sin mensajes de consola, banda p10–p90
  en λ y 1X2, «Rango 10–90» en la tarjeta de resultado, bloques de alineaciones,
  descanso, posiciones, apertura y sede; sin errores de hidratación.
- En vivo verificado sobre el fixture real de Bayern con estado `live`, 65 min y
  1-0 (script temporal, ya eliminado): 7 mercados (sin HT/FT, primer gol,
  córners), `parlay: null`, `marketAnchor.applied: false`, sin
  `comparisonSource`/valor, matriz desplazada y λ restantes 0,66/0,30.
- `../api` intacta; servidor temporal detenido; sin commits, pushes ni despliegues.

### 14.4 Límites y pendientes

- Los intervalos comunican sensibilidad a la entrada, no calibración observada;
  Brier/ECE reales requieren `data/results.json` con partidos ya jugados.
- En vivo no hay cuotas condicionadas al marcador en el contrato actual; el motor
  evita comparar, pero no puede publicar valor en vivo.
- Sigue pendiente la acción del usuario en Vercel: añadir `STATS_API_BASE_URL` al
  proyecto web y redesplegar para publicar esta versión.

## 15. Ciclo de aprendizaje con Supabase (2026-10-31)

### 15.1 Cambios

- **Esquema.** Seis migraciones en `supabase/migrations/`: tablas
  `matches`, `match_snapshots`, `engine_params`, `predictions` e
  `ingestion_events`; RLS activo sin políticas (solo `service_role`), unicidad
  por `(match_id, phase, payload_hash)`, un único post vigente, una única
  versión promovida y trigger que exige snapshot pre para predecir. RPC
  `record_snapshot` (idempotente, `partial → complete`, restaura el post
  anterior al corregir) y `purge_post_payloads`; vista `v_match_backtest` con
  `actual_result`, Brier y log-loss. Rollback en `supabase/rollback/`.
- **Parámetros.** Todo el motor lee de `EngineParams`
  (`src/lib/engine/params.ts`); los defaults reproducen 1.2.0 y
  `tests/engine/params.test.ts` fija la identidad implícito vs explícito.
- **Captura pre.** `persistPreAnalysis` escribe partido, snapshot canónico por
  hash y predicción de producción; se invoca desde `after()` en
  `/api/analyze`, con timeout propio y fail-open.
- **Variante sombra v1.** `src/lib/engine/shadow.ts` define
  `engine-1.3.0-shadow-noanchor`: los defaults de 1.2.0 con el ancla
  neutralizada (`finalWeightMin/Max = 0` y los cinco pesos a cero; sin tocar
  los mínimos el `weightScale` devolvía el peso a 0,25). La fila vive en
  `engine_params` con `status = shadow` (migración
  `20261031120500_learning_loop_shadow_params.sql`) y el código solo lee
  overrides numéricos: claves o valores inválidos se ignoran. Tras guardar la
  predicción de producción, `persistShadowAnalysis` lee la fila (caché de 60 s),
  corre el motor y escribe `variant = shadow` con
  `on_conflict (snapshot_id, variant, params_version)`; nunca lanza ni altera
  la producción. `anchorLambdas` recibe ahora `params` desde `analyzeMatch`
  (antes usaba siempre los defaults, lo que hacía que la sombra no pudiera
  desactivar el ancla).
- **Laboratorio real.** `getLabSummary` empareja la última captura pre con
  ambas variantes por partido finalizado y publica filas `1x2_home`,
  `1x2_draw`, `1x2_away` y `totals` (solo si comparten lado y línea): media de
  cada motor, `deltaPp = sombra − producción`, `n` partidos e IC 95 % de la
  diferencia cuando `n ≥ 2`. Estado `complete` con 100 partidos y filas,
  `partial` con 100 sin filas comparables, `insufficient` por debajo.
- **Retención.** `npm run purge [-- --keep días] [--dry-run]` llama a
  `purge_post_payloads`, vacía solo el JSON de los post antiguos y deja una
  traza `purge_payloads` en `ingestion_events`.
- **Ingesta post.** `POST /api/ingest/post` (`x-ingest-token`, comparación en
  tiempo constante) valida `post_match`, anula campos en conflicto, deriva el
  marcador y registra el snapshot post. Solo persiste si el partido ya tiene
  captura `pre` (409 `POST_MATCH_WITHOUT_PRE`, sin crear filas); el trigger
  `match_snapshots_post_requires_pre` bloquea la misma escritura directa por RPC.
  El contrato vive en `src/lib/server/post-run.ts` (`ingestPostMatch`) y lo
  comparten la ruta manual y el cron.
- **Cron de cierre.** `GET /api/cron/ingest` con `Authorization: Bearer
  CRON_SECRET` (comparación en tiempo constante; 503 `CRON_DISABLED` sin secreto
  en producción) busca partidos con captura `pre` y sin ningún snapshot `post`,
  ya iniciados hace ≥ 2 h, y registra el resultado de cada uno (máximo 10 por
  pasada y 45 s de presupuesto). `listPendingPostMatches` consulta snapshots,
  no `v_match_backtest`, para no depender de que existan predicciones; deduplica
  capturas pre y ordena por captura reciente para que un partido sin marcador
  disponible no bloquee al resto. Un fallo por partido no aborta la pasada y la
  respuesta resume `inserted/duplicates/skipped/errors`. `vercel.json` lo
  programa a diario (`0 6 * * *`); el plan Hobby solo admite una ejecución
  diaria.
- **UI.** Sección «Sombra vs. producción» al final del dashboard con la
  compuerta de 100 partidos, estados explícitos y `GET /api/lab`.

### 15.2 Verificación

- `npm run typecheck` limpio; `npm test` **93/93**; `npm run build` correcto
  con las rutas `/api/lab`, `/api/ingest/post` y `/api/cron/ingest`.
- Sombra verificada en vivo contra Supabase: un análisis real de
  Liverpool–Arsenal generó `production` 0,3069/0,2878/0,4053 y `shadow`
  0,2576/0,3066/0,4357 con `params_version = engine-1.3.0-shadow-noanchor`,
  evento `generate_predictions` `ok` (301 ms, `request_id = shadow`).
- `GET /api/lab` contrastado con un partido finalizado de prueba (snapshot pre
  + ambas variantes): 1/100, cuatro filas con delta +5,0 / −2,0 / −3,0 /
  −3,0 pp y `n = 1`; con dos predicciones del mismo partido se conserva la
  última captura y se deduplica. Filas de prueba eliminadas y laboratorio de
  nuevo en 0/100. En navegador sobre el build de producción, la tabla muestra
  los cuatro mercados con «Observación en curso».
- `npm run purge -- --dry-run` valida la ventana; la purga real no se ejecutó
  (no hay snapshots post todavía y requiere autorización).
- `npm run audit` idéntico a §14.2 (motor |Δ| 0,71 · MAE 4,4 pp; anclado
  |Δ| 0,16 · MAE 1,2 pp; sesgo 1,2 pp; valor 16/30; criterios OK): el refactor
  de parámetros no cambió producción.
- Migraciones aplicadas en PostgreSQL 17.11 y probadas en transacción:
  duplicado detectado, `partial → complete`, post único vigente, corrección
  restaura el anterior, trigger rechaza predicción sobre post, `anon` y
  `authenticated` sin acceso a tablas ni funciones.
- Persistencia real: primera captura `ok`, repetición `duplicate` con el mismo
  `snapshot_id`; 1 snapshot + 1 predicción. Un análisis desde la UI con datos
  actualizados generó un segundo snapshot (hash distinto) y su predicción, sin
  duplicar eventos.
- Post sin pre verificado en vivo: la capa devuelve `missing_pre` sin crear el
  partido, el RPC directo falla con `23514` y, con un pre previo, el post se
  registra como vigente. Filas de prueba eliminadas.
- `GET /api/lab` 200 `insufficient` (0/100); `POST /api/ingest/post` 401 sin
  token o con token incorrecto, 400 con cuerpo inválido.
- **Ingesta post desbloqueada (2026-10-31).** La instancia que usa la web,
  `https://api-flame-chi-53.vercel.app` (proyecto `api` de la cuenta
  `aaromski`, repo `github.com/aaromski/api`), ya sirve `?include=post_match`:
  `espn:401874972` (Atalanta–Frosinone 4-4) devuelve `post_match.status =
  complete`, 6/6 secciones. La primera sonda minutos antes daba 409 porque esa
  instancia aún respondía con un build anterior (las respuestas de estadísticas
  se cachean 30 s); tras el redespliegue responde `complete`. Con
  `INGEST_TOKEN` definido: sin pre → 409 `POST_MATCH_WITHOUT_PRE`; con un pre
  de prueba → 200, `inserted:true`, marcador 4-4, snapshot post vigente y
  evento `ok` (769 ms); repetición → 200 `inserted:false` con el mismo
  `snapshot_id`. Filas de prueba eliminadas. La instancia
  `api-eta-two-64.vercel.app` (cuenta `lucesanderson`) también sirve el bloque,
  pero no es la configurada en la web.
- **Producción web verificada (2026-10-31).** En
  `https://web-analisis-nu.vercel.app`: `/api/lab` → `insufficient` 0/100
  (Supabase configurado), ingesta sin token → 401, con token y sin pre → 409
  `POST_MATCH_WITHOUT_PRE`, con pre → 200 `complete` 4-4 con cobertura 6/6 y,
  repetida, 200 `inserted:false` con el mismo snapshot; un análisis real
  Liverpool–Arsenal desde el despliegue escribió las predicciones de producción
  y de sombra.
- **Cron verificado en vivo (2026-10-31).** Build de producción local con
  `.env.local` y `CRON_SECRET` generado: sin cabecera → 401; con el secreto y un
  pre de prueba para `espn:401874972` → 200,
  `pending:1, inserted:1`, evento `capture_post` `ok` (534 ms) y snapshot post
  vigente con marcador 4-4; segunda pasada → `pending:0` (la lista ya excluye el
  partido cerrado). Fixture eliminado y contador del laboratorio de nuevo en
  0/100.
- Navegador sobre el build de producción: análisis Bayern–Dortmund 200 y
  sección sombra visible con la compuerta en 0/100; sin errores de consola.

### 15.3 Límites y pendientes

- La sombra v1 es un brazo de control (sin ancla), no una candidata a
  promoción. La comparación solo gana muestra con partidos finalizados que
  tengan captura pre; el contador sigue en 0/100. Cambiar de candidata exige
  una nueva fila `shadow` en `engine_params`, sin tocar código.
- `n` e IC se calculan sobre partidos, no sobre predicciones sueltas: el lab
  usa un snapshot por partido (el más reciente con ambas variantes) y no mide
  calibración (Brier/log-loss) todavía; eso llegará con la vista de backtest.
  La lectura asume una versión de producción y una sombra; al promover una
  candidata habrá que filtrar por `params_version` para no mezclar motores.
- Despliegue: en Vercel el proyecto web ya tiene `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `INGEST_TOKEN` y `GEMINI_API_KEY`; comprobado en
  producción (`/api/lab` responde `insufficient` y la ingesta 200/401/409 como
  en local). Falta añadir `CRON_SECRET` (generado en `.env.local` el
  2026-10-31, mismo valor que en el servidor) y redesplegar para que
  `vercel.json` registre el cron: los cambios de variables y de configuración
  no aplican a despliegues existentes. Con el plan Hobby el cierre corre una
  vez al día; pasar a horario solo exige editar el `schedule`.
- Sin commits, pushes ni despliegues.

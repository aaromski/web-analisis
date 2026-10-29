# Parley Lab · Prototipo UX/UI

## 1. Objetivo, usuarios y principios

**Objetivo.** Que una persona pueda leer un partido pre-partido en menos de dos minutos: entender qué dice el modelo, por qué se eligió esa línea y cuánto riesgo asume antes de armar una combinada.

**Usuarios.**
- **Primario:** aficionado que arma parleys y compara cuotas. Entiende Over/Under y hándicap, pero no quiere interpretar una matriz Poisson.
- **Secundario:** analista curioso que quiere ver la calibración, el valor frente al mercado y las advertencias de datos.

**Principios.**
1. **La línea es la protagonista.** Selección, probabilidad y confianza antes que adornos.
2. **Editorial, no casino.** Serif en titulares, hairlines, aire; nada de dorados, urgencia ni promesas.
3. **El riesgo se dice, no se insinúa.** Bajo/Medio/Alto siempre con texto, no solo color.
4. **Datos trazables.** Cada cifra viene del motor; la UI no recalcula probabilidades ni inventa cuotas.
5. **Una lectura por pantalla.** Partido, mercados, combinada e IA en ese orden.

**Supuestos (a confirmar).**
- Local y visitante son obligatorios; fecha y liga, opcionales. Si la API exige fecha, el campo pasa a obligatorio sin cambiar el layout.
- No hay listado de partidos ni autocompletado: el buscador resuelve un partido exacto por equipos/fecha/liga o por ID.
- `dataQuality.insufficient` no bloquea: se muestra el dashboard con una banda de análisis limitado.
- Convención numérica: líneas como `2.5` (notación del motor); porcentajes y cuotas como `46,1 %` y `1,82`.

## 2. Arquitectura de información y sitemap

Una sola ruta, dos vistas. La URL es la fuente de verdad; los errores se renderizan sobre la misma consulta para que recargar reintente.

```text
/                                                        Vista 1 · Buscador
/?home=Milan&away=Inter&date=2025-10-12&league=Serie%20A  Vista 2 · Dashboard
/?id=1234567                                             Vista 2 · Dashboard por ID
#mercados   #combinada   #ia   #contexto
```

- **Buscador:** cabecera, titular, formulario, método y aviso de juego responsable. Sin historial ni partidos destacados.
- **Dashboard:** cabecera del partido → resumen → mercados (2 columnas) + columna lateral (combinada y contexto) → informe IA a ancho completo. Anclas para saltar.
- **Reglas:** el envío válido actualiza la URL antes de la respuesta; `Nueva búsqueda` vuelve a `/`; `id` tiene prioridad sobre los campos de equipos; el estado de la IA no se guarda en la URL.

**Estados de vista:** `buscador · cargando · dashboard · dashboard-limitado · error-api · no-encontrado · no-proyectable`.

## 3. Flujo principal y flujos alternos

| Flujo | Secuencia | Salida / recuperación |
|---|---|---|
| Búsqueda por equipos | Local/visitante (fecha y liga opcionales) → `Analizar partido` → URL → 4 etapas → dashboard | Mercados y combinada; foco en el `h1` del partido |
| Búsqueda por ID | Cambiar a `Por ID` → pegar ID → analizar | Mismo dashboard; cabecera completa al responder |
| API caída, timeout o respuesta incompleta | Fallo de red/5xx tras el envío | `ErrorState` de conexión; `Reintentar` repite la misma consulta sin perder la URL |
| Partido no encontrado | Respuesta vacía o 404 | `ErrorState` sin resultados; `Editar búsqueda` y `Buscar por ID` |
| Finalizado o en juego | El motor devuelve `MATCH_NOT_PROJECTABLE` | `ErrorState` con marcador y texto de estado; `Elegir otro partido` → `/` |
| Datos insuficientes | `dataQuality.insufficient` | Dashboard con banda ámbar; mercados visibles como referencia; la combinada puede ser nula |
| IA fallida | Gemini devuelve error o timeout | Error dentro de `AiPanel`; `Reintentar` solo regenera el informe; el análisis no se recarga |
| Sin combinada | `parlay === null` | `ParlayCard` vacía con explicación; los mercados siguen disponibles |

**Carga por etapas (sin demoras artificiales):** se muestran las etapas alcanzadas y se anuncian con `aria-live="polite"`: `Consultando estadísticas…` → `Ajustando forma y cuotas…` → `Calculando λ y la matriz…` → `Calibrando líneas y combinada…`.

## 4. Wireframes
Cifras de ejemplo; no son datos reales.

**Buscador · desktop (≥1200)**

```text
┌────────────────────────────── 1240 ──────────────────────────────┐
│ ▪ PARLEY LAB                    Motor v1.0.0 · Juego responsable │
│                                                                   │
│  ANÁLISIS PRE-PARTIDO                                             │
│  La línea correcta,                                               │
│  antes del pitido inicial.                                        │
│  Analiza el partido. El motor calcula λ, la matriz y la línea.    │
│                                                                   │
│  ┌ BUSCAR PARTIDO ─────────────────────────────────────────────┐  │
│  │ ( Por equipos )  ( Por ID )                                 │  │
│  │ LOCAL                     VISITANTE                          │  │
│  │ [ Ej. Milan            ]  [ Ej. Inter             ]          │  │
│  │ FECHA                     LIGA                               │  │
│  │ [ dd/mm/aaaa           ]  [ Ej. Serie A           ]          │  │
│  │ [ Analizar partido → ]        9 mercados + córners           │  │
│  └─────────────────────────────────────────────────────────────┘  │
│  ── Datos → matriz → línea calibrada ─────────────────────────    │
│  Análisis estimativo. No garantiza resultados.            18+     │
└───────────────────────────────────────────────────────────────────┘
```
**Buscador · mobile (390)**

```text
┌──────────── 390 ────────────┐
│ ▪ PARLEY LAB          18+   │
│ La línea correcta,          │
│ antes del pitido inicial.   │
│ ┌ BUSCAR PARTIDO ─────────┐ │
│ │ [Por equipos] [Por ID]  │ │
│ │ LOCAL [ Ej. Milan     ] │ │
│ │ VISITANTE [ Ej. Inter ] │ │
│ │ FECHA [ dd/mm/aaaa    ] │ │
│ │ LIGA [ Ej. Serie A    ] │ │
│ │ [ Analizar partido → ]  │ │
│ └─────────────────────────┘ │
│ Datos → matriz → línea      │
│ Juego responsable · 18+     │
└─────────────────────────────┘
```
**Dashboard · desktop (≥1200).** Tres columnas visuales: dos de mercados y la columna lateral.

```text
┌────────────────────────────── 1240 ─────────────────────────────────┐
│ ← Nueva búsqueda      ▪ PARLEY LAB        Modelo v1.0.0 · 18+      │
│ SERIE A · 2025/26 · PROGRAMADO                                      │
│ (MI) MILAN              20:45              INTER (IN)               │
│ sáb 12 oct · San Siro                                               │
│ ┌ λ 1,62–1,08 ┐ ┌ 1X2 46/27/27 ┐ ┌ Calidad Alta 82 ┐ ┌ Umbral 74 % ┐│
├──────────────────────────────────┬──────────────────────────────────┤
│ MERCADOS · 9 objetivos + córners │ COMBINADA SUGERIDA               │
│ ┌────────────┐ ┌────────────┐    │ 2 selecciones · 48,2 %           │
│ │01 RESULTADO│ │02 DOBLE OP.│    │ 1X · Local o empate   73,1 %     │
│ │Milan gana  │ │1X · Local  │    │ Over 2.5              78,4 %     │
│ │46,1 % 2,17 │ │73,1 % 1,37 │    │ Conjunta 48,2 % · 2,07           │
│ │[56 · Alto] │ │[76 · Bajo] │    │ Correlación incorporada          │
│ └────────────┘ └────────────┘    │ ───────────────────────────────  │
│ ┌────────────┐ ┌────────────┐    │ CONTEXTO DEL PARTIDO             │
│ │03 ALTAS... │ │04 RUNLINE  │    │ Predicción · Forma · H2H         │
│ └────────────┘ └────────────┘    │ Bajas · Cuotas · Advertencias     │
│ ── MERCADO EXTENDIDO ─────────   │                                  │
│ ┌ 10 CÓRNERS ────────────────┐   │                                  │
├──────────────────────────────────┴──────────────────────────────────┤
│ ANÁLISIS IA · GEMINI                                  [Generar]    │
│ Un informe en español sobre la lectura, las líneas y los riesgos.   │
└──────────────────────────────────────────────────────────────────────┘
```
**Dashboard · mobile (390).** Orden: partido → resumen → combinada → mercados → IA → contexto.

```text
┌──────────── 390 ────────────┐
│ ← Nueva búsqueda      18+   │
│ SERIE A · PROGRAMADO        │
│ (MI) MILAN   20:45  INTER   │
│ sáb 12 oct · San Siro       │
│ [λ 1,62–1,08] [1X2 46/27/27]│
│ [Calidad 82] [Umbral 74 %]  │
│ ┌ COMBINADA · 2 ──────────┐ │
│ │ 48,2 % · cuota 2,07     │ │
│ └─────────────────────────┘ │
│ 01 RESULTADO · 46,1 % · 2,17│
│ …                           │
│ ── MERCADO EXTENDIDO ─────  │
│ [ ANÁLISIS IA · Generar ]   │
│ [ CONTEXTO ▸ ]              │
└─────────────────────────────┘
```
## 5. Inventario de componentes

Los campos `name`, `tagline`, `selection`, `explanation` y `note` se muestran tal cual; la UI no recalcula valores.

| Componente | Propiedades clave (contrato del motor) | Estados / comportamiento |
|---|---|---|
| `SearchForm` | `mode`, `initial`, `busy`, `fieldErrors`, `onSubmit` | Inactivo, inválido, enviando; selector `Por equipos/Por ID` como radio group; errores con `aria-describedby`; botón principal deshabilitado solo al enviar |
| `MatchHeader` | `match: MatchSummary`, `onNewSearch` | `Programado` o `Estado no confirmado` con aviso ámbar; monogramas de 2 letras (sin escudos externos); liga, temporada, fecha, sede y estado |
| `SummaryStrip` | `analysis: AnalysisResult` | Normal y limitado; λ local/visitante/total, 1X2, calidad y umbral; 4 columnas → 2×2 |
| `MarketCard` | `market: MarketResult`, `expanded`, `onToggle` | Colapsada, expandida, `available:false`, `calibrated:false`, sin cuota; la cabecera es un `button` con `aria-expanded` |
| `CalibrationChart` | `points`, `threshold`, `selection`, `side`, `unit` | 7/9/21 puntos; umbral discontinuo; elegido con anillo y etiqueta; tabla conmutable con `Ver tabla`; sin `curve` no se renderiza |
| `ParlayCard` | `parlay: ParlaySuggestion \| null` | 2 patas, 3 patas, vacío; acento lima; probabilidad y cuota justa conjuntas; nota de correlación |
| `AiPanel` | `state`, `report`, `error`, `onGenerate`, `onRetry` | Inactivo, cargando, éxito, error; acento cian; markdown saneado, sin HTML crudo |
| `ErrorState` | `kind`, `title`, `message`, `meta`, `primary`, `secondary` | API, sin resultados, no proyectable; acento coral o ámbar; foco en el titular al aparecer |
| `Skeleton` | `variant: 'dashboard' \| 'markets' \| 'ai'` | `aria-hidden`; estático con `prefers-reduced-motion` |
| `ContextPanel` | `context: MatchContext`, `quality: DataQuality` | Completo, parcial o vacío por sección; forma V/E/D y bajas Baja/Duda/Disponible; señales y advertencias; `details` cerrado en móvil; no añade consultas |

## 6. Contrato visual de cada mercado

**Tarjeta colapsada (común).** Acento superior de 2 px según riesgo; `01 · RESULTADO FINAL` en mono; `tagline` atenuado; selección 20/600; chip de línea si `line !== null`; probabilidad 32 px mono lima; `Cuota justa`; `Confianza` 0–100 con barra; `Riesgo` con texto; chip de valor (`+4,2 pts` en lima o `−2,1 pts` en ámbar) solo si `edge !== null`, si no `Sin cuota comparable`; visual de 56 px; `available:false` atenúa la tarjeta y muestra `Mercado no disponible`; acción `Ver detalle`.

**Detalle expandido.** Dos columnas: visual (curva o ranking) y explicación + metadatos (`Umbral`, `Línea base`, `Línea de mercado`, `Calibrada`, solo si existen). Debajo, tabla `Selección · Probabilidad · Cuota justa · Valor`. `explanation` y `note` tal cual. El cambio de foco no la cierra.

**Curva de calibración.** SVG con eje X de líneas candidatas y eje Y 0–100 %; umbral discontinuo etiquetado; puntos que lo cumplen en lima y resto en gris; punto elegido con anillo y etiqueta. En Altas/Bajas y Córners, la serie contraria se dibuja discontinua como referencia. En la tarjeta, sparkline sin ejes; en el detalle, ejes y tabla `Línea · Probabilidad · Umbral`.

**Mercados discretos.** Sin curva: barras horizontales de las 3 primeras alternativas (o top 3 de `scores`/`combos`) con probabilidad mono; la elegida lleva borde lima y etiqueta, no solo color.

| # | `name` visible | Detalle expandido |
|---|---|---|
| 01 | Resultado final | 3 alternativas; valor solo con cuota sin vig; nota si nada supera 50 % |
| 02 | Doble oportunidad | 3 coberturas `1X / X2 / 12`; mismo tratamiento |
| 03 | Altas / Bajas | Curva 0.5–6.5; base y línea de mercado; alternativas ±0.5; aviso si no calibra |
| 04 | Runline / Hándicap | Curva −3.0–+3.0; favorito y línea; alternativas ±0.25; nota si la línea es positiva |
| 05 | Anota primero | 3 opciones (local / visitante / sin goles); nota de proceso Poisson |
| 06 | Impar o par | 2 opciones; nota de mercado casi simétrico |
| 07 | Descanso / Final | Top 6 `combos`; etiquetas Local / Empate / Visitante; nota 44/56 y varianza |
| 08 | Marcador exacto | Top 6 `scores`; barras; nota de alta varianza |
| 09 | Ambos anotan | 2 opciones; contexto de predicción externa si existe |
| 10 | Córners | Extendido, tras divisor; curva 6.5–14.5; línea de mercado sin valor si falta cuota; sin proyección no se pinta tarjeta |

**Confianza y riesgo.** La barra y el número usan lima ≥74, ámbar 62–73 y coral <62. La insignia usa `risk`; una línea calibrada puede seguir en Medio. `calibrated:false` añade el chip ámbar `Sin línea sobre umbral`. `Cuota justa = 1 ÷ probabilidad`: no es una cuota ofertada.

## 7. Tokens de diseño

| Token | Valor | Uso |
|---|---|---|
| `--bg` | `#080B0D` | Fondo de página |
| `--surface` | `#0F1416` | Tarjetas |
| `--surface-2` | `#151B1E` | Columna lateral, campos |
| `--surface-3` | `#1B2225` | Puntero, chips |
| `--line` | `#252D31` | Bordes de 1 px |
| `--line-strong` | `#3B464B` | Puntero de borde |
| `--text` | `#F3F5F2` | Texto principal |
| `--text-muted` | `#A8B2AD` | Texto secundario |
| `--text-dim` | `#8A9490` | Metadatos; AA sobre superficie |
| `--lime` | `#C6F24E` | Confianza, selección, acción principal |
| `--amber` | `#F0B44C` | Riesgo medio, avisos |
| `--coral` | `#FF6F5E` | Riesgo alto, errores |
| `--cyan` | `#5CD8E6` | Solo IA |
| `--focus` | `#C6F24E` | Anillo de foco |

**Tipografía.** Display `Georgia, "Times New Roman", serif` para `h1`, nombres de equipo y titulares de estado: 64/56 px desktop, 40/36 móvil, `line-height .98`, `letter-spacing -.02em`. UI `system-ui, -apple-system, "Segoe UI", sans-serif`: cuerpo 16/1.55; antetítulos 12/600 con `.08em`. Números `ui-monospace, "SFMono-Regular", Consolas, monospace` con `tabular-nums`; probabilidad 32/40, líneas y cuotas 13–15.

**Espaciado y radios.** Escala 4/8/12/16/20/24/32/40/56/72/96; contenedor 1240 px; margen lateral 24/16; relleno de tarjeta 20–24; secciones 48/32. Radios 4 chips, 6 campos y botones, 10 tarjetas y paneles. Sin píldoras, gradientes, glassmorphism ni texturas.

**Sombras y movimiento.** Ninguna sombra por defecto; `--shadow-rail: 0 24px 60px rgba(0,0,0,.45)` solo en la columna lateral fija. Foco: `0 0 0 2px var(--bg), 0 0 0 4px var(--lime)`. Movimiento: 140 ms puntero/foco, 220 ms expandir, 320 ms paneles; curva `cubic-bezier(.2,.7,.2,1)`; solo opacidad y transform; sin indicador giratorio infinito; con `prefers-reduced-motion`, 0.01 ms y sin desplazamientos.

## 8. Textos exactos

| Contexto | Texto |
|---|---|
| Título de pestaña | `Parley Lab · Análisis pre-partido` |
| Antetítulo del buscador | `ANÁLISIS PRE-PARTIDO` |
| H1 buscador | `La línea correcta, antes del pitido inicial.` |
| Introducción del buscador | `Analiza el partido. El motor calcula los goles esperados, la matriz de marcadores y la línea que mejor sostiene la confianza.` |
| Título formulario | `Buscar partido` |
| Modos | `Por equipos` · `Por ID` |
| Etiquetas | `Equipo local` · `Equipo visitante` · `Fecha` · `Liga` · `ID del partido` |
| Pistas de campo | `Ej. Milan` · `Ej. Inter` · `dd/mm/aaaa` · `Ej. Serie A` · `Pega el ID del partido` |
| Ayudas | `Opcional. Ayuda a resolver el partido correcto.` · `Opcional. Nombre de la liga.` · `El identificador que devuelve la API de estadísticas.` |
| Acciones del buscador | `Analizar partido` · `Analizando…` |
| Método | `Datos → matriz → línea calibrada.` |
| Validación | `Escribe el equipo local.` · `Escribe el equipo visitante.` · `El local y el visitante deben ser equipos distintos.` · `Introduce el ID del partido.` · `Revisa los campos marcados.` |
| Etapas de carga | `Consultando estadísticas…` · `Ajustando forma y cuotas…` · `Calculando λ y la matriz…` · `Calibrando líneas y combinada…` |
| Navegación del panel | `Nueva búsqueda` · `Mercados` · `Combinada sugerida` · `Contexto del partido` · `Análisis IA` |
| Resumen | `Goles esperados (λ)` · `Probabilidad 1X2` · `Calidad de datos` · `Umbral de calibración` |
| Métricas de tarjeta | `Probabilidad` · `Cuota justa` · `Confianza` · `Riesgo` · `Valor vs. mercado` · `Umbral` · `Línea base` · `Línea de mercado` · `Calibrada` · `Sin cuota comparable` · `Ver detalle` · `Ocultar detalle` · `Ver tabla` |
| Estados de mercado | `Sin línea sobre umbral` · `Mercado extendido` · `Mercado no disponible` |
| Combinada | `Probabilidad conjunta` · `Cuota justa` · `Correlación incorporada` · `Las selecciones comparten partido: la conjunta no es el producto de las probabilidades individuales.` |
| Combinada vacía | `Sin combinada para este partido` · `No hay al menos dos selecciones que cumplan probabilidad y conjunta mínima. Revisa los mercados individuales.` |
| IA inactiva | `Generar informe` · `Un informe en español que explica la lectura del partido, la línea elegida y los riesgos. Usa solo los datos de este análisis.` |
| IA cargando | `Redactando el informe…` · `Gemini está leyendo el análisis del motor.` |
| IA error | `No pudimos generar el informe` · `Gemini no respondió o devolvió un error. El análisis del motor sigue disponible.` · `Reintentar` |
| Error de API | `No pudimos conectar con la API` · `El servicio de estadísticas no respondió. Comprueba que esté activo y vuelve a intentarlo.` · `Reintentar` · `Cambiar búsqueda` |
| Sin resultados | `No encontramos ese partido` · `Revisa los nombres, la fecha o la liga. Si conoces el ID, busca por esa vía.` · `Editar búsqueda` · `Buscar por ID` |
| Finalizado / En juego | `Este partido ya finalizó` · `El partido está en juego` · `El motor calibra líneas antes del inicio. Elige un partido programado para ver el análisis.` · `Elegir otro partido` |
| Datos insuficientes | `Datos insuficientes para calibrar` · `Análisis limitado` · `La cobertura estadística es baja. Las probabilidades se apoyan en medias de liga y deben leerse como referencia.` · `Ver datos` |
| Contexto | `Predicción externa` · `Forma reciente` · `Historial directo` · `Bajas y dudas` · `Cuotas de mercado`; vacíos: `Sin predicción externa.` · `Sin forma reciente.` · `Sin historial directo.` · `Sin bajas registradas.` · `Sin cuotas de mercado.` |
| Nota de lectura | `Confianza ≠ probabilidad: combina probabilidad, calidad de datos y acuerdo con el mercado.` |
| Aviso de juego responsable | Corto: `Análisis estimativo. No garantiza resultados. Juego responsable · 18+` · Completo: `Parley Lab es una herramienta de análisis estadístico. No es una casa de apuestas, no acepta apuestas y no ofrece consejo financiero. Las probabilidades son estimaciones del modelo y no garantizan ningún resultado. Si decides jugar, hazlo solo siendo mayor de 18 años, con dinero que puedas perder y sin perseguir pérdidas. Si el juego deja de ser un entretenimiento, busca ayuda profesional.` |

## 9. Responsive y accesibilidad

**Adaptación.** Puntos de corte 1200, 900 y 640 px.
- ≥1200: tres columnas visuales (dos de mercados + columna lateral fija de 360 px). 900–1199: mercados en 2 columnas; combinada a ancho completo sobre los mercados y contexto tras la IA.
- <900: una columna; orden partido → resumen → combinada → mercados → IA → contexto. <640: formulario en una columna, cabecera del partido compacta, detalle de tarjeta en una columna y tablas de alternativas como lista de definiciones.
- Curva de 56 px en tarjeta y 200–240 px en detalle; en móvil se rotulan líneas alternas y la etiqueta elegida se ancla para no recortarse. Sin desplazamiento horizontal a 360 px.
- El informe IA se limita a 68–72 caracteres por línea; sus tablas hacen desplazamiento interno.

**Accesibilidad.**
- `lang="es"`, regiones (`header`, `main`, `aside`, `footer`), un `h1` por vista y tarjetas con `h3`.
- Enlace `Saltar a los mercados`; foco visible de 2 px con offset; objetivos táctiles de 44 px; nada depende solo del paso del puntero. Etiquetas asociadas, `aria-invalid` y error junto al campo; el selector de modo se opera con flechas como grupo de opciones.
- Cabecera de tarjeta como `button` con `aria-expanded` y `aria-controls`; el contenido colapsado usa `hidden`.
- Gráficos con `role="img"`, `<title>`/`<desc>` y tabla de calibración equivalente; umbral discontinuo + etiqueta y punto elegido con anillo, no solo color.
- `aria-live="polite"` para etapas e informe; `aria-live="assertive"` para errores; no se anuncian todas las tarjetas.
- Contraste AA: texto atenuado solo desde 12 px; botón lima con texto `#080B0D`. Zoom 200 % sin pérdida de contenido. Con `prefers-reduced-motion` se desactivan transiciones y desplazamientos; el markdown conserva jerarquía y no admite HTML crudo.

## 10. Criterios de aceptación
1. En `/`, el `h1` usa serif y el formulario muestra cuatro campos en modo equipos y el selector de modo; enviar vacío produce dos errores, enfoca el primer campo inválido y no cambia la URL.
2. Un envío válido actualiza la URL, deshabilita el formulario y anuncia las cuatro etapas sin retrasos; recargar reproduce el análisis y `Nueva búsqueda` limpia la consulta.
3. `Reintentar` en error de API repite exactamente la consulta y mantiene el layout; el foco pasa al estado de carga y `Cambiar búsqueda` vuelve al buscador.
4. Sin resultados, finalizado y en juego muestran `ErrorState` con su texto; los dos últimos incluyen marcador y `Elegir otro partido`.
5. El dashboard muestra liga, temporada, fecha, sede, equipos y estado, sin imágenes externas; `SummaryStrip` muestra λ, 1X2, etiqueta/puntuación de calidad y umbral, sin recalcular cifras.
6. Se pintan los 9 mercados en el orden del motor y Córners solo si existe proyección, tras el divisor extendido; no hay tarjetas vacías.
7. Cada tarjeta muestra selección, línea cuando exista, probabilidad, cuota justa, confianza, riesgo y valor o `Sin cuota comparable`; `calibrated:false` es visible y no se etiqueta como recomendación.
8. La tarjeta se expande con ratón y teclado, actualiza `aria-expanded` y revela explicación, metadatos, alternativas y curva o ranking; la curva incluye umbral, punto elegido y tabla conmutable, y se distingue sin color. En mercados discretos se ven las barras de alternativas.
9. La combinada muestra 2–3 patas, probabilidad conjunta, cuota justa y nota de correlación; si es nula, muestra el estado vacío.
10. La IA pasa por inactiva, cargando, éxito y error; el error permite reintentar sin recargar el análisis y el markdown no ejecuta HTML.
11. Con datos insuficientes se ve la banda ámbar, el dashboard sigue operativo y las advertencias del motor aparecen en contexto.
12. A 1280, 1024, 768 y 390 px se cumple tres columnas visuales → dos → una, sin desplazamiento horizontal y con la columna lateral reordenada según la sección 9.
13. Se completa todo el flujo solo con teclado, con foco visible, contraste AA, `aria-live` correcto y movimiento reducido respetado.
14. Los textos coinciden con la sección 8, con aviso de juego responsable 18+ en ambas vistas; el sistema visual usa serif en titulares, sans en UI, mono tabular en cifras, bordes de 1 px con acento de 2 px, sin gradientes ni glassmorphism y cian solo para IA.

# Motor de líneas dinámicas

Documento de contrato interno del motor analítico de **Parley Lab**. Define qué datos
entran, cómo se convierten en una distribución de marcadores y con qué criterio se
elige la línea publicada. El código vive en `src/lib/engine/` y es puro: no hace
peticiones HTTP ni conoce React.

## 1. Insumos

La app consume únicamente la Aggregator API (`../api`, por HTTP):

```text
GET {STATS_API_BASE_URL}/api/v1/matches/stats?home=&away=&date=&league=
GET {STATS_API_BASE_URL}/api/v1/matches/{match_id}/stats
```

Del bloque canónico se usan, por equipo, `goals_scored`, `goals_conceded`, `xg`,
`xga`, `shots_total`, `shots_on_target`, `big_chances_created`, `big_chances_missed`,
`possession_pct` y `corners`. Cada valor llega con `status` (`observed`, `projected`,
`missing`) y `source`; el motor nunca inventa un valor `missing`.

Del bloque opcional `pre_match` se usan:

| Sección | Uso |
|---|---|
| `prediction.expected_goals`, `prediction.match_result`, `prediction.over_under` | Contraste y mezcla con el modelo propio. |
| `odds.moneyline`, `odds.totals`, `odds.spread` | Probabilidad implícita sin vig y detección de valor. |
| `teams.*.recent_form` y `teams.*.form` | Ajuste de forma (peso bajo, ventana distinta a la temporada). |
| `teams.*.lineup.unavailable` / `insights` | Contexto para el prompt de Gemini, no para la matriz. |
| `h2h` | Contexto para el prompt, no para la matriz. |

## 2. Goles esperados (λ)

Para cada equipo se calcula una fuerza de ataque y una de defensa:

```text
attack  = 0.62 * xG_for   + 0.38 * goals_for
defense = 0.62 * xGA      + 0.38 * goals_against
```

Si `xg` o `xga` faltan, se usan los goles y se marca una penalización de calidad.
La media de los dos equipos se mezcla con la media de la liga (1.45 local / 1.25
visitante) para evitar extremos con muestras pequeñas:

```text
raw_home = (attack_home + defense_away) / 2
raw_away = (attack_away + defense_home) / 2
lambda_home = 0.82 * raw_home + 0.18 * 1.45
lambda_away = 0.82 * raw_away + 0.18 * 1.25
```

Ajustes posteriores, todos multiplicativos y acotados:

1. **Ventaja de localía:** ×1.06 local, ×0.96 visitante.
2. **Forma reciente** (`recent_form`, últimos 10): si hay ≥5 partidos, se mezcla
   un 15 % la media de goles a favor/en contra de la ventana con la de temporada.
3. **Predicción externa:** si `pre_match.prediction.expected_goals` existe y es
   positiva, se mezcla un 35 % de la fuente externa (65 % modelo propio / 35 %
   fuente).
4. **Muestra:** con `sample < 5`, se acerca un 20 % adicional a la media de liga.
5. **Clamp:** cada λ en `[0.15, 4.5]`; el total en `[0.8, 7.0]`.

Las ponderaciones son deliberadamente conservadoras: la API entrega promedios de
temporada, no un modelo de fuerza por rival. El motor publica `lambdaHome`,
`lambdaAway`, `lambdaTotal` y la procedencia (`sources`, `blend`, `caveats`).

## 3. Distribución de marcadores

Matriz de Poisson independiente con corrección Dixon-Coles para marcadores bajos
(`rho = -0.10`), truncada en 12 goles por equipo y normalizada:

```text
P(i,j) = tau(i,j) * Pois(i; λh) * Pois(j; λa)
```

`tau` corrige 0-0, 1-0, 0-1 y 1-1. La matriz es la única fuente de verdad para
1X2, doble oportunidad, totales, BTTS, par/impar, handicap y marcador exacto. Por
eso la combinada puede calcular su probabilidad conjunta sumando celdas, sin
multiplicar probabilidades correlacionadas.

Para HT/FT se parte λ en primera (44 %) y segunda parte (56 %), se calcula la
matriz de cada mitad y se convoluciona la segunda sobre la primera. El resultado
es una matriz conjunta `(resultado HT, resultado FT)`.

## 4. Calibración dinámica de líneas

El motor no publica la línea de mercado por defecto: busca la línea más ambiciosa
que siga superando un umbral de confianza.

```text
tau_confianza = 0.74 + 0.08 * (1 - calidad) + 0.02 * desacuerdo_mercado
tau_confianza = clamp(tau_confianza, 0.68, 0.86)
```

- `calidad` ∈ [0,1] resume cobertura de xG, muestra, predicción, cuotas y forma.
- `desacuerdo_mercado` = 1 si la línea de mercado se aleja >0.35 goles de λ_total.

### Over / Under

1. La línea base es la semientera más cercana a `lambdaTotal` (por defecto 2.5).
2. Se evalúan las líneas `0.5 … 6.5` en pasos de 0.5 con `P(total > línea)` y
   `P(total < línea)`.
3. **Over:** se elige la línea **más alta** cuya probabilidad ≥ τ. Es la línea
   que exige más goles sin perder el umbral (ej.: Over 3.5 al 60 % no pasa;
   Over 2.5 al 78 % sí → se publica Over 2.5).
4. **Under:** simétrico, se elige la línea **más baja** que cumple τ.
5. Entre Over y Under se publica el lado con mayor margen sobre τ; el otro queda
   en la curva.
6. Si ninguna línea cumple, se devuelve la de mayor probabilidad con riesgo alto
   y `calibrated: false`.

### Handicap (runline)

1. Se elige el favorito por probabilidad de victoria (1X2).
2. Se evalúan las líneas `-3.0 … +2.0` en pasos de 0.25 para el favorito. Una
   línea de cuarto se juega a media apuesta en cada línea semientera adyacente y
   su probabilidad es la media de ambas.
3. `p_cover = P(margen + línea > 0) + 0.5 * P(margen + línea = 0)`.
4. Se publica la línea **más negativa** que cumple τ. Si ninguna cumple, se
   publica la de mayor cobertura (puede ser positiva) y se marca riesgo alto.

### Córners (extendido)

Poisson sobre `λ_corners = corners_local + corners_visitante`; mismas reglas de
Over/Under con líneas `6.5 … 14.5`. Se publica como mercado extendido, separado
de los nueve mercados objetivo.

## 5. Mercados publicados

| Mercado | Cálculo | Línea dinámica |
|---|---|---|
| Resultado (1X2) | Suma de celdas por signo | No |
| Doble oportunidad | Suma de dos signos | No |
| Altas/Bajas | `P(total > L)` / `P(total < L)` | Sí |
| Handicap | `P(margen + L > 0)` con push | Sí |
| Anota primero | Procesos de Poisson: `λh/(λh+λa)·(1-e^-Λ)` | No |
| Par/Impar | Suma de celdas por paridad | No |
| HT/FT | Matriz conjunta por mitades | No |
| Marcador exacto | Top 6 celdas | No |
| BTTS | `1 - P(0,·) - P(·,0) + P(0,0)` | No |

Cada mercado devuelve: selección, línea (si aplica), probabilidad, cuota justa
(`1/p`), umbral, riesgo, confianza 0-100, valor frente al mercado (si hay cuota),
curva de calibración y una explicación corta en español.

## 6. Confianza y riesgo

- **Probabilidad** = probabilidad del resultado recomendado, no del mercado entero.
- **Confianza 0-100** = 70 % probabilidad + 18 % calidad de datos + 12 % acuerdo
  con la predicción/cuotas. Se muestra como número y barra.
- **Riesgo:** `Bajo` si confianza ≥ 74 y calidad ≥ 0.6; `Medio` si ≥ 62;
  `Alto` en el resto. Una línea calibrada puede seguir siendo `Medio` si la
  muestra es corta.
- **Valor:** `p_modelo - p_sin_vig`. Se muestra en puntos porcentuales solo cuando
  la API publica cuota; nunca se inventa una cuota.

## 7. Combinada

Se eligen hasta 3 selecciones con probabilidad ≥ 0.66 y ≤ 0.93, sin repetir
mercado ni anidar selecciones (una pata que implique a otra no aporta valor).
La probabilidad conjunta se calcula **sumando las celdas de la matriz que
cumplen todas las condiciones**, no multiplicando. Si la conjunta cae por debajo
de 0.45, se recorta a 2 selecciones. Se publica probabilidad conjunta, cuota
justa y una advertencia de correlación.

## 8. Prompt de Gemini

`src/lib/prompt.ts` construye un JSON compacto con: partido, calidad y cobertura,
λ y blend, mercados recomendados, curvas de calibración, combinada, cuotas y
caveats. Gemini recibe instrucciones de:

- usar solo los datos del JSON y no inventar estadísticas;
- explicar la lectura del partido y por qué la línea elegida es la óptima;
- señalar mercados con valor y riesgos;
- proponer una combinada coherente con las probabilidades;
- responder en español, en markdown, con una advertencia de juego responsable;
- no prometer resultados ni presentar probabilidades como certezas.

El reporte se muestra tal cual (markdown saneado por `react-markdown`), con estado
de carga, error y reintento. La clave `GEMINI_API_KEY` solo existe en el servidor.

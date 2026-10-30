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
| `odds.moneyline`, `odds.totals`, `odds.spread` | Ancla de λ, probabilidad implícita sin vig y detección de valor. |
| `teams.*.recent_form` y `teams.*.form` | Ajuste de forma (peso bajo, ventana distinta a la temporada). |
| `teams.*.lineup.unavailable` / `insights` | Contexto para el prompt de Gemini, no para la matriz. |
| `h2h` | Contexto para el prompt, no para la matriz. |

## 2. Goles esperados (λ)

### 2.1 Fuerzas relativas a la liga

Para cada equipo se calcula una fuerza de ataque y una de defensa:

```text
attack  = 0.62 * xG_for   + 0.38 * goals_for
defense = 0.62 * xGA      + 0.38 * goals_against
```

Si `xg` o `xga` faltan, se usan los goles y se marca una penalización de calidad.
Las fuerzas se expresan **relativas a la media de la liga** y se combinan de forma
multiplicativa. Esto evita que un ataque fuerte contra una defensa débil se diluya
en un promedio aritmético y que la supremacía entre equipos quede comprimida:

```text
perTeam          = leagueTotal / 2
attack_strength  = attack  / perTeam
defense_strength = defense / perTeam

λ_home = attack_strength_home * defense_strength_away * league.home
λ_away = attack_strength_away * defense_strength_home * league.away
```

`league.home = leagueTotal * 0.545` y `league.away = leagueTotal * 0.455`: la
ventaja de localía va incluida en el reparto del total, no como multiplicador
adicional. La media por liga vive en `src/lib/engine/league.ts`:

| Liga | Total | Liga | Total |
|---|---|---|---|
| `eng.1` | 2,86 | `ned.1` | 3,05 |
| `esp.1` | 2,62 | `bel.1` | 2,90 |
| `ita.1` | 2,68 | `tur.1` | 2,75 |
| `ger.1` | 3,12 | `usa.1` | 2,95 |
| `fra.1` | 2,82 | `mex.1` | 2,70 |
| `por.1` | 2,55 | `arg.1` | 2,45 |
| `eng.2` | 2,65 | `bra.1` | 2,40 |
| `esp.2` | 2,40 | Desconocida | 2,70 |

Cada fuerza se acerca a 1 (la media) con un peso `w`:

```text
w        = clamp(0.15 + extra, 0, 0.5)
extra    = sample < 5 ? 0.2 * (1 - sample / 5) : 0
strength = (1 - w) * strength + w
```

El 15 % base corrige el ruido de promedios de temporada; el extra por muestra
corta acerca más las fuerzas a la media de liga y se refleja en los caveats.

### 2.2 Ajustes posteriores

1. **Forma reciente** (`recent_form` de los últimos 10 partidos o `form` de los
   últimos 5): se compara la media de goles de la ventana con `perTeam`.
   - Goles a favor: `λ_propia *= clamp(1 + 0.15 * (ratio - 1), 0.85, 1.15)`.
   - Goles en contra: `λ_rival *= clamp(1 + 0.10 * (ratio - 1), 0.90, 1.10)`.
2. **Predicción externa:** si `pre_match.prediction.expected_goals` existe y es
   positiva, se mezcla un 35 % de la fuente externa (65 % modelo propio / 35 %
   fuente).
3. **Clamp:** cada λ en `[0.15, 4.5]`; el total se reescala a `[0.8, 7.0]`
   conservando la proporción entre equipos.

### 2.3 Ancla al mercado

Las cuotas son la mejor estimación agregada de goles y supremacía. Después de
construir λ, el motor calcula una λ de referencia con el mercado y mezcla ambas.
Solo usa **cuotas reales**: la predicción externa ya entró en §2.2.

**Total implícito.** A partir de la línea de totales y su probabilidad Over sin
vig se invierte una Poisson 1D por bisección (60 iteraciones, λ ∈ [0.15, 8]):

```text
impliedTotalFromOver(line, over) → λ tal que P(total > line; λ) = over
```

Se descarta si `over ≤ 0.001` o `over ≥ 0.999` (cuota degenerada).

**Reparto de supremacía.** Con el total fijo, se busca la cuota de goles del local
que reproduce la probabilidad de victoria local del moneyline sin vig
(bisección sobre `share ∈ [0.12, 0.88]`):

```text
fitSupremacy(total, p_home) → { home: total * share, away: total * (1 - share) }
```

**Solo moneyline.** Sin totales, se ajusta el par de λ con descenso por
coordenadas en 8 direcciones, paso inicial 0,4 que se reduce a la mitad cuando no
mejora, máximo 80 iteraciones y tolerancia de mejora `1e-10`; minimiza el error
cuadrático del 1X2.

**Peso del ancla.** El ancla pesa más cuando los datos propios son débiles, cuando
el modelo se aleja del mercado o cuando el total difiere mucho (una discrepancia
grande suele ser un problema de escala de promedios de temporada, no información
nueva):

```text
gap = clamp((|λ_total - total_mercado| - 0.3) / 0.7, 0, 1) * 0.18

moneyline + totales: w = clamp(0.58 + 0.20*(1-calidad) + 0.10*(1-acuerdo) + gap, 0.50, 0.85)
solo totales:        w = clamp(0.45 + 0.15*(1-calidad) + 0.6*gap,                  0.40, 0.70)
solo moneyline:      w = clamp(0.48 + 0.20*(1-calidad) + 0.5*gap,                  0.45, 0.70)
```

La λ final es `(1 - w) * λ_modelo + w * λ_mercado`, reescalada y redondeada a dos
decimales. Si no hay cuotas válidas, el ancla no se aplica (`applied: false`).

El motor publica `model.marketAnchor` con `applied`, `weight`, `source`
(`moneyline+totals`, `moneyline`, `totals`, `none`), `marketTotal`, `marketHome` y
`marketAway`, además de una entrada en `sources` y un caveat con el peso aplicado.

Las λ finales se publican en `lambdas.home/away/total`, la procedencia en
`sources`/`blend` y las advertencias en `caveats`.

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
que siga superando un umbral de confianza. **Cada mercado tiene su propio umbral
base**, porque una línea de hándicap del favorito necesita menos cobertura que un
Over/Under:

| Mercado | Base |
|---|---|
| Resto (referencia) | 0,74 |
| Altas/Bajas | 0,72 |
| Hándicap | 0,66 |
| Córners | 0,70 |

El umbral efectivo se ajusta con la calidad de datos y el desacuerdo con el
mercado, dentro de una ventana de ±6/+12 puntos sobre la base:

```text
tau = clamp(base + 0.08 * (1 - calidad) + 0.02 * desacuerdo, base - 0.06, base + 0.12)
```

- `calidad` ∈ [0,1] resume cobertura de xG, muestra, predicción, cuotas y forma.
- `desacuerdo` = 1 si la línea de mercado se aleja >0.35 goles de λ_total.

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

### Hándicap (runline)

1. Se elige el favorito por probabilidad de victoria (1X2).
2. Se evalúan solo líneas negativas, `-3.0 … -0.25` en pasos de 0.25: en el
   mercado real el favorito siempre entrega goles y el no favorito recibe el
   espejo positivo. Una línea de cuarto se juega a media apuesta en cada línea
   semientera adyacente y su probabilidad es la media de ambas.
3. `p_cover = P(margen + línea > 0) + 0.5 * P(margen + línea = 0)`.
4. Se publica la línea **más negativa** que cumple τ. Si ninguna cumple, se
   publica la menos exigente (`-0.25`) con `calibrated: false` y riesgo alto;
   nunca se asigna un hándicap positivo al favorito.

### Córners (extendido)

Poisson sobre `λ_corners = corners_local + corners_visitante`; mismas reglas de
Over/Under con líneas `6.5 … 14.5`. Se publica como mercado extendido, separado
de los nueve mercados objetivo.

### Valor en la línea de mercado

Cuando la API publica cuota, el valor se mide **en la línea del mercado**, no en
la línea recomendada: así se compara el mismo producto que ofrece la casa.

```text
modelo_en_linea   = P(selección; línea_mercado)
p_mercado         = probabilidad sin vig de la misma selección
edge              = modelo_en_linea - p_mercado
```

- En totales se usa Over o Under de la línea de mercado según el lado elegido.
- En hándicap se usa la línea del favorito (la del mercado se refleja de signo si
  el favorito es el visitante).
- `marketModelProbability` y `marketProbability` viajan en el mercado; la UI
  muestra «Modelo en mercado X%».
- La nota de valor se emite a partir de ±3 puntos: «Valor en…», «Sin valor en…» o
  «Modelo y mercado alineados…». Si la línea recomendada está a más de 0.5 de la
  de mercado, se añade una nota con la distancia.

## 5. Mercados publicados

| Mercado | Cálculo | Línea dinámica |
|---|---|---|
| Resultado (1X2) | Suma de celdas por signo | No |
| Doble oportunidad | Suma de dos signos | No |
| Altas/Bajas | `P(total > L)` / `P(total < L)` | Sí |
| Hándicap | `P(margen + L > 0)` con push | Sí |
| Anota primero | Procesos de Poisson: `λh/(λh+λa)·(1-e^-Λ)` | No |
| Par/Impar | Suma de celdas por paridad | No |
| HT/FT | Matriz conjunta por mitades | No |
| Marcador exacto | Top 6 celdas | No |
| BTTS | `1 - P(0,·) - P(·,0) + P(0,0)` | No |
| Córners (extendido) | Poisson 1D sobre λ de córners | Sí |

Cada mercado devuelve: selección, línea (si aplica), probabilidad, línea base,
línea de mercado, probabilidad del modelo en la línea de mercado, cuota justa
(`1/p`), umbral, riesgo, confianza 0-100, valor frente al mercado (si hay cuota),
curva de calibración y una explicación corta en español.

## 6. Confianza y riesgo

- **Probabilidad** = probabilidad del resultado recomendado, no del mercado entero.
- **Confianza 0-100** = 70 % probabilidad + 18 % calidad de datos + 12 % acuerdo
  con la predicción/cuotas. Se muestra como número y barra.
- **Riesgo:** `Bajo` si confianza ≥ 74 y calidad ≥ 0.6; `Medio` si ≥ 62;
  `Alto` en el resto. Una línea calibrada puede seguir siendo `Medio` si la
  muestra es corta.
- **Valor:** `modelo_en_línea_mercado - p_sin_vig`, en puntos porcentuales, solo
  cuando la API publica cuota; nunca se inventa una cuota. Los mercados sin cuota
  comparable no publican valor.

## 7. Combinada

Se eligen hasta 3 selecciones con probabilidad ≥ 0.66 y ≤ 0.93, sin repetir
mercado ni anidar selecciones (una pata que implique a otra no aporta valor).
La probabilidad conjunta se calcula **sumando las celdas de la matriz que
cumplen todas las condiciones**, no multiplicando. Si la conjunta cae por debajo
de 0.45, se recorta a 2 selecciones. Se publica probabilidad conjunta, cuota
justa y una advertencia de correlación.

## 8. Prompt de Gemini

`src/lib/prompt.ts` construye un JSON compacto con: partido, calidad y cobertura,
λ y blend, umbrales por mercado, ancla de mercado, mercados recomendados, curvas
de calibración, combinada, cuotas y caveats. Gemini recibe instrucciones de:

- usar solo los datos del JSON y no inventar estadísticas;
- explicar la lectura del partido y por qué la línea elegida es la óptima;
- citar el valor en puntos porcentuales y aclarar que se mide en la línea de
  mercado;
- explicar si el ancla de mercado se aplicó y con qué peso;
- proponer una combinada coherente con las probabilidades;
- responder en español, en markdown, con una advertencia de juego responsable;
- no prometer resultados ni presentar probabilidades como certezas.

El reporte se muestra tal cual (markdown saneado por `react-markdown`), con estado
de carga, error y reintento. La clave `GEMINI_API_KEY` solo existe en el servidor.

## 9. Arnés de medición

`scripts/snapshot.ts` y `scripts/measure.ts` permiten congelar respuestas de la
API y medir el motor contra el mercado sin tocar la UI:

```text
npm run snapshot -- --home Bayern --away Dortmund --league ger.1 --date 2026-11-01
npm run audit
```

`npm run audit` evalúa dos variantes sobre los snapshots de
`data/snapshots/`: **motor** (λ sin ancla) y **anclado** (λ final). Compara 1X2
con el mercado sin vig y el total con el implícito, y verifica los criterios
(|Δtotal| ≤ 0,30, sesgo del favorito ≤ 3 pp, MAE 1X2 ≤ 4 pp). Los detalles,
métricas y resultados vigentes están en `docs/MEDICION.md`.

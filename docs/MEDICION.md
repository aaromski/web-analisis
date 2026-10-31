# Medición del motor

Arnés mínimo para comprobar si las probabilidades del motor son coherentes con el
mercado y, cuando hay resultado, con el marcador. No forma parte del runtime de la
app: se ejecuta a mano y no envía datos a terceros.

## 1. Captura de snapshots

```bash
export STATS_API_BASE_URL=https://api-flame-chi-53.vercel.app
npm run snapshot -- --home "AC Milan" --away "Internazionale" --date 2026-10-31 --league ita.1
npm run snapshot -- --home "Liverpool" --away "Arsenal" --date 2026-11-01 --league eng.1
npm run snapshot -- --home "Bayern Munich" --away "Borussia Dortmund" --date 2026-10-31 --league ger.1
```

Cada ejecución guarda la respuesta cruda de la API en `data/snapshots/` (ignorada
por git). La URL base sale de `STATS_API_BASE_URL` o de `http://localhost:3000`;
el script nunca imprime claves.

## 2. Cálculo de métricas

```bash
npm run audit
```

Para cada snapshot calcula dos variantes:

- **motor**: λ de `buildLambdas` sin tocar, solo con estadísticas, forma,
  predicción externa y medias de liga.
- **anclado**: λ después de `anchorLambdas`, con el peso de mercado que decide la
  calidad, el acuerdo y la discrepancia de total.

Métricas:

| Métrica | Definición | Unidad |
|---|---|---|
| `MAE 1X2` | media de \|modelo − mercado\| en local, empate y visitante | puntos porcentuales |
| `Δtotal` | λ_total − total implícito en la línea de totales (bisección Poisson) | goles |
| `sesgo favorito` | p(modelo) − p(mercado) en el lado favorito del mercado | puntos porcentuales |
| `Brier` | Σ(p_i − y_i)² con el resultado observado; solo con marcador | 0–2 |
| `log-loss` | −ln p(resultado observado) | nats |
| `ECE` | error medio de calibración agrupando probabilidades por tramos | 0–1 |
| `ECE isotónica` | ECE tras calibrar con regresión isotónica (PAVA) ajustada en la muestra | 0–1 |
| `línea rec.` | línea recomendada de Altas/Bajas − línea de mercado | goles |
| `valor` | mercados con `edge` calculado / mercados publicados | conteo |

El total implícito se obtiene invirtiendo `P(total > línea) = over` sin vig con una
Poisson 1D; es la referencia de goles que el mercado está pagando, no la línea
semientera.

Los marcadores reales se leen de `data/results.json` (ignorado por git), con la
forma `{ "espn:401884754": { "home": 2, "away": 1 } }` o `{ "matches": { … } }`.
`measure.ts` inyecta el marcador **sin cambiar el estado del partido**, así que el
análisis sigue produciendo mercados y además se puede puntuar. Sin ese archivo,
Brier, log-loss y ECE quedan vacíos; el arnés nunca inventa resultados.

## 3. Resultado de la corrida de referencia

Tres partidos programados capturados el 2026-10-30 contra la API desplegada:

| Partido | Total mercado | Motor λ / Δ / MAE / sesgo | Anclado λ / Δ / MAE / sesgo | Peso ancla |
|---|---|---|---|---|
| Bayern – Dortmund | 4.07 (línea 3.5) | 3.04 / −1.03 / 4.6 pp / −6.9 pp | 3.92 / −0.15 / 0.8 pp / −0.9 pp | 85 % |
| Milan – Inter | 3.02 (línea 2.5) | 3.64 / +0.62 / 3.9 pp / +5.8 pp | 3.19 / +0.17 / 1.3 pp / +2.0 pp | 72 % |
| Liverpool – Arsenal | 2.74 (línea 2.5) | 2.26 / −0.48 / 4.7 pp / +3.9 pp | 2.59 / −0.15 / 1.4 pp / +0.9 pp | 69 % |
| **Agregado** | — | **|Δ| 0.71 · MAE 4.4 · sesgo 5.6** | **|Δ| 0.16 · MAE 1.2 · sesgo 1.2** | 69–85 % |

Criterios acordados para la variante anclada:

- `|Δtotal| ≤ 0.20` goles: **cumple** (0.16).
- `|sesgo favorito| ≤ 2.5 pp`: **cumple** (1.2).
- `MAE 1X2 ≤ 2.5 pp`: **cumple** (1.2).

Cobertura de valor: 16/30 mercados. Los tres partidos publican valor en 1X2,
doble oportunidad, Altas/Bajas y hándicap (cuotas); Milan y Liverpool añaden BTTS y
córners con la predicción externa como referencia orientativa. Bayern no publica
esos dos porque no trae predicción y los otros mercados (primer gol, par/impar,
HT/FT, marcador exacto) no tienen referencia comparable; el arnés no inventa una
cuota.

## 4. Lectura correcta

- **El ancla usa el mismo mercado con el que se mide.** Que el MAE anclado sea
  ~1 pp no demuestra que el motor bata a la casa; demuestra que la escala de
  goles y la supremacía son coherentes con la expectativa agregada. El valor
  real se busca en la forma de la matriz (correlaciones, hándicaps de cuarto,
  marcadores), no en el 1X2.
- **La línea recomendada no se fuerza a la de mercado.** El motor publica la
  línea más ambiciosa que sostiene su umbral; por eso una línea recomendada de
  Over 1.5 puede convivir con una línea de mercado de 3.5. La tarjeta muestra
  ambas y la probabilidad del modelo en la línea de mercado.
- **Muestra pequeña.** Tres partidos sirven para detectar sesgos gruesos, no para
  certificar calibración. Para una validación seria hacen falta decenas de
  partidos con resultado; el arnés ya calcula Brier y log-loss cuando el
  snapshot trae marcador.
- **Sin resultados en la corrida.** Los tres snapshots son partidos programados;
  Brier, log-loss y ECE quedan vacíos. Para medirlos, guardar el snapshot previo y
  añadir el marcador en `data/results.json`.
- **La banda p10–p90 no es calibración.** El Monte Carlo mide sensibilidad a la
  incertidumbre de λ (calidad y alineación), no la frecuencia real de acierto; para
  eso hacen falta resultados.
- **Los partidos en vivo no entran en el arnés.** `evaluateResponse` compara con
  cuotas previas al partido, que no condicionan al marcador actual.

## 5. Barrido del peso del ancla

```bash
npm run tune
```

Recorre escalas del peso del ancla (`0,80 … 1,20`, paso `0,05`) sobre la variante
anclada de todos los snapshots, ordena por Brier medio y reporta log-loss y ECE
antes y después de la isotónica. Guarda el resultado en `data/tuning.json`
(ignorado por git). Sin `data/results.json` no hay Brier y el script solo confirma
que el ancla reproduce el mercado; con menos de 20 partidos avisa de que la
muestra no es concluyente.

## 6. Pruebas del arnés

`tests/audit/metrics.test.ts` cubre MAE, sesgo del favorito, Brier, log-loss,
derivación del resultado, fiabilidad por tramos, ECE e isotónica (monotonía y
reducción del error). `tests/audit/results.test.ts` cubre la carga de marcadores y
la inyección sin cambiar el estado. `tests/engine/anchor.test.ts` cubre la
inversión del total, el ajuste de supremacía, el ajuste 2D de 1X2 y el efecto del
ancla sobre el derbi.

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
| `Brier` | Σ(p_i − y_i)² con el resultado observado; solo si el snapshot trae marcador | 0–2 |
| `log-loss` | −ln p(resultado observado) | nats |
| `línea rec.` | línea recomendada de Altas/Bajas − línea de mercado | goles |
| `valor` | mercados con `edge` calculado / mercados publicados | conteo |

El total implícito se obtiene invirtiendo `P(total > línea) = over` sin vig con una
Poisson 1D; es la referencia de goles que el mercado está pagando, no la línea
semientera.

## 3. Resultado de la corrida de referencia

Tres partidos programados capturados el 2026-10-30 contra la API desplegada:

| Partido | Total mercado | Motor λ / Δ / MAE / sesgo | Anclado λ / Δ / MAE / sesgo | Peso ancla |
|---|---|---|---|---|
| Bayern – Dortmund | 4.07 (línea 3.5) | 3.09 / −0.98 / 3.9 pp / −5.9 pp | 3.90 / −0.17 / 0.8 pp / −0.8 pp | 82 % |
| Milan – Inter | 3.02 (línea 2.5) | 3.66 / +0.64 / 2.3 pp / +2.9 pp | 3.22 / +0.20 / 1.0 pp / +1.3 pp | 69 % |
| Liverpool – Arsenal | 2.74 (línea 2.5) | 2.27 / −0.47 / 3.9 pp / +2.7 pp | 2.58 / −0.16 / 1.3 pp / +0.6 pp | 66 % |
| **Agregado** | — | **|Δ| 0.70 · MAE 3.4 · sesgo 3.8** | **|Δ| 0.18 · MAE 1.0 · sesgo 0.9** | 66–82 % |

Criterios acordados para la variante anclada:

- `|Δtotal| ≤ 0.20` goles: **cumple** (0.18).
- `|sesgo favorito| ≤ 2.5 pp`: **cumple** (0.9).
- `MAE 1X2 ≤ 2.5 pp`: **cumple** (1.0).

Cobertura de valor: 12/30 mercados (4 por partido: 1X2, doble oportunidad,
Altas/Bajas y hándicap). Los otros seis no tienen cuota comparable en la API
(primer gol, par/impar, HT/FT, marcador exacto, BTTS y córners), así que no se
inventa un valor.

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
  Brier y log-loss quedan vacíos. Para medirlos, capturar partidos finalizados o
  guardar el snapshot previo y añadir el marcador después.

## 5. Pruebas del arnés

`tests/audit/metrics.test.ts` cubre MAE, sesgo del favorito, Brier, log-loss,
derivación del resultado y agregación con nulos. `tests/engine/anchor.test.ts`
cubre la inversión del total, el ajuste de supremacía, el ajuste 2D de 1X2 y el
efecto del ancla sobre el derbi.

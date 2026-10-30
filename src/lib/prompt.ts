import type { AnalysisEnvelope, MarketResult } from './types/analysis';

const SYSTEM_PROMPT = `Eres un analista cuantitativo de fútbol y estratega de parleys. Recibes un JSON generado por un motor propio (Poisson bivariado con corrección Dixon-Coles) que calibra líneas de apuesta antes del partido.

Escribe un informe en español, en markdown, para alguien que decide si arma un parley. Reglas obligatorias:

1. Usa exclusivamente los datos del JSON. No inventes estadísticas, jugadores, cuotas, lesiones ni noticias.
2. Distingue probabilidad de certeza. No prometas ganancias ni uses lenguaje de apuesta segura.
3. Explica la lectura del partido: ritmo esperado, goles, favoritismo y qué dicen las cuotas o la predicción externa si existen.
4. Justifica la línea calibrada de Altas/Bajas y la de Hándicap: menciona la línea base, el umbral de confianza, la probabilidad elegida y por qué se bajó o subió la línea. Si no está calibrada, dilo y explica el riesgo. Cuando exista valor frente al mercado, cítalo en puntos porcentuales y aclara que se mide en la línea de mercado, no en la recomendada.
5. Comenta 2-4 mercados con la mejor relación probabilidad/riesgo y 1-2 de alta varianza (HT/FT, marcador exacto, par/impar). No recomiendes todos.
6. Evalúa la combinada sugerida: coherencia, correlación entre selecciones y probabilidad conjunta. Si no hay combinada, explica por qué.
7. Señala los caveats de datos (cobertura, muestra, contexto parcial, cuotas ausentes) y cómo afectan la confianza. Si "ancla_mercado.applied" es verdadero, explica que λ se apoya parcialmente en las cuotas y que eso reduce la independencia del pronóstico.
8. Cierra con una advertencia breve de juego responsable y recuerda que las probabilidades son estimaciones.

Formato exacto (sin tablas gigantes, máximo ~700 palabras):
# Lectura del partido
## Líneas calibradas
## Mercados con valor
## Combinada
## Riesgos y datos
## Advertencia

No repitas el JSON ni muestres identificadores internos. No uses emojis. No uses LaTeX ni fórmulas entre dólares: escribe λ, ×, % y los números en texto plano. Usa coma decimal en porcentajes y cuotas (43,0 %).`;

function percent(probability: number): number {
  return Math.round(probability * 1000) / 10;
}

function compactCurve(market: MarketResult): Array<{ linea: number; probabilidad: number }> | undefined {
  if (market.curve.length === 0) return undefined;
  return market.curve.map((point) => ({
    linea: point.line,
    probabilidad: percent(point.probability),
  }));
}

function compactMarket(market: MarketResult): Record<string, unknown> {
  return {
    mercado: market.name,
    seleccion: market.selection,
    linea: market.line,
    linea_base: market.baseLine,
    linea_mercado: market.marketLine,
    probabilidad_pct: percent(market.probability),
    cuota_justa: market.fairOdds,
    umbral_pct: market.curve.length > 0 ? percent(market.threshold) : undefined,
    confianza: market.confidence,
    riesgo: market.risk,
    calibrada: market.calibrated,
    valor_vs_mercado_pp: market.edge === null ? null : Math.round(market.edge * 1000) / 10,
    modelo_en_linea_mercado_pct:
      market.marketModelProbability === null ? null : percent(market.marketModelProbability),
    cuota_implicita_mercado_pct:
      market.marketProbability === null ? null : percent(market.marketProbability),
    explicacion: market.explanation,
    nota: market.note,
    curva: compactCurve(market),
    marcadores: market.scores?.slice(0, 3).map((score) => ({
      marcador: score.score,
      probabilidad_pct: percent(score.probability),
    })),
    ht_ft: market.combos?.slice(0, 3).map((combo) => ({
      escenario: combo.label,
      probabilidad_pct: percent(combo.probability),
    })),
  };
}

/** JSON compacto y trazable que recibe Gemini. */
export function buildAnalysisDigest(envelope: AnalysisEnvelope): Record<string, unknown> {
  const { analysis, source } = envelope;
  return {
    partido: {
      liga: analysis.match.leagueName,
      fecha: analysis.match.date,
      local: analysis.match.homeName,
      visitante: analysis.match.awayName,
      sede: analysis.match.venue,
      estado: analysis.match.status,
      calidad: {
        score: analysis.dataQuality.score,
        etiqueta: analysis.dataQuality.label,
        cobertura_pct: percent(analysis.dataQuality.coverage),
        muestra: analysis.dataQuality.sample,
        insuficiente: analysis.dataQuality.insufficient,
      },
    },
    modelo: {
      lambda_local: analysis.lambdas.home,
      lambda_visitante: analysis.lambdas.away,
      lambda_total: analysis.lambdas.total,
      probabilidad_1x2_pct: {
        local: percent(analysis.winProbabilities.home),
        empate: percent(analysis.winProbabilities.draw),
        visitante: percent(analysis.winProbabilities.away),
      },
      umbral_lineas_pct: percent(analysis.model.threshold),
      umbrales_pct: {
        base: percent(analysis.model.thresholds.default),
        totales: percent(analysis.model.thresholds.totals),
        handicap: percent(analysis.model.thresholds.handicap),
        corners: percent(analysis.model.thresholds.corners),
      },
      linea_base_total: analysis.model.baseTotalLine,
      media_liga_goles: analysis.model.leagueBaseline,
      acuerdo_motor_mercado: analysis.model.marketAgreement,
      ancla_mercado: analysis.model.marketAnchor,
      fuentes_lambda: analysis.model.lambdaSources,
      version: analysis.model.version,
    },
    mercados: analysis.markets.map(compactMarket),
    combinada: analysis.parlay
      ? {
          selecciones: analysis.parlay.legs.map((leg) => ({
            mercado: leg.market,
            seleccion: leg.selection,
            probabilidad_pct: percent(leg.probability),
            cuota_justa: leg.fairOdds,
          })),
          probabilidad_conjunta_pct: percent(analysis.parlay.probability),
          cuota_justa_conjunta: analysis.parlay.fairOdds,
          nota_correlacion: analysis.parlay.correlationNote,
        }
      : null,
    contexto: {
      prediccion_externa: analysis.context.prediction,
      forma_reciente: analysis.context.recentForm,
      bajas: analysis.context.injuries,
      h2h: analysis.context.h2h,
      arbitro: analysis.context.referee,
      clima: analysis.context.weather,
      cuotas: analysis.context.odds,
      insights: analysis.context.insights,
    },
    caveats: analysis.dataQuality.caveats,
    fuente: {
      version_canonica: source.canonicalVersion,
      pre_match: source.preMatchStatus,
      cobertura_contexto: source.coverage,
      generado: analysis.model.generatedAt,
    },
  };
}

export function buildGeminiPrompt(envelope: AnalysisEnvelope): { system: string; user: string } {
  const digest = buildAnalysisDigest(envelope);
  return {
    system: SYSTEM_PROMPT,
    user: `Analiza el siguiente partido y redacta el informe solicitado.\n\nDatos del motor:\n${JSON.stringify(digest, null, 2)}\n\nRecuerda: no inventes datos y no prometas resultados.`,
  };
}

import type { AiReport, AnalysisEnvelope } from '../types/analysis';
import { buildGeminiPrompt } from '../prompt';
import { GeminiError } from './errors';

const DEFAULT_MODEL = 'gemini-3.6-flash';
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1';

function modelName(): string {
  const value = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
  return /^[A-Za-z0-9._-]{1,80}$/.test(value) ? value : DEFAULT_MODEL;
}

export function geminiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export function geminiModel(): string {
  return modelName();
}

export function cleanMarkdown(text: string): string {
  return text
    .replace(/^\s*```(?:markdown|md)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/\$?\\lambda\s*\$?/gi, 'λ')
    .replace(/\$([^$\n]{1,40})\$/g, '$1')
    .replace(/\\times/g, '×')
    .trim();
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
}

export async function generateAiReport(envelope: AnalysisEnvelope): Promise<AiReport> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new GeminiError(
      503,
      'GEMINI_NOT_CONFIGURED',
      'Falta GEMINI_API_KEY en .env.local. Añade la clave de Google AI Studio y reinicia el servidor.',
    );
  }

  const model = modelName();
  const endpoint = (process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const { system, user } = buildGeminiPrompt(envelope);
  const started = Date.now();

  const requestBody = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.65,
      topP: 0.95,
      maxOutputTokens: 4096,
    },
  });

  // Google retira modelos sin previo aviso y los modelos grandes se saturan:
  // si el configurado no existe o está sobrecargado, se reintenta con un
  // respaldo más ligero antes de fallar.
  const models = [model, FALLBACK_MODEL].filter((value, index, all) => all.indexOf(value) === index);
  let usedModel = models[0];
  let response: Response | undefined;
  let payload: GeminiResponse | null = null;

  for (const candidateModel of models) {
    usedModel = candidateModel;
    try {
      response = await fetch(`${endpoint}/models/${encodeURIComponent(candidateModel)}:generateContent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: requestBody,
        cache: 'no-store',
        signal: AbortSignal.timeout(55_000),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new GeminiError(504, 'GEMINI_TIMEOUT', 'Gemini tardó demasiado en responder. Vuelve a intentarlo.');
      }
      throw new GeminiError(502, 'GEMINI_UNAVAILABLE', 'No se pudo conectar con Gemini. Revisa tu conexión y vuelve a intentarlo.');
    }

    payload = null;
    const text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text) as GeminiResponse;
      } catch {
        throw new GeminiError(502, 'GEMINI_INVALID_RESPONSE', 'Gemini devolvió una respuesta ilegible.');
      }
    }

    const retirable =
      (response.status === 404 || response.status === 503) &&
      /no longer available|not found|not supported|does not exist|high demand|overloaded|temporarily/i.test(
        payload?.error?.message ?? '',
      );
    if (retirable && candidateModel !== models[models.length - 1]) {
      continue;
    }
    break;
  }

  if (!response) {
    throw new GeminiError(502, 'GEMINI_UNAVAILABLE', 'No se pudo conectar con Gemini. Revisa tu conexión y vuelve a intentarlo.');
  }

  if (!response.ok) {
    const upstreamMessage = payload?.error?.message ?? '';
    if (response.status === 429) {
      throw new GeminiError(429, 'GEMINI_QUOTA', 'Gemini alcanzó el límite de cuota. Espera un momento o revisa tu plan de AI Studio.', upstreamMessage);
    }
    if (response.status === 401 || response.status === 403) {
      throw new GeminiError(502, 'GEMINI_AUTH', 'La clave de Gemini no es válida o no tiene permisos para este modelo.', upstreamMessage);
    }
    throw new GeminiError(502, 'GEMINI_ERROR', `Gemini respondió con HTTP ${response.status} (${usedModel}).`, upstreamMessage);
  }

  if (payload?.promptFeedback?.blockReason) {
    throw new GeminiError(
      422,
      'GEMINI_BLOCKED',
      'Gemini bloqueó el informe por sus filtros de seguridad. Vuelve a intentarlo o revisa el contenido del partido.',
      payload.promptFeedback.blockReason,
    );
  }

  const candidate = payload?.candidates?.[0];
  const report = cleanMarkdown(
    (candidate?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .filter(Boolean)
      .join('\n\n'),
  );

  if (!report) {
    throw new GeminiError(502, 'GEMINI_EMPTY', 'Gemini no devolvió texto. Vuelve a intentarlo.');
  }

  const truncated = candidate?.finishReason === 'MAX_TOKENS';
  return {
    report: truncated ? `${report}\n\n> El informe se truncó por longitud; vuelve a generar para ampliarlo.` : report,
    model: usedModel,
    generatedAt: new Date().toISOString(),
    latencyMs: Date.now() - started,
  };
}

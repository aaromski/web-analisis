import { AnalysisError } from '../engine/analyze';
import { GeminiError, StatsApiError, ValidationError } from './errors';

export function jsonError(
  status: number,
  code: string,
  message: string,
  details?: unknown,
): Response {
  return Response.json(
    {
      error: {
        code,
        message,
        ...(details === undefined ? {} : { details }),
      },
    },
    {
      status,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}

/**
 * Las rutas POST solo aceptan JSON. Devuelve una respuesta 415 si el cliente
 * envía otro tipo de contenido (formularios, texto plano, etc.).
 */
export function requireJson(request: Request): Response | null {
  const contentType = request.headers.get('content-type') ?? '';
  if (/^application\/json\b/i.test(contentType)) return null;
  return jsonError(
    415,
    'UNSUPPORTED_MEDIA_TYPE',
    'La petición debe enviarse con Content-Type: application/json.',
  );
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ValidationError) {
    return jsonError(400, 'INVALID_INPUT', error.message, error.details);
  }
  if (error instanceof StatsApiError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
    return jsonError(status, error.code, error.message, error.details);
  }
  if (error instanceof AnalysisError) {
    if (error.code === 'MATCH_NOT_PROJECTABLE') {
      return jsonError(422, error.code, error.message, error.details);
    }
    if (error.code === 'MISSING_TEAMS') {
      return jsonError(422, error.code, error.message);
    }
    return jsonError(502, error.code, error.message);
  }
  if (error instanceof GeminiError) {
    const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
    return jsonError(status, error.code, error.message, error.details);
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return jsonError(504, 'TIMEOUT', 'La operación tardó demasiado. Vuelve a intentarlo.');
  }
  console.error('[parley-lab] error no controlado', error);
  return jsonError(500, 'INTERNAL_ERROR', 'Ocurrió un error inesperado en el servidor.');
}

import { CliError } from './errors.js';
import { applicationSignal } from './lifecycle.js';

export interface HttpRequestOptions {
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  operation: string;
  responseType?: 'text' | 'binary';
}

export interface HttpResponse {
  status: number;
  statusText: string;
  ok: boolean;
  text: string;
  bytes?: Uint8Array;
  requestId?: string;
}

function requestIdOf(response: Response): string | undefined {
  return response.headers.get('x-request-id') ?? response.headers.get('x-correlation-id') ?? response.headers.get('request-id') ?? undefined;
}

function httpError(response: HttpResponse, operation: string): CliError {
  const suffix = response.requestId ? ` Solicitud: ${response.requestId}.` : '';
  if (response.status === 401 || response.status === 403) {
    return new CliError(`SIYS rechazó la autenticación o autorización (HTTP ${response.status}).${suffix}`, 'auth', response.status === 401 ? 'unauthorized' : 'forbidden', operation, response.requestId);
  }
  const retryable = response.status === 429 || response.status >= 500;
  return new CliError(`El servicio respondió HTTP ${response.status} ${response.statusText} durante ${operation}.${suffix}`, 'network', response.status === 429 ? 'rate_limited' : 'http_error', operation, response.requestId, retryable);
}

export async function requestHttp(url: string | URL, options: HttpRequestOptions): Promise<HttpResponse> {
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), options.timeoutMs);
  const signal = AbortSignal.any([applicationSignal, timeoutController.signal]);
  try {
    const response = await fetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal,
    });
    const bytes = options.responseType === 'binary' ? new Uint8Array(await response.arrayBuffer()) : undefined;
    const result: HttpResponse = {
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      text: bytes ? '' : await response.text(),
      bytes,
      requestId: requestIdOf(response),
    };
    if (!result.ok) throw httpError(result, options.operation);
    return result;
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error instanceof Error && /Tiempo de espera al escribir/i.test(error.message)) {
      throw new CliError(error.message, 'network', 'timeout', options.operation, undefined, true, { cause: error });
    }
    if (applicationSignal.aborted) throw new CliError('Operación cancelada por el usuario.', 'cancelled', 'cancelled', options.operation, undefined, false, { cause: error });
    if (timeoutController.signal.aborted) throw new CliError(`Tiempo de espera agotado después de ${options.timeoutMs} ms durante ${options.operation}.`, 'network', 'timeout', options.operation, undefined, true, { cause: error });
    throw new CliError(`No fue posible comunicarse con el servicio durante ${options.operation}.`, 'network', 'transport_error', options.operation, undefined, true, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}

export function parseJsonResponse<T>(response: HttpResponse, operation: string): T {
  try {
    return JSON.parse(response.text) as T;
  } catch (error) {
    throw new CliError(`El servicio devolvió JSON inválido durante ${operation}.`, 'network', 'invalid_response', operation, response.requestId, false, { cause: error });
  }
}

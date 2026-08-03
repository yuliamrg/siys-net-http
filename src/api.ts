import { API_URL, HTTP_TIMEOUT_MS } from './config.js';
import type { EndpointDefinition } from './types.js';
import { getByPath } from './utils.js';
import type { QueryParams } from './order-filters.js';
import { parseJsonResponse, requestHttp } from './http.js';

export interface FetchOptions {
  token: string;
  params: QueryParams;
  maxPages: number;
}

export interface FetchEndpointResult {
  rows: Record<string, unknown>[];
  pagesFetched: number;
  totalAvailable?: number;
  truncated: boolean;
}

async function requestJson(
  endpoint: EndpointDefinition,
  token: string,
  params: QueryParams,
): Promise<unknown> {
  const url = new URL(`${API_URL}${endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`}`);
  const merged = { ...(endpoint.defaultParams ?? {}), ...params };
  const init: RequestInit = {
    method: endpoint.method,
    headers: { accept: 'application/json', authentication: `Bearer ${token}` },
  };
  if (endpoint.method === 'GET') {
    for (const [key, value] of Object.entries(merged)) {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item);
    }
  } else {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(merged);
  }

  const operation = `${endpoint.method} ${url.pathname}`;
  const response = await requestHttp(url, { ...init, method: endpoint.method, headers: init.headers as Record<string, string>, body: init.body as string | undefined, timeoutMs: HTTP_TIMEOUT_MS, operation });
  return parseJsonResponse(response, operation);
}

export async function fetchApiJson<T>(apiPath: string, token: string): Promise<T> {
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const operation = `GET ${normalizedPath.split('?')[0]}`;
  const response = await requestHttp(`${API_URL}${normalizedPath}`, {
    method: 'GET',
    headers: { accept: 'application/json', authentication: `Bearer ${token}` },
    timeoutMs: HTTP_TIMEOUT_MS,
    operation,
  });
  return parseJsonResponse<T>(response, operation);
}

/**
 * Sends one explicitly approved mutation.  This is deliberately separate from
 * the download client: callers must opt in with an allow-listed contract.
 * Mutations are never retried because a timeout can still mean SIYS persisted
 * the change.
 */
export async function sendApiJson<T>(
  apiPath: string,
  token: string,
  method: 'PATCH' | 'PUT' | 'POST',
  body?: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const operation = `${method} ${normalizedPath}`;
  try {
    const response = await requestHttp(`${API_URL}${normalizedPath}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authentication: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs,
      operation,
    });
    return response.text ? parseJsonResponse<T>(response, operation) : {} as T;
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'timeout') {
      const original = error as Error & { category?: string; code?: string; operation?: string; retryable?: boolean };
      Object.defineProperty(original, 'message', { value: `Tiempo de espera al escribir ${method} ${normalizedPath}. No se reintentó: verifica la orden antes de continuar.` });
    }
    throw error;
  }
}

export async function fetchEndpoint(endpoint: EndpointDefinition, options: FetchOptions): Promise<FetchEndpointResult> {
  const all: Record<string, unknown>[] = [];
  const pagination = endpoint.pagination;
  const maxPages = pagination ? options.maxPages : 1;
  let pagesFetched = 0;
  let totalAvailable: number | undefined;
  let lastPageSize = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    const params: QueryParams = { ...options.params };
    if (pagination) {
      params[pagination.pageParam] = String(page);
      params[pagination.pageSizeParam] = String(pagination.pageSize);
    }
    const response = await requestJson(endpoint, options.token, params);
    pagesFetched += 1;
    const data = getByPath(response, endpoint.dataPath);
    const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
    lastPageSize = rows.length;
    if (pagination?.totalPath) {
      const total = getByPath(response, pagination.totalPath);
      if (typeof total === 'number' && Number.isFinite(total) && total >= 0) totalAvailable = total;
    }
    all.push(...rows.map((row) => (row && typeof row === 'object' ? row as Record<string, unknown> : { value: row })));
    if (!pagination || rows.length < pagination.pageSize) break;
  }
  const truncated = Boolean(pagination) && (totalAvailable !== undefined ? all.length < totalAvailable : pagesFetched === maxPages && lastPageSize === pagination!.pageSize);
  return { rows: all, pagesFetched, totalAvailable, truncated };
}

import { API_URL } from './config.js';
import type { EndpointDefinition } from './types.js';
import { getByPath } from './utils.js';
import type { QueryParams } from './order-filters.js';

export interface FetchOptions {
  token: string;
  params: QueryParams;
  maxPages: number;
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

  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${endpoint.method} ${url.pathname}`);
  return response.json();
}

export async function fetchApiJson<T>(apiPath: string, token: string): Promise<T> {
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const response = await fetch(`${API_URL}${normalizedPath}`, {
    method: 'GET',
    headers: { accept: 'application/json', authentication: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: GET ${normalizedPath}`);
  return response.json() as Promise<T>;
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
  method: 'PATCH' | 'PUT',
  body: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${API_URL}${normalizedPath}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authentication: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${method} ${normalizedPath}`);
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Tiempo de espera al escribir ${method} ${normalizedPath}. No se reintentó: verifica la orden antes de continuar.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchEndpoint(endpoint: EndpointDefinition, options: FetchOptions): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  const pagination = endpoint.pagination;
  const maxPages = pagination ? options.maxPages : 1;

  for (let page = 1; page <= maxPages; page += 1) {
    const params: QueryParams = { ...options.params };
    if (pagination) {
      params[pagination.pageParam] = String(page);
      params[pagination.pageSizeParam] = String(pagination.pageSize);
    }
    const response = await requestJson(endpoint, options.token, params);
    const data = getByPath(response, endpoint.dataPath);
    const rows = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
    all.push(...rows.map((row) => (row && typeof row === 'object' ? row as Record<string, unknown> : { value: row })));
    if (!pagination || rows.length < pagination.pageSize) break;
  }
  return all;
}

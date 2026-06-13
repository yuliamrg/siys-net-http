import { API_URL } from './config.js';
import type { EndpointDefinition } from './types.js';
import { getByPath } from './utils.js';

export interface FetchOptions {
  token: string;
  params: Record<string, string>;
  maxPages: number;
}

async function requestJson(
  endpoint: EndpointDefinition,
  token: string,
  params: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`${API_URL}${endpoint.path.startsWith('/') ? endpoint.path : `/${endpoint.path}`}`);
  const merged = { ...(endpoint.defaultParams ?? {}), ...params };
  const init: RequestInit = {
    method: endpoint.method,
    headers: { accept: 'application/json', authentication: `Bearer ${token}` },
  };
  if (endpoint.method === 'GET') {
    for (const [key, value] of Object.entries(merged)) url.searchParams.set(key, value);
  } else {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(merged);
  }

  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${endpoint.method} ${url.pathname}`);
  return response.json();
}

export async function fetchEndpoint(endpoint: EndpointDefinition, options: FetchOptions): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  const pagination = endpoint.pagination;
  const maxPages = pagination ? options.maxPages : 1;

  for (let page = 1; page <= maxPages; page += 1) {
    const params = { ...options.params };
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

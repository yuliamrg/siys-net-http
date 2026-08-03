import { expect, test } from '@playwright/test';
import { fetchEndpoint } from '../src/api.js';
import { requestHttp } from '../src/http.js';
import { CliError } from '../src/errors.js';
import type { EndpointDefinition } from '../src/types.js';

const originalFetch = global.fetch;

test.afterEach(() => { global.fetch = originalFetch; });

test('times out a read request and exposes a stable network error', async () => {
  global.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  let captured: unknown;
  try { await requestHttp('https://api.siys.net/api/order', { method: 'GET', timeoutMs: 5, operation: 'GET /order' }); } catch (error) { captured = error; }
  expect(captured).toBeInstanceOf(CliError);
  expect(captured).toEqual(expect.objectContaining({ category: 'network', code: 'timeout', operation: 'GET /order', retryable: true }));
});

test('classifies HTTP errors and preserves the request identifier', async () => {
  global.fetch = async () => new Response('{}', { status: 429, statusText: 'Too Many Requests', headers: { 'x-request-id': 'req-429' } });
  await expect(requestHttp('https://api.siys.net/api/order', { method: 'GET', timeoutMs: 100, operation: 'GET /order' }))
    .rejects.toEqual(expect.objectContaining({ category: 'network', code: 'rate_limited', requestId: 'req-429', retryable: true }));
});

test('reports pagination metadata and potential truncation', async () => {
  const endpoint: EndpointDefinition = {
    module: 'orders', method: 'GET', path: '/order', dataPath: 'doc',
    pagination: { pageParam: 'page', pageSizeParam: 'limit', pageSize: 2, totalPath: 'total' },
  };
  global.fetch = async (input) => {
    const page = new URL(String(input)).searchParams.get('page');
    return new Response(JSON.stringify({ doc: [{ id: `${page}-1` }, { id: `${page}-2` }], total: 5 }), { status: 200 });
  };
  const result = await fetchEndpoint(endpoint, { token: 'secret', params: {}, maxPages: 2 });
  expect(result).toEqual(expect.objectContaining({ pagesFetched: 2, totalAvailable: 5, truncated: true }));
  expect(result.rows).toHaveLength(4);
});

test('does not mark a short final page as truncated without a total', async () => {
  const endpoint: EndpointDefinition = {
    module: 'clients', method: 'GET', path: '/customer', dataPath: 'doc',
    pagination: { pageParam: 'page', pageSizeParam: 'limit', pageSize: 2 },
  };
  global.fetch = async () => new Response(JSON.stringify({ doc: [{ id: '1' }] }), { status: 200 });
  const result = await fetchEndpoint(endpoint, { token: 'secret', params: {}, maxPages: 1 });
  expect(result).toEqual(expect.objectContaining({ pagesFetched: 1, truncated: false }));
});

import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures.js';
import { fetchApiJson } from '../src/api.js';
import { cacheDatabasePath, searchCachedApiReads } from '../src/cache.js';

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('archives simulated GET reads in the temporary Playwright cache, not the operational default', async () => {
  const root = process.env.SIYS_PLAYWRIGHT_CACHE_DIR;
  expect(root).toBeTruthy();
  const workerRoot = process.env.SIYS_CACHE_DIR;
  expect(path.dirname(path.resolve(workerRoot!))).toBe(path.resolve(root!));
  expect(path.basename(workerRoot!)).toMatch(/^worker-\d+$/i);

  const isolatedPath = cacheDatabasePath();
  const relative = path.relative(path.resolve(workerRoot!), path.resolve(isolatedPath));
  expect(relative).not.toMatch(/^\.\.(?:[\\/]|$)|^[\\/]/);

  const configuredDirectory = process.env.SIYS_CACHE_DIR;
  const configuredProfile = process.env.SIYS_CACHE_PROFILE;
  delete process.env.SIYS_CACHE_DIR;
  delete process.env.SIYS_CACHE_PROFILE;
  const operationalDefaultPath = cacheDatabasePath();
  process.env.SIYS_CACHE_DIR = configuredDirectory;
  process.env.SIYS_CACHE_PROFILE = configuredProfile;
  expect(isolatedPath).not.toBe(operationalDefaultPath);

  const originalFetch = global.fetch;
  global.fetch = async () => response({ name: 'SIYS cache isolation fixture 7f31b6' });
  try {
    await fetchApiJson('/cache-isolation-proof?source=simulated-get', 'fixture-token');
    expect(fs.existsSync(isolatedPath)).toBe(true);
    expect(searchCachedApiReads('siys cache isolation fixture 7f31b6')).toEqual([
      expect.objectContaining({ endpoint: '/api/cache-isolation-proof', params: { source: ['simulated-get'] } }),
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, test } from '@playwright/test';
import {
  cacheDatabasePath,
  cacheTtlMs,
  readCachedApiResponse,
  readFreshCacheSnapshot,
  resolveCachedName,
  saveApiRead,
  saveCacheSnapshot,
  searchCacheRecords,
} from '../src/cache.js';
import { downloadData, type DownloadOptions } from '../src/download.js';

function withCacheEnvironment<T>(run: (root: string) => Promise<T> | T): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siys-cache-test-'));
  const original = {
    cacheDir: process.env.SIYS_CACHE_DIR,
    profile: process.env.SIYS_CACHE_PROFILE,
    token: process.env.SIYS_TOKEN,
    fetch: global.fetch,
  };
  process.env.SIYS_CACHE_DIR = root;
  process.env.SIYS_CACHE_PROFILE = 'test-profile';
  delete process.env.SIYS_TOKEN;
  return Promise.resolve()
    .then(() => run(root))
    .finally(() => {
      if (original.cacheDir === undefined) delete process.env.SIYS_CACHE_DIR;
      else process.env.SIYS_CACHE_DIR = original.cacheDir;
      if (original.profile === undefined) delete process.env.SIYS_CACHE_PROFILE;
      else process.env.SIYS_CACHE_PROFILE = original.profile;
      if (original.token === undefined) delete process.env.SIYS_TOKEN;
      else process.env.SIYS_TOKEN = original.token;
      global.fetch = original.fetch;
      fs.rmSync(root, { recursive: true, force: true });
    });
}

test('writes reusable snapshots, applies TTL, and marks expired search results', async () => {
  await withCacheEnvironment(() => {
    const fetchedAt = '2026-09-24T12:00:00.000Z';
    saveCacheSnapshot('users', {}, [{ _id: 'user-1', fullName: 'Ana Pérez' }], {
      pagesFetched: 1,
      totalAvailable: 1,
      truncated: false,
      fetchedAt,
    });

    expect(readFreshCacheSnapshot('users', {}, Date.parse(fetchedAt))).toEqual({
      rows: [{ _id: 'user-1', fullName: 'Ana Pérez' }],
      pagesFetched: 1,
      totalAvailable: 1,
      truncated: false,
      fetchedAt,
    });
    expect(readFreshCacheSnapshot('users', {}, Date.parse(fetchedAt) + cacheTtlMs.users + 1)).toBeUndefined();
    expect(searchCacheRecords('users', { text: 'ana' }, 20, Date.parse(fetchedAt) + cacheTtlMs.users + 1)[0]).toEqual(expect.objectContaining({
      id: 'user-1',
      stale: true,
    }));
  });
});

test('resolves a unique name only from a complete fresh catalog', async () => {
  await withCacheEnvironment(() => {
    const fetchedAt = '2026-09-24T12:00:00.000Z';
    saveCacheSnapshot('users', {}, [{ _id: 'user-1', fullName: 'Ana Pérez' }], {
      pagesFetched: 1,
      totalAvailable: 1,
      truncated: false,
      fetchedAt,
    });
    expect(resolveCachedName('users', 'perez ana', Date.parse(fetchedAt))).toEqual(expect.objectContaining({ id: 'user-1', stale: false }));

    saveCacheSnapshot('clients', {}, [{ _id: 'client-1', name: 'Same Name' }, { _id: 'client-2', name: 'Same Name' }], {
      pagesFetched: 1,
      totalAvailable: 2,
      truncated: false,
      fetchedAt,
    });
    expect(() => resolveCachedName('clients', 'Same Name', Date.parse(fetchedAt))).toThrow(/ambiguo/);
  });
});

test('does not use partial or corrupt snapshots as a cache-first source', async () => {
  await withCacheEnvironment(() => {
    const fetchedAt = '2026-09-24T12:00:00.000Z';
    saveCacheSnapshot('users', {}, [{ _id: 'user-1', name: 'Partial' }], {
      pagesFetched: 1,
      truncated: true,
      fetchedAt,
    });
    expect(readFreshCacheSnapshot('users', {}, Date.parse(fetchedAt))).toBeUndefined();

    saveCacheSnapshot('clients', {}, [{ _id: 'client-1', name: 'Corruptible' }], {
      pagesFetched: 1,
      truncated: false,
      fetchedAt,
    });
    const database = new Database(cacheDatabasePath());
    database.prepare("UPDATE cache_snapshots SET rows_json = '{invalid' WHERE module = 'clients'").run();
    database.close();
    expect(readFreshCacheSnapshot('clients', {}, Date.parse(fetchedAt))).toBeUndefined();
  });
});

test('redacts secret fields and signed URL values before caching API reads and records', async () => {
  await withCacheEnvironment(() => {
    const fetchedAt = '2026-09-24T12:00:00.000Z';
    saveApiRead('/customer?id=42&access_token=query-secret', {
      name: 'Cliente',
      password: 'password-secret',
      signedUrl: 'https://files.example/item?sig=url-secret',
    }, fetchedAt);
    saveCacheSnapshot('clients', {}, [{
      _id: 'client-42',
      name: 'Cliente',
      credentials: 'credential-secret',
      cookie: 'cookie-secret',
      signature: 'signature-secret',
    }], { pagesFetched: 1, truncated: false, fetchedAt });

    const apiRead = readCachedApiResponse(1);
    expect(apiRead?.params).toEqual({ id: ['42'] });
    expect(JSON.stringify(apiRead)).not.toMatch(/query-secret|password-secret|url-secret/);
    expect(readFreshCacheSnapshot('clients', {}, Date.parse(fetchedAt))?.rows[0]).toEqual({
      _id: 'client-42',
      name: 'Cliente',
      credentials: '[REDACTED]',
      cookie: '[REDACTED]',
      signature: '[REDACTED]',
    });
    expect(JSON.stringify(readFreshCacheSnapshot('clients', {}, Date.parse(fetchedAt)))).not.toMatch(/credential-secret|cookie-secret|signature-secret/);
  });
});

test('download uses a fresh snapshot and --refresh forces a new SIYS read', async () => {
  await withCacheEnvironment(async (root) => {
    let calls = 0;
    process.env.SIYS_TOKEN = 'test-token';
    global.fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify([{ _id: 'user-1', name: `Person ${calls}` }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const options: DownloadOptions = {
      modules: ['users'],
      formats: ['json'],
      params: {},
      maxPages: 10,
      outDir: path.join(root, 'exports'),
      autoLogin: false,
      allowPartial: false,
    };

    const first = await downloadData(options);
    const cached = await downloadData(options);
    const refreshed = await downloadData({ ...options, refresh: true });

    expect(first[0].source).toBe('siys');
    expect(cached[0].source).toBe('cache');
    expect(refreshed[0].source).toBe('siys');
    expect(calls).toBe(2);
    expect(fs.readFileSync(refreshed[0].output, 'utf8')).toContain('Person 2');
  });
});

test('exposes the cache CLI surface', async () => {
  await withCacheEnvironment((root) => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(process.cwd(), 'src', 'cli.ts'), 'cache', '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, SIYS_CACHE_DIR: root, NO_COLOR: '1' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('refresh');
    expect(result.stdout).toContain('status');
    expect(result.stdout).toContain('search');
    expect(result.stdout).toContain('resolve');
    expect(result.stdout).toContain('read');
  });
});

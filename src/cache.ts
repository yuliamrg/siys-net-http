import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { API_URL, sensitiveKeys } from './config.js';
import { CliError } from './errors.js';
import { endpointConfigPath } from './paths.js';
import { redact } from './security.js';
import { modules, type ModuleName } from './types.js';
import type { QueryParams } from './order-filters.js';

const schemaVersion = 3;
const QUOTE_CACHE_BUCKET_MS = 15 * 60 * 1000;

export const cacheTtlMs: Record<ModuleName, number> = {
  orders: 15 * 60 * 1000,
  quotes: 15 * 60 * 1000,
  clients: 24 * 60 * 60 * 1000,
  users: 24 * 60 * 60 * 1000,
  sites: 24 * 60 * 60 * 1000,
  equipment: 24 * 60 * 60 * 1000,
};

export interface CachedModuleData {
  rows: Record<string, unknown>[];
  pagesFetched: number;
  totalAvailable?: number;
  truncated: boolean;
  fetchedAt: string;
}

export interface CacheSnapshotMetadata {
  pagesFetched: number;
  totalAvailable?: number;
  truncated: boolean;
  fetchedAt: string;
}

export interface CacheModuleStatus {
  module: ModuleName;
  records: number;
  completeScopes: number;
  partialScopes: number;
  freshCompleteScopes: number;
  latestFetchedAt?: string;
  latestCompleteFetchedAt?: string;
  latestSnapshotFresh: boolean;
  ttlMs: number;
}

export interface CacheSearchResult {
  id: string;
  label: string;
  customerId?: string;
  state?: string;
  fetchedAt: string;
  stale: boolean;
}

export interface CachedApiReadMatch {
  snapshotId: number;
  endpoint: string;
  params: Record<string, string[]>;
  fetchedAt: string;
}

interface ApiReadRow {
  snapshot_id: number;
  endpoint_path: string;
  params_json: string;
  fetched_at: string;
  response_json: string;
}

interface CacheRecordRow {
  module: ModuleName;
  record_id: string;
  display_name: string;
  customer_id: string | null;
  state: string | null;
  search_text: string;
  record_json: string;
  fetched_at: string;
}

interface SnapshotRow {
  snapshot_id: number;
  fetched_at: string;
  record_count: number;
  pages_fetched: number;
  total_available: number | null;
  truncated: number;
  rows_json: string;
}

function cacheProfile(): string {
  const profile = (process.env.SIYS_CACHE_PROFILE ?? 'default').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(profile)) {
    throw new CliError('SIYS_CACHE_PROFILE debe usar letras, numeros, guion o guion bajo (1 a 48 caracteres).', 'usage', 'cache.profile.invalid');
  }
  return profile.toLowerCase();
}

export function cacheDatabasePath(): string {
  const configuredDirectory = process.env.SIYS_CACHE_DIR?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim();
  const root = configuredDirectory
    ? path.resolve(configuredDirectory)
    : localAppData || xdgCacheHome || path.join(os.homedir(), process.platform === 'win32' ? 'AppData' : '.cache', ...(process.platform === 'win32' ? ['Local'] : []));
  const hostHash = createHash('sha256').update(API_URL).digest('hex').slice(0, 16);
  return path.join(root, 'SIYS', 'cache', `${cacheProfile()}-${hostHash}.sqlite3`);
}

function openCache(): Database.Database {
  const filePath = cacheDatabasePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const db = new Database(filePath);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
    const versionRow = db.pragma('user_version') as Array<{ user_version: number }>;
    const currentVersion = versionRow[0]?.user_version ?? 0;
    if (currentVersion > schemaVersion) throw new Error(`La base SIYS usa un esquema ${currentVersion} posterior al admitido (${schemaVersion}).`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache_records (
        module TEXT NOT NULL,
        record_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        customer_id TEXT,
        state TEXT,
        search_text TEXT NOT NULL,
        record_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (module, record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_cache_records_search ON cache_records(module, search_text);
      CREATE INDEX IF NOT EXISTS idx_cache_records_fetched ON cache_records(module, fetched_at);
      CREATE TABLE IF NOT EXISTS cache_snapshots (
        snapshot_id INTEGER PRIMARY KEY,
        module TEXT NOT NULL,
        query_key TEXT NOT NULL,
        snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('complete', 'partial')),
        params_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        record_count INTEGER NOT NULL CHECK (record_count >= 0),
        pages_fetched INTEGER NOT NULL CHECK (pages_fetched >= 0),
        total_available INTEGER,
        truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
        rows_json TEXT NOT NULL,
        UNIQUE (module, query_key, snapshot_kind)
      );
      CREATE INDEX IF NOT EXISTS idx_cache_snapshots_module ON cache_snapshots(module, fetched_at);
      CREATE TABLE IF NOT EXISTS cache_snapshot_records (
        snapshot_id INTEGER NOT NULL REFERENCES cache_snapshots(snapshot_id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        module TEXT NOT NULL,
        record_id TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, ordinal),
        FOREIGN KEY (module, record_id) REFERENCES cache_records(module, record_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_cache_snapshot_records_id ON cache_snapshot_records(module, record_id);
      CREATE TABLE IF NOT EXISTS cache_api_reads (
        snapshot_id INTEGER PRIMARY KEY,
        endpoint_path TEXT NOT NULL,
        query_key TEXT NOT NULL,
        params_json TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        response_json TEXT NOT NULL,
        search_text TEXT NOT NULL,
        UNIQUE (endpoint_path, query_key)
      );
      CREATE INDEX IF NOT EXISTS idx_cache_api_reads_search ON cache_api_reads(search_text);
      CREATE INDEX IF NOT EXISTS idx_cache_api_reads_fetched ON cache_api_reads(fetched_at);
    `);
    if (currentVersion === 1) {
      const migrate = db.transaction(() => {
        db.exec("ALTER TABLE cache_snapshots ADD COLUMN rows_json TEXT NOT NULL DEFAULT '[]'");
        const snapshots = db.prepare('SELECT snapshot_id FROM cache_snapshots').all() as Array<{ snapshot_id: number }>;
        const rowsForSnapshot = db.prepare(`
          SELECT records.record_json
          FROM cache_snapshot_records AS members
          JOIN cache_records AS records ON records.module = members.module AND records.record_id = members.record_id
          WHERE members.snapshot_id = ?
          ORDER BY members.ordinal
        `);
        const updateSnapshot = db.prepare('UPDATE cache_snapshots SET rows_json = ? WHERE snapshot_id = ?');
        for (const snapshot of snapshots) {
          const rows = rowsForSnapshot.all(snapshot.snapshot_id) as Array<{ record_json: string }>;
          updateSnapshot.run(JSON.stringify(rows.map((row) => JSON.parse(row.record_json))), snapshot.snapshot_id);
        }
        db.exec(`PRAGMA user_version = ${schemaVersion}`);
      });
      migrate();
    } else if (currentVersion === 0 || currentVersion === 2) db.pragma(`user_version = ${schemaVersion}`);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function normalizedParams(module: ModuleName, params: QueryParams): Record<string, string | string[]> {
  const normalized: Record<string, string | string[]> = {};
  for (const key of Object.keys(params).sort()) {
    const raw = params[key];
    const value = Array.isArray(raw) ? [...raw] : raw;
    if (module === 'quotes' && key === 'fin' && typeof value === 'string') {
      const timestamp = Date.parse(value);
      if (Number.isFinite(timestamp)) normalized[key] = new Date(Math.floor(timestamp / QUOTE_CACHE_BUCKET_MS) * QUOTE_CACHE_BUCKET_MS).toISOString();
      else normalized[key] = value;
    } else normalized[key] = value;
  }
  return normalized;
}

function cacheQueryKey(module: ModuleName, params: QueryParams): { key: string; paramsJson: string } {
  const canonicalParams = normalizedParams(module, params);
  const paramsJson = JSON.stringify(canonicalParams);
  let endpointRevision = 'canonical';
  try {
    endpointRevision = createHash('sha256').update(fs.readFileSync(endpointConfigPath)).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return { key: createHash('sha256').update(`${module}\n${endpointRevision}\n${paramsJson}`).digest('hex'), paramsJson };
}

function isFresh(module: ModuleName, fetchedAt: string, now = Date.now()): boolean {
  const timestamp = Date.parse(fetchedAt);
  if (!Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= 0 && age <= cacheTtlMs[module];
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function objectId(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return scalarString(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  return scalarString(object._id) ?? scalarString(object.id);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = scalarString(record[key]);
    if (value) return value;
  }
  return undefined;
}

function recordIdOf(module: ModuleName, record: Record<string, unknown>): string {
  const id = firstString(record, ['_id', 'id', 'orderId', 'order_id', 'quoteId', 'quote_id', 'siteId', 'equipmentId', 'uuid']);
  return id ?? createHash('sha256').update(`${module}\n${JSON.stringify(record)}`).digest('hex');
}

function recordLabel(record: Record<string, unknown>, id: string): string {
  const preferred = firstString(record, ['fullName', 'full_name', 'displayName', 'display_name', 'razonSocial', 'razon_social']);
  if (preferred) return preferred;
  const first = firstString(record, ['firstName', 'first_name', 'nombres']);
  const last = firstString(record, ['lastName', 'last_name', 'apellidos']);
  const personName = [first, last].filter(Boolean).join(' ');
  if (personName) return personName;
  return firstString(record, ['name', 'nombre', 'title', 'titulo', 'orderCode', 'order_code', 'quoteCode', 'quote_code', 'code', 'codigo', 'number', 'numero']) ?? id;
}

function collectSearchValues(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.trim()) output.push(value.trim());
  } else if (typeof value === 'number' || typeof value === 'boolean') output.push(String(value));
  else if (Array.isArray(value)) {
    for (const child of value) collectSearchValues(child, output);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) collectSearchValues(child, output);
  }
  return output;
}

function canonicalApiRequest(apiPath: string): { endpoint: string; params: Record<string, string[]>; queryKey: string } {
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const url = new URL(`${API_URL}${normalizedPath}`);
  const params: Record<string, string[]> = {};
  for (const key of [...new Set([...url.searchParams.keys()])].sort()) {
    if (sensitiveKeys.test(key)) continue;
    const values = url.searchParams.getAll(key).filter((value) => redact(value) !== '[REDACTED]');
    if (values.length) params[key] = values;
  }
  const paramsJson = JSON.stringify(params);
  return {
    endpoint: url.pathname,
    params,
    queryKey: createHash('sha256').update(`${url.pathname}\n${paramsJson}`).digest('hex'),
  };
}

export function saveApiRead(apiPath: string, response: unknown, fetchedAt = new Date().toISOString()): void {
  const db = openCache();
  try {
    const request = canonicalApiRequest(apiPath);
    const safeResponse = redact(response);
    const responseJson = JSON.stringify(safeResponse ?? null);
    const searchText = normalizeText(collectSearchValues(safeResponse).join(' '));
    db.prepare(`
      INSERT INTO cache_api_reads(endpoint_path, query_key, params_json, fetched_at, response_json, search_text)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint_path, query_key) DO UPDATE SET
        params_json = excluded.params_json,
        fetched_at = excluded.fetched_at,
        response_json = excluded.response_json,
        search_text = excluded.search_text
      WHERE excluded.fetched_at >= cache_api_reads.fetched_at
    `).run(request.endpoint, request.queryKey, JSON.stringify(request.params), fetchedAt, responseJson, searchText);
  } finally {
    db.close();
  }
}

export function searchCachedApiReads(textQuery: string, limit = 20): CachedApiReadMatch[] {
  const normalizedQuery = normalizeText(textQuery);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new CliError('Escribe el texto que quieres buscar en las lecturas archivadas.', 'usage', 'cache.reads.query_required');
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const predicate = tokens.map(() => 'instr(search_text, ?) > 0').join(' AND ');
  const db = openCache();
  try {
    const rows = db.prepare(`
      SELECT snapshot_id, endpoint_path, params_json, fetched_at
      FROM cache_api_reads
      WHERE ${predicate}
      ORDER BY fetched_at DESC, endpoint_path
      LIMIT ?
    `).all(...tokens, boundedLimit) as ApiReadRow[];
    return rows.map((row) => ({
      snapshotId: row.snapshot_id,
      endpoint: row.endpoint_path,
      params: JSON.parse(row.params_json) as Record<string, string[]>,
      fetchedAt: row.fetched_at,
    }));
  } finally {
    db.close();
  }
}

export function readCachedApiResponse(snapshotId: number): { endpoint: string; params: Record<string, string[]>; fetchedAt: string; response: unknown } | undefined {
  const db = openCache();
  try {
    const row = db.prepare(`
      SELECT snapshot_id, endpoint_path, params_json, fetched_at, response_json
      FROM cache_api_reads
      WHERE snapshot_id = ?
    `).get(snapshotId) as ApiReadRow | undefined;
    if (!row) return undefined;
    return {
      endpoint: row.endpoint_path,
      params: JSON.parse(row.params_json) as Record<string, string[]>,
      fetchedAt: row.fetched_at,
      response: JSON.parse(row.response_json) as unknown,
    };
  } finally {
    db.close();
  }
}

function cacheRecord(db: Database.Database, module: ModuleName, source: Record<string, unknown>, fetchedAt: string): string {
  const safeRecord = redact(source) as Record<string, unknown>;
  const id = recordIdOf(module, safeRecord);
  const displayName = recordLabel(safeRecord, id);
  const customerId = objectId(safeRecord._customerId) ?? objectId(safeRecord.customerId) ?? objectId(safeRecord.customer_id) ?? objectId(safeRecord.customer);
  const state = firstString(safeRecord, ['state', 'status', 'estado']);
  const searchText = normalizeText(collectSearchValues(safeRecord).join(' '));
  db.prepare(`
    INSERT INTO cache_records(module, record_id, display_name, customer_id, state, search_text, record_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(module, record_id) DO UPDATE SET
      display_name = excluded.display_name,
      customer_id = excluded.customer_id,
      state = excluded.state,
      search_text = excluded.search_text,
      record_json = excluded.record_json,
      fetched_at = excluded.fetched_at
    WHERE excluded.fetched_at >= cache_records.fetched_at
  `).run(module, id, displayName, customerId ?? null, state ?? null, searchText, JSON.stringify(safeRecord), fetchedAt);
  return id;
}

export function saveCacheSnapshot(
  module: ModuleName,
  params: QueryParams,
  rows: Record<string, unknown>[],
  metadata: CacheSnapshotMetadata,
): void {
  const db = openCache();
  try {
    const { key, paramsJson } = cacheQueryKey(module, params);
    const kind = metadata.truncated ? 'partial' : 'complete';
    const transaction = db.transaction(() => {
      const ids = rows.map((row) => cacheRecord(db, module, row, metadata.fetchedAt));
      db.prepare(`
        INSERT INTO cache_snapshots(module, query_key, snapshot_kind, params_json, fetched_at, record_count, pages_fetched, total_available, truncated, rows_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(module, query_key, snapshot_kind) DO UPDATE SET
          params_json = excluded.params_json,
          fetched_at = excluded.fetched_at,
          record_count = excluded.record_count,
          pages_fetched = excluded.pages_fetched,
          total_available = excluded.total_available,
          truncated = excluded.truncated,
          rows_json = excluded.rows_json
      `).run(module, key, kind, paramsJson, metadata.fetchedAt, rows.length, metadata.pagesFetched, metadata.totalAvailable ?? null, metadata.truncated ? 1 : 0, JSON.stringify(rows.map((row) => redact(row))));
      const snapshot = db.prepare('SELECT snapshot_id FROM cache_snapshots WHERE module = ? AND query_key = ? AND snapshot_kind = ?').get(module, key, kind) as { snapshot_id: number };
      db.prepare('DELETE FROM cache_snapshot_records WHERE snapshot_id = ?').run(snapshot.snapshot_id);
      const addMembership = db.prepare('INSERT INTO cache_snapshot_records(snapshot_id, ordinal, module, record_id) VALUES (?, ?, ?, ?)');
      ids.forEach((id, ordinal) => addMembership.run(snapshot.snapshot_id, ordinal, module, id));
    });
    transaction();
  } finally {
    db.close();
  }
}

export function readFreshCacheSnapshot(module: ModuleName, params: QueryParams, now = Date.now()): CachedModuleData | undefined {
  const db = openCache();
  try {
    const { key } = cacheQueryKey(module, params);
    const snapshot = db.prepare(`
      SELECT snapshot_id, fetched_at, record_count, pages_fetched, total_available, truncated, rows_json
      FROM cache_snapshots
      WHERE module = ? AND query_key = ? AND snapshot_kind = 'complete'
    `).get(module, key) as SnapshotRow | undefined;
    if (!snapshot || snapshot.truncated || !isFresh(module, snapshot.fetched_at, now)) return undefined;
    let rows: unknown;
    try {
      rows = JSON.parse(snapshot.rows_json) as unknown;
    } catch {
      return undefined;
    }
    if (!Array.isArray(rows) || rows.length !== snapshot.record_count || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) return undefined;
    return {
      rows: rows as Record<string, unknown>[],
      pagesFetched: snapshot.pages_fetched,
      totalAvailable: snapshot.total_available ?? undefined,
      truncated: false,
      fetchedAt: snapshot.fetched_at,
    };
  } finally {
    db.close();
  }
}

function statusFromRows(module: ModuleName, records: number, snapshots: Array<{ snapshot_kind: string; fetched_at: string }>): CacheModuleStatus {
  const complete = snapshots.filter((snapshot) => snapshot.snapshot_kind === 'complete');
  const partial = snapshots.filter((snapshot) => snapshot.snapshot_kind === 'partial');
  const latestFetchedAt = snapshots.map((snapshot) => snapshot.fetched_at).sort().at(-1);
  const latestCompleteFetchedAt = complete.map((snapshot) => snapshot.fetched_at).sort().at(-1);
  return {
    module,
    records,
    completeScopes: complete.length,
    partialScopes: partial.length,
    freshCompleteScopes: complete.filter((snapshot) => isFresh(module, snapshot.fetched_at)).length,
    latestFetchedAt,
    latestCompleteFetchedAt,
    latestSnapshotFresh: latestCompleteFetchedAt ? isFresh(module, latestCompleteFetchedAt) : false,
    ttlMs: cacheTtlMs[module],
  };
}

export function readCacheStatus(): { path: string; profile: string; apiReadSnapshots: number; modules: CacheModuleStatus[] } {
  const db = openCache();
  try {
    const counts = db.prepare('SELECT module, COUNT(*) AS records FROM cache_records GROUP BY module').all() as Array<{ module: ModuleName; records: number }>;
    const scopes = db.prepare('SELECT module, snapshot_kind, fetched_at FROM cache_snapshots').all() as Array<{ module: ModuleName; snapshot_kind: string; fetched_at: string }>;
    const apiReadCount = db.prepare('SELECT COUNT(*) AS count FROM cache_api_reads').get() as { count: number };
    const recordCount = new Map(counts.map((row) => [row.module, row.records]));
    return {
      path: cacheDatabasePath(),
      profile: cacheProfile(),
      apiReadSnapshots: apiReadCount.count,
      modules: modules.map((module) => statusFromRows(module, recordCount.get(module) ?? 0, scopes.filter((scope) => scope.module === module))),
    };
  } finally {
    db.close();
  }
}

export function searchCacheRecords(module: ModuleName, query: { text?: string; id?: string }, limit = 20, now = Date.now()): CacheSearchResult[] {
  const text = query.text ? normalizeText(query.text) : '';
  const textTokens = text.split(/\s+/).filter(Boolean);
  const id = query.id?.trim() ?? '';
  if (!text && !id) throw new CliError('Indica --text o --id para buscar en la caché.', 'usage', 'cache.search.query_required');
  if (text && id) throw new CliError('Usa --text o --id, no ambos.', 'usage', 'cache.search.query_conflict');
  const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const textPredicate = textTokens.length ? `(${textTokens.map(() => 'instr(search_text, ?) > 0').join(' AND ')})` : '0';
  const db = openCache();
  try {
    const rows = db.prepare(`
      SELECT module, record_id, display_name, customer_id, state, search_text, record_json, fetched_at
      FROM cache_records
      WHERE module = ? AND ((? <> '' AND record_id = ?) OR ${textPredicate})
      ORDER BY display_name COLLATE NOCASE, record_id
      LIMIT ?
    `).all(module, id, id, ...textTokens, boundedLimit) as CacheRecordRow[];
    return rows.map((row) => ({
      id: row.record_id,
      label: row.display_name,
      customerId: row.customer_id ?? undefined,
      state: row.state ?? undefined,
      fetchedAt: row.fetched_at,
      stale: !isFresh(module, row.fetched_at, now),
    }));
  } finally {
    db.close();
  }
}

export function resolveCachedName(module: ModuleName, name: string, now = Date.now()): CacheSearchResult {
  const normalizedName = normalizeText(name);
  const nameTokens = normalizedName.split(/\s+/).filter(Boolean);
  if (!normalizedName) throw new CliError('Escribe el nombre que quieres resolver.', 'usage', 'cache.resolve.name_required');
  const snapshot = readFreshCacheSnapshot(module, {}, now);
  if (!snapshot) throw new CliError(`No hay un catálogo completo y vigente de ${module}. Ejecuta "siys cache refresh --module ${module}" y vuelve a intentar.`, 'usage', 'cache.resolve.stale');
  const matchingRows = snapshot.rows.filter((row) => {
    const indexedText = normalizeText(collectSearchValues(row).join(' '));
    return nameTokens.every((token) => indexedText.includes(token));
  });
  if (matchingRows.length === 0) throw new CliError(`No se encontró "${name}" en el catálogo vigente de ${module}.`, 'usage', 'cache.resolve.not_found');
  const matches = matchingRows.map((row) => {
    const id = recordIdOf(module, row);
    return {
      id,
      label: recordLabel(row, id),
      customerId: objectId(row._customerId) ?? objectId(row.customerId) ?? objectId(row.customer_id) ?? objectId(row.customer),
      state: firstString(row, ['state', 'status', 'estado']),
      fetchedAt: snapshot.fetchedAt,
      stale: false,
    } satisfies CacheSearchResult;
  });
  const distinct = [...new Map(matches.map((match) => [match.id, match])).values()];
  if (distinct.length !== 1) {
    const candidates = distinct.slice(0, 10).map((match) => `${match.label} (${match.id})`).join('; ');
    throw new CliError(`El nombre "${name}" es ambiguo y coincide con ${distinct.length} registros de ${module}. Usa "siys cache search ${module} --text <texto>" para elegir el ID exacto. Candidatos: ${candidates}`, 'safety', 'cache.resolve.ambiguous');
  }
  return distinct[0];
}

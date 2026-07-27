import path from 'node:path';
import { fetchEndpoint } from './api.js';
import { getAuthenticatedToken, loginDirect } from './auth.js';
import { loadEndpointDefinitions } from './endpoints.js';
import { exportRows } from './exporters.js';
import { exportsDir } from './paths.js';
import { redact } from './security.js';
import { exportFormats, modules, type EndpointDefinition, type ExportFormat, type ModuleName } from './types.js';
import { timestamp } from './utils.js';
import type { QueryParams } from './order-filters.js';

export interface DownloadOptions {
  modules: ModuleName[];
  formats: ExportFormat[];
  params: QueryParams;
  maxPages: number;
  outDir: string;
  output?: string;
  autoLogin: boolean;
}

export interface DownloadResult {
  module: ModuleName;
  format: ExportFormat;
  records: number;
  output: string;
}

export function sanitizeQuoteRecord(row: Record<string, unknown>): Record<string, unknown> {
  return redact(row) as Record<string, unknown>;
}

export function parseParams(values: string[]): QueryParams {
  return Object.fromEntries(values.map((value) => {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error(`Parametro invalido: ${value}. Usa clave=valor.`);
    return [value.slice(0, separator), value.slice(separator + 1)];
  }));
}

function splitOptionValues(values: string[]): string[] {
  return values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
}

export function parseModules(values: string[]): ModuleName[] {
  const requested = splitOptionValues(values.length > 0 ? values : ['all']);
  const expanded = requested.includes('all') ? [...modules] : requested;
  const invalid = expanded.filter((value) => !(modules as readonly string[]).includes(value));
  if (invalid.length > 0) throw new Error(`Modulo invalido: ${invalid.join(', ')}. Usa all, ${modules.join(', ')}.`);
  return [...new Set(expanded)] as ModuleName[];
}

export function parseFormats(values: string[]): ExportFormat[] {
  const requested = splitOptionValues(values.length > 0 ? values : ['xlsx']);
  const invalid = requested.filter((value) => !(exportFormats as readonly string[]).includes(value));
  if (invalid.length > 0) throw new Error(`Formato invalido: ${invalid.join(', ')}. Usa ${exportFormats.join(', ')}.`);
  return [...new Set(requested)] as ExportFormat[];
}

export function defaultParams(module: ModuleName): QueryParams {
  const now = new Date();
  const year = now.getUTCFullYear();
  if (module === 'orders') {
    return { start: `${year}-01-01`, end: now.toISOString().slice(0, 10) };
  }
  if (module === 'quotes') {
    return {
      fecha_busqueda: '1',
      inicio: new Date(Date.UTC(year, 0, 1, 5)).toISOString(),
      fin: now.toISOString(),
    };
  }
  return {};
}

export function buildDownloadOptions(options: {
  module?: string[];
  format?: string[];
  param?: string[];
  params?: QueryParams;
  maxPages?: number;
  outDir?: string;
  output?: string;
  autoLogin?: boolean;
}): DownloadOptions {
  const selectedModules = parseModules(options.module ?? []);
  const selectedFormats = parseFormats(options.format ?? []);
  if (options.output && (selectedModules.length !== 1 || selectedFormats.length !== 1)) {
    throw new Error('--output solo se puede usar con exactamente un modulo y un formato.');
  }
  if ((options.param?.length ?? 0) > 0 && selectedModules.length !== 1) {
    throw new Error('--param solo se puede usar con un modulo a la vez.');
  }
  return {
    modules: selectedModules,
    formats: selectedFormats,
    params: { ...parseParams(options.param ?? []), ...(options.params ?? {}) },
    maxPages: options.maxPages ?? 100,
    outDir: options.outDir ?? exportsDir,
    output: options.output,
    autoLogin: options.autoLogin ?? true,
  };
}

async function fetchAllEquipment(
  equipment: EndpointDefinition,
  clients: EndpointDefinition,
  token: string,
  maxPages: number,
): Promise<Record<string, unknown>[]> {
  const customerRows = await fetchEndpoint(clients, { token, params: {}, maxPages: 1 });
  const output: Record<string, unknown>[] = [];
  const batchSize = 5;
  for (let index = 0; index < customerRows.length; index += batchSize) {
    const batch = customerRows.slice(index, index + batchSize);
    const results = await Promise.all(batch.map(async (customer) => {
      const id = customer._id;
      if (typeof id !== 'string') return [];
      const rows = await fetchEndpoint(equipment, { token, params: { customer: id }, maxPages });
      return rows.map((row) => ({ _customerId: id, ...row }));
    }));
    output.push(...results.flat());
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return output;
}

function isAuthError(error: unknown): boolean {
  return error instanceof Error && /\b(401|403)\b/.test(error.message);
}

async function fetchRows(
  module: ModuleName,
  definitions: EndpointDefinition[],
  token: string,
  params: QueryParams,
  maxPages: number,
): Promise<Record<string, unknown>[]> {
  const selected = definitions.filter((definition) => definition.module === module);
  if (selected.length === 0) throw new Error(`No hay endpoint definido para ${module}.`);
  if (module === 'equipment' && typeof params.customer !== 'string') {
    const clients = definitions.find((definition) => definition.module === 'clients');
    if (!clients) throw new Error('No existe la definicion del endpoint de clientes.');
    return fetchAllEquipment(selected[0], clients, token, maxPages);
  }
  const rows: Record<string, unknown>[] = [];
  for (const endpoint of selected) {
    const endpointRows = await fetchEndpoint(endpoint, { token, params, maxPages });
    rows.push(...endpointRows.map((row) => {
      const record = { _endpoint: endpoint.path, ...row };
      return module === 'quotes' ? sanitizeQuoteRecord(record) : record;
    }));
  }
  return rows;
}

export function outputPathFor(module: ModuleName, format: ExportFormat, options: DownloadOptions, stamp = timestamp()): string {
  return options.output ?? path.join(options.outDir, `${module}-${stamp}.${format}`);
}

export async function downloadData(options: DownloadOptions): Promise<DownloadResult[]> {
  const definitions = await loadEndpointDefinitions();
  let token = await getAuthenticatedToken(options.autoLogin);
  const results: DownloadResult[] = [];
  const stamp = timestamp();

  for (const module of options.modules) {
    const params = { ...defaultParams(module), ...options.params };
    let rows: Record<string, unknown>[];
    try {
      rows = await fetchRows(module, definitions, token, params, options.maxPages);
    } catch (error) {
      if (!options.autoLogin || !isAuthError(error)) throw error;
      token = await loginDirect();
      rows = await fetchRows(module, definitions, token, params, options.maxPages);
    }

    for (const format of options.formats) {
      const output = outputPathFor(module, format, options, stamp);
      await exportRows(rows, format, output);
      results.push({ module, format, records: rows.length, output });
    }
  }
  return results;
}

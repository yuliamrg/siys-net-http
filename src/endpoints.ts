import { endpointConfigPath } from './paths.js';
import type { EndpointDefinition } from './types.js';
import { readJsonFile } from './json-file.js';
import { modules } from './types.js';

export const canonicalEndpoints: EndpointDefinition[] = [
  {
    module: 'orders',
    method: 'GET',
    path: '/order/v2',
    dataPath: 'docs',
    pagination: { pageParam: 'page', pageSizeParam: 'limit', pageSize: 100, totalPath: 'total' },
  },
  { module: 'quotes', method: 'GET', path: '/cotizacion' },
  { module: 'clients', method: 'GET', path: '/customer' },
  { module: 'equipment', method: 'GET', path: '/equipment' },
];

export async function loadEndpointDefinitions(): Promise<EndpointDefinition[]> {
  try {
    return validateEndpointDefinitions(await readJsonFile<unknown>(endpointConfigPath, 'La configuración de endpoints'));
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
    if (code !== 'ENOENT') throw error;
    return canonicalEndpoints;
  }
}

function exactKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} contiene claves desconocidas: ${unknown.join(', ')}.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} debe ser un objeto.`);
  return value as Record<string, unknown>;
}

function safePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/.test(value) || value.includes('//') || value.includes('..') || value.includes('\\')) {
    throw new Error(`${label} debe ser una ruta relativa segura que empiece por /.`);
  }
  return value;
}

function optionalDottedPath(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value)) throw new Error(`${label} debe ser una ruta de propiedades separada por puntos.`);
  return value;
}

export function validateEndpointDefinitions(value: unknown): EndpointDefinition[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('La configuración de endpoints debe ser una lista no vacía.');
  const seen = new Set<string>();
  return value.map((item, index) => {
    const label = `Endpoint ${index + 1}`;
    const source = record(item, label);
    exactKeys(source, new Set(['module', 'method', 'path', 'dataPath', 'pagination', 'defaultParams']), label);
    if (typeof source.module !== 'string' || !(modules as readonly string[]).includes(source.module)) throw new Error(`${label} usa un módulo desconocido.`);
    if (source.method !== 'GET') throw new Error(`${label} solo puede usar el método GET.`);
    const endpointPath = safePath(source.path, `${label}.path`);
    const duplicate = `${source.module} ${endpointPath}`;
    if (seen.has(duplicate)) throw new Error(`Endpoint duplicado: ${duplicate}.`);
    seen.add(duplicate);
    let pagination: EndpointDefinition['pagination'];
    if (source.pagination !== undefined) {
      const raw = record(source.pagination, `${label}.pagination`);
      exactKeys(raw, new Set(['pageParam', 'pageSizeParam', 'pageSize', 'totalPath']), `${label}.pagination`);
      if (typeof raw.pageParam !== 'string' || !/^[A-Za-z][\w.[\]-]*$/.test(raw.pageParam)) throw new Error(`${label}.pagination.pageParam es inválido.`);
      if (typeof raw.pageSizeParam !== 'string' || !/^[A-Za-z][\w.[\]-]*$/.test(raw.pageSizeParam)) throw new Error(`${label}.pagination.pageSizeParam es inválido.`);
      if (!Number.isInteger(raw.pageSize) || Number(raw.pageSize) < 1) throw new Error(`${label}.pagination.pageSize debe ser un entero positivo.`);
      pagination = { pageParam: raw.pageParam, pageSizeParam: raw.pageSizeParam, pageSize: Number(raw.pageSize), totalPath: optionalDottedPath(raw.totalPath, `${label}.pagination.totalPath`) } as EndpointDefinition['pagination'];
    }
    let defaultParams: Record<string, string> | undefined;
    if (source.defaultParams !== undefined) {
      const raw = record(source.defaultParams, `${label}.defaultParams`);
      if (Object.values(raw).some((entry) => typeof entry !== 'string')) throw new Error(`${label}.defaultParams solo admite valores de texto.`);
      defaultParams = raw as Record<string, string>;
    }
    return { module: source.module, method: 'GET', path: endpointPath, dataPath: optionalDottedPath(source.dataPath, `${label}.dataPath`), pagination, defaultParams } as EndpointDefinition;
  });
}

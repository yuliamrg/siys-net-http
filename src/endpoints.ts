import fs from 'node:fs/promises';
import { endpointConfigPath } from './paths.js';
import type { EndpointDefinition } from './types.js';

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
    return JSON.parse(await fs.readFile(endpointConfigPath, 'utf8')) as EndpointDefinition[];
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
    if (code !== 'ENOENT') throw error;
    return canonicalEndpoints;
  }
}

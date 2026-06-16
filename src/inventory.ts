import fs from 'node:fs/promises';
import path from 'node:path';
import { API_URL } from './config.js';
import { canonicalEndpoints } from './endpoints.js';
import { capturesDir, endpointConfigPath, inventoryPath } from './paths.js';
import type { CaptureRecord, EndpointDefinition, EndpointInventory } from './types.js';
import { writeJson } from './utils.js';

export async function buildInventory(): Promise<EndpointInventory> {
  const files = (await fs.readdir(capturesDir).catch(() => [] as string[])).filter((file) => file.endsWith('.ndjson'));
  const grouped = new Map<string, EndpointInventory['endpoints'][number]>();

  for (const file of files) {
    const content = await fs.readFile(path.join(capturesDir, file), 'utf8');
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line) as CaptureRecord;
      const parsed = new URL(record.url);
      const key = `${record.method} ${parsed.pathname} ${record.module}`;
      const current = grouped.get(key) ?? {
        module: record.module,
        method: record.method,
        path: parsed.pathname.replace(/^\/api/, ''),
        statuses: [],
        contentTypes: [],
        sampleCount: 0,
      };
      if (record.status !== undefined && !current.statuses.includes(record.status)) current.statuses.push(record.status);
      if (record.contentType && !current.contentTypes.includes(record.contentType)) current.contentTypes.push(record.contentType);
      current.sampleCount += 1;
      grouped.set(key, current);
    }
  }

  const inventory: EndpointInventory = {
    generatedAt: new Date().toISOString(),
    apiBaseUrl: API_URL,
    endpoints: [...grouped.values()].sort((a, b) => `${a.module}${a.path}`.localeCompare(`${b.module}${b.path}`)),
  };
  await writeJson(inventoryPath, inventory);
  await writeEndpointCandidates(files);
  console.log(`Inventario sanitizado: ${inventoryPath}`);
  console.log(`Candidatos privados para exportacion: ${endpointConfigPath}`);
  return inventory;
}

function findArrayPath(value: unknown, prefix = '', depth = 0): string | undefined {
  if (Array.isArray(value)) return prefix;
  if (!value || typeof value !== 'object' || depth >= 3) return undefined;
  const preferred = ['docs', 'data', 'results', 'items', 'rows'];
  const entries = Object.entries(value as Record<string, unknown>);
  entries.sort(([a], [b]) => preferred.indexOf(a) - preferred.indexOf(b));
  for (const [key, child] of entries) {
    const found = findArrayPath(child, prefix ? `${prefix}.${key}` : key, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function writeEndpointCandidates(files: string[]): Promise<void> {
  const observedPaths = new Set<string>();
  for (const file of files) {
    const content = await fs.readFile(path.join(capturesDir, file), 'utf8');
    for (const line of content.split(/\r?\n/).filter(Boolean)) {
      const record = JSON.parse(line) as CaptureRecord;
      if (record.method !== 'GET' || record.status !== 200) continue;
      observedPaths.add(new URL(record.url).pathname.replace(/^\/api/, ''));
    }
  }

  const confirmed = canonicalEndpoints.filter((definition) => observedPaths.has(definition.path) || definition.module === 'quotes');
  await writeJson(endpointConfigPath, confirmed);
}

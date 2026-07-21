import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { inspectOrder, inspectionOutputPath, writeInspection } from '../src/order-inspect.js';

const originalFetch = global.fetch;
const originalToken = process.env.SIYS_TOKEN;

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.SIYS_TOKEN;
  else process.env.SIYS_TOKEN = originalToken;
});

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('inspects an order and preserves nested maintenance and delivery data', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const calls: Array<{ url: string; method?: string }> = [];
  global.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    if (url.includes('/order/v2?')) return response({ docs: [{ _id: 'order-id', code: '007393' }], total: 1, page: 1 });
    if (url.endsWith('/order/order-id/detail?full=true')) return response({ doc: {
      _id: 'order-id', code: 7393, maintenances: [{ _id: 'link-1', maintenance: { _id: 'maintenance-1' }, equipment: { _id: 'equipment-1' } }], deliverOrder: { _id: 'delivery-1' },
    } });
    if (url.endsWith('/maintenance/maintenance-1/detail')) return response({
      _id: 'maintenance-1', equipment: { _id: 'equipment-1', name: 'Equipo' }, tasks: { activitys: [{ file: { path: 'files', name: 'photo.jpg' }, hiddenFile: null }, { file: null, hiddenFile: [] }] },
    });
    if (url.endsWith('/deliver-order/delivery-1')) return response({ show: true, questions: [] });
    throw new Error(`Ruta inesperada: ${url}`);
  };

  const inspection = await inspectOrder('007393', { autoLogin: false });

  expect(inspection.code).toBe('007393');
  expect(inspection.maintenances).toEqual([expect.objectContaining({ maintenanceId: 'maintenance-1', equipmentId: 'equipment-1' })]);
  expect(inspection.delivery).toEqual({ show: true, questions: [] });
  expect(calls).toHaveLength(4);
  expect(calls.every((call) => call.method === 'GET')).toBe(true);
});

test('rejects missing orders and incomplete maintenance links', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  global.fetch = async () => response({ docs: [], total: 0, page: 1 });
  await expect(inspectOrder('7393', { autoLogin: false })).rejects.toThrow(/No se encontro/);

  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/order/v2?')) return response({ docs: [{ _id: 'order-id', code: 7393 }] });
    if (url.endsWith('/order/order-id/detail?full=true')) return response({ doc: { _id: 'order-id', maintenances: [{ _id: 'link-1' }] } });
    throw new Error(`Ruta inesperada: ${url}`);
  };
  await expect(inspectOrder('7393', { autoLogin: false })).rejects.toThrow(/sin identificador/);
});

test('writes inspection output atomically and formats default paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-order-inspect-'));
  const output = path.join(directory, 'inspection.json');
  await writeInspection(output, {
    schemaVersion: '1.0', extractedAt: '2026-07-15T00:00:00.000Z', code: '007393',
    source: { list: { total: 1, page: 1 }, orderId: 'order-id' }, order: { _id: 'order-id' }, maintenances: [], delivery: null,
  });
  await expect(fs.readFile(output, 'utf8')).resolves.toContain('"schemaVersion": "1.0"');
  expect(inspectionOutputPath('7393', 'exports', '20260715-000000')).toBe(path.join('exports', 'order-007393-20260715-000000.json'));
  await fs.rm(directory, { recursive: true, force: true });
});

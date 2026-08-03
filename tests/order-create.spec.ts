import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { executeOrderCreate, orderCreateAuditOutputPath, orderCreateExecutionState, orderCreateSimulationOutputPath, simulateOrderCreate, writeOrderCreateAudit, writeOrderCreateSimulation } from '../src/order-create.js';

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

async function requestFile(overrides: Record<string, unknown> = {}): Promise<{ directory: string; file: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-order-create-'));
  const file = path.join(directory, 'request.json');
  const value = {
    schemaVersion: '1.0', status: 'draft', mode: 'manual', customerId: 'customer-1', subsidiaryId: 'subsidiary-1',
    orderTypeId: 'type-1', material: 'Herramientas manuales', observations: 'Prueba de simulacion sin escritura.',
    equipmentIds: ['equipment-1'],
    schedule: [{ startLocal: '2026-08-03T08:00:00', endLocal: '2026-08-03T09:00:00', technicianId: 'technician-1' }],
    timeZone: 'America/Bogota', ...overrides,
  };
  await fs.writeFile(file, JSON.stringify(value), 'utf8');
  return { directory, file };
}

async function contractFile(directory: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const file = path.join(directory, 'contract.json');
  await fs.writeFile(file, JSON.stringify({ schemaVersion: '1.0', enabled: true, operation: { method: 'POST', path: '/order' }, ...overrides }), 'utf8');
  return file;
}

function mockCatalogs(available = true): Array<{ url: string; method?: string }> {
  const calls: Array<{ url: string; method?: string }> = [];
  global.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, method: init?.method });
    if (url.endsWith('/customer')) return response([{ _id: 'customer-1', name: 'Cliente Uno' }]);
    if (url.includes('/subsidiary?')) return response([{ _id: 'subsidiary-1', name: 'Sede Uno' }]);
    if (url.endsWith('/order-type')) return response([{ _id: 'type-1', name: 'Correctivo' }]);
    if (url.includes('/equipment?')) return response([{ _id: 'equipment-1', name: 'Aire Uno' }]);
    if (url.endsWith('/user')) return response([{ _id: 'technician-1', name: 'Tecnico Uno', itIsTechnical: true }]);
    if (url.includes('/itAvailable?')) return response({ available });
    throw new Error(`Ruta inesperada: ${url}`);
  };
  return calls;
}

test('simulates the exact payload using only GET catalog and availability calls', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile();
  const calls = mockCatalogs();

  const simulation = await simulateOrderCreate(fixture.file, { autoLogin: false });

  expect(simulation.validation).toEqual({ ready: true, blockers: [] });
  expect(simulation.payload).toEqual({
    equipments: ['equipment-1'], type: 'type-1', customer: 'customer-1', subsidiary: 'subsidiary-1',
    material: 'Herramientas manuales', observations: 'Prueba de simulacion sin escritura.', users: ['technician-1'],
    dates: [{ start: '2026-08-03T13:00:00.000Z', end: '2026-08-03T14:00:00.000Z', user: 'technician-1' }],
  });
  expect(simulation.safety).toEqual({ siysWritesAttempted: 0, catalogAndAvailabilityMethod: 'GET', orderEndpointCalled: false });
  expect(calls).toHaveLength(6);
  expect(calls.every((call) => call.method === 'GET')).toBe(true);
  expect(calls.some((call) => /\/api\/order(?:\?|$)/.test(call.url))).toBe(false);
  expect(calls.find((call) => call.url.includes('/itAvailable?'))?.url).toContain('start=2026-08-03T08%3A00%3A00-05%3A00');
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('returns a blocking simulation when SIYS reports the technician unavailable', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile();
  mockCatalogs(false);
  const simulation = await simulateOrderCreate(fixture.file, { autoLogin: false });
  expect(simulation.validation.ready).toBe(false);
  expect(simulation.validation.blockers).toEqual([expect.stringContaining('no disponible')]);
  expect(simulation.payload.dates).toHaveLength(1);
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('rejects invalid schemas before making any HTTP request', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  let calls = 0;
  global.fetch = async () => { calls += 1; return response({}); };

  const plan = await requestFile({ mode: 'plan' });
  await expect(simulateOrderCreate(plan.file, { autoLogin: false })).rejects.toThrow(/mode debe ser "manual"/);
  await fs.rm(plan.directory, { recursive: true, force: true });

  const noEquipment = await requestFile({ equipmentIds: [] });
  await expect(simulateOrderCreate(noEquipment.file, { autoLogin: false })).rejects.toThrow(/al menos un equipo/);
  await fs.rm(noEquipment.directory, { recursive: true, force: true });

  const badDate = await requestFile({ schedule: [{ startLocal: '2026-02-30T08:00:00', endLocal: '2026-08-03T09:00:00', technicianId: 'technician-1' }] });
  await expect(simulateOrderCreate(badDate.file, { autoLogin: false })).rejects.toThrow(/no es una fecha valida/);
  await fs.rm(badDate.directory, { recursive: true, force: true });

  const forbidden = await requestFile({ users: ['technician-1'] });
  await expect(simulateOrderCreate(forbidden.file, { autoLogin: false })).rejects.toThrow(/campos no admitidos: users/);
  await fs.rm(forbidden.directory, { recursive: true, force: true });
  expect(calls).toBe(0);
});

test('rejects catalog inconsistencies and non-technical users', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const missingEquipment = await requestFile();
  global.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/customer')) return response([{ _id: 'customer-1' }]);
    if (url.includes('/subsidiary?')) return response([{ _id: 'subsidiary-1' }]);
    if (url.endsWith('/order-type')) return response([{ _id: 'type-1' }]);
    if (url.includes('/equipment?')) return response([]);
    if (url.endsWith('/user')) return response([{ _id: 'technician-1', itIsTechnical: true }]);
    throw new Error(`Ruta inesperada: ${url}`);
  };
  await expect(simulateOrderCreate(missingEquipment.file, { autoLogin: false })).rejects.toThrow(/equipo activo.*no existe/i);
  await fs.rm(missingEquipment.directory, { recursive: true, force: true });

  const nonTechnical = await requestFile();
  global.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/customer')) return response([{ _id: 'customer-1' }]);
    if (url.includes('/subsidiary?')) return response([{ _id: 'subsidiary-1' }]);
    if (url.endsWith('/order-type')) return response([{ _id: 'type-1' }]);
    if (url.includes('/equipment?')) return response([{ _id: 'equipment-1' }]);
    if (url.endsWith('/user')) return response([{ _id: 'technician-1', itIsTechnical: false }]);
    throw new Error(`Ruta inesperada: ${url}`);
  };
  await expect(simulateOrderCreate(nonTechnical.file, { autoLogin: false })).rejects.toThrow(/no esta marcado como tecnico/);
  await fs.rm(nonTechnical.directory, { recursive: true, force: true });
});

test('writes the local simulation atomically and builds its default path', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile();
  mockCatalogs();
  const simulation = await simulateOrderCreate(fixture.file, { autoLogin: false });
  const output = path.join(fixture.directory, 'result.json');
  await writeOrderCreateSimulation(output, simulation);
  await expect(fs.readFile(output, 'utf8')).resolves.toContain('"siysWritesAttempted": 0');
  expect(orderCreateSimulationOutputPath('exports', '20260802-120000')).toBe(path.join('exports', 'order-create-simulation-20260802-120000.json'));
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('requires approved status and an exact private contract before any confirmed write', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  let calls = 0;
  global.fetch = async () => { calls += 1; return response({}); };
  const draft = await requestFile();
  const contract = await contractFile(draft.directory);
  await expect(executeOrderCreate(draft.file, { confirm: true, contractPath: contract, autoLogin: false })).rejects.toThrow(/status: "approved"/);
  await fs.rm(draft.directory, { recursive: true, force: true });

  const approved = await requestFile({ status: 'approved' });
  const wrongContract = await contractFile(approved.directory, { operation: { method: 'PUT', path: '/order' } });
  await expect(executeOrderCreate(approved.file, { confirm: true, contractPath: wrongContract, autoLogin: false })).rejects.toThrow(/exactamente POST \/order/);
  await fs.rm(approved.directory, { recursive: true, force: true });
  expect(calls).toBe(0);
});

test('confirmed execution repeats preflight and sends exactly one contracted POST', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile({ status: 'approved' });
  const contract = await contractFile(fixture.directory);
  const calls = mockCatalogs();
  const catalogFetch = global.fetch;
  global.fetch = async (input, init) => {
    if (init?.method === 'POST') {
      calls.push({ url: String(input), method: init.method });
      expect(String(input)).toBe('https://api.siys.net/api/order');
      expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({ customer: 'customer-1', users: ['technician-1'] }));
      return response({ _id: 'created-order-1', code: 9999 });
    }
    if (String(input).endsWith('/order/created-order-1/detail?full=true')) return response({ doc: {
      _id: 'created-order-1', code: 9999, customer: 'customer-1', subsidiary: 'subsidiary-1', type: 'type-1',
      material: 'Herramientas manuales', observations: 'Prueba de simulacion sin escritura.', equipments: ['equipment-1'], users: ['technician-1'],
      dates: [{ start: '2026-08-03T13:00:00.000Z', end: '2026-08-03T14:00:00.000Z', user: 'technician-1' }],
    } });
    return catalogFetch(input, init);
  };

  const result = await executeOrderCreate(fixture.file, { confirm: true, contractPath: contract, autoLogin: false, receiptDir: path.join(fixture.directory, 'receipts') });

  expect(result.dryRun).toBe(false);
  if (!result.dryRun) {
    expect(result.response).toEqual({ _id: 'created-order-1', code: 9999 });
    expect(result.contract).toEqual(expect.objectContaining({ method: 'POST', path: '/order', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(result.audit.status).toBe('verified');
    expect(result.audit.verification).toEqual(expect.objectContaining({ status: 'verified', orderId: 'created-order-1', orderCode: '009999' }));
  }
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  expect(calls.filter((call) => call.method === 'GET')).toHaveLength(6);
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('records timeout as ambiguous and never retries the POST', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile({ status: 'approved' });
  const contract = await contractFile(fixture.directory);
  const calls = mockCatalogs();
  const catalogFetch = global.fetch;
  global.fetch = async (input, init) => {
    if (init?.method !== 'POST') return catalogFetch(input, init);
    calls.push({ url: String(input), method: init.method });
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
  };
  const progress: string[] = [];
  let captured: unknown;
  try {
    await executeOrderCreate(fixture.file, {
      confirm: true, contractPath: contract, autoLogin: false, timeoutMs: 5, receiptDir: path.join(fixture.directory, 'receipts'),
      onProgress: async (audit) => { progress.push(audit.status); },
    });
  } catch (error) { captured = error; }
  expect(captured).toBeInstanceOf(Error);
  expect((captured as Error).message).toMatch(/ambiguous; no reintentar/i);
  expect((captured as Error & { orderCreateAudit: { status: string; attempt: { retryAllowed: boolean } } }).orderCreateAudit)
    .toEqual(expect.objectContaining({ status: 'ambiguous', attempt: expect.objectContaining({ retryAllowed: false }) }));
  expect(progress).toEqual(['in_progress', 'ambiguous']);
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('writes an atomic audit without authentication secrets', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile({ status: 'approved' });
  const contract = await contractFile(fixture.directory);
  const calls = mockCatalogs();
  const catalogFetch = global.fetch;
  global.fetch = async (input, init) => {
    if (init?.method === 'POST') { calls.push({ url: String(input), method: init.method }); return response({ _id: 'created-order-1' }); }
    if (String(input).endsWith('/order/created-order-1/detail?full=true')) return response({ doc: {
      _id: 'created-order-1', customer: 'customer-1', subsidiary: 'subsidiary-1', type: 'type-1', material: 'Herramientas manuales',
      observations: 'Prueba de simulacion sin escritura.', equipments: ['equipment-1'], users: ['technician-1'],
      dates: [{ start: '2026-08-03T13:00:00.000Z', end: '2026-08-03T14:00:00.000Z', user: 'technician-1' }],
    } });
    return catalogFetch(input, init);
  };
  const result = await executeOrderCreate(fixture.file, { confirm: true, contractPath: contract, autoLogin: false, receiptDir: path.join(fixture.directory, 'receipts') });
  expect(result.dryRun).toBe(false);
  if (result.dryRun) throw new Error('Se esperaba ejecución confirmada.');
  const output = path.join(fixture.directory, 'audit.json');
  await writeOrderCreateAudit(output, result.audit);
  const serialized = await fs.readFile(output, 'utf8');
  expect(serialized).toContain('"status": "verified"');
  expect(serialized).not.toContain('header.payload.signature');
  expect(serialized).not.toMatch(/authentication|bearer/i);
  expect(orderCreateAuditOutputPath('exports', '20260802-120000')).toBe(path.join('exports', 'order-create-audit-20260802-120000.json'));
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('fails safely when the created detail differs or the response has no ID', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const mismatchFixture = await requestFile({ status: 'approved' });
  const mismatchContract = await contractFile(mismatchFixture.directory);
  mockCatalogs();
  const catalogFetch = global.fetch;
  global.fetch = async (input, init) => {
    if (init?.method === 'POST') return response({ _id: 'created-order-2' });
    if (String(input).endsWith('/order/created-order-2/detail?full=true')) return response({ doc: {
      _id: 'created-order-2', customer: 'customer-1', subsidiary: 'subsidiary-1', type: 'type-1', material: 'Otro material',
      observations: 'Prueba de simulacion sin escritura.', equipments: ['equipment-1'], users: ['technician-1'], dates: [],
    } });
    return catalogFetch(input, init);
  };
  let mismatchError: (Error & { orderCreateAudit?: { status: string; verification?: { status: string; checks: Array<{ matches: boolean; field: string }> } } }) | undefined;
  try { await executeOrderCreate(mismatchFixture.file, { confirm: true, contractPath: mismatchContract, autoLogin: false, receiptDir: path.join(mismatchFixture.directory, 'receipts') }); } catch (error) { mismatchError = error as typeof mismatchError; }
  expect(mismatchError?.message).toMatch(/verificación posterior falló/i);
  expect(mismatchError?.orderCreateAudit?.status).toBe('verification_failed');
  expect(mismatchError?.orderCreateAudit?.verification?.status).toBe('mismatch');
  expect(mismatchError?.orderCreateAudit?.verification?.checks.filter((check) => !check.matches).map((check) => check.field)).toContain('material');
  await fs.rm(mismatchFixture.directory, { recursive: true, force: true });

  const noIdFixture = await requestFile({ status: 'approved' });
  const noIdContract = await contractFile(noIdFixture.directory);
  mockCatalogs();
  const noIdCatalogFetch = global.fetch;
  global.fetch = async (input, init) => init?.method === 'POST' ? response({ ok: true }) : noIdCatalogFetch(input, init);
  let noIdError: (Error & { orderCreateAudit?: { status: string; verification?: unknown } }) | undefined;
  try { await executeOrderCreate(noIdFixture.file, { confirm: true, contractPath: noIdContract, autoLogin: false, receiptDir: path.join(noIdFixture.directory, 'receipts') }); } catch (error) { noIdError = error as typeof noIdError; }
  expect(noIdError?.orderCreateAudit?.status).toBe('verification_failed');
  expect(noIdError?.orderCreateAudit?.verification).toEqual(expect.objectContaining({ status: 'inconclusive', source: 'create-response' }));
  await fs.rm(noIdFixture.directory, { recursive: true, force: true });
});

test('reports confirmed execution as a write instead of inheriting dryRun from its nested simulation', async () => {
  const simulation = {
    dryRun: true,
  } as Parameters<typeof orderCreateExecutionState>[0];
  expect(orderCreateExecutionState(simulation)).toEqual({ dryRun: true, siysWritesAttempted: 0 });

  const execution = {
    dryRun: false,
    response: { _id: 'created-order-3' },
    audit: {
      status: 'verified',
      verification: { orderId: 'created-order-3', orderCode: '000013' },
    },
  } as unknown as Parameters<typeof orderCreateExecutionState>[0];
  expect(orderCreateExecutionState(execution)).toEqual({
    dryRun: false,
    siysWritesAttempted: 1,
    auditStatus: 'verified',
    created: { orderId: 'created-order-3', orderCode: '000013' },
  });
});

test('blocks replay of the same approved request by its atomic SHA-256 receipt', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile({ status: 'approved' });
  const contract = await contractFile(fixture.directory);
  const receiptDir = path.join(fixture.directory, 'receipts');
  const calls = mockCatalogs();
  const catalogFetch = global.fetch;
  global.fetch = async (input, init) => {
    if (init?.method === 'POST') { calls.push({ url: String(input), method: init.method }); return response({ _id: 'created-order-replay' }); }
    if (String(input).endsWith('/order/created-order-replay/detail?full=true')) return response({ doc: {
      _id: 'created-order-replay', code: 13, customer: 'customer-1', subsidiary: 'subsidiary-1', type: 'type-1',
      material: 'Herramientas manuales', observations: 'Prueba de simulacion sin escritura.', equipments: ['equipment-1'], users: ['technician-1'],
      dates: [{ start: '2026-08-03T13:00:00.000Z', end: '2026-08-03T14:00:00.000Z', user: 'technician-1' }],
    } });
    return catalogFetch(input, init);
  };

  const first = await executeOrderCreate(fixture.file, { confirm: true, contractPath: contract, autoLogin: false, receiptDir });
  expect(first.dryRun).toBe(false);
  await expect(executeOrderCreate(fixture.file, { confirm: true, contractPath: contract, autoLogin: false, receiptDir }))
    .rejects.toThrow(/ya tiene un recibo.*No se permite repetir el POST/i);
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  const receipts = await fs.readdir(receiptDir);
  expect(receipts).toHaveLength(1);
  const receipt = JSON.parse(await fs.readFile(path.join(receiptDir, receipts[0]), 'utf8'));
  expect(receipt).toEqual(expect.objectContaining({ status: 'verified', orderId: 'created-order-replay', orderCode: '000013' }));
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

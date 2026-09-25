import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures.js';
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

function nameRequestOverrides(): Record<string, unknown> {
  return {
    customerId: undefined, customerName: 'COOPIDROGAS',
    subsidiaryId: undefined, subsidiaryName: 'cali',
    orderTypeId: undefined, orderTypeName: 'LLAMADA DE EMERGENCIA',
    equipmentIds: undefined, equipmentNames: ['uma 3'],
    schedule: [{ startLocal: '2026-08-03T08:00:00', endLocal: '2026-08-03T09:00:00', technicianName: 'heiner sebastian' }],
  };
}

function mockNameCatalogs(overrides: Record<string, unknown> = {}): Array<{ url: string; method?: string }> {
  const catalogs: Record<string, unknown> = {
    customer: { docs: [{ _id: 'customer-name-id', name: 'Coopidrogás' }] },
    subsidiary: [{ _id: 'subsidiary-name-id', name: 'CÁLI' }],
    orderType: [{ _id: 'type-name-id', description: 'Llamada de emergencia' }],
    equipment: [{ _id: 'equipment-name-id', name: 'UMA-3' }],
    user: [
      { _id: 'nontechnical-name-id', name: 'Heiner Sebastian', itIsTechnical: false },
      { _id: 'technician-name-id', name: 'Heíner   Sebastián', itIsTechnical: true },
    ],
    available: true,
    ...overrides,
  };
  const calls: Array<{ url: string; method?: string }> = [];
  global.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, method: init?.method });
    if (url.endsWith('/customer')) return response(catalogs.customer);
    if (url.includes('/subsidiary?')) return response(catalogs.subsidiary);
    if (url.endsWith('/order-type')) return response(catalogs.orderType);
    if (url.includes('/equipment?')) return response(catalogs.equipment);
    if (url.endsWith('/user')) return response(catalogs.user);
    if (url.includes('/itAvailable?')) return response({ available: catalogs.available });
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

test('confirmed name request re-resolves catalogs, checks availability, posts IDs once, and verifies the created order', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile({ ...nameRequestOverrides(), status: 'approved' });
  const contract = await contractFile(fixture.directory);
  const calls = mockNameCatalogs();
  const catalogFetch = global.fetch;
  global.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'POST') {
      calls.push({ url, method: 'POST' });
      expect(url).toBe('https://api.siys.net/api/order');
      expect(JSON.parse(String(init.body))).toEqual(expect.objectContaining({
        customer: 'customer-name-id', subsidiary: 'subsidiary-name-id', type: 'type-name-id',
        equipments: ['equipment-name-id'], users: ['technician-name-id'],
      }));
      return response({ _id: 'created-name-order', code: 37 });
    }
    if (url.endsWith('/order/created-name-order/detail?full=true')) {
      calls.push({ url, method: 'GET' });
      return response({ doc: {
        _id: 'created-name-order', code: 37, customer: 'customer-name-id', subsidiary: 'subsidiary-name-id', type: 'type-name-id',
        material: 'Herramientas manuales', observations: 'Prueba de simulacion sin escritura.',
        equipments: ['equipment-name-id'], users: ['technician-name-id'],
        dates: [{ start: '2026-08-03T13:00:00.000Z', end: '2026-08-03T14:00:00.000Z', user: 'technician-name-id' }],
      } });
    }
    return catalogFetch(input, init);
  };

  const result = await executeOrderCreate(fixture.file, {
    confirm: true, contractPath: contract, autoLogin: false, receiptDir: path.join(fixture.directory, 'receipts'),
  });

  expect(result.dryRun).toBe(false);
  if (!result.dryRun) {
    expect(result.simulation.request).toHaveProperty('customerName', 'COOPIDROGAS');
    expect(result.simulation.resolved.customer.id).toBe('customer-name-id');
    expect(result.audit.status).toBe('verified');
    expect(result.audit.verification).toEqual(expect.objectContaining({ status: 'verified', orderId: 'created-name-order' }));
  }
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  expect(calls.filter((call) => call.method === 'GET')).toHaveLength(7);
  expect(calls.filter((call) => call.url.endsWith('/customer'))).toHaveLength(1);
  expect(calls.filter((call) => call.url.endsWith('/order-type'))).toHaveLength(1);
  expect(calls.filter((call) => call.url.endsWith('/user'))).toHaveLength(1);
  expect(calls.filter((call) => call.url.includes('/subsidiary?'))).toHaveLength(1);
  expect(calls.filter((call) => call.url.includes('/equipment?'))).toHaveLength(1);
  expect(calls.filter((call) => call.url.includes('/itAvailable?'))).toHaveLength(1);
  expect(calls.filter((call) => call.url.includes('/detail?full=true'))).toHaveLength(1);
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('resolves normalized human names through scoped catalogs and keeps IDs in the payload', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile(nameRequestOverrides());
  const calls = mockNameCatalogs();

  const simulation = await simulateOrderCreate(fixture.file, { autoLogin: false });

  expect(simulation.request).toEqual(expect.objectContaining({
    customerName: 'COOPIDROGAS', subsidiaryName: 'cali', orderTypeName: 'LLAMADA DE EMERGENCIA',
    equipmentNames: ['uma 3'], schedule: [expect.objectContaining({ technicianName: 'heiner sebastian' })],
  }));
  expect(simulation.resolved).toEqual({
    customer: { id: 'customer-name-id', name: 'Coopidrogás' },
    subsidiary: { id: 'subsidiary-name-id', name: 'CÁLI' },
    orderType: { id: 'type-name-id', name: 'Llamada de emergencia' },
    equipments: [{ id: 'equipment-name-id', name: 'UMA-3' }],
    technicians: [{ id: 'technician-name-id', name: 'Heíner   Sebastián' }],
  });
  expect(simulation.payload).toEqual(expect.objectContaining({
    customer: 'customer-name-id', subsidiary: 'subsidiary-name-id', type: 'type-name-id',
    equipments: ['equipment-name-id'], users: ['technician-name-id'],
  }));
  expect(simulation.safety).toEqual({ siysWritesAttempted: 0, catalogAndAvailabilityMethod: 'GET', orderEndpointCalled: false });
  expect(calls).toHaveLength(6);
  expect(calls.every((call) => call.method === 'GET')).toBe(true);
  expect(calls.slice(0, 3).map((call) => new URL(call.url).pathname).sort()).toEqual(['/api/customer', '/api/order-type', '/api/user']);
  expect(calls[3]?.url).toContain('/subsidiary?customer=customer-name-id');
  expect(calls[4]?.url).toContain('/equipment?subsidiary=subsidiary-name-id&active=1');
  expect(calls[5]?.url).toContain('/user/technician-name-id/itAvailable?');
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('resolves only mechanical equipment separator variants and keeps point schedules in the name-based flow', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const equipmentNames = ['UMA 3', 'UMA-3', 'UMA #3', 'UMA#3', 'uma # 3'];
  for (const equipmentName of equipmentNames) {
    const fixture = await requestFile({
      ...nameRequestOverrides(),
      equipmentNames: [equipmentName],
      schedule: [{ startLocal: '2026-08-03T08:00:00', endLocal: '2026-08-03T08:00:00', technicianName: 'heiner sebastian' }],
    });
    mockNameCatalogs({ equipment: [{ _id: 'equipment-name-id', name: 'UMA-3' }] });

    const simulation = await simulateOrderCreate(fixture.file, { autoLogin: false });

    expect(simulation.resolved.equipments).toEqual([{ id: 'equipment-name-id', name: 'UMA-3' }]);
    expect(simulation.request.schedule[0]).toEqual(expect.objectContaining({ startLocal: '2026-08-03T08:00:00', endLocal: '2026-08-03T08:00:00' }));
    expect(simulation.payload.dates).toEqual([{ start: '2026-08-03T13:00:00.000Z', end: '2026-08-03T13:00:00.000Z', user: 'technician-name-id' }]);
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }

  for (const unsupportedName of ['UMA03', 'Unidad Manejadora 3']) {
    const fixture = await requestFile({ ...nameRequestOverrides(), equipmentNames: [unsupportedName] });
    mockNameCatalogs({ equipment: [{ _id: 'equipment-name-id', name: 'UMA#3' }] });
    await expect(simulateOrderCreate(fixture.file, { autoLogin: false })).rejects.toThrow(/equipo activo con nombre exacto.*no existe/i);
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test('accepts equal point-schedule times for ID-only selectors and preserves the payload', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile({ schedule: [{ startLocal: '2026-08-03T08:00:00', endLocal: '2026-08-03T08:00:00', technicianId: 'technician-1' }] });
  const calls = mockCatalogs();

  const simulation = await simulateOrderCreate(fixture.file, { autoLogin: false });

  expect(simulation.payload.dates).toEqual([{ start: '2026-08-03T13:00:00.000Z', end: '2026-08-03T13:00:00.000Z', user: 'technician-1' }]);
  expect(simulation.availability).toEqual([expect.objectContaining({ startLocal: '2026-08-03T08:00:00', endLocal: '2026-08-03T08:00:00', available: true })]);
  expect(calls.find((call) => call.url.includes('/itAvailable?'))?.url).toContain('end=2026-08-03T08%3A00%3A00-05%3A00');
  expect(calls.every((call) => call.method === 'GET')).toBe(true);
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('rejects a point schedule whose end is before its start', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  let calls = 0;
  global.fetch = async () => { calls += 1; return response({}); };
  const fixture = await requestFile({ schedule: [{ startLocal: '2026-08-03T08:30:00', endLocal: '2026-08-03T08:00:00', technicianId: 'technician-1' }] });

  await expect(simulateOrderCreate(fixture.file, { autoLogin: false })).rejects.toThrow(/no puede terminar antes de iniciar/);

  expect(calls).toBe(0);
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('rejects zero and multiple normalized customer name matches with candidate IDs', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const missing = await requestFile(nameRequestOverrides());
  mockNameCatalogs({ customer: [{ _id: 'different-customer', name: 'Otra empresa' }] });
  await expect(simulateOrderCreate(missing.file, { autoLogin: false })).rejects.toThrow(/cliente con nombre exacto "COOPIDROGAS" no existe/i);
  await fs.rm(missing.directory, { recursive: true, force: true });

  const ambiguous = await requestFile(nameRequestOverrides());
  mockNameCatalogs({ customer: [
    { _id: 'customer-a', name: 'Coopidrogás' },
    { _id: 'customer-b', name: 'COOPIDROGAS' },
  ] });
  await expect(simulateOrderCreate(ambiguous.file, { autoLogin: false })).rejects.toThrow(/ambiguo.*customer-a.*customer-b/i);
  await fs.rm(ambiguous.directory, { recursive: true, force: true });
});

test('resolves a site only from the customer-scoped subsidiary response', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile(nameRequestOverrides());
  const calls = mockNameCatalogs({ subsidiary: [{ _id: 'other-customer-site', name: 'Bogotá' }] });
  await expect(simulateOrderCreate(fixture.file, { autoLogin: false })).rejects.toThrow(/sede con nombre exacto "cali" no existe.*cliente "Coopidrogás" \(ID: customer-name-id\)/i);
  expect(calls.some((call) => call.url.includes('/subsidiary?customer=customer-name-id'))).toBe(true);
  expect(calls.some((call) => call.url.endsWith('/subsidiary'))).toBe(false);
  expect(calls.some((call) => call.url.includes('/equipment?'))).toBe(false);
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('blocks duplicate equipment names within the resolved site and reports each ID and scope', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile(nameRequestOverrides());
  const calls = mockNameCatalogs({ equipment: [
    { _id: 'equipment-a', name: 'UMA 3' },
    { _id: 'equipment-b', name: 'UMA-3' },
  ] });
  await expect(simulateOrderCreate(fixture.file, { autoLogin: false })).rejects.toThrow(/ambiguo.*sede "CÁLI" \(ID: subsidiary-name-id\).*equipment-a.*equipment-b/i);
  expect(calls.find((call) => call.url.includes('/equipment?'))?.url).toContain('/equipment?subsidiary=subsidiary-name-id&active=1');
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('does not resolve a technician name from non-technical users', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile(nameRequestOverrides());
  const calls = mockNameCatalogs({ user: [{ _id: 'not-a-technician', name: 'Heiner Sebastian', itIsTechnical: false }] });
  await expect(simulateOrderCreate(fixture.file, { autoLogin: false })).rejects.toThrow(/tecnico con nombre exacto "heiner sebastian" no existe.*usuarios marcados como tecnicos/i);
  expect(calls.some((call) => call.url.includes('/itAvailable?'))).toBe(false);
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('resolves order type from name or description and blocks zero or ambiguous matches', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile(nameRequestOverrides());
  const calls = mockNameCatalogs({ orderType: [] });
  await expect(simulateOrderCreate(fixture.file, { autoLogin: false })).rejects.toThrow(/tipo de orden con nombre exacto "LLAMADA DE EMERGENCIA" no existe/i);
  expect(calls.some((call) => call.url.endsWith('/order-type'))).toBe(true);
  await fs.rm(fixture.directory, { recursive: true, force: true });

  const ambiguous = await requestFile(nameRequestOverrides());
  mockNameCatalogs({ orderType: [
    { _id: 'type-a', name: 'Llamada de emergencia' },
    { _id: 'type-b', description: 'LLAMADA DE EMERGENCIA' },
  ] });
  await expect(simulateOrderCreate(ambiguous.file, { autoLogin: false })).rejects.toThrow(/ambiguo.*type-a.*type-b/i);
  await fs.rm(ambiguous.directory, { recursive: true, force: true });
});

test('rejects ID and name alternatives supplied together for the same entity', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  let calls = 0;
  global.fetch = async () => { calls += 1; return response({}); };
  const cases: Array<{ overrides: Record<string, unknown>; error: RegExp }> = [
    { overrides: { customerName: 'Coopidrogas' }, error: /customerId y customerName/ },
    { overrides: { subsidiaryName: 'Cali' }, error: /subsidiaryId y subsidiaryName/ },
    { overrides: { orderTypeName: 'Emergencia' }, error: /orderTypeId y orderTypeName/ },
    { overrides: { equipmentNames: ['UMA 3'] }, error: /equipmentIds y equipmentNames/ },
    { overrides: { schedule: [{ startLocal: '2026-08-03T08:00:00', endLocal: '2026-08-03T09:00:00', technicianId: 'technician-1', technicianName: 'Heiner' }] }, error: /technicianId y technicianName/ },
  ];
  for (const entry of cases) {
    const fixture = await requestFile(entry.overrides);
    await expect(simulateOrderCreate(fixture.file, { autoLogin: false })).rejects.toThrow(entry.error);
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
  expect(calls).toBe(0);
});

test('records HTTP 500 as ambiguous with one POST and keeps its reserved receipt', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile({ status: 'approved' });
  const contract = await contractFile(fixture.directory);
  const receiptDir = path.join(fixture.directory, 'receipts');
  const calls = mockCatalogs();
  const catalogFetch = global.fetch;
  global.fetch = async (input, init) => {
    if (init?.method !== 'POST') return catalogFetch(input, init);
    calls.push({ url: String(input), method: init.method });
    return response({ error: 'synthetic server failure' }, 500);
  };

  let captured: (Error & { orderCreateAudit?: { status: string; attempt: { retryAllowed: boolean } } }) | undefined;
  try {
    await executeOrderCreate(fixture.file, { confirm: true, contractPath: contract, autoLogin: false, receiptDir });
  } catch (error) { captured = error as typeof captured; }

  expect(captured?.message).toMatch(/ambiguous; no reintentar automáticamente/i);
  expect(captured?.orderCreateAudit).toEqual(expect.objectContaining({
    status: 'ambiguous', attempt: expect.objectContaining({ retryAllowed: false }),
  }));
  expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
  const receiptFiles = await fs.readdir(receiptDir);
  expect(receiptFiles).toHaveLength(1);
  const receipt = JSON.parse(await fs.readFile(path.join(receiptDir, receiptFiles[0]!), 'utf8')) as { status: string };
  expect(receipt.status).toBe('ambiguous');
  await fs.rm(fixture.directory, { recursive: true, force: true });
});

test('keeps HTTP 400 as failed and does not retry the POST', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const fixture = await requestFile({ status: 'approved' });
  const contract = await contractFile(fixture.directory);
  const calls = mockCatalogs();
  const catalogFetch = global.fetch;
  global.fetch = async (input, init) => {
    if (init?.method !== 'POST') return catalogFetch(input, init);
    calls.push({ url: String(input), method: init.method });
    return response({ error: 'synthetic client failure' }, 400);
  };

  let captured: (Error & { orderCreateAudit?: { status: string; attempt: { retryAllowed: boolean } } }) | undefined;
  try {
    await executeOrderCreate(fixture.file, { confirm: true, contractPath: contract, autoLogin: false, receiptDir: path.join(fixture.directory, 'receipts') });
  } catch (error) { captured = error as typeof captured; }

  expect(captured?.message).toMatch(/failed; no reintentar automáticamente/i);
  expect(captured?.orderCreateAudit).toEqual(expect.objectContaining({
    status: 'failed', attempt: expect.objectContaining({ retryAllowed: false }),
  }));
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

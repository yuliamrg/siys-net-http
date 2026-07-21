import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { applyReview } from '../src/order-review.js';

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

async function fixtureFiles(status: 'draft' | 'approved' = 'draft'): Promise<{ directory: string; draft: string; contract: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-order-review-'));
  const draft = path.join(directory, 'review.json');
  const contract = path.join(directory, 'contract.json');
  await fs.writeFile(draft, JSON.stringify({
    schemaVersion: '1.0', status, order: { code: '007393' }, reviews: [{
      maintenanceId: 'maintenance-1', manualReview: false,
      original: { observations: 'Texto básico', equipmentState: 1 },
      proposed: { observations: 'Texto claro', equipmentState: 1 },
      tasks: [{ taskId: 'task-1', original: { name: 'General' }, proposed: { name: 'Tarea general' } }],
      activities: [{ taskId: 'task-1', activityId: 'activity-1', action: 'edit', original: { name: 'General', reply: 'Texto básico' }, proposed: { name: 'Mantenimiento general', reply: 'Texto claro' } }],
    }],
  }), 'utf8');
  await fs.writeFile(contract, JSON.stringify({
    schemaVersion: '1.0', enabled: true, operations: {
      maintenance: { method: 'PATCH', path: '/maintenance/{maintenanceId}', fields: { observations: { path: 'observations' }, equipmentState: { path: 'equipmentState' } } },
      task: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskId}', fields: { name: { path: 'name' } } },
      activity: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}', fields: { name: { path: 'name' }, reply: { path: 'reply' } } },
    },
  }), 'utf8');
  return { directory, draft, contract };
}

function maintenance(observations = 'Texto básico', taskName = 'General', activityName = 'General', reply = 'Texto básico'): object {
  return { _id: 'maintenance-1', observations, equipmentState: 1, tasks: [{ _id: 'task-1', name: taskName, activitys: [{ _id: 'activity-1', name: activityName, reply }] }] };
}

test('dry-run reads and detects changes without sending mutations', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await fixtureFiles(); const calls: string[] = [];
  global.fetch = async (input, init) => { calls.push(`${init?.method} ${input}`); return response(maintenance()); };
  const result = await applyReview(files.draft, { contractPath: files.contract, autoLogin: false });
  expect(result.dryRun).toBe(true); expect(result.planned).toHaveLength(4); expect(result.applied).toHaveLength(0);
  expect(calls.every((call) => call.startsWith('GET '))).toBe(true);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('requires approval and verifies every serialized update', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await fixtureFiles('approved'); let state = maintenance() as Record<string, any>; const calls: Array<{ method?: string; url: string; body?: string }> = [];
  global.fetch = async (input, init) => {
    const url = String(input); calls.push({ method: init?.method, url, body: init?.body as string | undefined });
    if (init?.method === 'GET') return response(state);
    const body = JSON.parse(String(init?.body));
    if (url.endsWith('/maintenance/maintenance-1')) state.observations = body.observations;
    else if (url.endsWith('/task/task-1/activity/activity-1')) Object.assign(state.tasks[0].activitys[0], body);
    else if (url.endsWith('/task/task-1')) Object.assign(state.tasks[0], body);
    else throw new Error(`Ruta inesperada ${url}`);
    return response({ ok: true });
  };
  const result = await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.applied).toHaveLength(4);
  expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(4);
  expect(calls.filter((call) => call.method === 'PATCH').map((call) => call.body)).toEqual([
    '{"observations":"Texto claro"}', '{"name":"Tarea general"}', '{"name":"Mantenimiento general"}', '{"reply":"Texto claro"}',
  ]);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('applies a captured equipment state with the maintenance PATCH contract', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await fixtureFiles('approved'); const draft = JSON.parse(await fs.readFile(files.draft, 'utf8'));
  draft.reviews[0].original = { equipmentState: 2 }; draft.reviews[0].proposed = { equipmentState: 3 }; draft.reviews[0].tasks = []; draft.reviews[0].activities = [];
  await fs.writeFile(files.draft, JSON.stringify(draft), 'utf8'); let state: any = maintenance(); state.equipmentState = 2; const writes: string[] = [];
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') return response(state);
    writes.push(`${init?.method} ${input} ${init?.body}`); state.equipmentState = JSON.parse(String(init?.body)).equipmentState; return response({ ok: true });
  };
  const result = await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.applied).toHaveLength(1); expect(writes).toEqual(['PATCH https://api.siys.net/api/maintenance/maintenance-1 {"equipmentState":3}']);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('blocks conflicts before it writes', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await fixtureFiles('approved'); const calls: string[] = [];
  global.fetch = async (input, init) => { calls.push(String(init?.method)); return response(maintenance('Texto editado por técnico')); };
  await expect(applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false })).rejects.toThrow(/Conflicto/);
  expect(calls).toEqual(['GET']);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('requires an explicit larger limit for a large review batch', async () => {
  const files = await fixtureFiles('approved');
  await expect(applyReview(files.draft, { contractPath: files.contract, confirm: true, maxChanges: 3, autoLogin: false }))
    .rejects.toThrow(/supera el límite de seguridad/);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('uses the field-specific correction endpoint and is safe to resume', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await fixtureFiles('approved');
  const contract = JSON.parse(await fs.readFile(files.contract, 'utf8'));
  contract.operations.activity.fields.name = {
    originalPath: 'name', verifyPath: 'nameCorrected.reply', bodyPath: 'reply',
    method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=nameCorrected',
  };
  contract.operations.activity.fields.reply = {
    originalPath: 'reply', verifyPath: 'replyCorrected.reply', bodyPath: 'reply',
    method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=replyCorrected',
  };
  await fs.writeFile(files.contract, JSON.stringify(contract), 'utf8');
  let state: any = maintenance(); const writes: string[] = [];
  global.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET') return response(state);
    writes.push(url);
    const activity = state.tasks[0].activitys[0]; const body = JSON.parse(String(init?.body));
    if (url.includes('nameCorrected')) activity.nameCorrected = { reply: body.reply };
    else if (url.includes('replyCorrected')) activity.replyCorrected = { reply: body.reply };
    else if (url.endsWith('/maintenance/maintenance-1')) state.observations = body.observations;
    else if (url.endsWith('/task/task-1')) state.tasks[0].name = body.name;
    return response({ ok: true });
  };
  const first = await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 });
  expect(first.applied).toHaveLength(4);
  expect(writes.some((url) => url.includes('field=nameCorrected'))).toBe(true);
  expect(writes.some((url) => url.includes('field=replyCorrected'))).toBe(true);
  writes.length = 0;
  const resumed = await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 });
  expect(resumed.applied).toHaveLength(0); expect(resumed.alreadyApplied).toHaveLength(4); expect(writes).toHaveLength(0);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('does not overwrite a different existing correction', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await fixtureFiles('approved');
  const contract = JSON.parse(await fs.readFile(files.contract, 'utf8'));
  contract.operations.activity.fields.name = { originalPath: 'name', verifyPath: 'nameCorrected.reply', bodyPath: 'reply' };
  await fs.writeFile(files.contract, JSON.stringify(contract), 'utf8');
  const state: any = maintenance(); state.tasks[0].activitys[0].nameCorrected = { reply: 'Corrección de otro usuario' };
  const calls: string[] = [];
  global.fetch = async (_input, init) => { calls.push(String(init?.method)); return response(state); };
  await expect(applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false })).rejects.toThrow(/corrección distinta/);
  expect(calls).toEqual(['GET']);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('permits an explicit same-text test only for a separate correction field', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await fixtureFiles('approved');
  const draft = JSON.parse(await fs.readFile(files.draft, 'utf8'));
  draft.reviews[0].original = { observations: 'Texto básico' };
  draft.reviews[0].proposed = { observations: 'Texto básico' };
  draft.reviews[0].forceApply = ['observations']; draft.reviews[0].tasks = []; draft.reviews[0].activities = [];
  await fs.writeFile(files.draft, JSON.stringify(draft), 'utf8');
  const contract = JSON.parse(await fs.readFile(files.contract, 'utf8'));
  contract.operations.maintenance.fields.observations = { originalPath: 'observations', verifyPath: 'observationsCorrected.reply', bodyPath: 'observationsCorrected.reply' };
  await fs.writeFile(files.contract, JSON.stringify(contract), 'utf8');
  const state: any = maintenance(); let writes = 0;
  global.fetch = async (_input, init) => {
    if (init?.method === 'GET') return response(state);
    writes += 1; state.observationsCorrected = JSON.parse(String(init?.body)).observationsCorrected; return response({ ok: true });
  };
  const result = await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.applied).toHaveLength(1); expect(writes).toBe(1);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('treats null and missing source text as the same empty value', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await fixtureFiles('approved');
  const draft = JSON.parse(await fs.readFile(files.draft, 'utf8'));
  draft.reviews[0].original = {}; draft.reviews[0].proposed = {}; draft.reviews[0].tasks = [];
  draft.reviews[0].activities = [{ taskId: 'task-1', activityId: 'activity-1', action: 'edit', original: { reply: null }, proposed: { reply: 'Descripción de prueba' } }];
  await fs.writeFile(files.draft, JSON.stringify(draft), 'utf8');
  const state: any = maintenance(); delete state.tasks[0].activitys[0].reply;
  global.fetch = async (_input, init) => {
    if (init?.method === 'GET') return response(state);
    state.tasks[0].activitys[0].reply = JSON.parse(String(init?.body)).reply; return response({ ok: true });
  };
  const result = await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.applied).toHaveLength(1);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('stops on a rate-limit response without retrying an ambiguous write and exposes partial progress', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await fixtureFiles('approved'); let state: any = maintenance(); let writes = 0;
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') return response(state);
    writes += 1;
    if (writes === 3) return response({ message: 'slow down' }, 429);
    const body = JSON.parse(String(init?.body)); const url = String(input);
    if (url.endsWith('/maintenance/maintenance-1')) state.observations = body.observations;
    else if (url.endsWith('/task/task-1')) state.tasks[0].name = body.name;
    return response({ ok: true });
  };
  let error: any;
  try { await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 }); }
  catch (caught) { error = caught; }
  expect(error.message).toMatch(/429/); expect(error.applyResult.applied).toHaveLength(2); expect(error.applyResult.audit.status).toBe('failed'); expect(writes).toBe(3);
  await fs.rm(files.directory, { recursive: true, force: true });
});

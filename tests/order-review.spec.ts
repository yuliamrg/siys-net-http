import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from './fixtures.js';
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
  const files = await fixtureFiles('approved'); const state = maintenance() as Record<string, any>; const calls: Array<{ method?: string; url: string; body?: string }> = [];
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
  await fs.writeFile(files.draft, JSON.stringify(draft), 'utf8'); const state: any = maintenance(); state.equipmentState = 2; const writes: string[] = [];
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
  const state: any = maintenance(); const writes: string[] = [];
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
  const files = await fixtureFiles('approved'); const state: any = maintenance(); let writes = 0;
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

async function actionFixture(operation: Record<string, unknown>, status: 'draft' | 'approved' = 'approved') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-order-actions-'));
  const draft = path.join(directory, 'review.json'); const contract = path.join(directory, 'contract.json');
  await fs.writeFile(draft, JSON.stringify({
    schemaVersion: '1.1', status, order: { code: '007257' }, reviews: [{
      maintenanceId: 'maintenance-1', original: {}, proposed: {}, operations: [operation],
    }],
  }), 'utf8');
  await fs.writeFile(contract, JSON.stringify({
    schemaVersion: '1.1', enabled: true, operations: {}, actions: {
      addActivity: {
        create: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskId}/add-activity' },
        name: { method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=nameCorrected', bodyPath: 'reply', verifyPath: 'nameCorrected.reply' },
        reply: { method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=replyCorrected', bodyPath: 'reply', verifyPath: 'replyCorrected.reply' },
      },
      addImage: {
        upload: { method: 'POST', path: '/file', folder: 'maintenance-files', miniatura: '1' },
        attach: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskIndex}/activity/{activityIndex}/add-file/{fileId}' },
      },
      setImageVisibility: {
        toggle: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskIndex}/activity/{activityIndex}/file/{fileId}/toggle-hidden' },
      },
      setActivityVisibility: {
        update: { method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=visible', bodyPath: 'visible', verifyPath: 'visible' },
      },
    },
  }), 'utf8');
  return { directory, draft, contract };
}

function actionState(): any {
  return {
    _id: 'maintenance-1',
    tasks: [
      { _id: 'other-task', activitys: [] },
      { _id: 'task-1', activitys: [
        { _id: 'other-activity', visible: true, file: [], hiddenFile: [] },
        { _id: 'activity-1', visible: true, file: [{ _id: 'file-1' }], hiddenFile: [] },
      ] },
    ],
  };
}

test('schema 1.1 creates an activity and completes its approved name and description', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await actionFixture({
    operationId: 'activity-audit-1', action: 'addActivity', taskId: 'task-1',
    original: { activityIds: ['other-activity', 'activity-1'] },
    proposed: { name: 'Validación de gestión de evidencia', reply: 'Prueba controlada.' },
  });
  const state = actionState(); const writes: Array<{ method?: string; url: string; body?: string }> = [];
  global.fetch = async (input, init) => {
    const url = String(input); if (init?.method === 'GET') return response(state);
    writes.push({ method: init?.method, url, body: init?.body as string | undefined });
    if (url.endsWith('/add-activity')) { state.tasks[1].activitys.push({ _id: 'activity-new', visible: true, file: [], hiddenFile: [] }); return response({ _id: 'activity-new' }); }
    const activity = state.tasks[1].activitys[2]; const body = JSON.parse(String(init?.body));
    if (url.includes('field=nameCorrected')) activity.nameCorrected = { reply: body.reply };
    if (url.includes('field=replyCorrected')) activity.replyCorrected = { reply: body.reply };
    return response({});
  };
  const result = await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.plannedWrites).toBe(3); expect(result.applied).toHaveLength(1);
  expect(writes.map(({ method, url, body }) => `${method} ${new URL(url).pathname}${new URL(url).search} ${body ?? ''}`)).toEqual([
    'PATCH /api/maintenance/maintenance-1/task/task-1/add-activity ',
    'PUT /api/maintenance/maintenance-1/task/task-1/activity/activity-new?field=nameCorrected {"reply":"Validación de gestión de evidencia"}',
    'PUT /api/maintenance/maintenance-1/task/task-1/activity/activity-new?field=replyCorrected {"reply":"Prueba controlada."}',
  ]);
  expect(result.steps.map((step) => step.step)).toEqual(['create', 'name', 'reply']);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('uploads and attaches an approved image using freshly resolved task and activity indices', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-image-source-')); const image = path.join(directory, 'evidence.jpg');
  await fs.writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); const sha256 = crypto.createHash('sha256').update(await fs.readFile(image)).digest('hex');
  const files = await actionFixture({
    operationId: 'image-audit-1', action: 'addImage', taskId: 'task-1', activityId: 'activity-1',
    original: { fileIds: ['file-1'] }, source: { path: image, sha256 },
  });
  const state = actionState(); const writes: Array<{ method?: string; url: string; body?: string }> = [];
  global.fetch = async (input, init) => {
    const url = String(input); if (init?.method === 'GET') return response(state);
    writes.push({ method: init?.method, url, body: init?.body as string | undefined });
    if (url.endsWith('/api/file')) return response({ _id: 'file-new' });
    state.tasks[1].activitys[1].file.push({ _id: 'file-new' }); return response({});
  };
  const result = await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.plannedWrites).toBe(2);
  expect(writes[0].method).toBe('POST'); expect(writes[0].url).toMatch(/\/api\/file$/);
  expect(JSON.parse(writes[0].body!)).toEqual({ content: '/9j/2Q==', folder: 'maintenance-files', miniatura: '1', fileName: 'evidence.jpg' });
  expect(writes[1]).toMatchObject({ method: 'PATCH' });
  expect(writes[1].url).toMatch(/\/task\/1\/activity\/1\/add-file\/file-new$/);
  await fs.rm(files.directory, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true });
});

test('exposes desired image visibility while using the SIYS toggle endpoint', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await actionFixture({
    operationId: 'image-visible-1', action: 'setImageVisibility', taskId: 'task-1', activityId: 'activity-1', fileId: 'file-1',
    original: { visible: true }, proposed: { visible: false },
  });
  const state = actionState(); const writes: string[] = [];
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') return response(state);
    writes.push(`${init?.method} ${input}`); state.tasks[1].activitys[1].hiddenFile = [{ _id: 'file-1' }]; return response({});
  };
  const result = await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.applied).toHaveLength(1);
  expect(writes).toEqual(['PATCH https://api.siys.net/api/maintenance/maintenance-1/task/1/activity/1/file/file-1/toggle-hidden']);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('sets whole-activity visibility with a boolean body and supports alreadyApplied', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await actionFixture({
    operationId: 'activity-visible-1', action: 'setActivityVisibility', taskId: 'task-1', activityId: 'activity-1',
    original: { visible: true }, proposed: { visible: false },
  });
  const state = actionState(); const writes: string[] = [];
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') return response(state);
    writes.push(`${init?.method} ${input} ${init?.body}`); state.tasks[1].activitys[1].visible = false; return response({});
  };
  const first = await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 });
  expect(first.applied).toHaveLength(1); expect(writes).toEqual(['PUT https://api.siys.net/api/maintenance/maintenance-1/task/task-1/activity/activity-1?field=visible {"visible":false}']);
  writes.length = 0;
  const second = await applyReview(files.draft, { contractPath: files.contract, autoLogin: false });
  expect(second.alreadyApplied).toHaveLength(1); expect(writes).toHaveLength(0);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('rejects changed source hashes and duplicate operation IDs before any mutation', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-image-hash-')); const image = path.join(directory, 'evidence.png'); await fs.writeFile(image, 'changed');
  const operation = { operationId: 'duplicate-op', action: 'addImage', taskId: 'task-1', activityId: 'activity-1', original: { fileIds: ['file-1'] }, source: { path: image, sha256: '0'.repeat(64) } };
  const files = await actionFixture(operation);
  global.fetch = async () => response(actionState());
  await expect(applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false })).rejects.toThrow(/SHA-256/);
  const draft = JSON.parse(await fs.readFile(files.draft, 'utf8')); draft.reviews[0].operations.push(operation); await fs.writeFile(files.draft, JSON.stringify(draft), 'utf8');
  await expect(applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false })).rejects.toThrow(/operationId duplicado/);
  await fs.rm(files.directory, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true });
});

test('resumes addActivity after creation without creating a duplicate activity', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await actionFixture({
    operationId: 'resume-activity-1', action: 'addActivity', taskId: 'task-1',
    original: { activityIds: ['other-activity', 'activity-1'] }, proposed: { name: 'Actividad auditada', reply: 'Descripción auditada' },
  });
  const state = actionState(); let creates = 0; let failProgress = true;
  global.fetch = async (input, init) => {
    const url = String(input); if (init?.method === 'GET') return response(state);
    if (url.endsWith('/add-activity')) { creates += 1; state.tasks[1].activitys.push({ _id: 'activity-resumed', visible: true, file: [], hiddenFile: [] }); return response({ _id: 'activity-resumed' }); }
    const body = JSON.parse(String(init?.body)); const activity = state.tasks[1].activitys[2];
    if (url.includes('nameCorrected')) activity.nameCorrected = { reply: body.reply };
    if (url.includes('replyCorrected')) activity.replyCorrected = { reply: body.reply };
    return response({});
  };
  let firstError: any;
  try {
    await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0, onProgress: async (result) => {
      if (failProgress && result.steps.some((step) => step.step === 'create')) { failProgress = false; throw new Error('corte simulado'); }
    } });
  } catch (error) { firstError = error; }
  const audit = path.join(files.directory, 'partial-audit.json'); await fs.writeFile(audit, JSON.stringify(firstError.applyResult), 'utf8');
  const resumed = await applyReview(files.draft, { contractPath: files.contract, resumeAuditPath: audit, confirm: true, autoLogin: false, delayMs: 0 });
  expect(creates).toBe(1); expect(resumed.applied).toHaveLength(1);
  expect(state.tasks[1].activitys[2]).toMatchObject({ nameCorrected: { reply: 'Actividad auditada' }, replyCorrected: { reply: 'Descripción auditada' } });
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plans multiple schema 1.1 operations and counts their underlying writes', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-multi-actions-')); const image = path.join(directory, 'evidence.gif'); await fs.writeFile(image, 'GIF89a');
  const sha256 = crypto.createHash('sha256').update(await fs.readFile(image)).digest('hex');
  const files = await actionFixture({
    operationId: 'multi-add-activity', action: 'addActivity', taskId: 'task-1', original: { activityIds: ['other-activity', 'activity-1'] }, proposed: { name: 'Nueva', reply: 'Descripción' },
  }, 'draft');
  const draft = JSON.parse(await fs.readFile(files.draft, 'utf8'));
  draft.reviews[0].operations.push(
    { operationId: 'multi-add-image', action: 'addImage', taskId: 'task-1', activityId: 'activity-1', original: { fileIds: ['file-1'] }, source: { path: image, sha256 } },
    { operationId: 'multi-image-visible', action: 'setImageVisibility', taskId: 'task-1', activityId: 'activity-1', fileId: 'file-1', original: { visible: true }, proposed: { visible: false } },
    { operationId: 'multi-activity-visible', action: 'setActivityVisibility', taskId: 'task-1', activityId: 'activity-1', original: { visible: true }, proposed: { visible: false } },
  );
  await fs.writeFile(files.draft, JSON.stringify(draft), 'utf8'); const methods: string[] = [];
  global.fetch = async (_input, init) => { methods.push(String(init?.method)); return response(actionState()); };
  const result = await applyReview(files.draft, { contractPath: files.contract, autoLogin: false });
  expect(result.planned).toHaveLength(4); expect(result.plannedWrites).toBe(7); expect(methods).toEqual(['GET']);
  await fs.rm(files.directory, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true });
});

test('re-reads once after an ambiguous visibility timeout and does not retry the write', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await actionFixture({
    operationId: 'timeout-visible-1', action: 'setActivityVisibility', taskId: 'task-1', activityId: 'activity-1',
    original: { visible: true }, proposed: { visible: false },
  });
  const state = actionState(); let writes = 0;
  global.fetch = async (_input, init) => {
    if (init?.method === 'GET') return response(state);
    writes += 1; state.tasks[1].activitys[1].visible = false;
    throw new Error('Tiempo de espera al escribir PUT /maintenance/test. No se reintentó: verifica la orden antes de continuar.');
  };
  const result = await applyReview(files.draft, { contractPath: files.contract, confirm: true, autoLogin: false, delayMs: 0 });
  expect(writes).toBe(1); expect(result.applied).toHaveLength(1); expect(result.audit.status).toBe('completed');
  await fs.rm(files.directory, { recursive: true, force: true });
});

const CONTRACT_12 = {
  schemaVersion: '1.2', enabled: true,
  operations: {
    task: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskId}', fields: { name: { path: 'name' } } },
  },
  actions: {
    addActivity: {
      create: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskId}/add-activity' },
      name: { method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=nameCorrected', bodyPath: 'reply', verifyPath: 'nameCorrected.reply' },
      reply: { method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=replyCorrected', bodyPath: 'reply', verifyPath: 'replyCorrected.reply' },
    },
    addImage: {
      upload: { method: 'POST', path: '/file', folder: 'maintenance-files', miniatura: '1' },
      attach: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskIndex}/activity/{activityIndex}/add-file/{fileId}' },
    },
    addTaskGeneral: { create: { method: 'POST', path: '/maintenance/{maintenanceId}/add-task-general', response: 'text' } },
    ensureEquipmentMaintenance: {
      linkEquipment: { method: 'PUT', path: '/order/{orderId}' },
      createMaintenance: { method: 'POST', path: '/maintenance/empty' },
    },
    finalizeOrder: {
      update: { method: 'PUT', path: '/order/{orderId}' },
    },
  },
};

async function writeFiles(draft: unknown, contract: unknown): Promise<{ directory: string; draftPath: string; contractPath: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-order-12-'));
  const draftPath = path.join(directory, 'review.json'); const contractPath = path.join(directory, 'contract.json');
  await fs.writeFile(draftPath, JSON.stringify(draft), 'utf8'); await fs.writeFile(contractPath, JSON.stringify(contract), 'utf8');
  return { directory, draftPath, contractPath };
}

function textResponse(body: string, status = 200): Response { return new Response(body, { status, headers: { 'content-type': 'text/plain' } }); }
function orderResponse(order: unknown): Response { return response({ doc: order }); }
function link(maintenanceId: string, equipmentId: string): Record<string, unknown> {
  return { _id: `link-${maintenanceId}-${equipmentId}`, maintenance: { _id: maintenanceId }, equipment: { _id: equipmentId } };
}
function baseOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { _id: 'order-1', code: '007644', material: 'M', equipments: [], maintenances: [], ...overrides };
}
function formReadyOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return baseOrder({
    type: { _id: 'type-live' }, customer: { _id: 'customer-live' }, subsidiary: { _id: 'subsidiary-live' },
    observations: 'Observación viva', users: [{ _id: 'user-live' }],
    dates: [{ _id: 'date-live', date: '2026-01-01', start: '08:00', end: '10:00', users: [{ _id: 'tech-live' }] }],
    ...overrides,
  });
}
const ENSURE_OP = {
  operationId: 'op-ensure', action: 'ensureEquipmentMaintenance', equipmentId: 'eq-1',
  maintenance: { user: 'user-1', equipmentState: 2, start: '2026-01-01T08:00:00', end: '2026-01-01T09:00:00' },
};
function ensureDraft(order: Record<string, unknown>, operations: unknown[]): Record<string, unknown> {
  return { schemaVersion: '1.2', status: 'approved', order, reviews: [{ original: {}, proposed: {}, operations }] };
}
function task12Draft(order: Record<string, unknown>, operations: unknown[]): Record<string, unknown> {
  return { schemaVersion: '1.2', status: 'approved', order, reviews: [{ original: {}, proposed: {}, operations }] };
}

test('schema 1.0 remains valid and unchanged', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await fixtureFiles('draft'); global.fetch = async () => response(maintenance());
  const result = await applyReview(files.draft, { contractPath: files.contract, autoLogin: false });
  expect(result.planned).toHaveLength(4); expect(result.plannedWrites).toBe(4);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('schema 1.1 remains valid', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await actionFixture({ operationId: 'keep-11', action: 'addActivity', taskId: 'task-1', original: { activityIds: ['other-activity', 'activity-1'] }, proposed: { name: 'N', reply: 'D' } }, 'draft');
  global.fetch = async () => response(actionState());
  const result = await applyReview(files.draft, { contractPath: files.contract, autoLogin: false });
  expect(result.planned).toHaveLength(1); expect(result.plannedWrites).toBe(3);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('schema 1.1 contract rejects the 1.2 actions', async () => {
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [ENSURE_OP]), {
    schemaVersion: '1.1', enabled: true, operations: {},
    actions: { ensureEquipmentMaintenance: { linkEquipment: { method: 'PUT', path: '/order/{orderId}' }, createMaintenance: { method: 'POST', path: '/maintenance/empty' } } },
  });
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, autoLogin: false })).rejects.toThrow(/schemaVersion "1\.2"/);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('a 1.1 draft rejects the 1.2 actions instead of reinterpreting them', async () => {
  const draft: any = ensureDraft({ code: '007644', orderId: 'order-1' }, [ENSURE_OP]);
  draft.schemaVersion = '1.1'; draft.reviews[0].maintenanceId = 'source-m';
  const files = await writeFiles(draft, CONTRACT_12);
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, autoLogin: false })).rejects.toThrow(/schemaVersion "1\.2"/);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('schema 1.1 still requires reviews[].maintenanceId', async () => {
  const files = await writeFiles({ schemaVersion: '1.1', status: 'approved', order: { code: '007644' }, reviews: [{ original: {}, proposed: {} }] }, CONTRACT_12);
  let requests = 0; global.fetch = async () => { requests += 1; return response({}); };
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, autoLogin: false })).rejects.toThrow(/maintenanceId/);
  expect(requests).toBe(0);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('schema 1.2 sin maintenanceId rechaza ediciones legacy antes de escribir', async () => {
  const files = await writeFiles({
    schemaVersion: '1.2', status: 'approved', order: { code: '007644' }, reviews: [{
      original: { observations: 'Anterior' }, proposed: { observations: 'Corregida' },
      tasks: [{ taskId: 'task-1', original: { name: 'General' }, proposed: { name: 'Tarea corregida' } }],
      activities: [{ taskId: 'task-1', activityId: 'activity-1', action: 'edit', original: { reply: 'Anterior' }, proposed: { reply: 'Corregida' } }],
    }],
  }, CONTRACT_12);
  let requests = 0; global.fetch = async () => { requests += 1; return response({}); };
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, autoLogin: false })).rejects.toThrow(/sin maintenanceId.*ediciones legacy/);
  expect(requests).toBe(0);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('rejects a forward reference before any write', async () => {
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [
    { operationId: 'op-task', action: 'addTaskGeneral', maintenanceRef: 'op-ensure' },
    ENSURE_OP,
  ]), CONTRACT_12);
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, autoLogin: false })).rejects.toThrow(/no aparece antes/);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('rejects declaring an id and a ref for the same entity', async () => {
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [
    ENSURE_OP,
    { operationId: 'op-task', action: 'addTaskGeneral', maintenanceId: 'm-1', maintenanceRef: 'op-ensure' },
  ]), CONTRACT_12);
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, autoLogin: false })).rejects.toThrow(/no puede declarar/);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('rejects a ref whose produced type does not match', async () => {
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [
    ENSURE_OP,
    { operationId: 'op-task', action: 'addTaskGeneral', taskRef: 'op-ensure' },
  ]), CONTRACT_12);
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, autoLogin: false })).rejects.toThrow(/produce maintenance/);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('schema 1.2 sin maintenanceId resuelve ensure→task mediante maintenanceRef', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order = formReadyOrder({ equipments: [{ _id: 'eq-1' }], maintenances: [link('m-existing', 'eq-1')] });
  const maintenance12: any = { _id: 'm-existing', tasks: [] };
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [
    ENSURE_OP,
    { operationId: 'op-task', action: 'addTaskGeneral', maintenanceRef: 'op-ensure' },
  ]), CONTRACT_12);
  let posts = 0;
  global.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET' && url.includes('/api/order/order-1/detail')) return orderResponse(order);
    if (init?.method === 'GET' && url.includes('/api/maintenance/m-existing/detail')) return response(maintenance12);
    if (init?.method === 'POST' && url.endsWith('/api/maintenance/m-existing/add-task-general')) {
      posts += 1; maintenance12.tasks.push({ _id: 'task-new', name: 'General', activitys: [] }); return textResponse('ok');
    }
    throw new Error(`Ruta inesperada ${url}`);
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  const savedDraft = JSON.parse(await fs.readFile(files.draftPath, 'utf8')) as { reviews: Array<Record<string, unknown>> };
  expect(Object.hasOwn(savedDraft.reviews[0], 'maintenanceId')).toBe(false);
  expect(posts).toBe(1); expect(result.plannedWrites).toBe(1); expect(result.applied).toHaveLength(1);
  expect(result.steps.map((step) => `${step.step}:${step.status}`)).toEqual(['ensure:alreadyApplied', 'create:completed', 'task:completed']);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('exige order.orderId para ensureEquipmentMaintenance', async () => {
  const files = await writeFiles(ensureDraft({ code: '007644' }, [ENSURE_OP]), CONTRACT_12);
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false })).rejects.toThrow(/orderId/);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla A: equipo ya con mantenimiento produce cero escrituras', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order = baseOrder({ equipments: ['eq-1'], maintenances: [link('m-1', 'eq-1')] });
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [ENSURE_OP]), CONTRACT_12);
  const calls: string[] = [];
  global.fetch = async (input, init) => { calls.push(String(init?.method)); return orderResponse(order); };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, autoLogin: false });
  expect(result.plannedWrites).toBe(0); expect(result.alreadyApplied).toHaveLength(1); expect(result.planned).toHaveLength(0);
  expect(calls.every((method) => method === 'GET')).toBe(true);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla B: equipo en la orden sin mantenimiento solo hace POST', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order = baseOrder({ equipments: ['eq-1'], maintenances: [] });
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [ENSURE_OP]), CONTRACT_12);
  const writes: Array<{ method?: string; url: string; body?: string }> = [];
  global.fetch = async (input, init) => {
    const url = String(input); if (init?.method === 'GET') return orderResponse(order);
    writes.push({ method: init?.method, url, body: init?.body as string });
    if (url.endsWith('/api/maintenance/empty')) { order.maintenances = [link('m-2', 'eq-1')]; return response({ _id: 'm-2' }); }
    throw new Error(`Ruta inesperada ${url}`);
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.plannedWrites).toBe(1); expect(writes).toHaveLength(1); expect(writes[0].method).toBe('POST');
  expect(JSON.parse(writes[0].body!)).toEqual({ equipment: 'eq-1', order: 'order-1', preview: false, user: 'user-1', equipmentState: 2, start: '2026-01-01T08:00:00', end: '2026-01-01T09:00:00' });
  expect(result.steps.map((step) => `${step.step}:${step.status}`)).toEqual(['createMaintenance:completed', 'ensure:completed']);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla C: equipo faltante hace PUT de la orden y POST del mantenimiento', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const staleOrder = formReadyOrder({
    type: { _id: 'type-stale' }, customer: { _id: 'customer-stale' }, subsidiary: { _id: 'subsidiary-stale' },
    material: 'Material vivo', observations: 'Observación anterior', users: [{ _id: 'user-stale' }],
    dates: [{ _id: 'date-stale', date: '2025-12-31', start: '07:00', end: '08:00', users: [{ _id: 'tech-stale' }] }],
    equipments: [{ _id: 'eq-existing' }], maintenances: [],
  });
  const order: any = formReadyOrder({
    type: { _id: 'type-live' }, customer: { _id: 'customer-live' }, subsidiary: { _id: 'subsidiary-live' },
    material: 'Material vivo', observations: 'Observación viva', users: [{ _id: 'user-live-1' }, { _id: 'user-live-2' }],
    dates: [{ _id: 'date-live', date: '2026-01-01', start: '08:00', end: '10:00', users: [{ _id: 'tech-live-1' }, { _id: 'tech-live-2' }] }],
    equipments: [{ _id: 'eq-existing' }], maintenances: [],
  });
  const expectedLiveFields = {
    type: 'type-live', customer: 'customer-live', subsidiary: 'subsidiary-live', material: 'Material vivo',
    observations: 'Observación viva', users: ['user-live-1', 'user-live-2'],
    dates: [{ _id: 'date-live', date: '2026-01-01', start: '08:00', end: '10:00', users: ['tech-live-1', 'tech-live-2'] }],
    equipments: ['eq-existing'],
  };
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1', approved: { material: 'Material vivo' } }, [ENSURE_OP]), CONTRACT_12);
  const writes: Array<{ method: string; body: Record<string, unknown> }> = []; let orderReads = 0;
  global.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET') { orderReads += 1; return orderResponse(orderReads <= 2 ? staleOrder : order); }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; writes.push({ method: String(init?.method), body });
    if (url.endsWith('/api/order/order-1')) {
      if (Object.keys(body).length === 1 && Object.hasOwn(body, 'equipments')) throw new Error('PUT parcial rechazado por el mock del formulario.');
      Object.assign(order, body); return response({ ok: true });
    }
    if (url.endsWith('/api/maintenance/empty')) { order.maintenances = [link('m-2', 'eq-1')]; return response({ _id: 'm-2' }); }
    throw new Error(`Ruta inesperada ${url}`);
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  const putBody = writes[0].body;
  expect(Object.keys(putBody).sort()).toEqual(['type', 'customer', 'subsidiary', 'material', 'observations', 'users', 'dates', 'equipments'].sort());
  expect(putBody).toEqual({ ...expectedLiveFields, equipments: ['eq-existing', 'eq-1'] });
  const { equipments: changedEquipments, ...afterFields } = putBody;
  const { equipments: originalEquipments, ...beforeFields } = expectedLiveFields;
  expect(afterFields).toEqual(beforeFields);
  expect(changedEquipments).toEqual([...originalEquipments, 'eq-1']);
  expect((changedEquipments as string[]).filter((id) => id === 'eq-1')).toHaveLength(1);
  expect(writes.map((write) => write.method)).toEqual(['PUT', 'POST']);
  expect(result.plannedWrites).toBe(2); expect(order.equipments.filter((id: string) => id === 'eq-1')).toHaveLength(1);
  expect(result.applied).toHaveLength(1);
  expect(result.steps.map((step) => `${step.step}:${step.status}`)).toEqual(['equipmentLink:completed', 'createMaintenance:completed', 'ensure:completed']);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla C bloquea el PUT si un campo obligatorio no tiene ID resoluble', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order = formReadyOrder({ customer: { name: 'Cliente sin ID' }, equipments: [], maintenances: [] });
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1', approved: {} }, [ENSURE_OP]), CONTRACT_12);
  let writes = 0;
  global.fetch = async (_input, init) => {
    if (init?.method !== 'GET') writes += 1;
    return orderResponse(order);
  };
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 })).rejects.toThrow(/customer no contiene un ID inequívoco/);
  expect(writes).toBe(0);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla 1.2: un cambio concurrente en campo protegido evita el PUT', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order = baseOrder({ equipments: [], maintenances: [], material: 'Cambiado por otro' });
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1', approved: { material: 'M' } }, [ENSURE_OP]), CONTRACT_12);
  const calls: string[] = [];
  global.fetch = async (input, init) => { calls.push(String(init?.method)); return orderResponse(order); };
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false })).rejects.toThrow(/campo protegido material/);
  expect(calls.every((method) => method === 'GET')).toBe(true);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla 1.2: un 500 al crear mantenimiento se reconcilia por relectura sin reintentar', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order = baseOrder({ equipments: ['eq-1'], maintenances: [] });
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [ENSURE_OP]), CONTRACT_12);
  let posts = 0;
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') return orderResponse(order);
    posts += 1; order.maintenances = [link('m-2', 'eq-1')]; return response({ message: 'boom' }, 500);
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(posts).toBe(1); expect(result.audit.status).toBe('completed'); expect(result.applied).toHaveLength(1);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla 1.2: un 500 sin persistencia no reintenta y queda ambiguo', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order = baseOrder({ equipments: ['eq-1'], maintenances: [] });
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [ENSURE_OP]), CONTRACT_12);
  let posts = 0;
  global.fetch = async (input, init) => { if (init?.method === 'GET') return orderResponse(order); posts += 1; return response({ message: 'boom' }, 500); };
  let error: any;
  try { await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 }); }
  catch (caught) { error = caught; }
  expect(posts).toBe(1); expect(error.applyResult.audit.status).toBe('ambiguous');
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla 1.2: add-task-general acepta texto ok y verifica la tarea', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const maintenance12: any = { _id: 'm-1', tasks: [] };
  const files = await writeFiles(task12Draft({ code: '007644' }, [{ operationId: 'op-task', action: 'addTaskGeneral', maintenanceId: 'm-1' }]), CONTRACT_12);
  let posts = 0;
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') return response(maintenance12);
    posts += 1; maintenance12.tasks.push({ _id: 'task-new', name: 'General', activitys: [] }); return textResponse('ok');
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(posts).toBe(1); expect(result.plannedWrites).toBe(1); expect(result.applied).toHaveLength(1);
  expect(result.steps.map((step) => `${step.step}:${step.status}`)).toEqual(['create:completed', 'task:completed']);
  expect(result.steps.find((step) => step.step === 'task')?.taskId).toBe('task-new');
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla 1.2: timeout de add-task-general se reconcilia por relectura', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const maintenance12: any = { _id: 'm-1', tasks: [] };
  const files = await writeFiles(task12Draft({ code: '007644' }, [{ operationId: 'op-task', action: 'addTaskGeneral', maintenanceId: 'm-1' }]), CONTRACT_12);
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') return response(maintenance12);
    maintenance12.tasks.push({ _id: 'task-new', name: 'General', activitys: [] });
    throw new Error('Tiempo de espera al escribir POST /maintenance/m-1/add-task-general. No se reintentó: verifica la orden antes de continuar.');
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.applied).toHaveLength(1); expect(result.audit.status).toBe('completed');
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla 1.2: tareas existentes sin coincidencia bloquean add-task-general', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const maintenance12: any = { _id: 'm-1', tasks: [{ _id: 't1', name: 'Otra tarea', activitys: [] }] };
  const files = await writeFiles(task12Draft({ code: '007644' }, [{ operationId: 'op-task', action: 'addTaskGeneral', maintenanceId: 'm-1' }]), CONTRACT_12);
  let posts = 0;
  global.fetch = async (input, init) => { if (init?.method === 'GET') return response(maintenance12); posts += 1; return textResponse('ok'); };
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false })).rejects.toThrow(/generic_task_create_not_supported/);
  expect(posts).toBe(0);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla 1.2: una tarea equivalente ya aplicada no escribe', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const maintenance12: any = { _id: 'm-1', tasks: [{ _id: 't1', name: 'General', activitys: [] }] };
  const files = await writeFiles(task12Draft({ code: '007644' }, [{ operationId: 'op-task', action: 'addTaskGeneral', maintenanceId: 'm-1' }]), CONTRACT_12);
  global.fetch = async () => response(maintenance12);
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.plannedWrites).toBe(0); expect(result.applied).toHaveLength(0); expect(result.alreadyApplied).toHaveLength(1);
  expect(result.steps.find((step) => step.step === 'task')?.taskId).toBe('t1');
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla 1.2: una carrera externa antes del PATCH de addActivity no escribe', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const maintenance12: any = { _id: 'm-1', tasks: [{ _id: 'task-1', activitys: [{ _id: 'a1', name: '', reply: '', file: [], hiddenFile: [] }] }] };
  const files = await writeFiles(task12Draft({ code: '007644' }, [{ operationId: 'op-activity', action: 'addActivity', maintenanceId: 'm-1', taskId: 'task-1', original: { activityIds: ['a1'] }, proposed: { name: 'Nueva', reply: 'Descripción' } }]), CONTRACT_12);
  let gets = 0; let patches = 0;
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') { gets += 1; if (gets === 2) maintenance12.tasks[0].activitys.push({ _id: 'external', name: 'De otro usuario', reply: 'Cambio externo' }); return response(maintenance12); }
    patches += 1; return response({ _id: 'a-new' });
  };
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 })).rejects.toThrow(/Conflicto/);
  expect(patches).toBe(0);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla 1.2: cadena ensure→task→activity→image con refs', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-chain-')); const image = path.join(directory, 'evidence.jpg');
  await fs.writeFile(image, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); const sha256 = crypto.createHash('sha256').update(await fs.readFile(image)).digest('hex');
  const order: any = formReadyOrder({ equipments: [{ _id: 'eq-0' }], maintenances: [], material: 'M' });
  const maintenance12: any = { _id: 'm-2', tasks: [] };
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1', approved: { material: 'M' } }, [
    ENSURE_OP,
    { operationId: 'op-task', action: 'addTaskGeneral', maintenanceRef: 'op-ensure' },
    { operationId: 'op-activity', action: 'addActivity', maintenanceRef: 'op-ensure', taskRef: 'op-task', original: { activityIds: [] }, proposed: { name: 'Nueva', reply: 'Descripción' } },
    { operationId: 'op-image', action: 'addImage', maintenanceRef: 'op-ensure', taskRef: 'op-task', activityRef: 'op-activity', original: { fileIds: [] }, source: { path: image, sha256 } },
  ]), CONTRACT_12);
  global.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET' && url.includes('/api/order/order-1/detail')) return orderResponse(order);
    if (init?.method === 'GET' && url.includes('/api/maintenance/m-2/detail')) return response(maintenance12);
    if (init?.method === 'PUT' && url.endsWith('/api/order/order-1')) { order.equipments = JSON.parse(String(init?.body)).equipments; return response({ ok: true }); }
    if (init?.method === 'POST' && url.endsWith('/api/maintenance/empty')) { order.maintenances = [link('m-2', 'eq-1')]; return response({ _id: 'm-2' }); }
    if (init?.method === 'POST' && url.endsWith('/api/maintenance/m-2/add-task-general')) { maintenance12.tasks.push({ _id: 't-2', name: 'General', activitys: [] }); return textResponse('ok'); }
    if (init?.method === 'PATCH' && url.endsWith('/add-activity')) { maintenance12.tasks[0].activitys.push({ _id: 'a-2', name: '', reply: '', file: [], hiddenFile: [] }); return response({ _id: 'a-2' }); }
    const activity = maintenance12.tasks[0]?.activitys?.[0];
    if (init?.method === 'PUT' && url.includes('field=nameCorrected')) { activity.nameCorrected = { reply: JSON.parse(String(init.body)).reply }; return response({}); }
    if (init?.method === 'PUT' && url.includes('field=replyCorrected')) { activity.replyCorrected = { reply: JSON.parse(String(init.body)).reply }; return response({}); }
    if (init?.method === 'POST' && url.endsWith('/api/file')) return response({ _id: 'file-2' });
    if (init?.method === 'PATCH' && url.includes('/add-file/file-2')) { activity.file.push({ _id: 'file-2' }); return response({}); }
    throw new Error(`Ruta inesperada ${url}`);
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.plannedWrites).toBe(8); expect(result.applied).toHaveLength(4); expect(result.audit.status).toBe('completed');
  expect(maintenance12.tasks[0].name).toBe('General');
  expect(maintenance12.tasks[0].activitys[0]).toMatchObject({ nameCorrected: { reply: 'Nueva' }, replyCorrected: { reply: 'Descripción' } });
  expect(maintenance12.tasks[0].activitys[0].file).toEqual([{ _id: 'file-2' }]);
  await fs.rm(files.directory, { recursive: true, force: true }); await fs.rm(directory, { recursive: true, force: true });
});

test('plantilla 1.2: reanudar conserva los IDs producidos por ensure', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order: any = formReadyOrder({ equipments: [{ _id: 'eq-0' }], maintenances: [], material: 'M' });
  const maintenance12: any = { _id: 'm-2', tasks: [] };
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1', approved: { material: 'M' } }, [
    ENSURE_OP,
    { operationId: 'op-task', action: 'addTaskGeneral', maintenanceRef: 'op-ensure' },
  ]), CONTRACT_12);
  let posts = 0;
  global.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET' && url.includes('/api/order/order-1/detail')) return orderResponse(order);
    if (init?.method === 'GET' && url.includes('/api/maintenance/m-2/detail')) return response(maintenance12);
    if (init?.method === 'PUT' && url.endsWith('/api/order/order-1')) { order.equipments = JSON.parse(String(init?.body)).equipments; return response({ ok: true }); }
    if (init?.method === 'POST' && url.endsWith('/api/maintenance/empty')) { posts += 1; order.maintenances = [link('m-2', 'eq-1')]; return response({ _id: 'm-2' }); }
    if (init?.method === 'POST' && url.endsWith('/api/maintenance/m-2/add-task-general')) { maintenance12.tasks.push({ _id: 't-2', name: 'General', activitys: [] }); return textResponse('ok'); }
    throw new Error(`Ruta inesperada ${url}`);
  };
  let error: any; let interrupted = false;
  try {
    await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0, onProgress: async (partial) => {
      if (!interrupted && partial.steps.some((step) => step.operationId === 'op-ensure' && step.step === 'ensure')) { interrupted = true; throw new Error('corte simulado'); }
    } });
  } catch (caught) { error = caught; }
  const audit = path.join(files.directory, 'partial.json'); await fs.writeFile(audit, JSON.stringify(error.applyResult), 'utf8');
  const resumed = await applyReview(files.draftPath, { contractPath: files.contractPath, resumeAuditPath: audit, confirm: true, autoLogin: false, delayMs: 0 });
  expect(posts).toBe(1); expect(resumed.applied).toHaveLength(1); expect(maintenance12.tasks[0]._id).toBe('t-2');
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla 1.2: plannedWrites refleja cada estado simulado', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const scenarios: Array<{ order: any; approved?: any; expected: number }> = [
    { order: baseOrder({ equipments: ['eq-1'], maintenances: [link('m-1', 'eq-1')] }), expected: 0 },
    { order: baseOrder({ equipments: ['eq-1'], maintenances: [] }), expected: 1 },
    { order: baseOrder({ equipments: [], maintenances: [], material: 'M' }), approved: { material: 'M' }, expected: 2 },
  ];
  for (const scenario of scenarios) {
    const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1', ...(scenario.approved ? { approved: scenario.approved } : {}) }, [ENSURE_OP]), CONTRACT_12);
    global.fetch = async () => orderResponse(scenario.order);
    const result = await applyReview(files.draftPath, { contractPath: files.contractPath, autoLogin: false });
    expect(result.plannedWrites).toBe(scenario.expected);
    await fs.rm(files.directory, { recursive: true, force: true });
  }
});

test('plantilla D: un equipo duplicado bloquea sin escribir', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order = baseOrder({ equipments: ['eq-1', 'eq-1'], maintenances: [] });
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1', approved: { material: 'M' } }, [ENSURE_OP]), CONTRACT_12);
  const calls: string[] = [];
  global.fetch = async (input, init) => { calls.push(String(init?.method)); return orderResponse(order); };
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false })).rejects.toThrow(/Bloqueado/);
  expect(calls.every((method) => method === 'GET')).toBe(true);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('plantilla 1.2: addImage reutiliza un fileId existente sin subir el binario', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const maintenance12: any = { _id: 'm-1', tasks: [{ _id: 'task-1', activitys: [{ _id: 'activity-1', name: '', reply: '', file: [{ _id: 'file-1' }], hiddenFile: [] }] }] };
  const files = await writeFiles(task12Draft({ code: '007644' }, [
    { operationId: 'op-attach', action: 'addImage', maintenanceId: 'm-1', taskId: 'task-1', activityId: 'activity-1', fileId: 'file-existing', original: { fileIds: ['file-1'] } },
  ]), CONTRACT_12);
  const writes: string[] = [];
  global.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET') return response(maintenance12);
    writes.push(`${init?.method} ${url}`);
    if (url.includes('/add-file/file-existing')) { maintenance12.tasks[0].activitys[0].file.push({ _id: 'file-existing' }); return response({}); }
    throw new Error(`Ruta inesperada ${url}`);
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.plannedWrites).toBe(1); expect(result.applied).toHaveLength(1);
  expect(writes).toHaveLength(1); expect(writes[0]).toContain('PATCH'); expect(writes[0]).toContain('/add-file/file-existing');
  expect(maintenance12.tasks[0].activitys[0].file).toEqual([{ _id: 'file-1' }, { _id: 'file-existing' }]);
  await fs.rm(files.directory, { recursive: true, force: true });
});

function finalizeDraft(order: Record<string, unknown>): Record<string, unknown> {
  return { schemaVersion: '1.2', status: 'approved', order, reviews: [{ original: {}, proposed: {}, operations: [{ operationId: 'op-finalize', action: 'finalizeOrder' }] }] };
}

test('normaliza dates[].user y dates[].users sin alterar start ni end', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order: any = formReadyOrder({
    equipments: [{ _id: 'eq-existing' }], maintenances: [],
    dates: [
      { _id: 'd1', date: '2026-01-01', start: '08:00', end: '10:00', user: { _id: 'tech-user' }, users: [{ _id: 'tech-a' }, { _id: 'tech-b' }] },
      { _id: 'd2', date: '2026-01-02', start: '11:00', end: '12:00', user: 'tech-string' },
    ],
  });
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1', approved: { material: 'M' } }, [ENSURE_OP]), CONTRACT_12);
  const writes: Array<{ method?: string; url: string; body?: string }> = [];
  global.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET') return orderResponse(order);
    writes.push({ method: init?.method, url, body: init?.body as string });
    if (url.endsWith('/api/order/order-1')) { Object.assign(order, JSON.parse(String(init?.body))); return response({ ok: true }); }
    if (url.endsWith('/api/maintenance/empty')) { order.maintenances = [link('m-2', 'eq-1')]; return response({ _id: 'm-2' }); }
    throw new Error(`Ruta inesperada ${url}`);
  };
  await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  const put = JSON.parse(writes.find((write) => write.method === 'PUT')!.body!) as { dates: unknown[] };
  expect(put.dates).toEqual([
    { _id: 'd1', date: '2026-01-01', start: '08:00', end: '10:00', user: 'tech-user', users: ['tech-a', 'tech-b'] },
    { _id: 'd2', date: '2026-01-02', start: '11:00', end: '12:00', user: 'tech-string' },
  ]);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('finalizeOrder: state 2 en dry-run cuenta una escritura y no envía PUT', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order = baseOrder({ state: 2, close: false });
  const files = await writeFiles(finalizeDraft({ code: '007644', orderId: 'order-1' }), CONTRACT_12);
  const methods: string[] = [];
  global.fetch = async (input, init) => { methods.push(String(init?.method)); return orderResponse(order); };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, autoLogin: false });
  expect(result.plannedWrites).toBe(1); expect(result.planned).toHaveLength(1); expect(result.applied).toHaveLength(0);
  expect(methods.every((method) => method === 'GET')).toBe(true);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('finalizeOrder: state 2 confirmado envía un único PUT {"state":3} y verifica', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order: any = baseOrder({ state: 2, close: false });
  const files = await writeFiles(finalizeDraft({ code: '007644', orderId: 'order-1' }), CONTRACT_12);
  const writes: Array<{ method?: string; url: string; body?: string }> = [];
  global.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET') return orderResponse(order);
    writes.push({ method: init?.method, url, body: init?.body as string });
    if (url.endsWith('/api/order/order-1')) { order.state = JSON.parse(String(init?.body)).state; return response({ ok: true }); }
    throw new Error(`Ruta inesperada ${url}`);
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(writes).toHaveLength(1); expect(writes[0].method).toBe('PUT'); expect(writes[0].body).toBe('{"state":3}');
  expect(order.state).toBe(3); expect(result.applied).toHaveLength(1); expect(result.audit.status).toBe('completed');
  expect(result.steps.at(-1)).toMatchObject({ operationId: 'op-finalize', step: 'finalize', status: 'completed', stateBefore: 2, stateAfter: 3, closeBefore: false, closeAfter: false });
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('finalizeOrder: state 3 queda alreadyApplied sin escribir', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order = baseOrder({ state: 3, close: false });
  const files = await writeFiles(finalizeDraft({ code: '007644', orderId: 'order-1' }), CONTRACT_12);
  const methods: string[] = [];
  global.fetch = async (input, init) => { methods.push(String(init?.method)); return orderResponse(order); };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.plannedWrites).toBe(0); expect(result.applied).toHaveLength(0); expect(result.alreadyApplied).toHaveLength(1);
  expect(methods.every((method) => method === 'GET')).toBe(true);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('finalizeOrder: rechaza si hay una mutación posterior antes de cualquier HTTP', async () => {
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [
    { operationId: 'op-finalize', action: 'finalizeOrder' },
    { operationId: 'op-task', action: 'addTaskGeneral', maintenanceId: 'm-1' },
  ]), CONTRACT_12);
  let requests = 0;
  global.fetch = async () => { requests += 1; return response({}); };
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 }))
    .rejects.toThrow(/finalizeOrder debe ser la última mutación efectiva/);
  expect(requests).toBe(0);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('finalizeOrder: state 6 o close true no degradan y no escriben', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  for (const order of [baseOrder({ state: 6, close: false }), baseOrder({ state: 2, close: true })]) {
    const files = await writeFiles(finalizeDraft({ code: '007644', orderId: 'order-1' }), CONTRACT_12);
    const methods: string[] = [];
    global.fetch = async (input, init) => { methods.push(String(init?.method)); return orderResponse(order); };
    const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
    expect(result.plannedWrites).toBe(0); expect(result.applied).toHaveLength(0); expect(result.alreadyApplied).toHaveLength(1);
    expect(methods.every((method) => method === 'GET')).toBe(true);
    await fs.rm(files.directory, { recursive: true, force: true });
  }
});

test('finalizeOrder: cambio externo a finalizada no escribe; transición desconocida bloquea', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const files = await writeFiles(finalizeDraft({ code: '007644', orderId: 'order-1' }), CONTRACT_12);
  let gets = 0; let puts = 0;
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') { gets += 1; return orderResponse(baseOrder({ state: gets === 1 ? 2 : 3, close: false })); }
    puts += 1; return response({ ok: true });
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(puts).toBe(0); expect(result.applied).toHaveLength(0); expect(result.alreadyApplied).toHaveLength(1);
  await fs.rm(files.directory, { recursive: true, force: true });

  const blocked = await writeFiles(finalizeDraft({ code: '007644', orderId: 'order-1' }), CONTRACT_12);
  let reads = 0; let blockedPuts = 0;
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') { reads += 1; return orderResponse(baseOrder({ state: reads === 1 ? 2 : 1, close: false })); }
    blockedPuts += 1; return response({ ok: true });
  };
  await expect(applyReview(blocked.draftPath, { contractPath: blocked.contractPath, confirm: true, autoLogin: false, delayMs: 0 })).rejects.toThrow(/unsupported_order_state_transition/);
  expect(blockedPuts).toBe(0);
  await fs.rm(blocked.directory, { recursive: true, force: true });
});

test('finalizeOrder: un 500 con state 3 confirmado reconcilia como completed sin reintentar', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order: any = baseOrder({ state: 2, close: false });
  const files = await writeFiles(finalizeDraft({ code: '007644', orderId: 'order-1' }), CONTRACT_12);
  let puts = 0;
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') return orderResponse(order);
    puts += 1; order.state = 3; return response({ message: 'boom' }, 500);
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(puts).toBe(1); expect(result.audit.status).toBe('completed'); expect(result.applied).toHaveLength(1);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('finalizeOrder: un PUT ambiguo sin state 3 queda ambiguous sin reintentar', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order: any = baseOrder({ state: 2, close: false });
  const files = await writeFiles(finalizeDraft({ code: '007644', orderId: 'order-1' }), CONTRACT_12);
  let puts = 0;
  global.fetch = async (input, init) => {
    if (init?.method === 'GET') return orderResponse(order);
    puts += 1; return response({ message: 'boom' }, 500);
  };
  let error: any;
  try { await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 }); }
  catch (caught) { error = caught; }
  expect(puts).toBe(1); expect(error.applyResult.audit.status).toBe('ambiguous');
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('finalizeOrder: close inesperado queda ambiguous aun con state 3 y no reintenta', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order: any = baseOrder({ state: 2, close: false });
  const files = await writeFiles(finalizeDraft({ code: '007644', orderId: 'order-1' }), CONTRACT_12);
  let puts = 0;
  global.fetch = async (_input, init) => {
    if (init?.method === 'GET') return orderResponse(order);
    puts += 1; order.state = 3; order.close = true; return response({ ok: true });
  };
  let error: any;
  try { await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 }); }
  catch (caught) { error = caught; }
  expect(puts).toBe(1);
  expect(error.applyResult.audit.status).toBe('ambiguous');
  expect(error.applyResult.steps.at(-1)).toMatchObject({ status: 'ambiguous', error: expect.stringContaining('unexpected_close_transition') });
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('finalizeOrder: cadena ensure→task→activity→finalize deja la finalización de último', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order: any = baseOrder({ equipments: ['eq-1'], maintenances: [], state: 2, close: false, material: 'M' });
  const maintenance12: any = { _id: 'm-2', tasks: [] };
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [
    ENSURE_OP,
    { operationId: 'op-task', action: 'addTaskGeneral', maintenanceRef: 'op-ensure' },
    { operationId: 'op-activity', action: 'addActivity', maintenanceRef: 'op-ensure', taskRef: 'op-task', original: { activityIds: [] }, proposed: { name: 'Nueva', reply: 'Descripción' } },
    { operationId: 'op-finalize', action: 'finalizeOrder' },
  ]), CONTRACT_12);
  const writes: string[] = [];
  global.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET' && url.includes('/api/order/order-1/detail')) return orderResponse(order);
    if (init?.method === 'GET' && url.includes('/api/maintenance/m-2/detail')) return response(maintenance12);
    writes.push(`${init?.method} ${new URL(url).pathname}`);
    if (init?.method === 'POST' && url.endsWith('/api/maintenance/empty')) { order.maintenances = [link('m-2', 'eq-1')]; return response({ _id: 'm-2' }); }
    if (init?.method === 'POST' && url.endsWith('/api/maintenance/m-2/add-task-general')) { maintenance12.tasks.push({ _id: 't-2', name: 'General', activitys: [] }); return textResponse('ok'); }
    if (init?.method === 'PATCH' && url.endsWith('/add-activity')) { maintenance12.tasks[0].activitys.push({ _id: 'a-2', name: '', reply: '', file: [], hiddenFile: [] }); return response({ _id: 'a-2' }); }
    const activity = maintenance12.tasks[0]?.activitys?.[0];
    if (init?.method === 'PUT' && url.includes('field=nameCorrected')) { activity.nameCorrected = { reply: JSON.parse(String(init.body)).reply }; return response({}); }
    if (init?.method === 'PUT' && url.includes('field=replyCorrected')) { activity.replyCorrected = { reply: JSON.parse(String(init.body)).reply }; return response({}); }
    if (init?.method === 'PUT' && url.endsWith('/api/order/order-1')) { order.state = JSON.parse(String(init.body)).state; return response({ ok: true }); }
    throw new Error(`Ruta inesperada ${url}`);
  };
  const result = await applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 });
  expect(result.plannedWrites).toBe(6); expect(result.applied).toHaveLength(4); expect(result.audit.status).toBe('completed');
  expect(writes.at(-1)).toBe('PUT /api/order/order-1');
  expect(result.steps.at(-1)).toMatchObject({ operationId: 'op-finalize', step: 'finalize', status: 'completed', stateBefore: 2, stateAfter: 3 });
  expect(order.state).toBe(3);
  await fs.rm(files.directory, { recursive: true, force: true });
});

test('finalizeOrder: una operación previa fallida no llega a finalizar', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const order: any = baseOrder({ equipments: ['eq-1'], maintenances: [], state: 2, close: false, material: 'M' });
  const maintenance12: any = { _id: 'm-1', tasks: [{ _id: 't1', name: 'Otra tarea', activitys: [] }] };
  const files = await writeFiles(ensureDraft({ code: '007644', orderId: 'order-1' }, [
    { operationId: 'op-task', action: 'addTaskGeneral', maintenanceId: 'm-1' },
    { operationId: 'op-finalize', action: 'finalizeOrder' },
  ]), CONTRACT_12);
  let puts = 0;
  global.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET' && url.includes('/api/order/order-1/detail')) return orderResponse(order);
    if (init?.method === 'GET' && url.includes('/api/maintenance/m-1/detail')) return response(maintenance12);
    if (init?.method === 'PUT' && url.endsWith('/api/order/order-1')) { puts += 1; return response({ ok: true }); }
    throw new Error(`Ruta inesperada ${url}`);
  };
  await expect(applyReview(files.draftPath, { contractPath: files.contractPath, confirm: true, autoLogin: false, delayMs: 0 })).rejects.toThrow(/generic_task_create_not_supported/);
  expect(puts).toBe(0);
  await fs.rm(files.directory, { recursive: true, force: true });
});

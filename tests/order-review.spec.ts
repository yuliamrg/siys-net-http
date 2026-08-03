import fs from 'node:fs/promises';
import crypto from 'node:crypto';
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

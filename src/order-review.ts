import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchApiJson, sendApiJson } from './api.js';
import { getAuthenticatedToken, loginDirect } from './auth.js';
import { ensureDir, timestamp } from './utils.js';
import { readJsonFile } from './json-file.js';

type JsonRecord = Record<string, unknown>;
type EntityType = 'maintenance' | 'task' | 'activity';
type HttpMethod = 'PATCH' | 'PUT' | 'POST';
type ActionName = 'addActivity' | 'addImage' | 'setImageVisibility' | 'setActivityVisibility';

interface FieldContract {
  originalPath: string;
  verifyPath: string;
  bodyPath: string;
  method?: 'PATCH' | 'PUT';
  path?: string;
}
interface OperationContract {
  method: 'PATCH' | 'PUT';
  path: string;
  fields: Record<string, FieldContract>;
}
interface EndpointContract {
  method: HttpMethod;
  path: string;
  bodyPath?: string;
  verifyPath?: string;
  folder?: string;
  miniatura?: string;
}
interface ActionContract {
  create?: EndpointContract;
  name?: EndpointContract;
  reply?: EndpointContract;
  upload?: EndpointContract;
  attach?: EndpointContract;
  toggle?: EndpointContract;
  update?: EndpointContract;
}
interface WriteContract {
  schemaVersion: '1.0' | '1.1';
  enabled: true;
  operations: Partial<Record<EntityType, OperationContract>>;
  actions: Partial<Record<ActionName, ActionContract>>;
}
export interface Change {
  kind: 'field';
  entity: EntityType;
  maintenanceId: string;
  taskId?: string;
  activityId?: string;
  field: string;
  original: unknown;
  proposed: unknown;
  force?: boolean;
}
export interface ReviewAction {
  kind: 'action';
  operationId: string;
  action: ActionName;
  maintenanceId: string;
  taskId: string;
  activityId?: string;
  fileId?: string;
  original: JsonRecord;
  proposed?: JsonRecord;
  source?: { path: string; sha256: string };
}
type WorkItem = Change | ReviewAction;

export interface AuditStep {
  operationId: string;
  action: string;
  step: string;
  status: 'completed' | 'alreadyApplied' | 'ambiguous' | 'failed';
  maintenanceId: string;
  taskId?: string;
  activityId?: string;
  fileId?: string;
  taskIndex?: number;
  activityIndex?: number;
  error?: string;
}
export interface ApplyReviewOptions {
  confirm?: boolean;
  autoLogin?: boolean;
  contractPath: string;
  resumeAuditPath?: string;
  delayMs?: number;
  timeoutMs?: number;
  maxChanges?: number;
  onProgress?: (result: ApplyReviewResult) => Promise<void>;
}
export interface ApplyReviewResult {
  dryRun: boolean;
  orderCode: string;
  planned: WorkItem[];
  applied: WorkItem[];
  alreadyApplied: WorkItem[];
  plannedWrites: number;
  steps: AuditStep[];
  audit: {
    generatedAt: string;
    contractPath: string;
    contractSha256: string;
    reviewPath: string;
    reviewSha256: string;
    resumeAuditPath?: string;
    status: 'planned' | 'in_progress' | 'completed' | 'failed' | 'ambiguous';
    error?: string;
  };
}

const EXPECTED_ACTIONS: Record<ActionName, Record<string, { method: HttpMethod; path: string }>> = {
  addActivity: {
    create: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskId}/add-activity' },
    name: { method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=nameCorrected' },
    reply: { method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=replyCorrected' },
  },
  addImage: {
    upload: { method: 'POST', path: '/file' },
    attach: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskIndex}/activity/{activityIndex}/add-file/{fileId}' },
  },
  setImageVisibility: {
    toggle: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskIndex}/activity/{activityIndex}/file/{fileId}/toggle-hidden' },
  },
  setActivityVisibility: {
    update: { method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=visible' },
  },
};

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} inválido.`);
  return value as JsonRecord;
}
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function bool(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw new Error(`${label} debe ser booleano.`); return value; }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function equalFieldValue(a: unknown, b: unknown): boolean { return (a === null && b === undefined) || (a === undefined && b === null) || equal(a, b); }
function isAuthError(error: unknown): boolean { return error instanceof Error && /\b(401|403)\b/.test(error.message); }
function isTimeout(error: unknown): boolean { return error instanceof Error && error.message.includes('Tiempo de espera al escribir'); }
function idOf(value: unknown): string | undefined { return string(value) ?? (value && typeof value === 'object' ? string((value as JsonRecord)._id) : undefined); }
function getPath(value: unknown, fieldPath: string): unknown { return fieldPath.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as JsonRecord)[key] : undefined, value); }
function setPath(target: JsonRecord, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split('.'); let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]; cursor[part] = next && typeof next === 'object' && !Array.isArray(next) ? next : {}; cursor = cursor[part] as JsonRecord;
  }
  cursor[parts.at(-1)!] = value;
}
async function readJson(file: string, label: string): Promise<JsonRecord> {
  try { return record(await readJsonFile<unknown>(file, label), label); }
  catch (error) { throw new Error(`No se pudo leer ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
}
async function sha256File(file: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

function parseLegacyOperations(value: unknown): Partial<Record<EntityType, OperationContract>> {
  if (value === undefined) return {};
  const operations = record(value, 'operations del contrato');
  const parsed: Partial<Record<EntityType, OperationContract>> = {};
  for (const entity of ['maintenance', 'task', 'activity'] as EntityType[]) {
    if (operations[entity] === undefined) continue;
    const item = record(operations[entity], `operación ${entity}`);
    const method = item.method; const endpoint = string(item.path);
    if ((method !== 'PATCH' && method !== 'PUT') || !endpoint?.startsWith('/')) throw new Error(`Contrato inválido para ${entity}.`);
    const fieldsInput = record(item.fields, `campos de ${entity}`); const fields: Record<string, FieldContract> = {};
    for (const [field, raw] of Object.entries(fieldsInput)) {
      const input = record(raw, `campo ${field}`); const legacyPath = string(input.path);
      const endpointOverride = legacyPath?.startsWith('/') ? legacyPath : undefined;
      const originalPath = string(input.originalPath) ?? legacyPath; const verifyPath = string(input.verifyPath) ?? legacyPath; const bodyPath = string(input.bodyPath) ?? legacyPath;
      if (!originalPath || !verifyPath || !bodyPath || [originalPath, verifyPath, bodyPath].some((part) => !/^[A-Za-z][A-Za-z0-9_.]*$/.test(part))) throw new Error(`Ruta de campo inválida: ${field}.`);
      const fieldMethod = input.method;
      if (fieldMethod !== undefined && fieldMethod !== 'PATCH' && fieldMethod !== 'PUT') throw new Error(`Método de campo inválido: ${field}.`);
      if (fieldMethod !== undefined && !endpointOverride) throw new Error(`La ruta de operación del campo ${field} debe comenzar con /.`);
      fields[field] = { originalPath, verifyPath, bodyPath, method: fieldMethod as FieldContract['method'], path: endpointOverride };
    }
    parsed[entity] = { method, path: endpoint, fields };
  }
  return parsed;
}

function endpointContract(raw: unknown, action: ActionName, step: string): EndpointContract {
  const input = record(raw, `contrato ${action}.${step}`); const expected = EXPECTED_ACTIONS[action][step];
  if (input.method !== expected.method || input.path !== expected.path) throw new Error(`El contrato no autoriza la ruta exacta de ${action}.${step}.`);
  const output: EndpointContract = { method: expected.method, path: expected.path };
  for (const key of ['bodyPath', 'verifyPath', 'folder', 'miniatura'] as const) if (input[key] !== undefined) {
    const value = string(input[key]); if (!value) throw new Error(`Contrato inválido en ${action}.${step}.${key}.`); output[key] = value;
  }
  return output;
}

function parseContract(value: JsonRecord): WriteContract {
  if ((value.schemaVersion !== '1.0' && value.schemaVersion !== '1.1') || value.enabled !== true) throw new Error('El contrato debe declarar schemaVersion "1.0" o "1.1" y enabled: true.');
  const actions: Partial<Record<ActionName, ActionContract>> = {};
  if (value.schemaVersion === '1.1') {
    const source = record(value.actions ?? {}, 'actions del contrato');
    for (const action of Object.keys(EXPECTED_ACTIONS) as ActionName[]) {
      if (source[action] === undefined) continue;
      const raw = record(source[action], `acción ${action}`); const parsed: ActionContract = {};
      for (const step of Object.keys(EXPECTED_ACTIONS[action])) parsed[step as keyof ActionContract] = endpointContract(raw[step], action, step);
      actions[action] = parsed;
    }
  } else if (value.actions !== undefined) throw new Error('Las acciones requieren un contrato schemaVersion "1.1".');
  return { schemaVersion: value.schemaVersion, enabled: true, operations: parseLegacyOperations(value.operations), actions };
}

function forcedFields(value: JsonRecord, label: string): Set<string> {
  if (value.forceApply === undefined) return new Set();
  if (!Array.isArray(value.forceApply) || value.forceApply.some((field) => typeof field !== 'string')) throw new Error(`${label}.forceApply debe ser una lista de nombres de campo.`);
  return new Set(value.forceApply as string[]);
}
function changesFromReview(review: JsonRecord): Change[] {
  const maintenanceId = string(review.maintenanceId);
  if (!maintenanceId) throw new Error('Una revisión no tiene maintenanceId.');
  if (review.manualReview === true) throw new Error(`El mantenimiento ${maintenanceId} requiere revisión manual y no se puede aplicar.`);
  const changes: Change[] = []; const original = record(review.original ?? {}, `original de ${maintenanceId}`); const proposed = record(review.proposed ?? {}, `proposed de ${maintenanceId}`);
  const forced = forcedFields(review, `revisión ${maintenanceId}`);
  for (const field of ['observations', 'equipmentState']) if (proposed[field] !== undefined && (!equal(original[field], proposed[field]) || forced.has(field))) changes.push({ kind: 'field', entity: 'maintenance', maintenanceId, field, original: original[field], proposed: proposed[field], force: forced.has(field) });
  for (const taskValue of Array.isArray(review.tasks) ? review.tasks : []) {
    const task = record(taskValue, 'tarea propuesta'); const taskId = string(task.taskId); const before = record(task.original, 'original de tarea'); const after = record(task.proposed, 'propuesta de tarea');
    if (!taskId || typeof after.name !== 'string') throw new Error(`Tarea inválida en ${maintenanceId}.`);
    if (!equal(before.name, after.name) || forcedFields(task, `tarea ${taskId}`).has('name')) changes.push({ kind: 'field', entity: 'task', maintenanceId, taskId, field: 'name', original: before.name, proposed: after.name, force: forcedFields(task, `tarea ${taskId}`).has('name') });
  }
  for (const activityValue of Array.isArray(review.activities) ? review.activities : []) {
    const activity = record(activityValue, 'actividad propuesta'); const taskId = string(activity.taskId); const activityId = string(activity.activityId);
    if (activity.action !== 'edit') throw new Error(`La actividad ${activityId ?? '(sin id)'} no es una edición permitida.`);
    const before = record(activity.original, 'original de actividad'); const after = record(activity.proposed, 'propuesta de actividad');
    if (!taskId || !activityId) throw new Error(`Actividad sin taskId o activityId en ${maintenanceId}.`);
    for (const field of ['name', 'reply']) {
      const force = forcedFields(activity, `actividad ${activityId}`).has(field);
      if (after[field] !== undefined && (!equal(before[field], after[field]) || force)) changes.push({ kind: 'field', entity: 'activity', maintenanceId, taskId, activityId, field, original: before[field], proposed: after[field], force });
    }
  }
  return changes;
}

function parseStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => !string(item))) throw new Error(`${label} debe ser una lista de IDs.`);
  return value as string[];
}
function actionFromValue(value: unknown, maintenanceId: string): ReviewAction {
  const item = record(value, 'operación propuesta'); const operationId = string(item.operationId); const action = string(item.action) as ActionName | undefined; const taskId = string(item.taskId);
  if (!operationId || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(operationId)) throw new Error('Cada operación requiere operationId único (3-80 caracteres).');
  if (!action || !(action in EXPECTED_ACTIONS) || !taskId) throw new Error(`Operación ${operationId} inválida.`);
  const original = record(item.original, `original de ${operationId}`); const activityId = string(item.activityId); const fileId = string(item.fileId);
  if (action === 'addActivity') {
    parseStringList(original.activityIds, `${operationId}.original.activityIds`); const proposed = record(item.proposed, `proposed de ${operationId}`);
    if (!string(proposed.name) || !string(proposed.reply)) throw new Error(`${operationId} requiere proposed.name y proposed.reply.`);
    return { kind: 'action', operationId, action, maintenanceId, taskId, original, proposed };
  }
  if (!activityId) throw new Error(`${operationId} requiere activityId existente; no se permiten referencias a entidades creadas en el mismo archivo.`);
  if (action === 'addImage') {
    parseStringList(original.fileIds, `${operationId}.original.fileIds`); const source = record(item.source, `source de ${operationId}`); const sourcePath = string(source.path); const sha256 = string(source.sha256)?.toLowerCase();
    if (!sourcePath || !path.isAbsolute(sourcePath) || !sha256?.match(/^[a-f0-9]{64}$/)) throw new Error(`${operationId}.source requiere path absoluto y sha256.`);
    if (!['.jpg', '.jpeg', '.png', '.gif'].includes(path.extname(sourcePath).toLowerCase())) throw new Error(`${operationId}: extensión de imagen no permitida.`);
    return { kind: 'action', operationId, action, maintenanceId, taskId, activityId, original, source: { path: sourcePath, sha256 } };
  }
  const proposed = record(item.proposed, `proposed de ${operationId}`); bool(original.visible, `${operationId}.original.visible`); bool(proposed.visible, `${operationId}.proposed.visible`);
  if (action === 'setImageVisibility' && !fileId) throw new Error(`${operationId} requiere fileId.`);
  return { kind: 'action', operationId, action, maintenanceId, taskId, activityId, fileId, original, proposed };
}
function parseReview(value: JsonRecord, requireApproved: boolean): { orderCode: string; items: WorkItem[] } {
  if (value.schemaVersion !== '1.0' && value.schemaVersion !== '1.1') throw new Error('El borrador debe usar schemaVersion "1.0" o "1.1".');
  if (requireApproved && value.status !== 'approved') throw new Error('Para escribir, el JSON debe tener status "approved" tras la revisión del coordinador.');
  if (!['draft', 'approved'].includes(String(value.status))) throw new Error('El estado del borrador debe ser draft o approved.');
  const order = record(value.order, 'order del borrador'); const orderCode = string(order.code);
  if (!orderCode || !/^\d+$/.test(orderCode)) throw new Error('El borrador no tiene un código de orden válido.');
  const reviews = Array.isArray(value.reviews) ? value.reviews : []; if (!reviews.length) throw new Error('El borrador no contiene revisiones.');
  const items: WorkItem[] = []; const ids = new Set<string>();
  for (const raw of reviews) {
    const review = record(raw, 'revisión'); const maintenanceId = string(review.maintenanceId); if (!maintenanceId) throw new Error('Una revisión no tiene maintenanceId.');
    items.push(...changesFromReview(review));
    if (value.schemaVersion === '1.0' && review.operations !== undefined) throw new Error('reviews[].operations requiere schemaVersion "1.1".');
    for (const operation of Array.isArray(review.operations) ? review.operations : []) {
      const parsed = actionFromValue(operation, maintenanceId); if (ids.has(parsed.operationId)) throw new Error(`operationId duplicado: ${parsed.operationId}.`); ids.add(parsed.operationId); items.push(parsed);
    }
  }
  if (!items.length) throw new Error('El borrador no contiene cambios ni operaciones.');
  return { orderCode, items };
}

function tasksOf(detail: JsonRecord): JsonRecord[] {
  const tasks = detail.tasks; return Array.isArray(tasks) ? tasks.map((item) => record(item, 'tarea actual')) : tasks && typeof tasks === 'object' ? [record(tasks, 'tarea actual')] : [];
}
function activitiesOf(task: JsonRecord): JsonRecord[] { return (Array.isArray(task.activitys) ? task.activitys : []).map((item) => record(item, 'actividad actual')); }
function idsOf(value: unknown): string[] { return (Array.isArray(value) ? value : []).map(idOf).filter((id): id is string => Boolean(id)); }
function taskCurrent(detail: JsonRecord, taskId: string): { task: JsonRecord; taskIndex: number } {
  const tasks = tasksOf(detail); const taskIndex = tasks.findIndex((item) => idOf(item._id) === taskId);
  if (taskIndex < 0) throw new Error(`Conflicto: no existe la tarea ${taskId}.`); return { task: tasks[taskIndex], taskIndex };
}
function activityCurrent(detail: JsonRecord, taskId: string, activityId: string): { task: JsonRecord; activity: JsonRecord; taskIndex: number; activityIndex: number } {
  const { task, taskIndex } = taskCurrent(detail, taskId); const activities = activitiesOf(task); const activityIndex = activities.findIndex((item) => idOf(item._id) === activityId);
  if (activityIndex < 0) throw new Error(`Conflicto: no existe la actividad ${activityId}.`); return { task, activity: activities[activityIndex], taskIndex, activityIndex };
}
function entityCurrent(detail: JsonRecord, change: Change): JsonRecord {
  if (change.entity === 'maintenance') return detail;
  const { task } = taskCurrent(detail, change.taskId!); if (change.entity === 'task') return task;
  return activityCurrent(detail, change.taskId!, change.activityId!).activity;
}
function endpointFor(template: string, values: object): string {
  const source = values as Record<string, unknown>;
  return template.replace(/\{(maintenanceId|taskId|activityId|taskIndex|activityIndex|fileId)\}/g, (_all, key: string) => {
    const value = source[key]; if (value === undefined) throw new Error(`El contrato exige ${key}, pero la operación no lo tiene.`); return encodeURIComponent(String(value));
  });
}
function stateOf(current: JsonRecord, field: FieldContract, change: Change): 'pending' | 'alreadyApplied' {
  const verified = getPath(current, field.verifyPath); if (equalFieldValue(verified, change.proposed)) return 'alreadyApplied';
  if (field.verifyPath !== field.originalPath && verified !== undefined && verified !== null && verified !== '') {
    if (change.force === true && equalFieldValue(getPath(current, field.originalPath), change.original)) return 'pending';
    throw new Error(`Conflicto en ${change.entity}.${change.field} (${change.maintenanceId}): ya existe una corrección distinta en SIYS.`);
  }
  if (!equalFieldValue(getPath(current, field.originalPath), change.original)) throw new Error(`Conflicto en ${change.entity}.${change.field} (${change.maintenanceId}): SIYS cambió desde la revisión.`);
  return 'pending';
}
function imageVisible(activity: JsonRecord, fileId: string): boolean {
  if (!idsOf(activity.file).includes(fileId)) throw new Error(`Conflicto: el archivo ${fileId} no pertenece a la actividad.`);
  return !idsOf(activity.hiddenFile).includes(fileId);
}
function writeCount(item: WorkItem): number {
  if (item.kind === 'field') return 1;
  return item.action === 'addActivity' ? 3 : item.action === 'addImage' ? 2 : 1;
}
function itemOperationId(item: WorkItem, index: number): string {
  return item.kind === 'action' ? item.operationId : `field-${index + 1}-${item.maintenanceId}-${item.entity}-${item.field}`;
}
function finalStep(item: WorkItem): string {
  if (item.kind === 'field') return 'write';
  if (item.action === 'addActivity') return 'reply';
  if (item.action === 'addImage') return 'attach';
  return 'visibility';
}
async function detailFor(maintenanceId: string, token: string): Promise<JsonRecord> {
  return record(await fetchApiJson<unknown>(`/maintenance/${encodeURIComponent(maintenanceId)}/detail`, token), 'mantenimiento actual');
}
function responseId(value: unknown): string | undefined {
  const root = value && typeof value === 'object' ? value as JsonRecord : {}; return idOf(root._id) ?? idOf(root.id) ?? idOf((root.activity as JsonRecord | undefined)?._id) ?? idOf((root.file as JsonRecord | undefined)?._id) ?? idOf((root.data as JsonRecord | undefined)?._id);
}

export async function applyReview(draftPath: string, options: ApplyReviewOptions): Promise<ApplyReviewResult> {
  const dryRun = !options.confirm; const draft = await readJson(draftPath, 'borrador'); const parsed = parseReview(draft, !dryRun);
  const contract = parseContract(await readJson(options.contractPath, 'contrato de escritura'));
  if (parsed.items.some((item) => item.kind === 'action') && contract.schemaVersion !== '1.1') throw new Error('Las operaciones requieren un contrato schemaVersion "1.1".');
  for (const item of parsed.items) {
    if (item.kind === 'field') {
      const field = contract.operations[item.entity]?.fields[item.field]; if (!field) throw new Error(`El contrato no autoriza ${item.entity}.${item.field}.`);
      if (equal(item.original, item.proposed) && field.originalPath === field.verifyPath) throw new Error(`No se puede forzar ${item.entity}.${item.field}: el contrato no distingue corrección y valor original.`);
    } else if (!contract.actions[item.action]) throw new Error(`El contrato no autoriza ${item.action}.`);
  }
  const plannedWrites = parsed.items.reduce((sum, item) => sum + writeCount(item), 0); const maxChanges = options.maxChanges ?? 20;
  if (!Number.isInteger(maxChanges) || maxChanges < 1) throw new Error('maxChanges debe ser un entero positivo.');
  if (plannedWrites > maxChanges) throw new Error(`La revisión contiene ${plannedWrites} escrituras y supera el límite de seguridad de ${maxChanges}. Divide el lote o aumenta --max-changes tras revisar la simulación.`);
  for (const item of parsed.items) if (item.kind === 'action' && item.source && await sha256File(item.source.path) !== item.source.sha256) throw new Error(`El SHA-256 de ${item.operationId} no coincide con la imagen aprobada.`);

  const reviewSha256 = await sha256File(draftPath); const contractSha256 = await sha256File(options.contractPath);
  let resume: ApplyReviewResult | undefined;
  if (options.resumeAuditPath) {
    resume = await readJson(options.resumeAuditPath, 'auditoría de reanudación') as unknown as ApplyReviewResult;
    if (resume.audit?.reviewSha256 !== reviewSha256 || resume.audit?.contractSha256 !== contractSha256) throw new Error('La auditoría de reanudación no corresponde a esta revisión y contrato.');
  }
  let token = await getAuthenticatedToken(options.autoLogin ?? true);
  const loadDetail = async (id: string): Promise<JsonRecord> => {
    try { return await detailFor(id, token); }
    catch (error) { if (!(options.autoLogin ?? true) || !isAuthError(error)) throw error; token = await loginDirect(); return detailFor(id, token); }
  };
  const details = new Map<string, JsonRecord>();
  for (const id of [...new Set(parsed.items.map((item) => item.maintenanceId))]) details.set(id, await loadDetail(id));
  const pending: WorkItem[] = []; const alreadyApplied: WorkItem[] = [];
  for (let index = 0; index < parsed.items.length; index += 1) {
    const item = parsed.items[index]; const priorDone = resume?.steps.some((step) => step.operationId === itemOperationId(item, index) && step.step === finalStep(item) && ['completed', 'alreadyApplied'].includes(step.status));
    if (priorDone) { alreadyApplied.push(item); continue; }
    const detail = details.get(item.maintenanceId)!;
    if (item.kind === 'field') {
      const field = contract.operations[item.entity]!.fields[item.field]; (stateOf(entityCurrent(detail, item), field, item) === 'alreadyApplied' ? alreadyApplied : pending).push(item); continue;
    }
    if (item.action === 'addActivity') {
      const priorCreate = resume?.steps.find((step) => step.operationId === item.operationId && step.step === 'create' && step.status === 'completed');
      const currentIds = idsOf(taskCurrent(detail, item.taskId).task.activitys);
      if (priorCreate?.activityId) {
        if (!currentIds.includes(priorCreate.activityId)) throw new Error(`Conflicto en ${item.operationId}: la actividad creada ya no existe.`);
      } else if (!equal(currentIds, item.original.activityIds)) throw new Error(`Conflicto en ${item.operationId}: cambió la lista de actividades.`);
      pending.push(item); continue;
    }
    const { activity } = activityCurrent(detail, item.taskId, item.activityId!);
    if (item.action === 'addImage') {
      if (!equal(idsOf(activity.file), item.original.fileIds)) throw new Error(`Conflicto en ${item.operationId}: cambió la lista de imágenes.`); pending.push(item); continue;
    }
    const desired = bool(item.proposed!.visible, `${item.operationId}.proposed.visible`);
    const current = item.action === 'setImageVisibility' ? imageVisible(activity, item.fileId!) : activity.visible !== false;
    if (current === desired) alreadyApplied.push(item);
    else if (current !== bool(item.original.visible, `${item.operationId}.original.visible`)) throw new Error(`Conflicto en ${item.operationId}: cambió la visibilidad.`);
    else pending.push(item);
  }
  const result: ApplyReviewResult = {
    dryRun, orderCode: parsed.orderCode, planned: pending, applied: [], alreadyApplied, plannedWrites,
    steps: resume?.steps ? [...resume.steps] : [],
    audit: { generatedAt: new Date().toISOString(), contractPath: path.resolve(options.contractPath), contractSha256, reviewPath: path.resolve(draftPath), reviewSha256, resumeAuditPath: options.resumeAuditPath && path.resolve(options.resumeAuditPath), status: dryRun ? 'planned' : 'in_progress' },
  };
  if (dryRun) return result;

  const progress = async (step: AuditStep): Promise<void> => { result.steps.push(step); await options.onProgress?.(result); };
  const delay = async (): Promise<void> => { if ((options.delayMs ?? 350) > 0) await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 350)); };
  const sendVerified = async (endpoint: string, method: HttpMethod, body: JsonRecord | undefined, verify: () => Promise<boolean>, step: AuditStep): Promise<void> => {
    let verifiedAfterTimeout = false;
    try { await sendApiJson(endpoint, token, method, body, options.timeoutMs); }
    catch (error) {
      if (!isTimeout(error) || !(verifiedAfterTimeout = await verify())) throw error;
    }
    if (!verifiedAfterTimeout && !await verify()) throw new Error(`Verificación fallida para ${step.operationId}.${step.step}.`);
    await progress({ ...step, status: 'completed' }); await delay();
  };

  try {
    for (const item of pending) {
      const index = parsed.items.indexOf(item); const operationId = itemOperationId(item, index);
      if (item.kind === 'field') {
        const detail = await loadDetail(item.maintenanceId); const operation = contract.operations[item.entity]!; const field = operation.fields[item.field];
        if (stateOf(entityCurrent(detail, item), field, item) === 'alreadyApplied') {
          result.alreadyApplied.push(item); await progress({ operationId, action: `${item.entity}.${item.field}`, step: 'write', status: 'alreadyApplied', maintenanceId: item.maintenanceId, taskId: item.taskId, activityId: item.activityId }); continue;
        }
        const body: JsonRecord = {}; setPath(body, field.bodyPath, item.proposed);
        await sendVerified(endpointFor(field.path ?? operation.path, item), field.method ?? operation.method, body, async () => equal(getPath(entityCurrent(await loadDetail(item.maintenanceId), item), field.verifyPath), item.proposed), { operationId, action: `${item.entity}.${item.field}`, step: 'write', status: 'completed', maintenanceId: item.maintenanceId, taskId: item.taskId, activityId: item.activityId });
        result.applied.push(item); continue;
      }
      const actionContract = contract.actions[item.action]!;
      if (item.action === 'addActivity') {
        const priorCreate = result.steps.find((step) => step.operationId === operationId && step.step === 'create' && step.status === 'completed');
        let activityId = priorCreate?.activityId;
        if (!activityId) {
          const before = idsOf(taskCurrent(await loadDetail(item.maintenanceId), item.taskId).task.activitys);
          let created: unknown;
          try {
            created = await sendApiJson<unknown>(endpointFor(actionContract.create!.path, item), token, actionContract.create!.method, undefined, options.timeoutMs);
          } catch (error) {
            if (!isTimeout(error)) throw error;
            const afterTimeoutIds = idsOf(taskCurrent(await loadDetail(item.maintenanceId), item.taskId).task.activitys);
            const createdAfterTimeout = afterTimeoutIds.filter((id) => !before.includes(id));
            if (createdAfterTimeout.length === 1) activityId = createdAfterTimeout[0];
            else {
              result.audit.status = 'ambiguous';
              await progress({ operationId, action: item.action, step: 'create', status: 'ambiguous', maintenanceId: item.maintenanceId, taskId: item.taskId, error: (error as Error).message });
              throw error;
            }
          }
          activityId ??= responseId(created); const afterDetail = await loadDetail(item.maintenanceId); const afterIds = idsOf(taskCurrent(afterDetail, item.taskId).task.activitys);
          activityId ??= afterIds.find((id) => !before.includes(id));
          if (!activityId || afterIds.filter((id) => !before.includes(id)).length !== 1) throw new Error(`No se pudo identificar inequívocamente la actividad creada por ${item.operationId}.`);
          await progress({ operationId, action: item.action, step: 'create', status: 'completed', maintenanceId: item.maintenanceId, taskId: item.taskId, activityId }); await delay();
        }
        for (const fieldName of ['name', 'reply'] as const) {
          const endpoint = actionContract[fieldName]!; const body: JsonRecord = {}; setPath(body, endpoint.bodyPath ?? 'reply', item.proposed![fieldName]);
          const priorStep = result.steps.find((step) => step.operationId === operationId && step.step === fieldName && step.status === 'completed');
          if (priorStep) continue;
          await sendVerified(endpointFor(endpoint.path, { ...item, activityId }), endpoint.method, body, async () => {
            const current = activityCurrent(await loadDetail(item.maintenanceId), item.taskId, activityId!).activity; return equal(getPath(current, endpoint.verifyPath ?? `${fieldName}Corrected.reply`), item.proposed![fieldName]);
          }, { operationId, action: item.action, step: fieldName, status: 'completed', maintenanceId: item.maintenanceId, taskId: item.taskId, activityId });
        }
        result.applied.push(item); continue;
      }
      if (item.action === 'addImage') {
        const upload = actionContract.upload!; const priorUpload = result.steps.find((step) => step.operationId === operationId && step.step === 'upload' && step.status === 'completed');
        let fileId = priorUpload?.fileId;
        if (!fileId) {
          const content = (await fs.readFile(item.source!.path)).toString('base64'); let uploaded: unknown;
          try {
            uploaded = await sendApiJson<unknown>(upload.path, token, upload.method, { content, folder: upload.folder ?? 'maintenance-files', miniatura: upload.miniatura ?? '1', fileName: path.basename(item.source!.path) }, options.timeoutMs);
          } catch (error) {
            if (isTimeout(error)) { await loadDetail(item.maintenanceId); await progress({ operationId, action: item.action, step: 'upload', status: 'ambiguous', maintenanceId: item.maintenanceId, taskId: item.taskId, activityId: item.activityId, error: (error as Error).message }); result.audit.status = 'ambiguous'; }
            throw error;
          }
          fileId = responseId(uploaded); if (!fileId) throw new Error(`La carga de ${item.operationId} no devolvió fileId.`);
          await progress({ operationId, action: item.action, step: 'upload', status: 'completed', maintenanceId: item.maintenanceId, taskId: item.taskId, activityId: item.activityId, fileId }); await delay();
        }
        const located = activityCurrent(await loadDetail(item.maintenanceId), item.taskId, item.activityId!);
        const attachPath = endpointFor(actionContract.attach!.path, { ...item, fileId, taskIndex: located.taskIndex, activityIndex: located.activityIndex });
        await sendVerified(attachPath, actionContract.attach!.method, undefined, async () => idsOf(activityCurrent(await loadDetail(item.maintenanceId), item.taskId, item.activityId!).activity.file).includes(fileId), { operationId, action: item.action, step: 'attach', status: 'completed', maintenanceId: item.maintenanceId, taskId: item.taskId, activityId: item.activityId, fileId, taskIndex: located.taskIndex, activityIndex: located.activityIndex });
        result.applied.push(item); continue;
      }
      const located = activityCurrent(await loadDetail(item.maintenanceId), item.taskId, item.activityId!); const desired = bool(item.proposed!.visible, `${item.operationId}.proposed.visible`);
      if (item.action === 'setImageVisibility') {
        const endpoint = endpointFor(actionContract.toggle!.path, { ...item, taskIndex: located.taskIndex, activityIndex: located.activityIndex });
        await sendVerified(endpoint, actionContract.toggle!.method, undefined, async () => imageVisible(activityCurrent(await loadDetail(item.maintenanceId), item.taskId, item.activityId!).activity, item.fileId!) === desired, { operationId, action: item.action, step: 'visibility', status: 'completed', maintenanceId: item.maintenanceId, taskId: item.taskId, activityId: item.activityId, fileId: item.fileId, taskIndex: located.taskIndex, activityIndex: located.activityIndex });
      } else {
        const endpoint = actionContract.update!; const body: JsonRecord = {}; setPath(body, endpoint.bodyPath ?? 'visible', desired);
        await sendVerified(endpointFor(endpoint.path, item), endpoint.method, body, async () => (activityCurrent(await loadDetail(item.maintenanceId), item.taskId, item.activityId!).activity.visible !== false) === desired, { operationId, action: item.action, step: 'visibility', status: 'completed', maintenanceId: item.maintenanceId, taskId: item.taskId, activityId: item.activityId });
      }
      result.applied.push(item);
    }
    result.audit.status = 'completed'; await options.onProgress?.(result);
  } catch (error) {
    if (result.audit.status !== 'ambiguous') result.audit.status = 'failed';
    result.audit.error = error instanceof Error ? error.message : String(error);
    const lastItem = pending.find((item) => !result.applied.includes(item));
    if (lastItem && !result.steps.some((step) => step.operationId === (lastItem.kind === 'action' ? lastItem.operationId : itemOperationId(lastItem, parsed.items.indexOf(lastItem))) && ['failed', 'ambiguous'].includes(step.status))) {
      await progress({ operationId: lastItem.kind === 'action' ? lastItem.operationId : itemOperationId(lastItem, parsed.items.indexOf(lastItem)), action: lastItem.kind === 'action' ? lastItem.action : `${lastItem.entity}.${lastItem.field}`, step: 'operation', status: result.audit.status === 'ambiguous' ? 'ambiguous' : 'failed', maintenanceId: lastItem.maintenanceId, taskId: lastItem.taskId, activityId: lastItem.activityId, fileId: lastItem.kind === 'action' ? lastItem.fileId : undefined, error: result.audit.error });
    }
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { applyResult: result });
  }
  return result;
}

export function applyAuditOutputPath(code: string, outDir: string, stamp = timestamp()): string { return path.join(outDir, `order-apply-${code}-${stamp}.json`); }
export async function writeApplyAudit(output: string, result: ApplyReviewResult): Promise<void> {
  await ensureDir(path.dirname(output)); const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  try { await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8'); await fs.rename(temporary, output); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

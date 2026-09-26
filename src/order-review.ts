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
type ResponseKind = 'json' | 'text' | 'empty';
type ProducedType = 'maintenance' | 'task' | 'activity';
type ActionName = 'addActivity' | 'addImage' | 'setImageVisibility' | 'setActivityVisibility' | 'ensureEquipmentMaintenance' | 'addTaskGeneral' | 'finalizeOrder';

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
  response: ResponseKind;
}
interface ActionContract {
  create?: EndpointContract;
  name?: EndpointContract;
  reply?: EndpointContract;
  upload?: EndpointContract;
  attach?: EndpointContract;
  toggle?: EndpointContract;
  update?: EndpointContract;
  linkEquipment?: EndpointContract;
  createMaintenance?: EndpointContract;
}
interface WriteContract {
  schemaVersion: '1.0' | '1.1' | '1.2';
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
  /** Escrituras HTTP que este paso necesita; se resuelve en la preclasificación. */
  writes?: number;
}
export interface ReviewAction {
  kind: 'action';
  operationId: string;
  action: ActionName;
  maintenanceId?: string;
  maintenanceRef?: string;
  taskId?: string;
  taskRef?: string;
  activityId?: string;
  activityRef?: string;
  equipmentId?: string;
  fileId?: string;
  name?: string;
  maintenance?: JsonRecord;
  original: JsonRecord;
  proposed?: JsonRecord;
  source?: { path: string; sha256: string };
  /** Escrituras HTTP que este paso necesita; se resuelve en la preclasificación. */
  writes?: number;
}
type WorkItem = Change | ReviewAction;

export interface AuditStep {
  operationId: string;
  action: string;
  step: string;
  status: 'completed' | 'alreadyApplied' | 'ambiguous' | 'failed';
  maintenanceId?: string;
  taskId?: string;
  activityId?: string;
  fileId?: string;
  orderId?: string;
  taskIndex?: number;
  activityIndex?: number;
  /** Estado de la orden observado antes de una transición (solo finalize). */
  stateBefore?: number;
  stateAfter?: number;
  closeBefore?: boolean;
  closeAfter?: boolean;
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
    orderId?: string;
    status: 'planned' | 'in_progress' | 'completed' | 'failed' | 'ambiguous';
    error?: string;
  };
}

interface ExpectedStep {
  method: HttpMethod;
  path: string;
  responses: ResponseKind[];
  response: ResponseKind;
}

const EXPECTED_ACTIONS: Record<ActionName, Record<string, ExpectedStep>> = {
  addActivity: {
    create: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskId}/add-activity', responses: ['json', 'empty'], response: 'json' },
    name: { method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=nameCorrected', responses: ['json', 'empty'], response: 'json' },
    reply: { method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=replyCorrected', responses: ['json', 'empty'], response: 'json' },
  },
  addImage: {
    upload: { method: 'POST', path: '/file', responses: ['json'], response: 'json' },
    attach: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskIndex}/activity/{activityIndex}/add-file/{fileId}', responses: ['json', 'empty'], response: 'json' },
  },
  setImageVisibility: {
    toggle: { method: 'PATCH', path: '/maintenance/{maintenanceId}/task/{taskIndex}/activity/{activityIndex}/file/{fileId}/toggle-hidden', responses: ['json', 'empty'], response: 'json' },
  },
  setActivityVisibility: {
    update: { method: 'PUT', path: '/maintenance/{maintenanceId}/task/{taskId}/activity/{activityId}?field=visible', responses: ['json', 'empty'], response: 'json' },
  },
  addTaskGeneral: {
    create: { method: 'POST', path: '/maintenance/{maintenanceId}/add-task-general', responses: ['text', 'json', 'empty'], response: 'text' },
  },
  ensureEquipmentMaintenance: {
    linkEquipment: { method: 'PUT', path: '/order/{orderId}', responses: ['json', 'empty', 'text'], response: 'json' },
    createMaintenance: { method: 'POST', path: '/maintenance/empty', responses: ['json', 'empty', 'text'], response: 'json' },
  },
  finalizeOrder: {
    update: { method: 'PUT', path: '/order/{orderId}', responses: ['json', 'empty', 'text'], response: 'json' },
  },
};

const ACTION_PRODUCES: Partial<Record<ActionName, ProducedType>> = {
  ensureEquipmentMaintenance: 'maintenance',
  addTaskGeneral: 'task',
  addActivity: 'activity',
};
const PROTECTED_ORDER_FIELDS = ['customer', 'subsidiary', 'type', 'material', 'observations', 'users', 'dates', 'equipments'] as const;

interface ProducedIds { maintenanceId?: string; taskId?: string; activityId?: string; fileId?: string; }
interface Targets { maintenanceId?: string; taskId?: string; activityId?: string; unresolved: boolean; }

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} inválido.`);
  return value as JsonRecord;
}
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function bool(value: unknown, label: string): boolean { if (typeof value !== 'boolean') throw new Error(`${label} debe ser booleano.`); return value; }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function equalFieldValue(a: unknown, b: unknown): boolean { return (a === null && b === undefined) || (a === undefined && b === null) || equal(a, b); }
function isAuthError(error: unknown): boolean { return error instanceof Error && /\b(401|403)\b/.test(error.message); }
function errorCode(error: unknown): string | undefined { return error && typeof error === 'object' ? (error as { code?: string }).code : undefined; }
function isTimeout(error: unknown): boolean { return error instanceof Error && error.message.includes('Tiempo de espera al escribir'); }
/** Una escritura cuyo resultado no puede deducirse solo de la respuesta HTTP. */
function isAmbiguousWrite(error: unknown): boolean {
  const code = errorCode(error);
  if (code === 'timeout' || code === 'transport_error' || code === 'invalid_response') return true;
  if (code === 'http_error' && error instanceof Error && /\b5\d\d\b/.test(error.message)) return true;
  return isTimeout(error);
}
function idOf(value: unknown): string | undefined { return string(value) ?? (value && typeof value === 'object' ? string((value as JsonRecord)._id) : undefined); }
function getPath(value: unknown, fieldPath: string): unknown { return fieldPath.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as JsonRecord)[key] : undefined, value); }
function setPath(target: JsonRecord, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split('.'); let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part]; cursor[part] = next && typeof next === 'object' && !Array.isArray(next) ? next : {}; cursor = cursor[part] as JsonRecord;
  }
  cursor[parts.at(-1)!] = value;
}
function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ');
}
function normalizeCode(value: unknown): string | undefined {
  const text = string(value); if (!text || !/^\d+$/.test(text)) return undefined; return text.replace(/^0+(?=\d)/, '');
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
  const output: EndpointContract = { method: expected.method, path: expected.path, response: expected.response };
  for (const key of ['bodyPath', 'verifyPath', 'folder', 'miniatura'] as const) if (input[key] !== undefined) {
    const value = string(input[key]); if (!value) throw new Error(`Contrato inválido en ${action}.${step}.${key}.`); output[key] = value;
  }
  if (input.response !== undefined) {
    const value = string(input.response);
    if (!value || !expected.responses.includes(value as ResponseKind)) throw new Error(`El contrato no autoriza la respuesta "${String(input.response)}" de ${action}.${step}.`);
    output.response = value as ResponseKind;
  }
  return output;
}

function parseContract(value: JsonRecord): WriteContract {
  const version = value.schemaVersion;
  if ((version !== '1.0' && version !== '1.1' && version !== '1.2') || value.enabled !== true) throw new Error('El contrato debe declarar schemaVersion "1.0", "1.1" o "1.2" y enabled: true.');
  const actions: Partial<Record<ActionName, ActionContract>> = {};
  if (version === '1.1' || version === '1.2') {
    const source = record(value.actions ?? {}, 'actions del contrato');
    for (const action of Object.keys(EXPECTED_ACTIONS) as ActionName[]) {
      if (source[action] === undefined) continue;
      if (version === '1.1' && (action === 'ensureEquipmentMaintenance' || action === 'addTaskGeneral' || action === 'finalizeOrder')) throw new Error(`La acción ${action} requiere un contrato schemaVersion "1.2".`);
      const raw = record(source[action], `acción ${action}`); const parsed: ActionContract = {};
      for (const step of Object.keys(EXPECTED_ACTIONS[action])) parsed[step as keyof ActionContract] = endpointContract(raw[step], action, step);
      actions[action] = parsed;
    }
  } else if (value.actions !== undefined) throw new Error('Las acciones requieren un contrato schemaVersion "1.1".');
  return { schemaVersion: version, enabled: true, operations: parseLegacyOperations(value.operations), actions };
}

function forcedFields(value: JsonRecord, label: string): Set<string> {
  if (value.forceApply === undefined) return new Set();
  if (!Array.isArray(value.forceApply) || value.forceApply.some((field) => typeof field !== 'string')) throw new Error(`${label}.forceApply debe ser una lista de nombres de campo.`);
  return new Set(value.forceApply as string[]);
}
function changesFromReview(review: JsonRecord, maintenanceId: string | undefined, schemaVersion: string): Change[] {
  if (!maintenanceId) {
    if (schemaVersion !== '1.2') throw new Error('Una revisión no tiene maintenanceId.');
    if (review.manualReview === true) throw new Error('Una revisión sin maintenanceId no puede declarar manualReview.');
    const original = record(review.original ?? {}, 'original de revisión sin maintenanceId');
    const proposed = record(review.proposed ?? {}, 'proposed de revisión sin maintenanceId');
    const forced = forcedFields(review, 'revisión sin maintenanceId');
    const hasMaintenanceEdit = ['observations', 'equipmentState'].some((field) => proposed[field] !== undefined && (!equal(original[field], proposed[field]) || forced.has(field)));
    if (hasMaintenanceEdit || (Array.isArray(review.tasks) && review.tasks.length > 0) || (Array.isArray(review.activities) && review.activities.length > 0)) {
      throw new Error('Una revisión 1.2 sin maintenanceId no puede contener ediciones legacy de maintenance, tasks o activities.');
    }
    return [];
  }
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
function refValue(item: JsonRecord, key: string, operationId: string): string | undefined {
  if (item[key] === undefined) return undefined;
  const value = string(item[key]);
  if (!value) throw new Error(`${operationId}.${key} debe ser un operationId no vacío.`);
  return value;
}
function checkExclusive(operationId: string, entity: string, id?: string, ref?: string): void {
  if (id && ref) throw new Error(`La operación ${operationId} no puede declarar ${entity}Id y ${entity}Ref a la vez.`);
}
function actionFromValue(value: unknown, reviewMaintenanceId: string | undefined, schemaVersion: string, produced: Map<string, ProducedType>): ReviewAction {
  const item = record(value, 'operación propuesta'); const operationId = string(item.operationId); const action = string(item.action) as ActionName | undefined;
  if (!operationId || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(operationId)) throw new Error('Cada operación requiere operationId único (3-80 caracteres).');
  if (!action || !(action in EXPECTED_ACTIONS)) throw new Error(`Operación ${operationId} inválida.`);
  const is12 = schemaVersion === '1.2';
  if (!is12 && (action === 'ensureEquipmentMaintenance' || action === 'addTaskGeneral' || action === 'finalizeOrder')) throw new Error(`La acción ${action} requiere schemaVersion "1.2"; no se reinterpreta un borrador anterior.`);
  const maintenanceId = string(item.maintenanceId); const maintenanceRef = refValue(item, 'maintenanceRef', operationId);
  const taskId = string(item.taskId); const taskRef = refValue(item, 'taskRef', operationId);
  const activityId = string(item.activityId); const activityRef = refValue(item, 'activityRef', operationId);
  if (!is12 && (maintenanceRef || taskRef || activityRef)) throw new Error(`La operación ${operationId} usa referencias operationId, que requieren schemaVersion "1.2".`);
  checkExclusive(operationId, 'maintenance', maintenanceId, maintenanceRef);
  checkExclusive(operationId, 'task', taskId, taskRef);
  checkExclusive(operationId, 'activity', activityId, activityRef);
  const refs: Array<[string | undefined, ProducedType]> = [[maintenanceRef, 'maintenance'], [taskRef, 'task'], [activityRef, 'activity']];
  for (const [ref, type] of refs) {
    if (!ref) continue;
    const target = produced.get(ref);
    if (!target) throw new Error(`La operación ${operationId} referencia ${ref}, que no aparece antes en el archivo.`);
    if (target !== type) throw new Error(`La operación ${operationId} usa ${type}Ref hacia una operación que produce ${target}.`);
  }
  const needsMaintenance = action !== 'ensureEquipmentMaintenance' && action !== 'finalizeOrder';
  let baseMaintenanceId = maintenanceId;
  if (!baseMaintenanceId && !maintenanceRef) {
    if (is12) { if (needsMaintenance) throw new Error(`La operación ${operationId} debe declarar maintenanceId o maintenanceRef.`); }
    else if (needsMaintenance) baseMaintenanceId = reviewMaintenanceId;
  }

  if (action === 'finalizeOrder') {
    if (maintenanceId || maintenanceRef || taskId || taskRef || activityId || activityRef || string(item.equipmentId)) throw new Error(`${operationId} no admite referencias de mantenimiento, tarea, actividad ni equipo.`);
    return { kind: 'action', operationId, action, original: {} };
  }
  if (action === 'ensureEquipmentMaintenance') {
    if (maintenanceId || maintenanceRef || taskId || taskRef || activityId || activityRef) throw new Error(`${operationId} no admite referencias de mantenimiento, tarea o actividad.`);
    const equipmentId = string(item.equipmentId); if (!equipmentId) throw new Error(`${operationId} requiere equipmentId.`);
    const maintenance = record(item.maintenance, `${operationId}.maintenance`);
    const user = string(maintenance.user); const start = string(maintenance.start); const end = string(maintenance.end);
    if (!user || maintenance.equipmentState === undefined || !start || !end) throw new Error(`${operationId}.maintenance requiere user, equipmentState, start y end.`);
    const observations = maintenance.observations === undefined ? undefined : string(maintenance.observations);
    if (maintenance.observations !== undefined && observations === undefined) throw new Error(`${operationId}.maintenance.observations debe ser texto.`);
    return { kind: 'action', operationId, action, equipmentId, maintenance: { user, equipmentState: maintenance.equipmentState, start, end, ...(observations ? { observations } : {}) }, original: {} };
  }
  if (action === 'addTaskGeneral') {
    if (!maintenanceId && !maintenanceRef) throw new Error(`${operationId} requiere maintenanceId o maintenanceRef.`);
    const name = item.name === undefined ? undefined : string(item.name);
    if (item.name !== undefined && !name) throw new Error(`${operationId}.name debe ser texto.`);
    return { kind: 'action', operationId, action, maintenanceId, maintenanceRef, name, original: {} };
  }
  if (action === 'addActivity') {
    if (!taskId && !taskRef) throw new Error(`${operationId} requiere taskId o taskRef.`);
    const original = record(item.original, `original de ${operationId}`); parseStringList(original.activityIds, `${operationId}.original.activityIds`);
    const proposed = record(item.proposed, `proposed de ${operationId}`);
    if (!string(proposed.name) || !string(proposed.reply)) throw new Error(`${operationId} requiere proposed.name y proposed.reply.`);
    return { kind: 'action', operationId, action, maintenanceId: baseMaintenanceId, maintenanceRef, taskId, taskRef, original, proposed };
  }
  if (action === 'addImage') {
    if (!taskId && !taskRef) throw new Error(`${operationId} requiere taskId o taskRef.`);
    if (!activityId && !activityRef) throw new Error(`${operationId} requiere activityId o activityRef.`);
    const original = record(item.original, `original de ${operationId}`); parseStringList(original.fileIds, `${operationId}.original.fileIds`);
    let source: { path: string; sha256: string } | undefined;
    if (item.source !== undefined) {
      const raw = record(item.source, `source de ${operationId}`); const sourcePath = string(raw.path); const sha256 = string(raw.sha256)?.toLowerCase();
      if (!sourcePath || !path.isAbsolute(sourcePath) || !sha256?.match(/^[a-f0-9]{64}$/)) throw new Error(`${operationId}.source requiere path absoluto y sha256.`);
      if (!['.jpg', '.jpeg', '.png', '.gif'].includes(path.extname(sourcePath).toLowerCase())) throw new Error(`${operationId}: extensión de imagen no permitida.`);
      source = { path: sourcePath, sha256 };
    }
    const existingFileId = string(item.fileId);
    if (!source && !existingFileId) throw new Error(`${operationId} requiere source o fileId existente autorizado.`);
    return { kind: 'action', operationId, action, maintenanceId: baseMaintenanceId, maintenanceRef, taskId, taskRef, activityId, activityRef, fileId: source ? undefined : existingFileId, source, original };
  }
  if (!activityId && !activityRef) throw new Error(`${operationId} requiere activityId o activityRef.`);
  const original = record(item.original, `original de ${operationId}`); const proposed = record(item.proposed, `proposed de ${operationId}`);
  bool(original.visible, `${operationId}.original.visible`); bool(proposed.visible, `${operationId}.proposed.visible`);
  const fileId = string(item.fileId);
  if (action === 'setImageVisibility' && !fileId) throw new Error(`${operationId} requiere fileId.`);
  return { kind: 'action', operationId, action, maintenanceId: baseMaintenanceId, maintenanceRef, taskId, taskRef, activityId, activityRef, fileId, original, proposed };
}

function parseReview(value: JsonRecord, requireApproved: boolean): { schemaVersion: string; orderCode: string; orderId?: string; orderApproved?: JsonRecord; items: WorkItem[] } {
  const schemaVersion = value.schemaVersion;
  if (schemaVersion !== '1.0' && schemaVersion !== '1.1' && schemaVersion !== '1.2') throw new Error('El borrador debe usar schemaVersion "1.0", "1.1" o "1.2".');
  if (requireApproved && value.status !== 'approved') throw new Error('Para escribir, el JSON debe tener status "approved" tras la revisión del coordinador.');
  if (!['draft', 'approved'].includes(String(value.status))) throw new Error('El estado del borrador debe ser draft o approved.');
  const order = record(value.order, 'order del borrador'); const orderCode = string(order.code);
  if (!orderCode || !/^\d+$/.test(orderCode)) throw new Error('El borrador no tiene un código de orden válido.');
  const orderId = string(order.orderId);
  const orderApproved = order.approved === undefined ? undefined : record(order.approved, 'order.approved');
  const reviews = Array.isArray(value.reviews) ? value.reviews : []; if (!reviews.length) throw new Error('El borrador no contiene revisiones.');
  const items: WorkItem[] = []; const ids = new Set<string>(); const produced = new Map<string, ProducedType>(); let needsOrderId = false;
  for (const raw of reviews) {
    const review = record(raw, 'revisión'); const maintenanceId = string(review.maintenanceId);
    if (!maintenanceId && schemaVersion !== '1.2') throw new Error('Una revisión no tiene maintenanceId.');
    items.push(...changesFromReview(review, maintenanceId, String(schemaVersion)));
    if (schemaVersion === '1.0' && review.operations !== undefined) throw new Error('reviews[].operations requiere schemaVersion "1.1".');
    for (const operation of Array.isArray(review.operations) ? review.operations : []) {
      const parsed = actionFromValue(operation, maintenanceId, String(schemaVersion), produced);
      if (ids.has(parsed.operationId)) throw new Error(`operationId duplicado: ${parsed.operationId}.`);
      ids.add(parsed.operationId);
      if (parsed.action === 'ensureEquipmentMaintenance' || parsed.action === 'finalizeOrder') needsOrderId = true;
      const produces = ACTION_PRODUCES[parsed.action]; if (produces) produced.set(parsed.operationId, produces);
      items.push(parsed);
    }
  }
  const finalizeItems = items.filter((item) => item.kind === 'action' && item.action === 'finalizeOrder');
  if (finalizeItems.length > 1) throw new Error('Un lote solo puede contener un finalizeOrder.');
  if (finalizeItems.length === 1 && items.at(-1) !== finalizeItems[0]) {
    throw new Error('finalizeOrder debe ser la última mutación efectiva del lote.');
  }
  if (!items.length) throw new Error('El borrador no contiene cambios ni operaciones.');
  if (needsOrderId && !orderId) throw new Error('ensureEquipmentMaintenance exige order.orderId inequívoco; no se selecciona una orden solo por code.');
  return { schemaVersion, orderCode, orderId, orderApproved, items };
}

function tasksOf(detail: JsonRecord): JsonRecord[] {
  const tasks = detail.tasks; return Array.isArray(tasks) ? tasks.map((item) => record(item, 'tarea actual')) : tasks && typeof tasks === 'object' ? [record(tasks, 'tarea actual')] : [];
}
function activitiesOf(task: JsonRecord): JsonRecord[] { return (Array.isArray(task.activitys) ? task.activitys : []).map((item) => record(item, 'actividad actual')); }
function idsOf(value: unknown): string[] { return (Array.isArray(value) ? value : []).map(idOf).filter((id): id is string => Boolean(id)); }
function equipmentIdsOf(order: JsonRecord): string[] { return idsOf(order.equipments); }
function requiredOrderId(value: unknown, field: string): string {
  const id = idOf(value);
  if (!id) throw new Error(`No se puede preparar el PUT de la orden: ${field} no contiene un ID inequívoco en la lectura viva.`);
  return id;
}
function requiredOrderIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`No se puede preparar el PUT de la orden: ${field} no es una lista en la lectura viva.`);
  return value.map((item, index) => requiredOrderId(item, `${field}[${index}]`));
}
function requiredLiveOrderField(order: JsonRecord, field: 'material' | 'observations'): unknown {
  if (!Object.hasOwn(order, field) || order[field] === undefined) throw new Error(`No se puede preparar el PUT de la orden: falta ${field} en la lectura viva.`);
  return order[field];
}
function liveOrderDatesForPut(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('No se puede preparar el PUT de la orden: dates no es una lista en la lectura viva.');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const schedule = entry as JsonRecord;
    const normalized: JsonRecord = { ...schedule };
    if (Object.hasOwn(schedule, 'user')) normalized.user = requiredOrderId(schedule.user, `dates[${index}].user`);
    if (Object.hasOwn(schedule, 'users')) normalized.users = requiredOrderIds(schedule.users, `dates[${index}].users`);
    return normalized;
  });
}
function orderFormPutBody(order: JsonRecord, equipmentId: string): JsonRecord {
  const equipments = requiredOrderIds(order.equipments, 'equipments');
  const existingCount = equipments.filter((id) => id === equipmentId).length;
  if (existingCount > 1) throw new Error(`No se puede preparar el PUT de la orden: equipmentId ${equipmentId} aparece más de una vez en la lectura viva.`);
  if (existingCount === 0) equipments.push(equipmentId);
  return {
    type: requiredOrderId(order.type, 'type'),
    customer: requiredOrderId(order.customer, 'customer'),
    subsidiary: requiredOrderId(order.subsidiary, 'subsidiary'),
    material: requiredLiveOrderField(order, 'material'),
    observations: requiredLiveOrderField(order, 'observations'),
    users: requiredOrderIds(order.users, 'users'),
    dates: liveOrderDatesForPut(order.dates),
    equipments,
  };
}
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
  return template.replace(/\{(maintenanceId|taskId|activityId|taskIndex|activityIndex|fileId|orderId)\}/g, (_all, key: string) => {
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
function estimatedWrites(item: WorkItem): number {
  if (item.kind === 'field') return 1;
  switch (item.action) {
    case 'addActivity': return 3;
    case 'addImage': return item.source ? 2 : 1;
    case 'ensureEquipmentMaintenance': return 2;
    case 'addTaskGeneral': return 2;
    case 'finalizeOrder': return 1;
    default: return 1;
  }
}
function itemOperationId(item: WorkItem, index: number): string {
  return item.kind === 'action' ? item.operationId : `field-${index + 1}-${item.maintenanceId}-${item.entity}-${item.field}`;
}
function finalStep(item: WorkItem): string {
  if (item.kind === 'field') return 'write';
  if (item.action === 'addActivity') return 'reply';
  if (item.action === 'addImage') return 'attach';
  if (item.action === 'ensureEquipmentMaintenance') return 'ensure';
  if (item.action === 'addTaskGeneral') return 'task';
  if (item.action === 'finalizeOrder') return 'finalize';
  return 'visibility';
}
async function detailFor(maintenanceId: string, token: string): Promise<JsonRecord> {
  return record(await fetchApiJson<unknown>(`/maintenance/${encodeURIComponent(maintenanceId)}/detail`, token), 'mantenimiento actual');
}
function responseId(value: unknown): string | undefined {
  const root = value && typeof value === 'object' ? value as JsonRecord : {}; return idOf(root._id) ?? idOf(root.id) ?? idOf((root.activity as JsonRecord | undefined)?._id) ?? idOf((root.file as JsonRecord | undefined)?._id) ?? idOf((root.data as JsonRecord | undefined)?._id);
}
function producedFromSteps(steps: AuditStep[]): Map<string, ProducedIds> {
  const map = new Map<string, ProducedIds>();
  for (const step of steps) {
    if (!['completed', 'alreadyApplied'].includes(step.status)) continue;
    const entry = map.get(step.operationId) ?? {};
    if (step.maintenanceId) entry.maintenanceId = step.maintenanceId;
    if (step.taskId) entry.taskId = step.taskId;
    if (step.activityId) entry.activityId = step.activityId;
    if (step.fileId) entry.fileId = step.fileId;
    map.set(step.operationId, entry);
  }
  return map;
}
function actionTargets(item: ReviewAction, produced: Map<string, ProducedIds>): Targets {
  const maintenanceId = item.maintenanceRef ? produced.get(item.maintenanceRef)?.maintenanceId : item.maintenanceId;
  const taskId = item.taskRef ? produced.get(item.taskRef)?.taskId : item.taskId;
  const activityId = item.activityRef ? produced.get(item.activityRef)?.activityId : item.activityId;
  const unresolved = (item.maintenanceRef !== undefined && !maintenanceId) || (item.taskRef !== undefined && !taskId) || (item.activityRef !== undefined && !activityId);
  return { maintenanceId, taskId, activityId, unresolved };
}
function maintenanceLinksOf(order: JsonRecord): Array<{ maintenanceId: string; equipmentId?: string }> {
  const links = Array.isArray(order.maintenances) ? order.maintenances : []; const out: Array<{ maintenanceId: string; equipmentId?: string }> = [];
  for (const raw of links) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const link = raw as JsonRecord; const maintenanceId = idOf(link.maintenance) ?? idOf(link.maintenanceId);
    if (maintenanceId) out.push({ maintenanceId, equipmentId: idOf(link.equipment) });
  }
  return out;
}
function maintenanceIdsForEquipment(order: JsonRecord, equipmentId: string): string[] {
  return [...new Set(maintenanceLinksOf(order).filter((link) => link.equipmentId === equipmentId).map((link) => link.maintenanceId))];
}
type EnsureClass = { status: 'alreadyApplied'; maintenanceId: string } | { status: 'pending'; writes: 1 | 2 } | { status: 'ambiguous'; reason: string };
function classifyEnsure(order: JsonRecord, equipmentId: string): EnsureClass {
  const listed = equipmentIdsOf(order).filter((id) => id === equipmentId).length;
  const maintenanceIds = maintenanceIdsForEquipment(order, equipmentId);
  if (listed > 1) return { status: 'ambiguous', reason: `el equipo ${equipmentId} aparece ${listed} veces en la orden` };
  if (maintenanceIds.length > 1) return { status: 'ambiguous', reason: `el equipo ${equipmentId} tiene ${maintenanceIds.length} mantenimientos asociados` };
  if (listed >= 1) {
    if (maintenanceIds.length === 1) return { status: 'alreadyApplied', maintenanceId: maintenanceIds[0] };
    return { status: 'pending', writes: 1 };
  }
  if (maintenanceIds.length === 1) return { status: 'alreadyApplied', maintenanceId: maintenanceIds[0] };
  return { status: 'pending', writes: 2 };
}
function stateNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}
type FinalizeClass =
  | { status: 'alreadyApplied'; state?: number; close: boolean; reason: 'finalized' | 'closed' }
  | { status: 'pending'; state: 2; close: boolean }
  | { status: 'unsupported'; state: unknown };
/**
 * Solo se acredita una transición: `state = 2` → `state = 3` mediante
 * `PUT /order/{orderId}` con `{"state":3}`. Un estado posterior o cerrado se
 * respeta sin degradarlo; cualquier otro estado queda sin contrato y se bloquea.
 */
function classifyFinalize(order: JsonRecord): FinalizeClass {
  const state = stateNumber(order.state);
  const close = order.close === true;
  if (state === 3) return { status: 'alreadyApplied', state, close, reason: 'finalized' };
  if (close) return { status: 'alreadyApplied', state, close, reason: 'closed' };
  if (state === 6) return { status: 'alreadyApplied', state, close, reason: 'closed' };
  if (state === 2) return { status: 'pending', state: 2, close };
  return { status: 'unsupported', state: order.state };
}
function unsupportedTransition(operationId: string, state: unknown): Error {
  return Object.assign(new Error(`Transición no soportada en ${operationId}: unsupported_order_state_transition (state=${String(state ?? '(sin estado)')}).`), { code: 'unsupported_order_state_transition' });
}
function assertOrderCode(order: JsonRecord, code: string): void {
  const actual = normalizeCode(order.code); const expected = normalizeCode(code);
  if (!actual || !expected || actual !== expected) throw new Error(`Conflicto: el ID de orden corresponde a ${String(order.code ?? '(sin código)')}, no a ${code}.`);
}
function compareProtected(order: JsonRecord, approved: JsonRecord): string | undefined {
  for (const field of PROTECTED_ORDER_FIELDS) {
    if (approved[field] === undefined) continue;
    if (!equalFieldValue(order[field], approved[field])) return field;
  }
  return undefined;
}
type TaskGuard = { status: 'alreadyApplied'; taskId: string } | { status: 'pending' } | { status: 'blocked' } | { status: 'ambiguous'; reason: string };
function taskGuard(detail: JsonRecord, requestedName?: string): TaskGuard {
  const tasks = tasksOf(detail); const desired = normalizeName(requestedName ?? 'General');
  const matches = tasks.filter((task) => normalizeName(String(task.name ?? '')) === desired);
  if (matches.length === 1) {
    const taskId = idOf(matches[0]._id);
    if (!taskId) return { status: 'ambiguous', reason: 'la tarea equivalente no tiene _id' };
    return { status: 'alreadyApplied', taskId };
  }
  if (matches.length > 1) return { status: 'ambiguous', reason: `hay ${matches.length} tareas equivalentes` };
  if (tasks.length === 0) return { status: 'pending' };
  return { status: 'blocked' };
}
function extraActivityMatching(task: JsonRecord, extras: string[], proposed: JsonRecord): string | undefined {
  const desiredName = normalizeName(String(proposed.name ?? '')); const desiredReply = String(proposed.reply ?? '');
  const matches = activitiesOf(task).filter((activity) => {
    const id = idOf(activity);
    return Boolean(id && extras.includes(id) && normalizeName(String(activity.name ?? '')) === desiredName && String(activity.reply ?? '') === desiredReply);
  });
  return matches.length === 1 ? idOf(matches[0]) : undefined;
}

export async function applyReview(draftPath: string, options: ApplyReviewOptions): Promise<ApplyReviewResult> {
  const dryRun = !options.confirm; const draft = await readJson(draftPath, 'borrador'); const parsed = parseReview(draft, !dryRun);
  const contract = parseContract(await readJson(options.contractPath, 'contrato de escritura'));
  if (parsed.schemaVersion === '1.2' && contract.schemaVersion !== '1.2') throw new Error('Un borrador schemaVersion "1.2" exige un contrato schemaVersion "1.2". No se reinterpreta como un contrato anterior.');
  for (const item of parsed.items) {
    if (item.kind === 'field') {
      const field = contract.operations[item.entity]?.fields[item.field]; if (!field) throw new Error(`El contrato no autoriza ${item.entity}.${item.field}.`);
      if (equal(item.original, item.proposed) && field.originalPath === field.verifyPath) throw new Error(`No se puede forzar ${item.entity}.${item.field}: el contrato no distingue corrección y valor original.`);
      continue;
    }
    const actionContract = contract.actions[item.action];
    if (!actionContract) throw new Error(`El contrato no autoriza ${item.action}.`);
    if (item.action === 'ensureEquipmentMaintenance' && (!actionContract.linkEquipment || !actionContract.createMaintenance)) throw new Error('El contrato no define linkEquipment y createMaintenance para ensureEquipmentMaintenance.');
    if (item.action === 'addTaskGeneral' && !actionContract.create) throw new Error('El contrato no define create para addTaskGeneral.');
    if (item.action === 'addImage') {
      if (!actionContract.attach) throw new Error('El contrato no define attach para addImage.');
      if (item.source && !actionContract.upload) throw new Error('El contrato no define upload para addImage con archivo nuevo.');
    }
    if (item.action === 'addActivity' && (!actionContract.create || !actionContract.name || !actionContract.reply)) throw new Error('El contrato no define create, name y reply para addActivity.');
    if (item.action === 'finalizeOrder' && !actionContract.update) throw new Error('El contrato no define update para finalizeOrder.');
  }
  const maxChanges = options.maxChanges ?? 20;
  if (!Number.isInteger(maxChanges) || maxChanges < 1) throw new Error('maxChanges debe ser un entero positivo.');
  const estimatedTotal = parsed.items.reduce((sum, item) => sum + estimatedWrites(item), 0);
  if (estimatedTotal > maxChanges) throw new Error(`La revisión contiene ${estimatedTotal} escrituras y supera el límite de seguridad de ${maxChanges}. Divide el lote o aumenta --max-changes tras revisar la simulación.`);
  for (const item of parsed.items) if (item.kind === 'action' && item.source && await sha256File(item.source.path) !== item.source.sha256) throw new Error(`El SHA-256 de ${item.operationId} no coincide con la imagen aprobada.`);

  const reviewSha256 = await sha256File(draftPath); const contractSha256 = await sha256File(options.contractPath);
  let resume: ApplyReviewResult | undefined;
  if (options.resumeAuditPath) {
    resume = await readJson(options.resumeAuditPath, 'auditoría de reanudación') as unknown as ApplyReviewResult;
    if (resume.audit?.reviewSha256 !== reviewSha256 || resume.audit?.contractSha256 !== contractSha256) throw new Error('La auditoría de reanudación no corresponde a esta revisión y contrato.');
  }
  let token = await getAuthenticatedToken(options.autoLogin ?? true);
  const authed = async <T>(operation: (current: string) => Promise<T>): Promise<T> => {
    try { return await operation(token); }
    catch (error) { if (!(options.autoLogin ?? true) || !isAuthError(error)) throw error; token = await loginDirect(); return operation(token); }
  };
  const loadDetail = (id: string): Promise<JsonRecord> => authed((current) => detailFor(id, current));
  const loadOrder = (orderId: string): Promise<JsonRecord> => authed(async (current) => {
    const response = record(await fetchApiJson<unknown>(`/order/${encodeURIComponent(orderId)}/detail?full=true`, current), 'detalle de orden');
    return response.doc === undefined ? response : record(response.doc, 'doc de orden');
  });

  const details = new Map<string, JsonRecord>();
  const liveDetail = async (id: string): Promise<JsonRecord> => {
    const cached = details.get(id); if (cached) return cached;
    const detail = await loadDetail(id); details.set(id, detail); return detail;
  };
  const orders = new Map<string, JsonRecord>();
  const liveOrder = async (id: string): Promise<JsonRecord> => {
    const cached = orders.get(id); if (cached) return cached;
    const order = await loadOrder(id); orders.set(id, order); return order;
  };
  const requireResolved = (value: string | undefined, label: string, operationId: string): string => {
    if (!value) throw new Error(`No se pudo resolver ${label} de ${operationId}.`);
    return value;
  };

  const pending: WorkItem[] = []; const alreadyApplied: WorkItem[] = [];
  const resolvedProducerSteps: AuditStep[] = [];
  const runtimeProduced = new Map<string, ProducedIds>(producedFromSteps(resume?.steps ?? []));
  for (let index = 0; index < parsed.items.length; index += 1) {
    const item = parsed.items[index]; const operationId = itemOperationId(item, index);
    const priorDone = resume?.steps.some((step) => step.operationId === operationId && step.step === finalStep(item) && ['completed', 'alreadyApplied'].includes(step.status));
    if (priorDone) { alreadyApplied.push(item); continue; }
    if (item.kind === 'field') {
      const field = contract.operations[item.entity]!.fields[item.field]; item.writes = 1;
      (stateOf(entityCurrent(await liveDetail(item.maintenanceId), item), field, item) === 'alreadyApplied' ? alreadyApplied : pending).push(item); continue;
    }
    if (item.action === 'finalizeOrder') {
      const orderId = requireResolved(parsed.orderId, 'orderId', operationId);
      const order = await liveOrder(orderId); assertOrderCode(order, parsed.orderCode);
      const classification = classifyFinalize(order);
      if (classification.status === 'unsupported') throw unsupportedTransition(operationId, classification.state);
      if (classification.status === 'alreadyApplied') {
        item.writes = 0; alreadyApplied.push(item);
        resolvedProducerSteps.push({ operationId, action: item.action, step: 'finalize', status: 'alreadyApplied', orderId, stateBefore: classification.state, stateAfter: classification.state, closeBefore: classification.close, closeAfter: classification.close });
        continue;
      }
      item.writes = 1; pending.push(item); continue;
    }
    if (item.action === 'ensureEquipmentMaintenance') {
      const orderId = requireResolved(parsed.orderId, 'orderId', operationId); const equipmentId = item.equipmentId!;
      const order = await liveOrder(orderId); assertOrderCode(order, parsed.orderCode);
      const classification = classifyEnsure(order, equipmentId);
      if (classification.status === 'ambiguous') throw new Error(`Bloqueado en ${operationId}: ${classification.reason}.`);
      if (classification.status === 'alreadyApplied') {
        item.writes = 0; alreadyApplied.push(item); runtimeProduced.set(operationId, { maintenanceId: classification.maintenanceId });
        resolvedProducerSteps.push({ operationId, action: item.action, step: 'ensure', status: 'alreadyApplied', orderId, maintenanceId: classification.maintenanceId });
        continue;
      }
      if (classification.writes === 2) {
        if (!parsed.orderApproved) throw new Error(`Bloqueado en ${operationId}: se requiere order.approved para vincular un equipo sin sobrescribir el estado vivo.`);
        const mismatch = compareProtected(order, parsed.orderApproved);
        if (mismatch) throw new Error(`Conflicto en ${operationId}: el campo protegido ${mismatch} cambió en SIYS desde la revisión.`);
      }
      item.writes = classification.writes; pending.push(item); continue;
    }
    if (item.action === 'addTaskGeneral') {
      item.writes = item.name && normalizeName(item.name) !== 'general' ? 2 : 1;
      const maintenanceId = item.maintenanceRef ? runtimeProduced.get(item.maintenanceRef)?.maintenanceId : item.maintenanceId;
      if (!maintenanceId) { pending.push(item); continue; }
      const guard = taskGuard(await liveDetail(maintenanceId), item.name);
      if (guard.status === 'alreadyApplied') { item.writes = 0; alreadyApplied.push(item); runtimeProduced.set(operationId, { taskId: guard.taskId }); resolvedProducerSteps.push({ operationId, action: item.action, step: 'task', status: 'alreadyApplied', maintenanceId, taskId: guard.taskId }); continue; }
      if (guard.status === 'ambiguous') throw new Error(`Bloqueado en ${operationId}: ${guard.reason}.`);
      if (guard.status === 'blocked') throw new Error(`Bloqueado en ${operationId}: generic_task_create_not_supported.`);
      pending.push(item); continue;
    }
    item.writes = estimatedWrites(item);
    const targets = actionTargets(item, runtimeProduced);
    if (targets.unresolved) { pending.push(item); continue; }
    if (item.action === 'addActivity') {
      const detail = await liveDetail(requireResolved(targets.maintenanceId, 'maintenanceId', operationId)); const taskId = requireResolved(targets.taskId, 'taskId', operationId);
      const currentIds = idsOf(taskCurrent(detail, taskId).task.activitys);
      const priorCreate = resume?.steps.find((step) => step.operationId === operationId && step.step === 'create' && step.status === 'completed');
      if (priorCreate?.activityId) {
        if (!currentIds.includes(priorCreate.activityId)) throw new Error(`Conflicto en ${operationId}: la actividad creada ya no existe.`);
      } else if (!equal(currentIds, item.original.activityIds)) throw new Error(`Conflicto en ${operationId}: cambió la lista de actividades.`);
      pending.push(item); continue;
    }
    const maintenanceId = requireResolved(targets.maintenanceId, 'maintenanceId', operationId); const taskId = requireResolved(targets.taskId, 'taskId', operationId); const activityId = requireResolved(targets.activityId, 'activityId', operationId);
    const { activity } = activityCurrent(await liveDetail(maintenanceId), taskId, activityId);
    if (item.action === 'addImage') {
      if (!equal(idsOf(activity.file), item.original.fileIds)) throw new Error(`Conflicto en ${item.operationId}: cambió la lista de imágenes.`);
      pending.push(item); continue;
    }
    const desired = bool(item.proposed!.visible, `${item.operationId}.proposed.visible`);
    const current = item.action === 'setImageVisibility' ? imageVisible(activity, item.fileId!) : activity.visible !== false;
    if (current === desired) alreadyApplied.push(item);
    else if (current !== bool(item.original.visible, `${item.operationId}.original.visible`)) throw new Error(`Conflicto en ${item.operationId}: cambió la visibilidad.`);
    else pending.push(item);
  }
  const plannedWrites = parsed.items.reduce((sum, item) => sum + (item.writes ?? estimatedWrites(item)), 0);
  const result: ApplyReviewResult = {
    dryRun, orderCode: parsed.orderCode, planned: pending, applied: [], alreadyApplied, plannedWrites,
    steps: resume?.steps ? [...resume.steps] : [],
    audit: { generatedAt: new Date().toISOString(), contractPath: path.resolve(options.contractPath), contractSha256, reviewPath: path.resolve(draftPath), reviewSha256, resumeAuditPath: options.resumeAuditPath && path.resolve(options.resumeAuditPath), orderId: parsed.orderId, status: dryRun ? 'planned' : 'in_progress' },
  };
  if (dryRun) return result;

  const progress = async (step: AuditStep): Promise<void> => { result.steps.push(step); await options.onProgress?.(result); };
  const delay = async (): Promise<void> => { if ((options.delayMs ?? 350) > 0) await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 350)); };
  const sendVerified = async (endpoint: string, method: HttpMethod, body: JsonRecord | undefined, responseKind: ResponseKind, verify: () => Promise<boolean>, step: AuditStep): Promise<void> => {
    try {
      await sendApiJson(endpoint, token, method, body, options.timeoutMs, { responseType: responseKind });
    } catch (error) {
      if (!isAmbiguousWrite(error)) throw error;
      if (await verify()) { await progress({ ...step, status: 'completed' }); await delay(); return; }
      result.audit.status = 'ambiguous';
      await progress({ ...step, status: 'ambiguous', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (!await verify()) throw new Error(`Verificación fallida para ${step.operationId}.${step.step}.`);
    await progress({ ...step, status: 'completed' }); await delay();
  };
  const createdActivities = new Map<string, Set<string>>();

  try {
    for (const step of resolvedProducerSteps) await progress(step);
    for (const item of pending) {
      const index = parsed.items.indexOf(item); const operationId = itemOperationId(item, index);
      if (item.kind === 'field') {
        const detail = await loadDetail(item.maintenanceId); const operation = contract.operations[item.entity]!; const field = operation.fields[item.field];
        if (stateOf(entityCurrent(detail, item), field, item) === 'alreadyApplied') {
          result.alreadyApplied.push(item); await progress({ operationId, action: `${item.entity}.${item.field}`, step: 'write', status: 'alreadyApplied', maintenanceId: item.maintenanceId, taskId: item.taskId, activityId: item.activityId }); continue;
        }
        const body: JsonRecord = {}; setPath(body, field.bodyPath, item.proposed);
        await sendVerified(endpointFor(field.path ?? operation.path, item), field.method ?? operation.method, body, 'json', async () => equal(getPath(entityCurrent(await loadDetail(item.maintenanceId), item), field.verifyPath), item.proposed), { operationId, action: `${item.entity}.${item.field}`, step: 'write', status: 'completed', maintenanceId: item.maintenanceId, taskId: item.taskId, activityId: item.activityId });
        result.applied.push(item); continue;
      }
      if (item.action === 'finalizeOrder') {
        const orderId = requireResolved(parsed.orderId, 'orderId', operationId);
        const update = contract.actions[item.action]!.update!;
        const plan = await loadOrder(orderId); assertOrderCode(plan, parsed.orderCode);
        const planned = classifyFinalize(plan);
        if (planned.status === 'unsupported') {
          result.audit.status = 'failed';
          await progress({ operationId, action: item.action, step: 'finalize', status: 'failed', orderId, stateBefore: stateNumber(planned.state), error: 'unsupported_order_state_transition' });
          throw unsupportedTransition(operationId, planned.state);
        }
        if (planned.status === 'alreadyApplied') {
          item.writes = 0; result.alreadyApplied.push(item);
          await progress({ operationId, action: item.action, step: 'finalize', status: 'alreadyApplied', orderId, stateBefore: planned.state, stateAfter: planned.state, closeBefore: planned.close, closeAfter: planned.close });
          continue;
        }
        const stateBefore = planned.state; const closeBefore = planned.close;
        const fresh = await loadOrder(orderId); assertOrderCode(fresh, parsed.orderCode);
        const rechecked = classifyFinalize(fresh);
        if (rechecked.status === 'unsupported') {
          result.audit.status = 'failed';
          await progress({ operationId, action: item.action, step: 'finalize', status: 'failed', orderId, stateBefore, error: 'unsupported_order_state_transition' });
          throw unsupportedTransition(operationId, rechecked.state);
        }
        if (rechecked.status === 'alreadyApplied') {
          item.writes = 0; result.alreadyApplied.push(item);
          await progress({ operationId, action: item.action, step: 'finalize', status: 'alreadyApplied', orderId, stateBefore, stateAfter: rechecked.state, closeBefore, closeAfter: rechecked.close });
          continue;
        }
        const closeImmediatelyBefore = rechecked.close;
        let writeError: unknown;
        try { await sendApiJson(endpointFor(update.path, { orderId }), token, update.method, { state: 3 }, options.timeoutMs, { responseType: update.response }); }
        catch (error) {
          writeError = error;
          if (!isAmbiguousWrite(error)) {
            result.audit.status = 'failed';
            await progress({ operationId, action: item.action, step: 'finalize', status: 'failed', orderId, stateBefore, error: error instanceof Error ? error.message : String(error) });
            throw error;
          }
        }
        const after = await loadOrder(orderId);
        const stateAfter = stateNumber(after.state); const closeAfter = after.close === true;
        if (stateAfter === 3) {
          if (closeAfter !== closeImmediatelyBefore) {
            result.audit.status = 'ambiguous';
            const message = 'unexpected_close_transition: finalizeOrder cambió close junto con state=3; no se reintentará.';
            await progress({ operationId, action: item.action, step: 'finalize', status: 'ambiguous', orderId, stateBefore, stateAfter, closeBefore: closeImmediatelyBefore, closeAfter, error: message });
            throw new Error(message);
          }
          item.writes = 1; result.applied.push(item);
          await progress({ operationId, action: item.action, step: 'finalize', status: 'completed', orderId, stateBefore, stateAfter: 3, closeBefore: closeImmediatelyBefore, closeAfter });
          await delay(); continue;
        }
        if (writeError) {
          result.audit.status = 'ambiguous';
          const message = writeError instanceof Error ? writeError.message : String(writeError);
          await progress({ operationId, action: item.action, step: 'finalize', status: 'ambiguous', orderId, stateBefore, stateAfter, closeBefore: closeImmediatelyBefore, closeAfter, error: message });
          throw writeError instanceof Error ? writeError : new Error(message);
        }
        result.audit.status = 'failed';
        const message = `Verificación fallida para ${operationId}.finalize: state=${String(after.state ?? '(sin estado)')}.`;
        await progress({ operationId, action: item.action, step: 'finalize', status: 'failed', orderId, stateBefore, stateAfter, closeBefore: closeImmediatelyBefore, closeAfter, error: message });
        throw new Error(message);
      }
      const actionContract = contract.actions[item.action]!;
      const targets = actionTargets(item, runtimeProduced);
      if (item.action === 'ensureEquipmentMaintenance') {
        const orderId = requireResolved(parsed.orderId, 'orderId', operationId); const equipmentId = item.equipmentId!;
        const link = actionContract.linkEquipment!; const create = actionContract.createMaintenance!;
        let order = await loadOrder(orderId); assertOrderCode(order, parsed.orderCode);
        const classification = classifyEnsure(order, equipmentId);
        if (classification.status === 'ambiguous') { result.audit.status = 'ambiguous'; await progress({ operationId, action: item.action, step: 'ensure', status: 'ambiguous', orderId, error: classification.reason }); throw new Error(`Bloqueado en ${operationId}: ${classification.reason}.`); }
        if (classification.status === 'alreadyApplied') {
          runtimeProduced.set(operationId, { maintenanceId: classification.maintenanceId }); result.alreadyApplied.push(item);
          await progress({ operationId, action: item.action, step: 'ensure', status: 'alreadyApplied', orderId, maintenanceId: classification.maintenanceId }); continue;
        }
        let maintenanceId: string | undefined;
        if (classification.writes === 2) {
          const freshOrder = await loadOrder(orderId);
          if (!parsed.orderApproved) throw new Error(`Bloqueado en ${operationId}: se requiere order.approved para vincular un equipo nuevo.`);
          const mismatch = compareProtected(freshOrder, parsed.orderApproved);
          if (mismatch) throw new Error(`Conflicto en ${operationId}: el campo protegido ${mismatch} cambió en SIYS antes de vincular el equipo.`);
          const body = orderFormPutBody(freshOrder, equipmentId);
          await sendVerified(endpointFor(link.path, { orderId }), link.method, body, link.response, async () => equipmentIdsOf(await loadOrder(orderId)).filter((id) => id === equipmentId).length === 1, { operationId, action: item.action, step: 'equipmentLink', status: 'completed', orderId });
        }
        order = await loadOrder(orderId);
        const linked = maintenanceIdsForEquipment(order, equipmentId);
        if (linked.length > 1) { result.audit.status = 'ambiguous'; const message = `El equipo ${equipmentId} quedó con ${linked.length} mantenimientos; no se puede atribuir.`; await progress({ operationId, action: item.action, step: 'createMaintenance', status: 'ambiguous', orderId, error: message }); throw new Error(message); }
        if (linked.length === 1) {
          maintenanceId = linked[0]; await progress({ operationId, action: item.action, step: 'createMaintenance', status: 'alreadyApplied', orderId, maintenanceId });
        } else {
          const input = item.maintenance!;
          const body: JsonRecord = { equipment: equipmentId, order: orderId, preview: false, user: input.user, equipmentState: input.equipmentState, start: input.start, end: input.end, ...(input.observations === undefined ? {} : { observations: input.observations }) };
          let postError: unknown;
          try { await sendApiJson(endpointFor(create.path, { orderId, equipmentId }), token, create.method, body, options.timeoutMs, { responseType: create.response }); }
          catch (error) { postError = error; }
          const afterLinks = maintenanceIdsForEquipment(await loadOrder(orderId), equipmentId);
          if (afterLinks.length === 1) {
            maintenanceId = afterLinks[0]; await progress({ operationId, action: item.action, step: 'createMaintenance', status: 'completed', orderId, maintenanceId });
          } else if (afterLinks.length === 0) {
            if (postError && !isAmbiguousWrite(postError)) { await progress({ operationId, action: item.action, step: 'createMaintenance', status: 'failed', orderId, error: postError instanceof Error ? postError.message : String(postError) }); throw postError; }
            result.audit.status = 'ambiguous'; const message = postError instanceof Error ? postError.message : `No se pudo confirmar el mantenimiento del equipo ${equipmentId}.`;
            await progress({ operationId, action: item.action, step: 'createMaintenance', status: 'ambiguous', orderId, error: message }); throw postError instanceof Error ? postError : new Error(message);
          } else {
            result.audit.status = 'ambiguous'; const message = `El equipo ${equipmentId} quedó con ${afterLinks.length} mantenimientos; no se puede atribuir el creado.`;
            await progress({ operationId, action: item.action, step: 'createMaintenance', status: 'ambiguous', orderId, error: message }); throw new Error(message);
          }
        }
        runtimeProduced.set(operationId, { maintenanceId }); result.applied.push(item);
        await progress({ operationId, action: item.action, step: 'ensure', status: 'completed', orderId, maintenanceId }); continue;
      }
      if (item.action === 'addTaskGeneral') {
        const maintenanceId = requireResolved(targets.maintenanceId, 'maintenanceId', operationId); const create = actionContract.create!;
        const guard = taskGuard(await loadDetail(maintenanceId), item.name);
        if (guard.status === 'alreadyApplied') {
          runtimeProduced.set(operationId, { maintenanceId, taskId: guard.taskId }); result.alreadyApplied.push(item);
          await progress({ operationId, action: item.action, step: 'task', status: 'alreadyApplied', maintenanceId, taskId: guard.taskId }); continue;
        }
        if (guard.status === 'ambiguous') throw new Error(`Bloqueado en ${operationId}: ${guard.reason}.`);
        if (guard.status === 'blocked') { result.audit.status = 'failed'; await progress({ operationId, action: item.action, step: 'task', status: 'failed', maintenanceId, error: 'generic_task_create_not_supported' }); throw new Error(`Bloqueado en ${operationId}: generic_task_create_not_supported.`); }
        const before = tasksOf(await loadDetail(maintenanceId)).map((task) => idOf(task._id)).filter((id): id is string => Boolean(id));
        let createError: unknown;
        try { await sendApiJson(endpointFor(create.path, { maintenanceId }), token, create.method, undefined, options.timeoutMs, { responseType: create.response }); }
        catch (error) { createError = error; }
        const afterIds = tasksOf(await loadDetail(maintenanceId)).map((task) => idOf(task._id)).filter((id): id is string => Boolean(id));
        const newIds = afterIds.filter((id) => !before.includes(id));
        let taskId: string;
        if (newIds.length === 1) {
          taskId = newIds[0]; await progress({ operationId, action: item.action, step: 'create', status: 'completed', maintenanceId, taskId }); await delay();
        } else if (newIds.length === 0) {
          if (createError && !isAmbiguousWrite(createError)) { await progress({ operationId, action: item.action, step: 'create', status: 'failed', maintenanceId, error: createError instanceof Error ? createError.message : String(createError) }); throw createError; }
          result.audit.status = 'ambiguous'; const message = createError instanceof Error ? createError.message : 'No se pudo confirmar la tarea General.';
          await progress({ operationId, action: item.action, step: 'create', status: 'ambiguous', maintenanceId, error: message }); throw createError instanceof Error ? createError : new Error(message);
        } else {
          result.audit.status = 'ambiguous'; const message = `Se detectaron ${newIds.length} tareas nuevas; no se puede atribuir la creada.`;
          await progress({ operationId, action: item.action, step: 'create', status: 'ambiguous', maintenanceId, error: message }); throw new Error(message);
        }
        if (item.name) {
          const current = taskCurrent(await loadDetail(maintenanceId), taskId).task;
          if (normalizeName(String(current.name ?? '')) !== normalizeName(item.name)) {
            const operation = contract.operations.task; const field = operation?.fields.name;
            if (!operation || !field) throw new Error(`El contrato no autoriza task.name para renombrar la tarea de ${operationId}.`);
            const body: JsonRecord = {}; setPath(body, field.bodyPath, item.name);
            await sendVerified(endpointFor(field.path ?? operation.path, { maintenanceId, taskId }), field.method ?? operation.method, body, 'json', async () => normalizeName(String(getPath(taskCurrent(await loadDetail(maintenanceId), taskId).task, field.verifyPath) ?? '')) === normalizeName(item.name!), { operationId, action: item.action, step: 'rename', status: 'completed', maintenanceId, taskId });
          }
        }
        runtimeProduced.set(operationId, { maintenanceId, taskId }); result.applied.push(item);
        await progress({ operationId, action: item.action, step: 'task', status: 'completed', maintenanceId, taskId }); continue;
      }
      if (item.action === 'addActivity') {
        const maintenanceId = requireResolved(targets.maintenanceId, 'maintenanceId', operationId); const taskId = requireResolved(targets.taskId, 'taskId', operationId);
        let activityId = result.steps.find((step) => step.operationId === operationId && step.step === 'create' && step.status === 'completed')?.activityId;
        const taskKey = `${maintenanceId}|${taskId}`;
        if (!activityId) {
          const task = taskCurrent(await loadDetail(maintenanceId), taskId).task;
          const current = idsOf(task.activitys); const baseline = item.original.activityIds as string[];
          const batchCreated = createdActivities.get(taskKey) ?? new Set<string>();
          if (!equal(current, baseline) && !equal(current, [...baseline, ...batchCreated])) {
            const extras = current.filter((id) => !baseline.includes(id) && !batchCreated.has(id));
            const matched = extraActivityMatching(task, extras, item.proposed!);
            if (matched) { activityId = matched; await progress({ operationId, action: item.action, step: 'create', status: 'alreadyApplied', maintenanceId, taskId, activityId: matched }); }
            else throw new Error(`Conflicto en ${operationId}: la lista de actividades cambió justo antes de crear; no se envió el PATCH.`);
          }
          if (!activityId) {
            const before = current; let createError: unknown;
            try { await sendApiJson(endpointFor(actionContract.create!.path, { maintenanceId, taskId }), token, actionContract.create!.method, undefined, options.timeoutMs, { responseType: actionContract.create!.response }); }
            catch (error) { createError = error; }
            const afterIds = idsOf(taskCurrent(await loadDetail(maintenanceId), taskId).task.activitys);
            const newIds = afterIds.filter((id) => !before.includes(id) && !batchCreated.has(id));
            if (newIds.length === 1) { activityId = newIds[0]; }
            else if (newIds.length === 0) {
              if (createError && !isAmbiguousWrite(createError)) throw createError;
              result.audit.status = 'ambiguous'; const message = createError instanceof Error ? createError.message : `No se creó la actividad de ${operationId}.`;
              await progress({ operationId, action: item.action, step: 'create', status: 'ambiguous', maintenanceId, taskId, error: message }); throw createError instanceof Error ? createError : new Error(message);
            } else {
              result.audit.status = 'ambiguous'; throw new Error(`No se pudo identificar inequívocamente la actividad creada por ${operationId}.`);
            }
            batchCreated.add(activityId); createdActivities.set(taskKey, batchCreated);
            await progress({ operationId, action: item.action, step: 'create', status: 'completed', maintenanceId, taskId, activityId }); await delay();
          }
        }
        for (const fieldName of ['name', 'reply'] as const) {
          const endpoint = actionContract[fieldName]!; const body: JsonRecord = {}; setPath(body, endpoint.bodyPath ?? 'reply', item.proposed![fieldName]);
          const priorStep = result.steps.find((step) => step.operationId === operationId && step.step === fieldName && step.status === 'completed');
          if (priorStep) continue;
          await sendVerified(endpointFor(endpoint.path, { maintenanceId, taskId, activityId }), endpoint.method, body, endpoint.response, async () => {
            const current = activityCurrent(await loadDetail(maintenanceId), taskId, activityId!).activity;
            return equal(getPath(current, endpoint.verifyPath ?? `${fieldName}Corrected.reply`), item.proposed![fieldName]);
          }, { operationId, action: item.action, step: fieldName, status: 'completed', maintenanceId, taskId, activityId });
        }
        runtimeProduced.set(operationId, { maintenanceId, taskId, activityId }); result.applied.push(item); continue;
      }
      if (item.action === 'addImage') {
        const maintenanceId = requireResolved(targets.maintenanceId, 'maintenanceId', operationId); const taskId = requireResolved(targets.taskId, 'taskId', operationId); const activityId = requireResolved(targets.activityId, 'activityId', operationId);
        const attach = actionContract.attach!;
        const priorUpload = result.steps.find((step) => step.operationId === operationId && step.step === 'upload' && step.status === 'completed')?.fileId;
        let fileId = priorUpload ?? item.fileId;
        if (!fileId) {
          const upload = actionContract.upload!; const content = (await fs.readFile(item.source!.path)).toString('base64'); let uploaded: unknown;
          try { uploaded = await sendApiJson(upload.path, token, upload.method, { content, folder: upload.folder ?? 'maintenance-files', miniatura: upload.miniatura ?? '1', fileName: path.basename(item.source!.path) }, options.timeoutMs, { responseType: upload.response }); }
          catch (error) { if (isAmbiguousWrite(error)) { await loadDetail(maintenanceId); result.audit.status = 'ambiguous'; await progress({ operationId, action: item.action, step: 'upload', status: 'ambiguous', maintenanceId, taskId, activityId, error: error instanceof Error ? error.message : String(error) }); } throw error; }
          fileId = responseId(uploaded); if (!fileId) throw new Error(`La carga de ${item.operationId} no devolvió fileId.`);
          await progress({ operationId, action: item.action, step: 'upload', status: 'completed', maintenanceId, taskId, activityId, fileId }); await delay();
        }
        const located = activityCurrent(await loadDetail(maintenanceId), taskId, activityId);
        if (idsOf(located.activity.file).includes(fileId)) {
          await progress({ operationId, action: item.action, step: 'attach', status: 'alreadyApplied', maintenanceId, taskId, activityId, fileId, taskIndex: located.taskIndex, activityIndex: located.activityIndex });
        } else {
          const attachPath = endpointFor(attach.path, { maintenanceId, taskId, activityId, fileId, taskIndex: located.taskIndex, activityIndex: located.activityIndex });
          await sendVerified(attachPath, attach.method, undefined, attach.response, async () => idsOf(activityCurrent(await loadDetail(maintenanceId), taskId, activityId).activity.file).includes(fileId!), { operationId, action: item.action, step: 'attach', status: 'completed', maintenanceId, taskId, activityId, fileId, taskIndex: located.taskIndex, activityIndex: located.activityIndex });
        }
        runtimeProduced.set(operationId, { maintenanceId, taskId, activityId, fileId }); result.applied.push(item); continue;
      }
      const maintenanceId = requireResolved(targets.maintenanceId, 'maintenanceId', operationId); const taskId = requireResolved(targets.taskId, 'taskId', operationId); const activityId = requireResolved(targets.activityId, 'activityId', operationId);
      const located = activityCurrent(await loadDetail(maintenanceId), taskId, activityId); const desired = bool(item.proposed!.visible, `${item.operationId}.proposed.visible`);
      if (item.action === 'setImageVisibility') {
        const toggle = actionContract.toggle!; const endpoint = endpointFor(toggle.path, { maintenanceId, taskId, activityId, fileId: item.fileId!, taskIndex: located.taskIndex, activityIndex: located.activityIndex });
        await sendVerified(endpoint, toggle.method, undefined, toggle.response, async () => imageVisible(activityCurrent(await loadDetail(maintenanceId), taskId, activityId).activity, item.fileId!) === desired, { operationId, action: item.action, step: 'visibility', status: 'completed', maintenanceId, taskId, activityId, fileId: item.fileId, taskIndex: located.taskIndex, activityIndex: located.activityIndex });
      } else {
        const update = actionContract.update!; const body: JsonRecord = {}; setPath(body, update.bodyPath ?? 'visible', desired);
        await sendVerified(endpointFor(update.path, { maintenanceId, taskId, activityId }), update.method, body, update.response, async () => (activityCurrent(await loadDetail(maintenanceId), taskId, activityId).activity.visible !== false) === desired, { operationId, action: item.action, step: 'visibility', status: 'completed', maintenanceId, taskId, activityId });
      }
      result.applied.push(item);
    }
    result.audit.status = 'completed'; await options.onProgress?.(result);
  } catch (error) {
    if (result.audit.status !== 'ambiguous') result.audit.status = 'failed';
    result.audit.error = error instanceof Error ? error.message : String(error);
    const lastItem = pending.find((item) => !result.applied.includes(item));
    if (lastItem && !result.steps.some((step) => step.operationId === (lastItem.kind === 'action' ? lastItem.operationId : itemOperationId(lastItem, parsed.items.indexOf(lastItem))) && ['failed', 'ambiguous'].includes(step.status))) {
      await progress({ operationId: lastItem.kind === 'action' ? lastItem.operationId : itemOperationId(lastItem, parsed.items.indexOf(lastItem)), action: lastItem.kind === 'action' ? lastItem.action : `${lastItem.entity}.${lastItem.field}`, step: 'operation', status: result.audit.status === 'ambiguous' ? 'ambiguous' : 'failed', maintenanceId: lastItem.kind === 'action' ? lastItem.maintenanceId : lastItem.maintenanceId, taskId: lastItem.taskId, activityId: lastItem.activityId, fileId: lastItem.kind === 'action' ? lastItem.fileId : undefined, error: result.audit.error });
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

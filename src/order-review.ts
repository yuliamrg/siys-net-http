import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchApiJson, sendApiJson } from './api.js';
import { getAuthenticatedToken, loginDirect } from './auth.js';
import { ensureDir, timestamp } from './utils.js';

type JsonRecord = Record<string, unknown>;
type EntityType = 'maintenance' | 'task' | 'activity';

interface FieldContract {
  originalPath: string;
  verifyPath: string;
  bodyPath: string;
  /** Some UI fields share an entity but are saved through distinct endpoints. */
  method?: 'PATCH' | 'PUT';
  path?: string;
}
interface OperationContract {
  method: 'PATCH' | 'PUT';
  path: string;
  fields: Record<string, FieldContract>;
}
interface WriteContract {
  schemaVersion: '1.0';
  enabled: true;
  operations: Partial<Record<EntityType, OperationContract>>;
}
interface Change {
  entity: EntityType;
  maintenanceId: string;
  taskId?: string;
  activityId?: string;
  field: string;
  original: unknown;
  proposed: unknown;
}
export interface ApplyReviewOptions {
  confirm?: boolean;
  autoLogin?: boolean;
  contractPath: string;
  delayMs?: number;
  timeoutMs?: number;
  maxChanges?: number;
  onProgress?: (result: ApplyReviewResult) => Promise<void>;
}
export interface ApplyReviewResult {
  dryRun: boolean;
  orderCode: string;
  planned: Change[];
  applied: Change[];
  /** Changes whose proposed value was already present in SIYS; no write was sent. */
  alreadyApplied: Change[];
  audit: { generatedAt: string; contractPath: string; status: 'planned' | 'completed' | 'failed'; error?: string };
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} inválido.`);
  return value as JsonRecord;
}
function string(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value : undefined; }
function equal(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function equalFieldValue(a: unknown, b: unknown): boolean { return (a === null && b === undefined) || (a === undefined && b === null) || equal(a, b); }
function isAuthError(error: unknown): boolean { return error instanceof Error && /\b(401|403)\b/.test(error.message); }

async function readJson(file: string, label: string): Promise<JsonRecord> {
  try { return record(JSON.parse(await fs.readFile(file, 'utf8')), label); }
  catch (error) { throw new Error(`No se pudo leer ${label} ${file}: ${error instanceof Error ? error.message : String(error)}`); }
}

function parseContract(value: JsonRecord): WriteContract {
  if (value.schemaVersion !== '1.0' || value.enabled !== true) {
    throw new Error('El contrato de escritura debe declarar schemaVersion "1.0" y enabled: true.');
  }
  const operations = record(value.operations, 'operations del contrato');
  const parsed: Partial<Record<EntityType, OperationContract>> = {};
  for (const entity of ['maintenance', 'task', 'activity'] as EntityType[]) {
    if (operations[entity] === undefined) continue;
    const item = record(operations[entity], `operación ${entity}`);
    const method = item.method;
    const endpoint = string(item.path);
    if ((method !== 'PATCH' && method !== 'PUT') || !endpoint || !endpoint.startsWith('/')) throw new Error(`Contrato inválido para ${entity}.`);
    const fieldsInput = record(item.fields, `campos de ${entity}`);
    const fields: Record<string, FieldContract> = {};
    for (const [field, raw] of Object.entries(fieldsInput)) {
      const fieldRecord = record(raw, `campo ${field}`);
      const legacyPath = string(fieldRecord.path);
      const endpointOverride = legacyPath?.startsWith('/') ? legacyPath : undefined;
      const originalPath = string(fieldRecord.originalPath) ?? legacyPath;
      const verifyPath = string(fieldRecord.verifyPath) ?? legacyPath;
      const bodyPath = string(fieldRecord.bodyPath) ?? legacyPath;
      if (!originalPath || !verifyPath || !bodyPath || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(originalPath) || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(verifyPath) || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(bodyPath)) throw new Error(`Ruta de campo inválida: ${field}.`);
      const fieldMethod = fieldRecord.method;
      if (fieldMethod !== undefined && fieldMethod !== 'PATCH' && fieldMethod !== 'PUT') throw new Error(`Método de campo inválido: ${field}.`);
      if (fieldMethod !== undefined && !endpointOverride) throw new Error(`La ruta de operación del campo ${field} debe comenzar con /.`);
      fields[field] = { originalPath, verifyPath, bodyPath, method: fieldMethod as FieldContract['method'], path: endpointOverride };
    }
    parsed[entity] = { method, path: endpoint, fields };
  }
  return { schemaVersion: '1.0', enabled: true, operations: parsed };
}

function stateOf(current: JsonRecord, field: FieldContract, change: Change): 'pending' | 'alreadyApplied' {
  const verified = getPath(current, field.verifyPath);
  if (equalFieldValue(verified, change.proposed)) return 'alreadyApplied';
  if (field.verifyPath !== field.originalPath && verified !== undefined && verified !== null && verified !== '') {
    throw new Error(`Conflicto en ${change.entity}.${change.field} (${change.maintenanceId}): ya existe una corrección distinta en SIYS.`);
  }
  if (!equalFieldValue(getPath(current, field.originalPath), change.original)) {
    throw new Error(`Conflicto en ${change.entity}.${change.field} (${change.maintenanceId}): SIYS cambió desde la revisión.`);
  }
  return 'pending';
}

function forcedFields(value: JsonRecord, label: string): Set<string> {
  if (value.forceApply === undefined) return new Set();
  if (!Array.isArray(value.forceApply) || value.forceApply.some((field) => typeof field !== 'string')) {
    throw new Error(`${label}.forceApply debe ser una lista de nombres de campo.`);
  }
  return new Set(value.forceApply as string[]);
}

function changesFromReview(review: JsonRecord): Change[] {
  const maintenanceId = string(review.maintenanceId);
  if (!maintenanceId) throw new Error('Una revisión no tiene maintenanceId.');
  if (review.manualReview === true) throw new Error(`El mantenimiento ${maintenanceId} requiere revisión manual y no se puede aplicar.`);
  const changes: Change[] = [];
  const original = record(review.original, `original de ${maintenanceId}`);
  const proposed = record(review.proposed, `proposed de ${maintenanceId}`);
  const forced = forcedFields(review, `revisión ${maintenanceId}`);
  for (const field of ['observations', 'equipmentState']) {
    if (proposed[field] !== undefined && (!equal(original[field], proposed[field]) || forced.has(field))) changes.push({ entity: 'maintenance', maintenanceId, field, original: original[field], proposed: proposed[field] });
  }
  const tasks = Array.isArray(review.tasks) ? review.tasks : [];
  for (const taskValue of tasks) {
    const task = record(taskValue, 'tarea propuesta'); const taskId = string(task.taskId);
    const before = record(task.original, 'original de tarea'); const after = record(task.proposed, 'propuesta de tarea');
    if (!taskId || typeof after.name !== 'string') throw new Error(`Tarea inválida en ${maintenanceId}.`);
    if (!equal(before.name, after.name) || forcedFields(task, `tarea ${taskId}`).has('name')) changes.push({ entity: 'task', maintenanceId, taskId, field: 'name', original: before.name, proposed: after.name });
  }
  const activities = Array.isArray(review.activities) ? review.activities : [];
  for (const activityValue of activities) {
    const activity = record(activityValue, 'actividad propuesta'); const taskId = string(activity.taskId); const activityId = string(activity.activityId);
    if (activity.action !== 'edit') throw new Error(`La actividad ${activityId ?? '(sin id)'} no es una edición permitida.`);
    const before = record(activity.original, 'original de actividad'); const after = record(activity.proposed, 'propuesta de actividad');
    if (!taskId || !activityId) throw new Error(`Actividad sin taskId o activityId en ${maintenanceId}.`);
    for (const field of ['name', 'reply']) {
      if (after[field] !== undefined && (!equal(before[field], after[field]) || forcedFields(activity, `actividad ${activityId}`).has(field))) changes.push({ entity: 'activity', maintenanceId, taskId, activityId, field, original: before[field], proposed: after[field] });
    }
  }
  return changes;
}

function parseReview(value: JsonRecord, requireApproved: boolean): { orderCode: string; changes: Change[] } {
  if (value.schemaVersion !== '1.0') throw new Error('El borrador debe usar schemaVersion "1.0".');
  if (requireApproved && value.status !== 'approved') throw new Error('Para escribir, el JSON debe tener status "approved" tras la revisión del coordinador.');
  if (!['draft', 'approved'].includes(String(value.status))) throw new Error('El estado del borrador debe ser draft o approved.');
  const order = record(value.order, 'order del borrador'); const orderCode = string(order.code);
  if (!orderCode || !/^\d+$/.test(orderCode)) throw new Error('El borrador no tiene un código de orden válido.');
  const reviews = Array.isArray(value.reviews) ? value.reviews : [];
  if (!reviews.length) throw new Error('El borrador no contiene revisiones.');
  return { orderCode, changes: reviews.flatMap((item) => changesFromReview(record(item, 'revisión'))) };
}

function tasksOf(detail: JsonRecord): JsonRecord[] {
  const tasks = detail.tasks;
  return Array.isArray(tasks) ? tasks.map((item) => record(item, 'tarea actual')) : tasks && typeof tasks === 'object' ? [record(tasks, 'tarea actual')] : [];
}
function idOf(value: unknown): string | undefined { return string(value) ?? (value && typeof value === 'object' ? string((value as JsonRecord)._id) : undefined); }
function getPath(value: unknown, fieldPath: string): unknown { return fieldPath.split('.').reduce<unknown>((current, key) => current && typeof current === 'object' ? (current as JsonRecord)[key] : undefined, value); }
function setPath(target: JsonRecord, fieldPath: string, value: unknown): void {
  const parts = fieldPath.split('.'); let cursor = target;
  for (const part of parts.slice(0, -1)) { const next = cursor[part]; cursor[part] = next && typeof next === 'object' && !Array.isArray(next) ? next : {}; cursor = cursor[part] as JsonRecord; }
  cursor[parts.at(-1)!] = value;
}
function entityCurrent(detail: JsonRecord, change: Change): JsonRecord {
  if (change.entity === 'maintenance') return detail;
  const task = tasksOf(detail).find((item) => idOf(item._id) === change.taskId);
  if (!task) throw new Error(`Conflicto: no existe la tarea ${change.taskId} en ${change.maintenanceId}.`);
  if (change.entity === 'task') return task;
  const activities = Array.isArray(task.activitys) ? task.activitys : [];
  const activity = activities.map((item) => record(item, 'actividad actual')).find((item) => idOf(item._id) === change.activityId);
  if (!activity) throw new Error(`Conflicto: no existe la actividad ${change.activityId} en ${change.maintenanceId}.`);
  return activity;
}
function endpointFor(template: string, change: Change): string {
  const values: Record<string, string | undefined> = { maintenanceId: change.maintenanceId, taskId: change.taskId, activityId: change.activityId };
  return template.replace(/\{(maintenanceId|taskId|activityId)\}/g, (_all, key: string) => {
    const value = values[key]; if (!value) throw new Error(`El contrato exige ${key}, pero el cambio no lo tiene.`); return encodeURIComponent(value);
  });
}
async function detailFor(maintenanceId: string, token: string): Promise<JsonRecord> {
  return record(await fetchApiJson<unknown>(`/maintenance/${encodeURIComponent(maintenanceId)}/detail`, token), 'mantenimiento actual');
}

export async function applyReview(draftPath: string, options: ApplyReviewOptions): Promise<ApplyReviewResult> {
  const dryRun = !options.confirm;
  const draft = await readJson(draftPath, 'borrador');
  const parsed = parseReview(draft, !dryRun);
  const maxChanges = options.maxChanges ?? 20;
  if (!Number.isInteger(maxChanges) || maxChanges < 1) throw new Error('maxChanges debe ser un entero positivo.');
  if (parsed.changes.length > maxChanges) {
    throw new Error(`La revisión contiene ${parsed.changes.length} cambios y supera el límite de seguridad de ${maxChanges}. Divide el lote o aumenta --max-changes tras revisar la simulación.`);
  }
  const contract = parseContract(await readJson(options.contractPath, 'contrato de escritura'));
  for (const change of parsed.changes) {
    const field = contract.operations[change.entity]?.fields[change.field];
    if (!field) throw new Error(`El contrato no autoriza ${change.entity}.${change.field}.`);
    if (equal(change.original, change.proposed) && field.originalPath === field.verifyPath) {
      throw new Error(`No se puede forzar ${change.entity}.${change.field}: el contrato no distingue corrección y valor original.`);
    }
  }
  let token = await getAuthenticatedToken(options.autoLogin ?? true);
  const loadDetail = async (id: string): Promise<JsonRecord> => {
    try { return await detailFor(id, token); }
    catch (error) { if (!(options.autoLogin ?? true) || !isAuthError(error)) throw error; token = await loginDirect(); return detailFor(id, token); }
  };
  const details = new Map<string, JsonRecord>();
  for (const id of [...new Set(parsed.changes.map((change) => change.maintenanceId))]) details.set(id, await loadDetail(id));
  const pending: Change[] = [];
  const alreadyApplied: Change[] = [];
  for (const change of parsed.changes) {
    const current = entityCurrent(details.get(change.maintenanceId)!, change);
    const field = contract.operations[change.entity]!.fields[change.field];
    if (stateOf(current, field, change) === 'alreadyApplied') alreadyApplied.push(change);
    else pending.push(change);
  }
  const result: ApplyReviewResult = { dryRun, orderCode: parsed.orderCode, planned: pending, applied: [], alreadyApplied, audit: { generatedAt: new Date().toISOString(), contractPath: path.resolve(options.contractPath), status: dryRun ? 'planned' : 'completed' } };
  if (dryRun) return result;
  try {
    for (const change of pending) {
      const currentDetail = await loadDetail(change.maintenanceId); // relectura justo antes de escribir
      const current = entityCurrent(currentDetail, change);
      const operation = contract.operations[change.entity]!; const field = operation.fields[change.field];
      if (stateOf(current, field, change) === 'alreadyApplied') {
        result.alreadyApplied.push(change);
        await options.onProgress?.(result);
        continue;
      }
      const body: JsonRecord = {}; setPath(body, field.bodyPath, change.proposed);
      await sendApiJson(endpointFor(field.path ?? operation.path, change), token, field.method ?? operation.method, body, options.timeoutMs);
      const verified = entityCurrent(await loadDetail(change.maintenanceId), change);
      if (!equal(getPath(verified, field.verifyPath), change.proposed)) throw new Error(`Verificación fallida para ${change.entity}.${change.field} (${change.maintenanceId}).`);
      result.applied.push(change);
      await options.onProgress?.(result);
      if ((options.delayMs ?? 350) > 0) await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 350));
    }
  } catch (error) { result.audit.status = 'failed'; result.audit.error = error instanceof Error ? error.message : String(error); throw Object.assign(error instanceof Error ? error : new Error(String(error)), { applyResult: result }); }
  return result;
}

export function applyAuditOutputPath(code: string, outDir: string, stamp = timestamp()): string { return path.join(outDir, `order-apply-${code}-${stamp}.json`); }
export async function writeApplyAudit(output: string, result: ApplyReviewResult): Promise<void> {
  await ensureDir(path.dirname(output)); const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  try { await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8'); await fs.rename(temporary, output); }
  catch (error) { await fs.rm(temporary, { force: true }); throw error; }
}

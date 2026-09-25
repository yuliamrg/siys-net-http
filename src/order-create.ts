import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchApiJson, sendApiJson } from './api.js';
import { getAuthenticatedToken, loginDirect } from './auth.js';
import { privateDir } from './paths.js';
import { ensureDir, timestamp } from './utils.js';
import { CliError } from './errors.js';
import { parseJsonBytes } from './json-file.js';

type JsonRecord = Record<string, unknown>;

export interface OrderCreateScheduleInput {
  startLocal: string;
  endLocal: string;
  technicianId?: string;
  technicianName?: string;
}

export interface OrderCreateRequest {
  schemaVersion: '1.0';
  status: 'draft' | 'approved';
  mode: 'manual';
  customerId?: string;
  customerName?: string;
  subsidiaryId?: string;
  subsidiaryName?: string;
  orderTypeId?: string;
  orderTypeName?: string;
  material: string;
  observations: string;
  equipmentIds?: string[];
  equipmentNames?: string[];
  schedule: OrderCreateScheduleInput[];
  timeZone: 'America/Bogota';
  allowNoEquipment?: true;
}

export interface OrderCreatePayload {
  [key: string]: unknown;
  equipments: string[];
  type: string;
  customer: string;
  subsidiary: string;
  material: string;
  observations: string;
  users: string[];
  dates: Array<{ start: string; end: string; user: string }>;
}

export interface OrderCreateSimulation {
  schemaVersion: '1.0';
  kind: 'order-create-simulation';
  dryRun: true;
  simulatedAt: string;
  source: { file: string; sha256: string };
  request: OrderCreateRequest;
  resolved: {
    customer: { id: string; name: string };
    subsidiary: { id: string; name: string };
    orderType: { id: string; name: string };
    equipments: Array<{ id: string; name: string }>;
    technicians: Array<{ id: string; name: string }>;
  };
  availability: Array<{
    technicianId: string;
    startLocal: string;
    endLocal: string;
    startUtc: string;
    endUtc: string;
    available: boolean;
  }>;
  payload: OrderCreatePayload;
  validation: { ready: boolean; blockers: string[] };
  safety: { siysWritesAttempted: 0; catalogAndAvailabilityMethod: 'GET'; orderEndpointCalled: false };
}

export interface SimulateOrderCreateOptions {
  autoLogin?: boolean;
}

export interface ExecuteOrderCreateOptions extends SimulateOrderCreateOptions {
  confirm?: boolean;
  contractPath?: string;
  timeoutMs?: number;
  onProgress?: (audit: OrderCreateAudit) => Promise<void>;
  receiptDir?: string;
}

export interface OrderCreateExecution {
  dryRun: false;
  simulation: OrderCreateSimulation;
  contract: { file: string; sha256: string; method: 'POST'; path: '/order' };
  response: unknown;
  audit: OrderCreateAudit;
}

export interface OrderCreateAudit {
  schemaVersion: '1.0';
  kind: 'order-create-audit';
  status: 'in_progress' | 'submitted' | 'verified' | 'verification_failed' | 'failed' | 'ambiguous';
  generatedAt: string;
  updatedAt: string;
  simulation: OrderCreateSimulation;
  contract: { file: string; sha256: string; method: 'POST'; path: '/order' };
  attempt: {
    method: 'POST';
    path: '/order';
    timeoutMs: number;
    startedAt: string;
    finishedAt?: string;
    response?: unknown;
    error?: string;
    retryAllowed: false;
  };
  verification?: OrderCreateVerification;
  receipt: { file: string; requestSha256: string };
}

export interface OrderCreateVerification {
  status: 'verified' | 'mismatch' | 'inconclusive';
  checkedAt: string;
  source: 'order-detail' | 'create-response';
  orderId?: string;
  orderCode?: string;
  checks: Array<{ field: string; expected: unknown; actual: unknown; matches: boolean }>;
  error?: string;
}

export interface OrderCreateExecutionState {
  dryRun: boolean;
  siysWritesAttempted: 0 | 1;
  auditStatus?: OrderCreateAudit['status'];
  created?: { orderId?: string; orderCode?: string };
}

export interface OrderCreateReceipt {
  schemaVersion: '1.0';
  kind: 'order-create-receipt';
  requestSha256: string;
  contractSha256: string;
  status: OrderCreateAudit['status'];
  reservedAt: string;
  updatedAt: string;
  orderId?: string;
  orderCode?: string;
  error?: string;
}

const ROOT_KEYS = new Set([
  'schemaVersion', 'status', 'mode', 'customerId', 'customerName', 'subsidiaryId', 'subsidiaryName',
  'orderTypeId', 'orderTypeName', 'material', 'observations', 'equipmentIds', 'equipmentNames',
  'schedule', 'timeZone', 'allowNoEquipment',
]);
const SCHEDULE_KEYS = new Set(['startLocal', 'endLocal', 'technicianId', 'technicianName']);
const FORBIDDEN_KEYS = new Set(['plan', 'period', 'tasks', 'created_by', 'createdBy', 'code', 'state', 'users', 'dates']);

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} debe ser un objeto JSON.`);
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, allowed: Set<string>, label: string): void {
  const unsupported = Object.keys(value).filter((key) => !allowed.has(key));
  if (unsupported.length) throw new Error(`${label} contiene campos no admitidos: ${unsupported.join(', ')}.`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} debe ser texto no vacio.`);
  return value.trim();
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} debe ser una lista.`);
  return value.map((item, index) => requiredString(item, `${label}[${index}]`));
}

function unique(values: string[], label: string): string[] {
  const duplicated = values.find((value, index) => values.indexOf(value) !== index);
  if (duplicated) throw new Error(`${label} contiene el ID duplicado ${duplicated}.`);
  return values;
}

function normalizeName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
    .replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ');
}

function normalizeEquipmentName(value: string): string {
  return normalizeName(value).replace(/#/g, ' ').replace(/\s+/g, ' ').trim();
}

function exclusiveString(input: JsonRecord, idKey: string, nameKey: string, label: string): { id?: string; name?: string } {
  const hasId = Object.hasOwn(input, idKey);
  const hasName = Object.hasOwn(input, nameKey);
  if (hasId && hasName) throw new Error(`${label} no puede especificarse simultaneamente con ${idKey} y ${nameKey}.`);
  if (!hasId && !hasName) throw new Error(`${label} requiere ${idKey} o ${nameKey}.`);
  return hasId ? { id: requiredString(input[idKey], idKey) } : { name: requiredString(input[nameKey], nameKey) };
}

function exclusiveStringArray(input: JsonRecord, idsKey: string, namesKey: string, label: string): { ids?: string[]; names?: string[] } {
  const hasIds = Object.hasOwn(input, idsKey);
  const hasNames = Object.hasOwn(input, namesKey);
  if (hasIds && hasNames) throw new Error(`${label} no puede especificarse simultaneamente con ${idsKey} y ${namesKey}.`);
  if (!hasIds && !hasNames) throw new Error(`${label} debe especificarse con ${idsKey} o ${namesKey}.`);
  if (hasIds) return { ids: unique(stringArray(input[idsKey], idsKey), idsKey) };
  const names = stringArray(input[namesKey], namesKey);
  const seen = new Set<string>();
  for (const name of names) {
    const normalized = normalizeEquipmentName(name);
    if (!normalized) throw new Error(`${namesKey} contiene un nombre vacio.`);
    if (seen.has(normalized)) throw new Error(`${namesKey} contiene el nombre duplicado "${name}" despues de normalizar.`);
    seen.add(normalized);
  }
  return { names };
}

function parseLocal(value: unknown, label: string): { local: string; epochUtc: number; utc: string; offset: string } {
  const local = requiredString(value, label);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(local);
  if (!match) throw new Error(`${label} debe usar YYYY-MM-DDTHH:mm:ss, sin zona horaria.`);
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const [year, month, day, hour, minute, second] = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(localAsUtc);
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day
    || roundTrip.getUTCHours() !== hour || roundTrip.getUTCMinutes() !== minute || roundTrip.getUTCSeconds() !== second) {
    throw new Error(`${label} no es una fecha valida.`);
  }
  if (minute % 30 !== 0 || second !== 0) throw new Error(`${label} debe estar en intervalos de 30 minutos y segundos 00.`);
  const epochUtc = localAsUtc + (5 * 60 * 60 * 1000);
  return { local, epochUtc, utc: new Date(epochUtc).toISOString(), offset: `${local}-05:00` };
}

function parseRequest(value: unknown): OrderCreateRequest {
  const input = record(value, 'La solicitud');
  exactKeys(input, ROOT_KEYS, 'La solicitud');
  for (const key of FORBIDDEN_KEYS) {
    if (Object.hasOwn(input, key)) throw new Error(`La solicitud no admite ${key}; esta version solo crea ordenes manuales.`);
  }
  if (input.schemaVersion !== '1.0') throw new Error('schemaVersion debe ser "1.0".');
  if (input.status !== 'draft' && input.status !== 'approved') throw new Error('status debe ser "draft" o "approved".');
  if (input.mode !== 'manual') throw new Error('mode debe ser "manual"; la creacion desde planes esta excluida.');
  if (input.timeZone !== 'America/Bogota') throw new Error('timeZone debe ser "America/Bogota" en esta version.');
  if (input.allowNoEquipment !== undefined && input.allowNoEquipment !== true) throw new Error('allowNoEquipment solo admite true como excepcion explicita.');

  const customer = exclusiveString(input, 'customerId', 'customerName', 'El cliente');
  const subsidiary = exclusiveString(input, 'subsidiaryId', 'subsidiaryName', 'La sede');
  const orderType = exclusiveString(input, 'orderTypeId', 'orderTypeName', 'El tipo de orden');
  const equipment = exclusiveStringArray(input, 'equipmentIds', 'equipmentNames', 'Los equipos');
  const equipmentCount = equipment.ids?.length ?? equipment.names?.length ?? 0;
  if (!equipmentCount && input.allowNoEquipment !== true) {
    throw new Error('equipmentIds o equipmentNames requiere al menos un equipo; usa allowNoEquipment: true solo para una excepcion justificada.');
  }
  if (!Array.isArray(input.schedule) || !input.schedule.length) throw new Error('schedule requiere al menos una asignacion.');
  const schedule: OrderCreateScheduleInput[] = input.schedule.map((item, index) => {
    const row = record(item, `schedule[${index}]`);
    exactKeys(row, SCHEDULE_KEYS, `schedule[${index}]`);
    const start = parseLocal(row.startLocal, `schedule[${index}].startLocal`);
    const end = parseLocal(row.endLocal, `schedule[${index}].endLocal`);
    if (start.epochUtc > end.epochUtc) throw new Error(`schedule[${index}] no puede terminar antes de iniciar.`);
    const technician = exclusiveString(row, 'technicianId', 'technicianName', `El tecnico de schedule[${index}]`);
    return {
      startLocal: start.local, endLocal: end.local,
      ...(technician.id ? { technicianId: technician.id } : { technicianName: technician.name! }),
    };
  });
  for (let left = 0; left < schedule.length; left += 1) {
    const a = schedule[left];
    const aStart = parseLocal(a.startLocal, '').epochUtc;
    const aEnd = parseLocal(a.endLocal, '').epochUtc;
    for (let right = left + 1; right < schedule.length; right += 1) {
      const b = schedule[right];
      const aTechnician = a.technicianId ? `id:${a.technicianId}` : `name:${normalizeName(a.technicianName!)}`;
      const bTechnician = b.technicianId ? `id:${b.technicianId}` : `name:${normalizeName(b.technicianName!)}`;
      if (aTechnician !== bTechnician) continue;
      const bStart = parseLocal(b.startLocal, '').epochUtc;
      const bEnd = parseLocal(b.endLocal, '').epochUtc;
      if (aStart < bEnd && bStart < aEnd) throw new Error(`schedule[${left}] y schedule[${right}] se solapan para el mismo tecnico.`);
    }
  }

  return {
    schemaVersion: '1.0', status: input.status, mode: 'manual',
    ...(customer.id ? { customerId: customer.id } : { customerName: customer.name! }),
    ...(subsidiary.id ? { subsidiaryId: subsidiary.id } : { subsidiaryName: subsidiary.name! }),
    ...(orderType.id ? { orderTypeId: orderType.id } : { orderTypeName: orderType.name! }),
    material: requiredString(input.material, 'material'),
    observations: requiredString(input.observations, 'observations'),
    ...(equipment.ids ? { equipmentIds: equipment.ids } : { equipmentNames: equipment.names! }),
    schedule, timeZone: 'America/Bogota',
    ...(input.allowNoEquipment === true ? { allowNoEquipment: true as const } : {}),
  };
}

function list(value: unknown, label: string): JsonRecord[] {
  const candidate = Array.isArray(value) ? value : record(value, label).docs;
  if (!Array.isArray(candidate)) throw new Error(`Respuesta invalida de ${label}: se esperaba una lista o docs[].`);
  return candidate.map((item, index) => record(item, `${label}[${index}]`));
}

function idOf(value: JsonRecord): string | undefined {
  return typeof value._id === 'string' && value._id.trim() ? value._id.trim() : undefined;
}

function nameOf(value: JsonRecord, fallback: string): string {
  for (const key of ['name', 'businessName', 'description', 'email']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return fallback;
}

function identifier(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object' && !Array.isArray(value)) return idOf(value as JsonRecord);
  return undefined;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.map(identifier).filter((item): item is string => Boolean(item)) : [];
}

function sorted(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function unwrapOrder(value: unknown): JsonRecord {
  const response = record(value, 'detalle de la orden creada');
  return response.doc === undefined ? response : record(response.doc, 'doc de la orden creada');
}

function responseOrderId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const response = value as JsonRecord;
  return identifier(response) ?? (response.doc ? identifier(response.doc) : undefined);
}

function verificationOf(value: unknown, payload: OrderCreatePayload, orderId: string): OrderCreateVerification {
  const order = unwrapOrder(value);
  const maintenanceEquipmentIds = Array.isArray(order.maintenances)
    ? order.maintenances.map((item) => item && typeof item === 'object' ? identifier((item as JsonRecord).equipment) : undefined).filter((item): item is string => Boolean(item))
    : [];
  const actualEquipmentIds = ids(order.equipments).length ? ids(order.equipments) : maintenanceEquipmentIds;
  const actualType = identifier(order.type) ?? identifier(order.orderType);
  const actualDates = Array.isArray(order.dates) ? order.dates.map((item) => {
    const row = item && typeof item === 'object' && !Array.isArray(item) ? item as JsonRecord : {};
    return { start: typeof row.start === 'string' ? row.start : undefined, end: typeof row.end === 'string' ? row.end : undefined, user: identifier(row.user) };
  }) : [];
  const expectedDates = payload.dates.map((item) => ({ start: item.start, end: item.end, user: item.user }));
  const checks: OrderCreateVerification['checks'] = [
    { field: 'customer', expected: payload.customer, actual: identifier(order.customer), matches: identifier(order.customer) === payload.customer },
    { field: 'subsidiary', expected: payload.subsidiary, actual: identifier(order.subsidiary), matches: identifier(order.subsidiary) === payload.subsidiary },
    { field: 'type', expected: payload.type, actual: actualType, matches: actualType === payload.type },
    { field: 'material', expected: payload.material, actual: order.material, matches: order.material === payload.material },
    { field: 'observations', expected: payload.observations, actual: order.observations, matches: order.observations === payload.observations },
    { field: 'equipments', expected: sorted(payload.equipments), actual: sorted(actualEquipmentIds), matches: JSON.stringify(sorted(actualEquipmentIds)) === JSON.stringify(sorted(payload.equipments)) },
    { field: 'users', expected: sorted(payload.users), actual: sorted(ids(order.users)), matches: JSON.stringify(sorted(ids(order.users))) === JSON.stringify(sorted(payload.users)) },
    { field: 'dates', expected: expectedDates, actual: actualDates, matches: JSON.stringify(actualDates) === JSON.stringify(expectedDates) },
  ];
  const orderCode = order.code === undefined ? undefined : String(order.code).padStart(6, '0');
  return { status: checks.every((check) => check.matches) ? 'verified' : 'mismatch', checkedAt: new Date().toISOString(), source: 'order-detail', orderId, orderCode, checks };
}

async function verifyCreatedOrder(response: unknown, payload: OrderCreatePayload, token: string): Promise<OrderCreateVerification> {
  const orderId = responseOrderId(response);
  if (!orderId) {
    return {
      status: 'inconclusive', checkedAt: new Date().toISOString(), source: 'create-response', checks: [],
      error: 'La respuesta de creación no contiene un ID inequívoco; no se infiere éxito ni se reintenta.',
    };
  }
  const detail = await fetchApiJson<unknown>(`/order/${encodeURIComponent(orderId)}/detail?full=true`, token);
  return verificationOf(detail, payload, orderId);
}

function findEntity(items: JsonRecord[], id: string, label: string): JsonRecord {
  const match = items.find((item) => idOf(item) === id);
  if (!match) throw new Error(`${label} ${id} no existe en el catalogo autorizado.`);
  return match;
}

function matchingDisplayName(item: JsonRecord, requested: string | undefined, fields: string[], fallback: string): string {
  if (requested !== undefined) {
    const matching = fields.find((field) => typeof item[field] === 'string' && normalizeName(item[field] as string) === normalizeName(requested));
    if (matching) return (item[matching] as string).trim();
  }
  return nameOf(item, fallback);
}

function findEntityByName(items: JsonRecord[], requested: string, label: string, fields: string[], context?: string, normalizer = normalizeName): JsonRecord {
  const wanted = normalizer(requested);
  const matches = items.filter((item) => fields.some((field) => {
    const value = item[field];
    return typeof value === 'string' && normalizer(value) === wanted;
  }));
  const scope = context ? ` ${context}` : '';
  if (!matches.length) throw new Error(`${label} con nombre exacto "${requested}" no existe${scope}.`);
  if (matches.length > 1) {
    const candidates = matches.map((item) => {
      const names = [...new Set(fields.map((field) => typeof item[field] === 'string' ? (item[field] as string).trim() : '').filter(Boolean))];
      return `"${names.join(' / ') || '(sin nombre)'}" (ID: ${idOf(item) ?? '(sin _id)'})`;
    });
    throw new Error(`${label} con nombre exacto "${requested}" es ambiguo${scope}. Candidatos: ${candidates.join('; ')}.`);
  }
  const match = matches[0]!;
  if (!idOf(match)) throw new Error(`${label} con nombre exacto "${requested}"${scope} no contiene un _id resoluble.`);
  return match;
}

function resolvedId(item: JsonRecord, label: string): string {
  const id = idOf(item);
  if (!id) throw new Error(`${label} resuelto no contiene un _id.`);
  return id;
}

function assertNoOverlappingResolvedSchedule(schedule: Array<OrderCreateScheduleInput & { technicianId: string }>): void {
  for (let left = 0; left < schedule.length; left += 1) {
    const a = schedule[left]!;
    const aStart = parseLocal(a.startLocal, '').epochUtc;
    const aEnd = parseLocal(a.endLocal, '').epochUtc;
    for (let right = left + 1; right < schedule.length; right += 1) {
      const b = schedule[right]!;
      if (a.technicianId !== b.technicianId) continue;
      const bStart = parseLocal(b.startLocal, '').epochUtc;
      const bEnd = parseLocal(b.endLocal, '').epochUtc;
      if (aStart < bEnd && bStart < aEnd) throw new Error(`schedule[${left}] y schedule[${right}] se solapan para el mismo tecnico resuelto (${a.technicianId}).`);
    }
  }
}

function isAuthError(error: unknown): boolean {
  return error instanceof Error && /\b(401|403)\b/.test(error.message);
}

async function readRequestSource(file: string): Promise<{ request: OrderCreateRequest; sourceSha256: string }> {
  const bytes = await fs.readFile(file);
  const raw = parseJsonBytes<unknown>(bytes, 'La solicitud JSON');
  return { request: parseRequest(raw), sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function readCreateContract(file: string): Promise<{ file: string; sha256: string; method: 'POST'; path: '/order' }> {
  const bytes = await fs.readFile(file);
  let raw: JsonRecord;
  try { raw = record(parseJsonBytes<unknown>(bytes, 'El contrato'), 'El contrato'); } catch (error) { throw new Error(`No se pudo leer el contrato ${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
  exactKeys(raw, new Set(['schemaVersion', 'enabled', 'operation']), 'El contrato');
  if (raw.schemaVersion !== '1.0' || raw.enabled !== true) throw new Error('El contrato debe declarar schemaVersion "1.0" y enabled: true.');
  const operation = record(raw.operation, 'operation del contrato');
  exactKeys(operation, new Set(['method', 'path']), 'operation del contrato');
  if (operation.method !== 'POST' || operation.path !== '/order') throw new Error('El contrato no autoriza exactamente POST /order.');
  return { file: path.resolve(file), sha256: crypto.createHash('sha256').update(bytes).digest('hex'), method: 'POST', path: '/order' };
}

function createReceiptPath(receiptDir: string, requestSha256: string): string {
  return path.join(receiptDir, `${requestSha256}.json`);
}

async function reserveReceipt(file: string, receipt: OrderCreateReceipt): Promise<void> {
  await ensureDir(path.dirname(file));
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(file, 'wx');
    await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'EEXIST') {
      let previous = 'estado desconocido';
      try {
        const value = record(JSON.parse(await fs.readFile(file, 'utf8')), 'recibo existente');
        previous = `${String(value.status ?? 'desconocido')}${value.orderCode ? `, orden ${String(value.orderCode)}` : ''}`;
      } catch { /* The existing file itself is enough to block a replay. */ }
      throw new Error(`La solicitud aprobada ya tiene un recibo de ejecución (${previous}) en ${file}. No se permite repetir el POST.`, { cause: error });
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function updateReceipt(file: string, receipt: OrderCreateReceipt): Promise<void> {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

async function simulateWithToken(file: string, sourceSha256: string, request: OrderCreateRequest, token: string): Promise<OrderCreateSimulation> {
  const needsNameResolution = Boolean(request.customerName || request.subsidiaryName || request.orderTypeName
    || request.equipmentNames || request.schedule.some((row) => row.technicianName));
  let customerResponse: unknown;
  let typeResponse: unknown;
  let userResponse: unknown;
  let subsidiaryResponse: unknown;
  let equipmentResponse: unknown;

  if (needsNameResolution) {
    [customerResponse, typeResponse, userResponse] = await Promise.all([
      fetchApiJson<unknown>('/customer', token),
      fetchApiJson<unknown>('/order-type', token),
      fetchApiJson<unknown>('/user', token),
    ]);
  } else {
    [customerResponse, subsidiaryResponse, typeResponse, equipmentResponse, userResponse] = await Promise.all([
      fetchApiJson<unknown>('/customer', token),
      fetchApiJson<unknown>(`/subsidiary?customer=${encodeURIComponent(request.customerId!)}`, token),
      fetchApiJson<unknown>('/order-type', token),
      fetchApiJson<unknown>(`/equipment?subsidiary=${encodeURIComponent(request.subsidiaryId!)}&active=1`, token),
      fetchApiJson<unknown>('/user', token),
    ]);
  }

  const customerCatalog = list(customerResponse, 'clientes');
  const customer = request.customerId
    ? findEntity(customerCatalog, request.customerId, 'El cliente')
    : findEntityByName(customerCatalog, request.customerName!, 'El cliente', ['name']);
  const customerId = resolvedId(customer, 'El cliente');
  if (needsNameResolution) subsidiaryResponse = await fetchApiJson<unknown>(`/subsidiary?customer=${encodeURIComponent(customerId)}`, token);

  const subsidiaryCatalog = list(subsidiaryResponse, 'sedes del cliente');
  const customerContext = `del cliente "${nameOf(customer, customerId)}" (ID: ${customerId})`;
  const subsidiary = request.subsidiaryId
    ? findEntity(subsidiaryCatalog, request.subsidiaryId, 'La sede')
    : findEntityByName(subsidiaryCatalog, request.subsidiaryName!, 'La sede', ['name'], customerContext);
  const subsidiaryId = resolvedId(subsidiary, 'La sede');
  if (needsNameResolution) equipmentResponse = await fetchApiJson<unknown>(`/equipment?subsidiary=${encodeURIComponent(subsidiaryId)}&active=1`, token);

  const typeCatalog = list(typeResponse, 'tipos de orden');
  const orderType = request.orderTypeId
    ? findEntity(typeCatalog, request.orderTypeId, 'El tipo de orden')
    : findEntityByName(typeCatalog, request.orderTypeName!, 'El tipo de orden', ['name', 'description']);
  const orderTypeId = resolvedId(orderType, 'El tipo de orden');
  const equipmentCatalog = list(equipmentResponse, 'equipos activos de la sede');
  const equipmentSelectors = request.equipmentIds ?? request.equipmentNames ?? [];
  const equipments = equipmentSelectors.map((selector) => request.equipmentIds
    ? findEntity(equipmentCatalog, selector, 'El equipo activo')
    : findEntityByName(equipmentCatalog, selector, 'El equipo activo', ['name'], `de la sede "${nameOf(subsidiary, subsidiaryId)}" (ID: ${subsidiaryId})`, normalizeEquipmentName));
  const equipmentIds = equipments.map((item) => resolvedId(item, 'El equipo activo'));
  const userCatalog = list(userResponse, 'usuarios');
  const techniciansBySchedule = request.schedule.map((row) => {
    const technician = row.technicianId
      ? findEntity(userCatalog, row.technicianId, 'El tecnico')
      : findEntityByName(userCatalog.filter((item) => item.itIsTechnical === true), row.technicianName!, 'El tecnico', ['name'], 'entre usuarios marcados como tecnicos');
    if (technician.itIsTechnical !== true) {
      const identifier = row.technicianId ?? row.technicianName!;
      throw new Error(`El usuario ${identifier} existe, pero no esta marcado como tecnico.`);
    }
    return { technician, technicianId: resolvedId(technician, 'El tecnico') };
  });
  const resolvedSchedule = request.schedule.map((row, index) => ({ ...row, technicianId: techniciansBySchedule[index]!.technicianId }));
  assertNoOverlappingResolvedSchedule(resolvedSchedule);
  const technicianIds = [...new Set(resolvedSchedule.map((row) => row.technicianId))];
  const technicians = technicianIds.map((id) => findEntity(userCatalog, id, 'El tecnico'));
  const technicianNameById = new Map(techniciansBySchedule.map((item, index) => [
    item.technicianId,
    matchingDisplayName(item.technician, request.schedule[index]!.technicianName, ['name'], item.technicianId),
  ]));

  const availability = await Promise.all(resolvedSchedule.map(async (row) => {
    const start = parseLocal(row.startLocal, 'startLocal');
    const end = parseLocal(row.endLocal, 'endLocal');
    const query = `order=undefined&start=${encodeURIComponent(start.offset)}&end=${encodeURIComponent(end.offset)}`;
    const result = record(await fetchApiJson<unknown>(`/user/${encodeURIComponent(row.technicianId)}/itAvailable?${query}`, token), 'disponibilidad');
    if (typeof result.available !== 'boolean') throw new Error(`La disponibilidad del tecnico ${row.technicianId} no contiene available booleano.`);
    return { technicianId: row.technicianId, startLocal: row.startLocal, endLocal: row.endLocal, startUtc: start.utc, endUtc: end.utc, available: result.available };
  }));
  const blockers = availability.filter((item) => !item.available).map((item) => `Tecnico ${item.technicianId} no disponible entre ${item.startLocal} y ${item.endLocal}.`);
  const payload: OrderCreatePayload = {
    equipments: equipmentIds, type: orderTypeId, customer: customerId,
    subsidiary: subsidiaryId, material: request.material, observations: request.observations,
    users: technicianIds,
    dates: resolvedSchedule.map((row) => ({
      start: parseLocal(row.startLocal, 'startLocal').utc,
      end: parseLocal(row.endLocal, 'endLocal').utc,
      user: row.technicianId,
    })),
  };
  return {
    schemaVersion: '1.0', kind: 'order-create-simulation', dryRun: true, simulatedAt: new Date().toISOString(),
    source: { file: path.resolve(file), sha256: sourceSha256 }, request,
    resolved: {
      customer: { id: customerId, name: matchingDisplayName(customer, request.customerName, ['name'], customerId) },
      subsidiary: { id: subsidiaryId, name: matchingDisplayName(subsidiary, request.subsidiaryName, ['name'], subsidiaryId) },
      orderType: { id: orderTypeId, name: matchingDisplayName(orderType, request.orderTypeName, ['name', 'description'], orderTypeId) },
      equipments: equipments.map((item, index) => ({
        id: equipmentIds[index]!, name: matchingDisplayName(item, request.equipmentNames?.[index], ['name'], equipmentIds[index]!),
      })),
      technicians: technicians.map((item, index) => ({ id: technicianIds[index]!, name: technicianNameById.get(technicianIds[index]!) ?? nameOf(item, technicianIds[index]!) })),
    },
    availability, payload, validation: { ready: blockers.length === 0, blockers },
    safety: { siysWritesAttempted: 0, catalogAndAvailabilityMethod: 'GET', orderEndpointCalled: false },
  };
}

export async function simulateOrderCreate(file: string, options: SimulateOrderCreateOptions = {}): Promise<OrderCreateSimulation> {
  const { request, sourceSha256 } = await readRequestSource(file);
  const autoLogin = options.autoLogin ?? true;
  let token = await getAuthenticatedToken(autoLogin);
  try {
    return await simulateWithToken(file, sourceSha256, request, token);
  } catch (error) {
    if (!autoLogin || !isAuthError(error)) throw error;
    token = await loginDirect();
    return simulateWithToken(file, sourceSha256, request, token);
  }
}

export async function executeOrderCreate(file: string, options: ExecuteOrderCreateOptions = {}): Promise<OrderCreateSimulation | OrderCreateExecution> {
  if (!options.confirm) return simulateOrderCreate(file, options);
  const { request, sourceSha256 } = await readRequestSource(file);
  if (request.status !== 'approved') throw new Error('La escritura exige status: "approved" en la solicitud revisada.');
  if (!options.contractPath) throw new Error('La escritura exige --contract <archivo> con autorización privada exacta.');
  const contract = await readCreateContract(options.contractPath);
  const autoLogin = options.autoLogin ?? true;
  let token = await getAuthenticatedToken(autoLogin);
  let simulation: OrderCreateSimulation;
  try {
    simulation = await simulateWithToken(file, sourceSha256, request, token);
  } catch (error) {
    if (!autoLogin || !isAuthError(error)) throw error;
    token = await loginDirect();
    simulation = await simulateWithToken(file, sourceSha256, request, token);
  }
  if (!simulation.validation.ready) throw new Error(`La prevalidacion bloquea la creacion: ${simulation.validation.blockers.join(' ')}`);
  const now = new Date().toISOString();
  const receiptFile = createReceiptPath(options.receiptDir ?? path.join(privateDir, 'order-create-receipts'), sourceSha256);
  const receipt: OrderCreateReceipt = {
    schemaVersion: '1.0', kind: 'order-create-receipt', requestSha256: sourceSha256, contractSha256: contract.sha256,
    status: 'in_progress', reservedAt: now, updatedAt: now,
  };
  const audit: OrderCreateAudit = {
    schemaVersion: '1.0', kind: 'order-create-audit', status: 'in_progress', generatedAt: now, updatedAt: now,
    simulation, contract,
    attempt: { method: 'POST', path: '/order', timeoutMs: options.timeoutMs ?? 15_000, startedAt: now, retryAllowed: false },
    receipt: { file: receiptFile, requestSha256: sourceSha256 },
  };
  await reserveReceipt(receiptFile, receipt);
  try { await options.onProgress?.(audit); } catch (error) {
    audit.status = 'failed';
    audit.updatedAt = new Date().toISOString();
    audit.attempt.finishedAt = audit.updatedAt;
    audit.attempt.error = `No se guardó la auditoría previa; el POST no fue enviado: ${error instanceof Error ? error.message : String(error)}`;
    receipt.status = audit.status; receipt.updatedAt = audit.updatedAt; receipt.error = audit.attempt.error;
    try { await updateReceipt(receiptFile, receipt); } catch { /* Preserve the no-POST error. */ }
    const wrapped = new Error(`${audit.attempt.error} No reintentar sin revisar el recibo local.`) as Error & { orderCreateAudit?: OrderCreateAudit };
    wrapped.orderCreateAudit = audit;
    throw wrapped;
  }
  let response: unknown;
  try {
    response = await sendApiJson<unknown>(contract.path, token, contract.method, simulation.payload, options.timeoutMs);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const httpStatus = message.match(/\bHTTP (\d{3})\b|^(\d{3})\s/);
    const statusCode = Number(httpStatus?.[1] ?? httpStatus?.[2]);
    audit.status = statusCode >= 400 && statusCode < 500 ? 'failed' : 'ambiguous';
    audit.updatedAt = new Date().toISOString();
    audit.attempt.finishedAt = audit.updatedAt;
    audit.attempt.error = message;
    receipt.status = audit.status; receipt.updatedAt = audit.updatedAt; receipt.error = message;
    try { await updateReceipt(receiptFile, receipt); } catch { /* The reserved receipt still blocks a replay. */ }
    try { await options.onProgress?.(audit); } catch { /* Preserve the original POST outcome. */ }
    const wrapped = new Error(`${message} Estado de creación: ${audit.status}; no reintentar automáticamente ni repetir el POST.`) as Error & { orderCreateAudit?: OrderCreateAudit };
    wrapped.orderCreateAudit = audit;
    throw wrapped;
  }
  audit.status = 'submitted';
  audit.updatedAt = new Date().toISOString();
  audit.attempt.finishedAt = audit.updatedAt;
  audit.attempt.response = response;
  receipt.status = audit.status; receipt.updatedAt = audit.updatedAt;
  try { await updateReceipt(receiptFile, receipt); } catch (error) {
    const wrapped = new Error(`SIYS aceptó el POST, pero no se pudo actualizar el recibo local: ${error instanceof Error ? error.message : String(error)}. No reintentar.`) as Error & { orderCreateAudit?: OrderCreateAudit };
    wrapped.orderCreateAudit = audit;
    throw wrapped;
  }
  try { await options.onProgress?.(audit); } catch (error) {
    const wrapped = new Error(`SIYS aceptó el POST, pero no se pudo actualizar la auditoría local: ${error instanceof Error ? error.message : String(error)}. No reintentar.`) as Error & { orderCreateAudit?: OrderCreateAudit };
    wrapped.orderCreateAudit = audit;
    throw wrapped;
  }
  try {
    audit.verification = await verifyCreatedOrder(response, simulation.payload, token);
  } catch (error) {
    audit.verification = {
      status: 'inconclusive', checkedAt: new Date().toISOString(), source: 'order-detail', checks: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
  audit.status = audit.verification.status === 'verified' ? 'verified' : 'verification_failed';
  audit.updatedAt = new Date().toISOString();
  receipt.status = audit.status;
  receipt.updatedAt = audit.updatedAt;
  receipt.orderId = audit.verification.orderId;
  receipt.orderCode = audit.verification.orderCode;
  receipt.error = audit.verification.error;
  try { await updateReceipt(receiptFile, receipt); } catch (error) {
    const wrapped = new Error(`La orden fue enviada, pero no se pudo actualizar su recibo de verificación: ${error instanceof Error ? error.message : String(error)}. No reintentar.`) as Error & { orderCreateAudit?: OrderCreateAudit };
    wrapped.orderCreateAudit = audit;
    throw wrapped;
  }
  try { await options.onProgress?.(audit); } catch (error) {
    const wrapped = new Error(`La orden fue enviada, pero no se pudo guardar su verificación: ${error instanceof Error ? error.message : String(error)}. No reintentar.`) as Error & { orderCreateAudit?: OrderCreateAudit };
    wrapped.orderCreateAudit = audit;
    throw wrapped;
  }
  if (audit.status === 'verification_failed') {
    const wrapped = new CliError('SIYS recibió la creación, pero la verificación posterior falló. No reintentar automáticamente.', 'safety', 'verification_failed', 'order create') as CliError & { orderCreateAudit?: OrderCreateAudit };
    wrapped.orderCreateAudit = audit;
    throw wrapped;
  }
  const execution: OrderCreateExecution = { dryRun: false, simulation, contract, response, audit };
  return execution;
}

export function orderCreateExecutionState(execution: OrderCreateSimulation | OrderCreateExecution): OrderCreateExecutionState {
  if (execution.dryRun) return { dryRun: true, siysWritesAttempted: 0 };
  return {
    dryRun: false,
    siysWritesAttempted: 1,
    auditStatus: execution.audit.status,
    created: {
      orderId: execution.audit.verification?.orderId ?? responseOrderId(execution.response),
      orderCode: execution.audit.verification?.orderCode,
    },
  };
}

export function orderCreateSimulationOutputPath(outDir: string, stamp = timestamp()): string {
  return path.join(outDir, `order-create-simulation-${stamp}.json`);
}

export async function writeOrderCreateSimulation(output: string, simulation: OrderCreateSimulation): Promise<void> {
  await ensureDir(path.dirname(output));
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(simulation, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, output);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export function orderCreateAuditOutputPath(outDir: string, stamp = timestamp()): string {
  return path.join(outDir, `order-create-audit-${stamp}.json`);
}

export async function writeOrderCreateAudit(output: string, audit: OrderCreateAudit): Promise<void> {
  await ensureDir(path.dirname(output));
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, output);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

export async function registerOrderCreateReceiptFromAudit(audit: OrderCreateAudit, receiptDir = path.join(privateDir, 'order-create-receipts')): Promise<string> {
  if (audit.status !== 'verified' || audit.verification?.status !== 'verified') throw new Error('Solo se puede registrar retrospectivamente una auditoría verificada.');
  const now = new Date().toISOString();
  const file = createReceiptPath(receiptDir, audit.simulation.source.sha256);
  const receipt: OrderCreateReceipt = {
    schemaVersion: '1.0', kind: 'order-create-receipt', requestSha256: audit.simulation.source.sha256,
    contractSha256: audit.contract.sha256, status: 'verified', reservedAt: audit.attempt.startedAt,
    updatedAt: now, orderId: audit.verification.orderId, orderCode: audit.verification.orderCode,
  };
  await reserveReceipt(file, receipt);
  return file;
}

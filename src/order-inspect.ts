import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchApiJson } from './api.js';
import { getAuthenticatedToken, loginDirect } from './auth.js';
import { ensureDir, timestamp } from './utils.js';

type JsonRecord = Record<string, unknown>;

interface OrderListResponse {
  docs?: JsonRecord[];
  total?: number;
  page?: number;
}

interface OrderDetailResponse {
  doc?: JsonRecord;
}

export interface MaintenanceInspection {
  orderMaintenanceId?: string;
  maintenanceId: string;
  equipmentId?: string;
  detail: JsonRecord;
}

export interface OrderInspection {
  schemaVersion: '1.0';
  extractedAt: string;
  code: string;
  source: {
    list: { total?: number; page?: number };
    orderId: string;
  };
  order: JsonRecord;
  maintenances: MaintenanceInspection[];
  delivery: JsonRecord | null;
}

export interface InspectOrderOptions {
  autoLogin?: boolean;
  concurrency?: number;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Respuesta invalida de ${label}.`);
  return value as JsonRecord;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function identifier(value: unknown): string | undefined {
  const direct = asString(value);
  if (direct) return direct;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return asString((value as JsonRecord)._id);
  }
  return undefined;
}

function orderCode(value: string): string {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`Codigo de orden invalido: ${value}. Usa solo numeros.`);
  return normalized.replace(/^0+(?=\d)/, '');
}

function formatCode(value: string): string {
  return value.padStart(6, '0');
}

function isAuthError(error: unknown): boolean {
  return error instanceof Error && /\b(401|403)\b/.test(error.message);
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(concurrency, 1), items.length || 1) }, worker));
  return results;
}

async function loadInspection(code: string, token: string, concurrency: number): Promise<OrderInspection> {
  const list = await fetchApiJson<OrderListResponse>(`/order/v2?page=1&limit=10&total=0&code=${encodeURIComponent(code)}`, token);
  const matches = (list.docs ?? []).filter((order) => {
    try {
      return orderCode(String(order.code ?? '')) === code;
    } catch {
      return false;
    }
  });
  if (matches.length !== 1) {
    throw new Error(matches.length === 0
      ? `No se encontro la orden ${formatCode(code)}.`
      : `El filtro de la orden ${formatCode(code)} devolvio ${matches.length} coincidencias.`);
  }
  const orderId = asString(matches[0]._id);
  if (!orderId) throw new Error(`La orden ${formatCode(code)} no contiene _id.`);

  const detailResponse = await fetchApiJson<OrderDetailResponse>(`/order/${encodeURIComponent(orderId)}/detail?full=true`, token);
  const order = asRecord(detailResponse.doc, 'detalle de orden');
  const links = Array.isArray(order.maintenances) ? order.maintenances.map((value) => asRecord(value, 'mantenimiento resumido')) : [];
  const maintenances = await mapConcurrent(links, concurrency, async (link) => {
    const maintenanceId = identifier(link.maintenance);
    if (!maintenanceId) throw new Error(`La orden ${formatCode(code)} contiene un mantenimiento sin identificador.`);
    const detail = asRecord(await fetchApiJson<unknown>(`/maintenance/${encodeURIComponent(maintenanceId)}/detail`, token), 'detalle de mantenimiento');
    return {
      orderMaintenanceId: asString(link._id),
      maintenanceId,
      equipmentId: identifier(link.equipment),
      detail,
    };
  });

  const deliveryId = identifier(order.deliverOrder);
  const delivery = deliveryId
    ? asRecord(await fetchApiJson<unknown>(`/deliver-order/${encodeURIComponent(deliveryId)}`, token), 'entrega de orden')
    : null;

  return {
    schemaVersion: '1.0',
    extractedAt: new Date().toISOString(),
    code: formatCode(code),
    source: { list: { total: list.total, page: list.page }, orderId },
    order,
    maintenances,
    delivery,
  };
}

export async function inspectOrder(codeInput: string, options: InspectOrderOptions = {}): Promise<OrderInspection> {
  const code = orderCode(codeInput);
  const autoLogin = options.autoLogin ?? true;
  const concurrency = options.concurrency ?? 5;
  let token = await getAuthenticatedToken(autoLogin);
  try {
    return await loadInspection(code, token, concurrency);
  } catch (error) {
    if (!autoLogin || !isAuthError(error)) throw error;
    token = await loginDirect();
    return loadInspection(code, token, concurrency);
  }
}

export function inspectionOutputPath(code: string, outDir: string, stamp = timestamp()): string {
  return path.join(outDir, `order-${formatCode(orderCode(code))}-${stamp}.json`);
}

export async function writeInspection(output: string, inspection: OrderInspection): Promise<void> {
  await ensureDir(path.dirname(output));
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(inspection, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, output);
  } catch (error) {
    await fs.rm(temporary, { force: true });
    throw error;
  }
}

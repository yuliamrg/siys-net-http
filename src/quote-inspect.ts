import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchApiJson } from './api.js';
import { getAuthenticatedToken, loginDirect } from './auth.js';
import { redact } from './security.js';
import { ensureDir, timestamp } from './utils.js';

type JsonRecord = Record<string, unknown>;

export const quoteCostCategories = ['equipos', 'materiales', 'contratista', 'mano_de_obra', 'transporte', 'viaticos'] as const;
export type QuoteCostCategory = (typeof quoteCostCategories)[number];

export interface QuoteBreakdownItem {
  item: string | null;
  value: number | null;
  raw: JsonRecord;
}

export interface QuoteCostComponent {
  value: number | null;
  breakdown: QuoteBreakdownItem[];
}

export interface QuoteItem {
  index: number;
  kind: 'group' | 'line';
  type: number | null;
  description: string | null;
  unit: string | null;
  quantity: number | null;
  factorVenta: number | null;
  costs: Record<QuoteCostCategory, QuoteCostComponent>;
  baseCostPerUnit: number | null;
  baseCostTotal: number | null;
  unitPrice: number | null;
  lineTotal: number | null;
}

export interface QuoteTotals {
  subtotal: number | null;
  discountRate: number | null;
  discountRateUsed: number | null;
  discountAmount: number | null;
  subtotalAfterDiscount: number | null;
  vatRate: number | null;
  vatAmount: number | null;
  total: number | null;
  warnings: string[];
}

export interface QuoteInspection {
  schemaVersion: '1.0';
  extractedAt: string;
  code: string;
  quoteId: string;
  source: {
    listPath?: string;
    detailPath: string;
    listMatches?: number;
  };
  quote: {
    id: string;
    fullCode: string | null;
    codigo: string | null;
    numericCode: number | null;
    title: string | null;
    type: string | number | null;
    businessUnit: JsonRecord | null;
    status: JsonRecord | null;
    statusHistory: JsonRecord[];
    spendPlan: string | number | null;
    mode: string | number | null;
    client: JsonRecord | null;
    subsidiary: JsonRecord | null;
    observations: string | null;
    date: string | null;
    year: number | null;
    month: number | null;
    createdBy: JsonRecord | null;
    items: QuoteItem[];
    totals: QuoteTotals;
    raw: JsonRecord;
  };
}

export interface InspectQuoteOptions {
  autoLogin?: boolean;
  /** Selects an exact quote when the code is not unique. */
  quoteId?: string;
}

function asRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Respuesta invalida de ${label}.`);
  return value as JsonRecord;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function asObjectOrNull(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function quoteCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]\d+$/.test(normalized)) throw new Error(`Codigo de cotizacion invalido: ${value}. Usa, por ejemplo, C20260734.`);
  return normalized;
}

function pathForQuote(code: string, id?: string): string {
  return id ? `/cotizacion/${encodeURIComponent(id)}` : `/cotizacion?fullCode=${encodeURIComponent(code)}`;
}

function sanitizedRecord(value: unknown): JsonRecord {
  return redact(value) as JsonRecord;
}

function buildBreakdown(value: unknown): QuoteBreakdownItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length > 0)
    .map((entry) => {
      const record = entry as JsonRecord;
      return { item: asString(record.item), value: asNumber(record.valor ?? record.value), raw: sanitizedRecord(record) };
    });
}

function buildCosts(article: JsonRecord): Record<QuoteCostCategory, QuoteCostComponent> {
  return Object.fromEntries(quoteCostCategories.map((category) => {
    const source = asObjectOrNull(article[category]);
    return [category, {
      value: asNumber(source?.valor),
      breakdown: buildBreakdown(source?.desglose),
    }];
  })) as Record<QuoteCostCategory, QuoteCostComponent>;
}

function buildItems(rawArticles: unknown): QuoteItem[] {
  if (!Array.isArray(rawArticles)) return [];
  return rawArticles.map((value, index) => {
    const article = asRecord(value, `articulo ${index + 1}`);
    const costs = buildCosts(article);
    const costValues = quoteCostCategories.map((category) => costs[category].value).filter((item): item is number => item !== null);
    const baseCostPerUnit = costValues.length > 0 ? roundMoney(costValues.reduce((sum, item) => sum + item, 0)) : null;
    const quantity = asNumber(article.cantidad);
    const factorVenta = asNumber(article.factorVenta);
    const type = asNumber(article.tipo);
    const isLine = type === 1 || (quantity !== null && asString(article.unidad) !== null);
    const unitPrice = isLine && baseCostPerUnit !== null && factorVenta !== null && factorVenta > 0
      ? roundMoney(baseCostPerUnit / (factorVenta / 100))
      : null;
    return {
      index,
      kind: isLine ? 'line' : 'group',
      type,
      description: asString(article.descripcion),
      unit: asString(article.unidad),
      quantity,
      factorVenta,
      costs,
      baseCostPerUnit,
      baseCostTotal: baseCostPerUnit !== null && quantity !== null ? roundMoney(baseCostPerUnit * quantity) : null,
      unitPrice,
      lineTotal: unitPrice !== null && quantity !== null ? roundMoney(unitPrice * quantity) : null,
    };
  });
}

function buildTotals(rawQuote: JsonRecord, items: QuoteItem[]): QuoteTotals {
  const lines = items.filter((item) => item.kind === 'line');
  const warnings: string[] = [];
  const subtotal = lines.length > 0 && lines.every((item) => item.lineTotal !== null)
    ? roundMoney(lines.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0))
    : null;
  if (lines.some((item) => item.lineTotal === null)) warnings.push('Hay lineas cobrables sin factorVenta, costo base o cantidad suficiente para calcular su total.');

  const discountRate = asNumber(rawQuote.descuento);
  const discountRateUsed = discountRate ?? 0;
  if (discountRate === null) warnings.push('descuento no informado; se uso 0 % para completar el calculo.');
  const discountAmount = subtotal !== null ? roundMoney(subtotal * (discountRateUsed / 100)) : null;
  const subtotalAfterDiscount = subtotal !== null && discountAmount !== null ? roundMoney(subtotal - discountAmount) : null;
  const vatRate = asNumber(rawQuote.iva);
  if (vatRate === null) warnings.push('IVA no informado; no se calculo el total final.');
  const vatAmount = subtotalAfterDiscount !== null && vatRate !== null ? roundMoney(subtotalAfterDiscount * (vatRate / 100)) : null;
  const total = subtotalAfterDiscount !== null && vatAmount !== null ? roundMoney(subtotalAfterDiscount + vatAmount) : null;
  return { subtotal, discountRate, discountRateUsed, discountAmount, subtotalAfterDiscount, vatRate, vatAmount, total, warnings };
}

function buildStatusHistory(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const record = asRecord(entry, `estado historico ${index + 1}`);
    return sanitizedRecord({
      id: record._id,
      userId: asObjectOrNull(record.usuario)?._id ?? record.usuario,
      userName: asObjectOrNull(record.usuario)?.name,
      statusId: asObjectOrNull(record.estado)?._id ?? record.estado,
      statusName: asObjectOrNull(record.estado)?.nombre,
      date: record.fecha,
    });
  });
}

function normalizeQuote(rawQuote: JsonRecord, code: string, source: QuoteInspection['source']): QuoteInspection {
  const quoteId = asString(rawQuote._id ?? rawQuote.id);
  if (!quoteId) throw new Error(`La cotizacion ${code} no contiene _id.`);
  const returnedCode = asString(rawQuote.fullCode ?? rawQuote.codigo);
  if (returnedCode && returnedCode.toUpperCase() !== code) throw new Error(`El ID de cotizacion ${quoteId} corresponde a ${returnedCode}, no a ${code}.`);
  const rawItems = buildItems(rawQuote.articulos);
  const safeRaw = sanitizedRecord(rawQuote);
  const safeCreatedBy = asObjectOrNull(safeRaw.creadoPor);
  return {
    schemaVersion: '1.0',
    extractedAt: new Date().toISOString(),
    code,
    quoteId,
    source,
    quote: {
      id: quoteId,
      fullCode: asString(rawQuote.fullCode),
      codigo: asString(rawQuote.codigo),
      numericCode: asNumber(rawQuote.code),
      title: asString(rawQuote.titulo),
      type: typeof rawQuote.tipo === 'string' || typeof rawQuote.tipo === 'number' ? rawQuote.tipo : null,
      businessUnit: asObjectOrNull(safeRaw.unidad_negocio),
      status: asObjectOrNull(safeRaw.estado),
      statusHistory: buildStatusHistory(rawQuote.estados),
      spendPlan: typeof rawQuote.spendPlan === 'string' || typeof rawQuote.spendPlan === 'number' ? rawQuote.spendPlan : null,
      mode: typeof rawQuote.modo === 'string' || typeof rawQuote.modo === 'number' ? rawQuote.modo : null,
      client: asObjectOrNull(safeRaw.cliente),
      subsidiary: asObjectOrNull(safeRaw.sucursal),
      observations: asString(rawQuote.obs),
      date: asString(rawQuote.fecha),
      year: asNumber(rawQuote.anio),
      month: asNumber(rawQuote.mes),
      createdBy: safeCreatedBy ? { _id: safeCreatedBy._id, name: safeCreatedBy.name } : null,
      items: rawItems,
      totals: buildTotals(rawQuote, rawItems),
      raw: safeRaw,
    },
  };
}

function isAuthError(error: unknown): boolean {
  return error instanceof Error && /\b(401|403)\b/.test(error.message);
}

async function loadQuote(code: string, token: string, explicitQuoteId?: string): Promise<QuoteInspection> {
  if (explicitQuoteId) {
    const detailPath = pathForQuote(code, explicitQuoteId);
    const detail = asRecord(await fetchApiJson<unknown>(detailPath, token), 'detalle de cotizacion');
    return normalizeQuote(detail, code, { detailPath });
  }

  const listPath = pathForQuote(code);
  const response = await fetchApiJson<unknown>(listPath, token);
  if (!Array.isArray(response)) throw new Error('Respuesta invalida del listado de cotizaciones.');
  const matches = response
    .map((value) => asRecord(value, 'cotizacion del listado'))
    .filter((quote) => [quote.fullCode, quote.codigo].some((value) => asString(value)?.toUpperCase() === code));
  if (matches.length === 0) throw new Error(`No se encontro la cotizacion ${code}.`);
  if (matches.length > 1) throw new Error(`El filtro de la cotizacion ${code} devolvio ${matches.length} coincidencias; usa --quote-id <id>.`);
  const quoteId = asString(matches[0]._id ?? matches[0].id);
  if (!quoteId) throw new Error(`La cotizacion ${code} no contiene _id.`);
  const detailPath = pathForQuote(code, quoteId);
  const detail = asRecord(await fetchApiJson<unknown>(detailPath, token), 'detalle de cotizacion');
  return normalizeQuote(detail, code, { listPath, detailPath, listMatches: matches.length });
}

export async function inspectQuote(codeInput: string, options: InspectQuoteOptions = {}): Promise<QuoteInspection> {
  const code = quoteCode(codeInput);
  const explicitQuoteId = options.quoteId?.trim();
  if (options.quoteId !== undefined && !explicitQuoteId) throw new Error('El ID de cotizacion no puede estar vacio.');
  const autoLogin = options.autoLogin ?? true;
  let token = await getAuthenticatedToken(autoLogin);
  try {
    return await loadQuote(code, token, explicitQuoteId);
  } catch (error) {
    if (!autoLogin || !isAuthError(error)) throw error;
    token = await loginDirect();
    return loadQuote(code, token, explicitQuoteId);
  }
}

export function quoteInspectionOutputPath(codeInput: string, outDir: string, stamp = timestamp()): string {
  return path.join(outDir, `quote-${quoteCode(codeInput)}-${stamp}.json`);
}

export async function writeQuoteInspection(output: string, inspection: QuoteInspection): Promise<void> {
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

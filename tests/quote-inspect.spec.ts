import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { inspectQuote, quoteInspectionOutputPath, writeQuoteInspection } from '../src/quote-inspect.js';

const originalFetch = global.fetch;
const originalToken = process.env.SIYS_TOKEN;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test.afterEach(() => {
  global.fetch = originalFetch;
  if (originalToken === undefined) delete process.env.SIYS_TOKEN;
  else process.env.SIYS_TOKEN = originalToken;
});

test('inspects quote detail, calculates totals, preserves breakdowns and redacts creator secrets', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const calls: string[] = [];
  global.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/cotizacion?fullCode=C20260734')) return response([{ _id: 'quote-id', fullCode: 'C20260734' }]);
    if (url.endsWith('/cotizacion/quote-id')) return response({
      _id: 'quote-id', fullCode: 'C20260734', codigo: 'C20260734', code: 34,
      titulo: 'Correctivo HVAC', iva: 19, descuento: 2, tipo: 'C', spendPlan: 'Si', modo: 1,
      unidad_negocio: { _id: 'unit-id', nombre: 'Mantenimiento Correctivo' },
      estado: { _id: 'status-id', nombre: 'En estudio' },
      estados: [{ _id: 'history-id', usuario: { _id: 'user-id', name: 'Coordinador' }, estado: { _id: 'status-id', nombre: 'En estudio' }, fecha: '2026-07-26T00:00:00.000Z' }],
      cliente: { _id: 'client-id', name: 'Cliente' },
      sucursal: { _id: 'site-id', name: 'Sede' },
      obs: 'Forma de pago: contra entrega', fecha: '2026-07-25T00:00:00.000Z', anio: 2026, mes: 7,
      creadoPor: { _id: 'user-id', name: 'Coordinador', password: 'hash', pushToken: 'secret-token' },
      articulos: [
        { tipo: 0, descripcion: 'Equipo paquete' },
        { tipo: 1, descripcion: 'Cambio de componente', unidad: 'UND', cantidad: 2, factorVenta: 50,
          materiales: { valor: 100, desglose: [{ item: 'Componente', valor: 100 }] },
          contratista: { valor: 50, desglose: [{ item: 'Instalacion', valor: 50 }] },
          equipos: { valor: 0, desglose: [{}] }, mano_de_obra: { valor: 0, desglose: [{}] },
          transporte: { valor: 0, desglose: [{}] }, viaticos: { valor: 0, desglose: [{}] } },
      ],
    });
    throw new Error(`Ruta inesperada: ${url}`);
  };

  const inspection = await inspectQuote('c20260734', { autoLogin: false });

  expect(calls).toEqual([
    expect.stringContaining('/cotizacion?fullCode=C20260734'),
    expect.stringContaining('/cotizacion/quote-id'),
  ]);
  expect(inspection.code).toBe('C20260734');
  expect(inspection.quote.items.map((item) => item.kind)).toEqual(['group', 'line']);
  expect(inspection.quote.items[1].costs.materiales.breakdown).toEqual([{ item: 'Componente', value: 100, raw: { item: 'Componente', valor: 100 } }]);
  expect(inspection.quote.totals).toMatchObject({ subtotal: 600, discountAmount: 12, subtotalAfterDiscount: 588, vatAmount: 111.72, total: 699.72 });
  expect(inspection.quote.createdBy).toEqual({ _id: 'user-id', name: 'Coordinador' });
  expect(inspection.quote.raw.creadoPor).toMatchObject({ password: '[REDACTED]', pushToken: '[REDACTED]' });
  expect(inspection.quote.statusHistory[0]).toMatchObject({ userName: 'Coordinador', statusName: 'En estudio' });
});

test('uses an explicit quote ID without querying the list and rejects code mismatches', async () => {
  process.env.SIYS_TOKEN = 'header.payload.signature';
  const calls: string[] = [];
  global.fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    return response({ _id: 'quote-id', fullCode: 'C20260734', articulos: [], iva: 19, descuento: 0 });
  };

  const inspection = await inspectQuote('C20260734', { autoLogin: false, quoteId: 'quote-id' });
  expect(inspection.source.listPath).toBeUndefined();
  expect(calls).toEqual([expect.stringContaining('/cotizacion/quote-id')]);

  global.fetch = async () => response({ _id: 'quote-id', fullCode: 'C20260735', articulos: [] });
  await expect(inspectQuote('C20260734', { autoLogin: false, quoteId: 'quote-id' })).rejects.toThrow(/corresponde a C20260735/);
});

test('writes quote inspection atomically and formats default paths', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-quote-inspect-'));
  const output = path.join(directory, 'inspection.json');
  const inspection = {
    schemaVersion: '1.0' as const, extractedAt: '2026-07-26T00:00:00.000Z', code: 'C20260734', quoteId: 'quote-id',
    source: { detailPath: '/cotizacion/quote-id' },
    quote: { id: 'quote-id', fullCode: 'C20260734', codigo: 'C20260734', numericCode: 34, title: null, type: null,
      businessUnit: null, status: null, statusHistory: [], spendPlan: null, mode: null, client: null, subsidiary: null,
      observations: null, date: null, year: null, month: null, createdBy: null, items: [],
      totals: { subtotal: 0, discountRate: 0, discountRateUsed: 0, discountAmount: 0, subtotalAfterDiscount: 0, vatRate: 19, vatAmount: 0, total: 0, warnings: [] }, raw: {} },
  };
  await writeQuoteInspection(output, inspection);
  await expect(fs.readFile(output, 'utf8')).resolves.toContain('"schemaVersion": "1.0"');
  expect(quoteInspectionOutputPath('c20260734', 'exports', '20260726-000000')).toBe(path.join('exports', 'quote-C20260734-20260726-000000.json'));
  await fs.rm(directory, { recursive: true, force: true });
});

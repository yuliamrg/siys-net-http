import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';
import parquet from 'parquetjs-lite';
import type { ExportFormat } from './types.js';
import { ensureDir } from './utils.js';

function flatten(value: unknown, prefix = '', output: Record<string, unknown> = {}): Record<string, unknown> {
  if (value === null || value === undefined) {
    output[prefix || 'value'] = null;
  } else if (Array.isArray(value)) {
    output[prefix || 'value'] = JSON.stringify(value);
  } else if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flatten(child, prefix ? `${prefix}.${key}` : key, output);
    }
  } else {
    output[prefix || 'value'] = value;
  }
  return output;
}

function columnsFor(rows: Record<string, unknown>[]): string[] {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  return columns.length > 0 ? columns : ['_empty'];
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export async function exportRows(
  rows: Record<string, unknown>[],
  format: ExportFormat,
  outputFile: string,
): Promise<void> {
  await ensureDir(path.dirname(outputFile));
  if (format === 'json') {
    await fs.writeFile(outputFile, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
    return;
  }

  const flatRows = rows.map((row) => flatten(row));
  const columns = columnsFor(flatRows);
  if (format === 'csv') {
    const lines = [columns.map(csvCell).join(','), ...flatRows.map((row) => columns.map((c) => csvCell(row[c])).join(','))];
    await fs.writeFile(outputFile, `\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
    return;
  }
  if (format === 'xlsx') {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Datos');
    sheet.columns = columns.map((column) => ({ header: column, key: column, width: Math.min(Math.max(column.length + 2, 12), 40) }));
    for (const row of flatRows) sheet.addRow(row);
    sheet.views = [{ state: 'frozen', ySplit: 1 }];
    sheet.autoFilter = { from: 'A1', to: `${sheet.getColumn(columns.length || 1).letter}1` };
    await workbook.xlsx.writeFile(outputFile);
    return;
  }

  const schema = new parquet.ParquetSchema(Object.fromEntries(columns.map((column) => [column, { type: 'UTF8', optional: true }])));
  const writer = await parquet.ParquetWriter.openFile(schema, outputFile);
  try {
    for (const row of flatRows) {
      await writer.appendRow(Object.fromEntries(columns.map((column) => [column, row[column] == null ? undefined : String(row[column])])));
    }
  } finally {
    await writer.close();
  }
}

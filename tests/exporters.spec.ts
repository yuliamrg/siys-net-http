import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { exportRows } from '../src/exporters.js';
import type { ExportFormat } from '../src/types.js';

test('writes every supported export format', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-export-'));
  const rows = [{ id: 1, client: { name: 'Cliente Á' }, tags: ['preventivo', 'activo'] }];
  try {
    for (const format of ['json', 'csv', 'xlsx', 'parquet'] as ExportFormat[]) {
      const file = path.join(directory, `sample.${format}`);
      await exportRows(rows, format, file);
      expect((await fs.stat(file)).size).toBeGreaterThan(0);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('exports an empty parquet dataset', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-empty-'));
  const file = path.join(directory, 'empty.parquet');
  try {
    await exportRows([], 'parquet', file);
    expect((await fs.stat(file)).size).toBeGreaterThan(0);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

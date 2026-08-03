import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { validateSiysUrls } from '../src/config.js';
import { readJsonFile } from '../src/json-file.js';

test('requires absolute HTTPS SIYS URLs and a shared API/login origin', () => {
  expect(validateSiysUrls('https://app.siys.net', 'https://api.siys.net/api', 'https://api.siys.net/login')).toEqual({
    baseUrl: 'https://app.siys.net', apiUrl: 'https://api.siys.net/api', loginUrl: 'https://api.siys.net/login',
  });
  expect(() => validateSiysUrls('http://app.siys.net', 'https://api.siys.net/api', 'https://api.siys.net/login')).toThrow(/HTTPS/);
  expect(() => validateSiysUrls('https://app.siys.net', 'https://api.siys.net/api', 'https://login.siys.net/login')).toThrow(/mismo origen/);
  expect(() => validateSiysUrls('https://user:secret@app.siys.net', 'https://api.siys.net/api', 'https://api.siys.net/login')).toThrow(/credenciales/);
  expect(() => validateSiysUrls('https://app.siys.net', 'https://api.siys.net/api?token=x', 'https://api.siys.net/login')).toThrow(/query/);
});

test('rejects BOM, replacement characters and mojibake in local JSON', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'siys-json-'));
  const file = path.join(directory, 'input.json');
  try {
    await fs.writeFile(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]));
    await expect(readJsonFile(file, 'Entrada')).rejects.toThrow(/BOM/);
    await fs.writeFile(file, '{"text":"\uFFFD"}', 'utf8');
    await expect(readJsonFile(file, 'Entrada')).rejects.toThrow(/reemplazo/);
    await fs.writeFile(file, '{"text":"CotizaciÃ³n"}', 'utf8');
    await expect(readJsonFile(file, 'Entrada')).rejects.toThrow(/mojibake/);
    await fs.writeFile(file, '{"text":"Cotización"}', 'utf8');
    await expect(readJsonFile(file, 'Entrada')).resolves.toEqual({ text: 'Cotización' });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

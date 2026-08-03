import path from 'node:path';
import { expect, test } from '@playwright/test';
import { buildDownloadOptions, defaultParams, outputPathFor, parseFormats, parseModules, sanitizeQuoteRecord } from '../src/download.js';

test('parses repeated and comma-separated modules', () => {
  expect(parseModules(['orders,quotes', 'clients'])).toEqual(['orders', 'quotes', 'clients']);
  expect(parseModules(['all'])).toEqual(['orders', 'quotes', 'clients', 'equipment']);
});

test('parses repeated and comma-separated formats', () => {
  expect(parseFormats(['json,csv', 'xlsx'])).toEqual(['json', 'csv', 'xlsx']);
  expect(parseFormats([])).toEqual(['xlsx']);
});

test('rejects output for multiple files', () => {
  expect(() => buildDownloadOptions({ module: ['orders,quotes'], format: ['xlsx'], output: 'out.xlsx' })).toThrow(/--output/);
  expect(() => buildDownloadOptions({ module: ['orders'], format: ['json,xlsx'], output: 'out.xlsx' })).toThrow(/--output/);
});

test('builds output names for download combinations', () => {
  const options = buildDownloadOptions({ module: ['orders'], format: ['json'], outDir: 'data' });
  expect(outputPathFor('orders', 'json', options, '20260616-010203')).toBe(path.join('data', 'orders-20260616-010203.json'));
});

test('uses the current year as the default orders date range', () => {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);

  expect(defaultParams('orders')).toEqual({ start: `${year}-01-01`, end: today });
});

test('requires explicit opt-in for partial downloads', () => {
  expect(buildDownloadOptions({ module: ['orders'] }).allowPartial).toBe(false);
  expect(buildDownloadOptions({ module: ['orders'], allowPartial: true }).allowPartial).toBe(true);
});

test('sanitizes secrets embedded in quote creator data before export', () => {
  expect(sanitizeQuoteRecord({ creadoPor: { name: 'Coordinador', password: 'hash', pushToken: 'token' } })).toEqual({
    creadoPor: { name: 'Coordinador', password: '[REDACTED]', pushToken: '[REDACTED]' },
  });
});

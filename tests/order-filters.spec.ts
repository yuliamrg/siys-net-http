import { expect, test } from '@playwright/test';
import { buildOrderFilterParams, parseOrderState } from '../src/order-filters.js';

test('builds the exact SIYS order-list filters for finalised orders by creator', () => {
  expect(buildOrderFilterParams({ start: '2026-01-01', end: '2026-07-20', state: 'Finalizada', createdBy: 'user-id' })).toMatchObject({
    state: '3', created_by: 'user-id', start: '2026-01-01', end: '2026-07-20',
    'range[]': ['"2026-01-01T05:00:00.000Z"', '"2026-07-21T04:59:59.999Z"'],
  });
});

test('accepts the state labels shown by SIYS', () => {
  expect(parseOrderState('En ejecución')).toBe('2');
  expect(parseOrderState('Finalizada')).toBe('3');
});

test('validates real calendar dates instead of normalizing them', () => {
  expect(() => buildOrderFilterParams({ start: '2026-02-29', end: '2026-03-01' })).toThrow(/--start/);
  expect(() => buildOrderFilterParams({ start: '2026-02-31', end: '2026-03-01' })).toThrow(/--start/);
  expect(buildOrderFilterParams({ start: '2028-02-29', end: '2028-02-29' }).start).toBe('2028-02-29');
});

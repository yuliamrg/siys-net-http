import { expect, test } from '@playwright/test';
import { canonicalEndpoints } from '../src/endpoints.js';

test('ships canonical endpoint definitions for clean installs', () => {
  expect(canonicalEndpoints.map((endpoint) => endpoint.module)).toEqual(['orders', 'quotes', 'clients', 'equipment']);
  expect(canonicalEndpoints.find((endpoint) => endpoint.module === 'orders')?.pagination?.pageParam).toBe('page');
});

import { expect, test } from '@playwright/test';
import { canonicalEndpoints, validateEndpointDefinitions } from '../src/endpoints.js';

test('ships canonical endpoint definitions for clean installs', () => {
  expect(canonicalEndpoints.map((endpoint) => endpoint.module)).toEqual(['orders', 'quotes', 'clients', 'equipment']);
  expect(canonicalEndpoints.find((endpoint) => endpoint.module === 'orders')?.pagination?.pageParam).toBe('page');
});

test('accepts only known read-only endpoint definitions', () => {
  expect(validateEndpointDefinitions(canonicalEndpoints)).toHaveLength(4);
  expect(() => validateEndpointDefinitions([{ module: 'orders', method: 'POST', path: '/order' }])).toThrow(/GET/);
  expect(() => validateEndpointDefinitions([{ module: 'orders', method: 'GET', path: 'https://evil.example/order' }])).toThrow(/ruta relativa segura/);
  expect(() => validateEndpointDefinitions([{ module: 'orders', method: 'GET', path: '/%2e%2e/secret' }])).toThrow(/ruta relativa segura/);
  expect(() => validateEndpointDefinitions([{ module: 'orders', method: 'GET', path: '/order', extra: true }])).toThrow(/claves desconocidas/);
  expect(() => validateEndpointDefinitions([
    { module: 'orders', method: 'GET', path: '/order' },
    { module: 'orders', method: 'GET', path: '/order' },
  ])).toThrow(/duplicado/);
});

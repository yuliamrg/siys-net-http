import { expect, test } from '@playwright/test';
import { LOGIN_URL } from '../src/config.js';
import { isAllowedRequest, parseBody, redact } from '../src/security.js';

test('allows read methods and the login request', () => {
  expect(isAllowedRequest('GET', 'https://api.siys.net/api/orders')).toBe(true);
  expect(isAllowedRequest('HEAD', 'https://app.siys.net')).toBe(true);
  expect(isAllowedRequest('OPTIONS', 'https://api.siys.net/api/orders')).toBe(true);
  expect(isAllowedRequest('POST', LOGIN_URL)).toBe(true);
});

test('blocks other potentially mutating requests', () => {
  expect(isAllowedRequest('POST', 'https://api.siys.net/api/orders')).toBe(false);
  expect(isAllowedRequest('PUT', 'https://api.siys.net/api/orders/1')).toBe(false);
  expect(isAllowedRequest('PATCH', 'https://api.siys.net/api/orders/1')).toBe(false);
  expect(isAllowedRequest('DELETE', 'https://api.siys.net/api/orders/1')).toBe(false);
});

test('redacts secrets recursively', () => {
  expect(redact({ email: 'a@example.com', password: 'secret', nested: { token: 'jwt' } })).toEqual({
    email: 'a@example.com',
    password: '[REDACTED]',
    nested: { token: '[REDACTED]' },
  });
  expect(parseBody('email=a%40example.com&password=secret')).toEqual({
    email: 'a@example.com',
    password: '[REDACTED]',
  });
});

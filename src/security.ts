import { LOGIN_URL, sensitiveKeys } from './config.js';

const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isAllowedRequest(method: string, url: string): boolean {
  const normalizedMethod = method.toUpperCase();
  return readMethods.has(normalizedMethod) || (normalizedMethod === 'POST' && url === LOGIN_URL);
}

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      sensitiveKeys.test(key) ? '[REDACTED]' : redact(child),
    ]),
  );
}

export function parseBody(body: string | null): unknown {
  if (!body) return undefined;
  try {
    return redact(JSON.parse(body));
  } catch {
    const params = new URLSearchParams(body);
    if ([...params.keys()].length > 0) return redact(Object.fromEntries(params));
    return '[NON_JSON_BODY]';
  }
}

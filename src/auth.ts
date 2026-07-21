import fs from 'node:fs/promises';
import { BASE_URL, LOGIN_URL } from './config.js';
import { ensureDir } from './utils.js';
import { privateDir, storageStatePath } from './paths.js';

interface StorageState {
  cookies?: unknown[];
  origins?: Array<{ origin?: string; localStorage?: Array<{ name: string; value: string }> }>;
}

export async function loadToken(): Promise<string> {
  if (process.env.SIYS_TOKEN) return process.env.SIYS_TOKEN;
  const state = JSON.parse(await fs.readFile(storageStatePath, 'utf8')) as StorageState;
  for (const origin of state.origins ?? []) {
    const token = origin.localStorage?.find((entry) => entry.name === 'token')?.value;
    if (token) return token;
  }
  throw new Error('No se encontro un token. Ejecuta siys login, define SIYS_TOKEN o configura SIYS_EMAIL y SIYS_PASSWORD.');
}

export function tokenExpiration(token: string): Date | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: number };
    return payload.exp ? new Date(payload.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

export function tokenIssuedAt(token: string): Date | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { iat?: number };
    return payload.iat ? new Date(payload.iat * 1000) : undefined;
  } catch {
    return undefined;
  }
}

export async function saveToken(token: string): Promise<void> {
  await ensureDir(privateDir);
  const origin = new URL(BASE_URL).origin;
  const state: StorageState = {
    cookies: [],
    origins: [{ origin, localStorage: [{ name: 'token', value: token }] }],
  };
  await fs.writeFile(storageStatePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function tokenFromLoginResponse(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.token === 'string') return record.token;
  if (typeof record.data === 'string') return record.data;
  return undefined;
}

export async function loginDirect(): Promise<string> {
  const email = process.env.SIYS_EMAIL;
  const password = process.env.SIYS_PASSWORD;
  if (!email || !password) throw new Error('Define SIYS_EMAIL y SIYS_PASSWORD en .env para login HTTP directo.');

  const response = await fetch(LOGIN_URL, {
    method: 'POST',
    headers: { accept: 'application/json, text/plain, */*', 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Login rechazado por SIYS: HTTP ${response.status}.`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text.trim();
  }
  const token = tokenFromLoginResponse(parsed);
  if (!token || token.split('.').length !== 3) throw new Error('Login exitoso, pero la respuesta no contiene un JWT reconocible.');
  await saveToken(token);
  return token;
}

export async function getAuthenticatedToken(autoLogin = true): Promise<string> {
  try {
    // SIYS conserva la sesión autenticada. Reutilizar siempre el token disponible
    // y dejar que el servidor indique si dejó de ser válido.
    return await loadToken();
  } catch (error) {
    if (!autoLogin) throw error;
  }
  return loginDirect();
}

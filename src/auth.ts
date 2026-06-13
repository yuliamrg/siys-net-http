import fs from 'node:fs/promises';
import { storageStatePath } from './paths.js';

interface StorageState {
  origins?: Array<{ localStorage?: Array<{ name: string; value: string }> }>;
}

export async function loadToken(): Promise<string> {
  if (process.env.SIYS_TOKEN) return process.env.SIYS_TOKEN;
  const state = JSON.parse(await fs.readFile(storageStatePath, 'utf8')) as StorageState;
  for (const origin of state.origins ?? []) {
    const token = origin.localStorage?.find((entry) => entry.name === 'token')?.value;
    if (token) return token;
  }
  throw new Error('No se encontro un token. Ejecuta npm run capture o define SIYS_TOKEN.');
}

export function tokenExpiration(token: string): Date | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { exp?: number };
    return payload.exp ? new Date(payload.exp * 1000) : undefined;
  } catch {
    return undefined;
  }
}

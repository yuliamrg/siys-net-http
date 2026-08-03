import './env.js';

export const BASE_URL = process.env.SIYS_BASE_URL ?? 'https://app.siys.net';
export const API_URL = process.env.SIYS_API_URL ?? 'https://api.siys.net/api';
export const LOGIN_URL = process.env.SIYS_LOGIN_URL ?? 'https://api.siys.net/login';

function timeoutFromEnvironment(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1_000 || value > 300_000) {
    throw new Error(`${name} debe ser un entero entre 1000 y 300000 milisegundos.`);
  }
  return value;
}

export const HTTP_TIMEOUT_MS = timeoutFromEnvironment('SIYS_HTTP_TIMEOUT_MS', 30_000);
export const IMAGE_TIMEOUT_MS = 60_000;
export const OPENAI_TIMEOUT_MS = 120_000;

export const moduleLabels = {
  orders: /orden(?:es)?/i,
  quotes: /cotizaci[oó]n(?:es)?/i,
  clients: /cliente(?:s)?/i,
  equipment: /equipo(?:s)?|activo(?:s)?/i,
} as const;

export const sensitiveKeys = /password|clave|token|authorization|authentication|cookie|secret/i;

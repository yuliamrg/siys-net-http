import './env.js';

export function validateSiysUrls(baseValue: string, apiValue: string, loginValue: string): { baseUrl: string; apiUrl: string; loginUrl: string } {
  const entries = [['SIYS_BASE_URL', baseValue], ['SIYS_API_URL', apiValue], ['SIYS_LOGIN_URL', loginValue]] as const;
  const parsed = entries.map(([name, value]) => {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error(`${name} debe ser una URL absoluta HTTPS.`); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${name} debe ser una URL HTTPS sin credenciales embebidas.`);
    if (url.search || url.hash) throw new Error(`${name} no debe contener query ni fragmento.`);
    return url;
  });
  if (parsed[1].origin !== parsed[2].origin) throw new Error('SIYS_API_URL y SIYS_LOGIN_URL deben usar el mismo origen HTTPS.');
  return { baseUrl: parsed[0].toString().replace(/\/$/, ''), apiUrl: parsed[1].toString().replace(/\/$/, ''), loginUrl: parsed[2].toString() };
}

const validatedUrls = validateSiysUrls(
  process.env.SIYS_BASE_URL ?? 'https://app.siys.net',
  process.env.SIYS_API_URL ?? 'https://api.siys.net/api',
  process.env.SIYS_LOGIN_URL ?? 'https://api.siys.net/login',
);

export const BASE_URL = validatedUrls.baseUrl;
export const API_URL = validatedUrls.apiUrl;
export const LOGIN_URL = validatedUrls.loginUrl;

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

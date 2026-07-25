import './env.js';

export const BASE_URL = process.env.SIYS_BASE_URL ?? 'https://app.siys.net';
export const API_URL = process.env.SIYS_API_URL ?? 'https://api.siys.net/api';
export const LOGIN_URL = process.env.SIYS_LOGIN_URL ?? 'https://api.siys.net/login';

export const moduleLabels = {
  orders: /orden(?:es)?/i,
  quotes: /cotizaci[oó]n(?:es)?/i,
  clients: /cliente(?:s)?/i,
  equipment: /equipo(?:s)?|activo(?:s)?/i,
} as const;

export const sensitiveKeys = /password|clave|token|authorization|authentication|cookie|secret/i;

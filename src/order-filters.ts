export type QueryValue = string | string[];
export type QueryParams = Record<string, QueryValue>;

export interface OrderFilterInput {
  code?: string;
  type?: string;
  cause?: string;
  rootCause?: string;
  start: string;
  end: string;
  state?: string;
  invoiced?: string;
  customer?: string;
  subsidiary?: string;
  technician?: string;
  createdBy?: string;
}

const states: Record<string, string> = {
  abierta: '1', 'en ejecucion': '2', finalizada: '3', 'pendiente por cotizar': '4', cotizada: '5', cerrada: '6', anulada: '0',
};

function normalized(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase();
}

function validDate(value: string, option: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : undefined;
  if (!match || !parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${option} debe tener formato YYYY-MM-DD.`);
  }
}

function endOfBogotaDay(date: string): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return `${next.toISOString().slice(0, 10)}T04:59:59.999Z`;
}

export function parseOrderState(value: string): string {
  const state = states[normalized(value)] ?? value;
  if (!/^[0-6]$/.test(state)) throw new Error(`Estado de orden invalido: ${value}.`);
  return state;
}

export function parseInvoiced(value: string): string {
  const parsed: Record<string, string> = { si: 'true', yes: 'true', true: 'true', no: 'false', false: 'false' };
  const result = parsed[normalized(value)];
  if (!result) throw new Error('--invoiced acepta si o no.');
  return result;
}

/** Parámetros observados en la pantalla SIYS > Mantenimiento > Órdenes. */
export function buildOrderFilterParams(input: OrderFilterInput): QueryParams {
  validDate(input.start, '--start');
  validDate(input.end, '--end');
  if (input.start > input.end) throw new Error('--start no puede ser posterior a --end.');

  const params: QueryParams = {
    code: input.code ?? '',
    causa: input.cause ?? '',
    raiz: input.rootCause ?? '',
    state: input.state ? parseOrderState(input.state) : '',
    checkIn: input.invoiced ? parseInvoiced(input.invoiced) : '',
    subsidiary: input.subsidiary ?? '',
    start: input.start,
    end: input.end,
    'range[]': [`"${input.start}T05:00:00.000Z"`, `"${endOfBogotaDay(input.end)}"`],
  };
  if (input.type) params.type = input.type;
  if (input.customer) params.customer = input.customer;
  if (input.technician) params.user = input.technician;
  if (input.createdBy) params.created_by = input.createdBy;
  return params;
}

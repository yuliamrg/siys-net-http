export type ErrorCategory = 'internal' | 'usage' | 'auth' | 'network' | 'io' | 'safety' | 'cancelled';

const EXIT_CODES: Record<ErrorCategory, number> = {
  internal: 1,
  usage: 2,
  auth: 3,
  network: 4,
  io: 5,
  safety: 6,
  cancelled: 130,
};

export class CliError extends Error {
  readonly exitCode: number;

  constructor(
    message: string,
    readonly category: ErrorCategory,
    readonly code: string,
    readonly operation?: string,
    readonly requestId?: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CliError';
    this.exitCode = EXIT_CODES[category];
  }
}

const IO_CODES = new Set(['EACCES', 'EBUSY', 'EEXIST', 'EISDIR', 'EMFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'EPERM', 'EROFS']);

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;
  const value = error && typeof error === 'object' ? error as { code?: string; message?: string } : {};
  const message = error instanceof Error ? error.message : String(error);
  if (value.code && IO_CODES.has(value.code)) return new CliError(message, 'io', 'local_io', undefined, undefined, false, { cause: error });
  if (/\b(?:401|403)\b|token|credencial|login rechazado/i.test(message)) return new CliError(message, 'auth', 'authentication_failed', undefined, undefined, false, { cause: error });
  if (/contrato|aprob|confirm|conflict|conflicto|ambiguous|ambiguo|verific|recibo|no reintentar/i.test(message)) return new CliError(message, 'safety', 'safety_check_failed', undefined, undefined, false, { cause: error });
  if (/invalido|inválido|requiere|indica --|debe |no existe|falta |solo se puede|no hay endpoint|schema|JSON valido/i.test(message)) return new CliError(message, 'usage', 'invalid_input', undefined, undefined, false, { cause: error });
  return new CliError(message, 'internal', 'internal_error', undefined, undefined, false, { cause: error });
}

export function errorPayload(error: CliError): Record<string, unknown> {
  return {
    code: error.code,
    category: error.category,
    message: error.message,
    operation: error.operation ?? null,
    requestId: error.requestId ?? null,
    retryable: error.retryable,
  };
}

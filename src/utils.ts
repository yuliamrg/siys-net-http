import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDir(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
}

export function timestamp(): string {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function getByPath(value: unknown, dottedPath?: string): unknown {
  if (!dottedPath) return value;
  return dottedPath.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object') return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

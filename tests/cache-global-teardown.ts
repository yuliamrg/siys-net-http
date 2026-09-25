import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function globalTeardown(): Promise<void> {
  const root = process.env.SIYS_PLAYWRIGHT_CACHE_DIR;
  if (!root) return;
  const resolvedRoot = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir());
  if (path.dirname(resolvedRoot) !== tempRoot || !path.basename(resolvedRoot).startsWith('siys-playwright-cache-')) {
    throw new Error('Se rechazo limpiar un cache de tests fuera del directorio temporal esperado.');
  }
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

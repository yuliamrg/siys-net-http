import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export default async function globalSetup(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'siys-playwright-cache-'));
  process.env.SIYS_PLAYWRIGHT_CACHE_DIR = root;
  process.env.SIYS_CACHE_DIR = root;
  process.env.SIYS_CACHE_PROFILE = 'playwright-tests';
}

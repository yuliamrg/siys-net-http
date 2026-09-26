import fs from 'node:fs';
import path from 'node:path';
import { expect, test as base } from '@playwright/test';

type WorkerFixtures = { isolatedCache: void };
type NoTestFixtures = Record<never, never>;

export const test = base.extend<NoTestFixtures, WorkerFixtures>({
  isolatedCache: [async ({ browserName }, use, workerInfo) => {
    void browserName;
    const root = process.env.SIYS_PLAYWRIGHT_CACHE_DIR;
    if (!root) throw new Error('El cache temporal global de Playwright no esta configurado.');
    const workerRoot = path.join(root, `worker-${workerInfo.workerIndex}`);
    fs.mkdirSync(workerRoot, { recursive: true });
    process.env.SIYS_CACHE_DIR = workerRoot;
    process.env.SIYS_CACHE_PROFILE = 'playwright-tests';
    await use();
  }, { scope: 'worker', auto: true }],
});

export { expect };

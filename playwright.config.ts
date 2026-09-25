import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  globalSetup: './tests/cache-global-setup.ts',
  globalTeardown: './tests/cache-global-teardown.ts',
  use: {
    baseURL: 'https://app.siys.net',
    browserName: 'chromium',
    headless: true,
  },
});

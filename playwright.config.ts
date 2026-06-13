import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  use: {
    baseURL: 'https://app.siys.net',
    browserName: 'chromium',
    headless: true,
  },
});

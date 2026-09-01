import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm start',
    url: 'http://127.0.0.1:3000/health',
    reuseExistingServer: false,
    env: { PUBLIC_ORIGIN: 'http://127.0.0.1:3000', PORT: '3000' },
  },
  reporter: 'list',
});

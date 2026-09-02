import { defineConfig, devices } from '@playwright/test';

const isCI = process.env.CI === 'true';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  workers: isCI ? 2 : 4,
  retries: isCI ? 1 : 0,
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 7'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 15'] } },
  ],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm start',
    url: 'http://127.0.0.1:3000/health',
    reuseExistingServer: false,
    env: {
      PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
      PORT: '3000',
    },
  },
  reporter: 'list',
});

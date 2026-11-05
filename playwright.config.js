import { defineConfig, devices } from '@playwright/test';

const baseURL = 'http://127.0.0.1:8787';

export default defineConfig({
  testDir: './browser-tests',
  fullyParallel: true,
  reporter: 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run dev -- --ip 127.0.0.1 --port 8787',
    url: baseURL,
    // Never reuse an arbitrary server or allow these destructive-flow tests
    // to be pointed at a production URL. Always start a local Wrangler Worker.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

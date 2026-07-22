import { defineConfig, devices } from '@playwright/test';

const webServerEnvironment = {
  ...process.env,
  LOG_LEVEL: 'silent',
  NODE_ENV: 'test',
};
const e2eApiPort = process.env.E2E_API_PORT ?? process.env.API_PORT ?? '3000';
const e2eApiBaseUrl = `http://127.0.0.1:${e2eApiPort}`;

export default defineConfig({
  expect: { timeout: 7_500 },
  forbidOnly: Boolean(process.env.CI),
  fullyParallel: false,
  globalSetup: './tests/e2e/global-setup.ts',
  outputDir: 'test-results',
  projects: [
    {
      name: 'admin-chromium',
      testMatch: /admin\.e2e\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { height: 900, width: 1440 } },
    },
    {
      name: 'mini-android-chromium',
      testMatch: /mini-app\.e2e\.spec\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'mini-iphone-webkit',
      testMatch: /mini-app\.e2e\.spec\.ts/,
      use: { ...devices['iPhone 13'] },
    },
  ],
  reporter: [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  retries: process.env.CI ? 1 : 0,
  testDir: './tests/e2e',
  timeout: 30_000,
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  webServer: [
    {
      command: 'corepack pnpm --filter @zalo-shop/api dev',
      env: { ...webServerEnvironment, API_PORT: e2eApiPort },
      name: 'API',
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'ignore',
      timeout: 120_000,
      url: `http://127.0.0.1:${e2eApiPort}/health/live`,
    },
    {
      command:
        'corepack pnpm --filter @zalo-shop/admin-web exec vite --host 127.0.0.1 --port 5173 --strictPort',
      env: {
        ...webServerEnvironment,
        VITE_API_BASE_URL: '/api',
        VITE_API_PROXY_TARGET: e2eApiBaseUrl,
      },
      name: 'Admin Web',
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'ignore',
      timeout: 120_000,
      url: 'http://127.0.0.1:5173/',
    },
    {
      command:
        'corepack pnpm --filter @zalo-shop/mini-app exec vite --host 127.0.0.1 --port 5174 --strictPort',
      env: {
        ...webServerEnvironment,
        VITE_API_BASE_URL: '/api',
        VITE_API_PROXY_TARGET: e2eApiBaseUrl,
        VITE_STORE_CODE: 'beauty-local',
        VITE_ZALO_TEST_BRIDGE: 'true',
      },
      name: 'Beauty Mini App',
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'ignore',
      timeout: 120_000,
      url: 'http://127.0.0.1:5174/',
    },
    {
      command:
        'corepack pnpm --filter @zalo-shop/mini-app exec vite --host 127.0.0.1 --port 5175 --strictPort',
      env: {
        ...webServerEnvironment,
        VITE_API_BASE_URL: '/api',
        VITE_API_PROXY_TARGET: e2eApiBaseUrl,
        VITE_STORE_CODE: 'fashion-local',
        VITE_ZALO_TEST_BRIDGE: 'true',
      },
      name: 'Fashion Mini App',
      reuseExistingServer: false,
      stderr: 'pipe',
      stdout: 'ignore',
      timeout: 120_000,
      url: 'http://127.0.0.1:5175/',
    },
  ],
  workers: 1,
});

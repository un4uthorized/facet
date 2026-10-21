import { defineConfig } from '@playwright/test';
import { createTestDatabase, validateTestDatabaseUrl } from './tests/postgres.js';

const databaseUrl = process.env.FACET_E2E_DATABASE_URL ?? (await createTestDatabase()).databaseUrl;
validateTestDatabaseUrl(databaseUrl);
process.env.FACET_E2E_DATABASE_URL = databaseUrl;
export default defineConfig({
  testDir: './tests/e2e',
  globalTeardown: './tests/e2e/teardown.ts',
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://127.0.0.1:4273',
    channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: process.env.PLAYWRIGHT_DEV === '1' ? 'node --import tsx server/index.ts' : 'node build/server/index.js',
    url: 'http://127.0.0.1:4273/login',
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '4273',
      ADMIN_EMAIL: 'admin@facet.test',
      ADMIN_PASSWORD: 'browser-admin-password',
      DATABASE_URL: databaseUrl,
      MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      COOKIE_SECURE: 'false',
      TRUST_PROXY: 'false',
    },
  },
});

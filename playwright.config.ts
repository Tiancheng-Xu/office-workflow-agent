import { defineConfig, chromium } from '@playwright/test';
import { qaBudgets } from './tests/e2e/qa-metadata.ts';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: qaBudgets.testMs,
  expect: { timeout: qaBudgets.expectationMs },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['./tests/e2e/qa-reporter.ts']],
  outputDir: 'work/qa-playwright',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1440, height: 1050 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ?? chromium.executablePath() },
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
});

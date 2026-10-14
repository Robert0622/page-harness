import { defineConfig, devices } from '@playwright/test'

const APP = 17980
const FIXTURE = 5179

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${APP}`,
    locale: 'en-US',
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1400, height: 900 },
  },
  webServer: {
    command: 'node e2e/fixture-server.mjs',
    env: { FIXTURE_PORT: String(FIXTURE), APP_PORT: String(APP) },
    url: `http://localhost:${APP}/__ph/overlay.js`,
    reuseExistingServer: false,
  },
})

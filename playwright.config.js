import { defineConfig } from '@playwright/test';

const apiUrl = 'http://127.0.0.1:3001/api/health';
const demoUrl = 'http://127.0.0.1:5173';

export default defineConfig({
  testDir: './tests',
  testMatch: 'flow.spec.js',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: demoUrl,
    channel: 'msedge',
    headless: true,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  webServer: [
    {
      command: 'node server.js',
      url: apiUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { PORT: '3001', NODE_ENV: 'test' },
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 5173 --strictPort',
      url: demoUrl,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});

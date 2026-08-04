import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'html',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    contextOptions: { reducedMotion: 'reduce' },
    serviceWorkers: 'block',
    launchOptions: {
      args: [
        '--font-render-hinting=none',
        '--disable-font-subpixel-positioning',
        '--disable-lcd-text',
        '--disable-skia-runtime-opts',
        '--disable-system-font-check',
        '--force-device-scale-factor=1',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu', // Use software rendering for consistency across CI and local runs.
        '--use-gl=swiftshader',
        '--disable-smooth-scrolling',
        '--disable-partial-raster',
      ],
    },
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1, // Enforce 1x so screenshots stay a manageable, comparable size.
    timezoneId: 'America/New_York',
    locale: 'en-US',
  },
  snapshotPathTemplate: '{testDir}/{testFileDir}/screenshots/{arg}{ext}',
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
  },
  timeout: 60000,
  expect: {
    timeout: 5000,
    toHaveScreenshot: { maxDiffPixels: 0 },
  },
});

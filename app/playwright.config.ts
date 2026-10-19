import { defineConfig } from '@playwright/test'

/**
 * Playwright E2E config for the Flow Electron app.
 *
 * These tests launch the *built* app (`out/main/index.js`), so run
 * `npm run build` (and `npm run rebuild` for native modules) first —
 * `npm run e2e` does the build for you.
 *
 * Electron tests share a single OS-level app surface and native resources
 * (SQLite, node-pty), so they run serially (workers: 1, no parallelism).
 */
export default defineConfig({
  testDir: './e2e',
  // Clears seed directories left by a run that was killed before its teardown
  // could run — see e2e/global-setup.ts for why this is at START.
  globalSetup: './e2e/global-setup.ts',
  testMatch: '**/*.spec.ts',
  /**
   * A PACKAGED BUILD IS NOT A TEST SOURCE.
   *
   * `electron-builder` copies the app — `e2e/` and this config with it — into
   * `dist/mac-arm64/Flow.app/Contents/Resources/app/`, and a filtered run
   * collected that copy too: every spec ran twice, and the packaged one ran
   * whatever it was built from. A fix to a spec left the stale twin failing on
   * the old assertion, which reads as a real regression and is not one.
   */
  // SPECS THAT DRIVE THE USER'S REAL CHECKOUTS ARE OPT-IN (2026-10-09). The
  // app under test runs on a throwaway Flow folder; adding a real checkout to it
  // re-pointed that checkout's flow/ link into the folder, which was deleted
  // after the run — the user's own app then launched on a dangling link. Run
  // them only on purpose: FLOW_LIVE_REAL_CHECKOUT=1.
  testIgnore: [
    '**/dist/**',
    '**/out/**',
    '**/node_modules/**',
    ...(process.env.FLOW_LIVE_REAL_CHECKOUT === '1'
      ? []
      : ['**/live-*.spec.ts', '**/learn-chats.spec.ts', '**/blueprint-cell-figures.spec.ts']),
  ],
  // Electron cannot be driven headless the way a browser can; one app at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never' }]]
    : [['list']],
  use: {
    trace: 'retain-on-failure',
  },
})

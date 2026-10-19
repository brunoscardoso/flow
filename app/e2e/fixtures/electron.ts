import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/** Absolute path to the built Electron main entry. */
const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')

/** How long a graceful app quit may take before the process is reaped. */
const CLOSE_BUDGET_MS = 15_000

/**
 * Closes the first-run onboarding wizard if it's up. A fresh userData dir has no
 * Claude account, so the "Welcome to Flow" wizard (reusing .fl-settings-overlay,
 * identified by its .fl-wizard-body) opens over the shell and intercepts clicks.
 * Feature specs need a clean shell, so the `window` fixture dismisses it here.
 */
export async function dismissOnboarding(window: Page): Promise<void> {
  const wizard = window.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if ((await wizard.count()) === 0) return
  const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
  if (await skip.count()) {
    await skip.first().click()
  } else {
    await window.keyboard.press('Escape')
  }
  await expect(wizard).toHaveCount(0)
}

export interface FlowFixtures {
  /** The launched Electron application. */
  app: ElectronApplication
  /** The app's first (main) window, with first-run onboarding already dismissed. */
  window: Page
  /** The temp userData directory this run is sandboxed to. */
  userDataDir: string
}

export interface FlowOptions {
  /**
   * Environment overrides for the launched app, merged over the inherited
   * process env. A key mapped to `undefined` is REMOVED rather than set — which
   * is the whole reason this exists: a spec that must not reach a real agent
   * account has to delete the inherited auth tokens, not blank them.
   *
   * Default `{}` — every existing spec launches with exactly the env it always
   * did. Set per-file with `test.use({ appEnv: … })`.
   */
  appEnv: Record<string, string | undefined>
}

/** Apply `appEnv` to a base environment: set what is given, delete what is not. */
function withOverrides(
  base: NodeJS.ProcessEnv,
  overrides: Record<string, string | undefined>,
): Record<string, string> {
  const merged: NodeJS.ProcessEnv = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(merged)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

/**
 * Launches the built Flow app against a throwaway userData directory so every
 * test starts from a known, isolated state (a fresh dir triggers first-run
 * onboarding). Seed state by writing into `userDataDir` before first use, or
 * by driving the UI.
 */
export const test = base.extend<FlowFixtures & FlowOptions>({
  appEnv: [{}, { option: true }],

  userDataDir: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'flow-e2e-'))
    await use(dir)
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup — a locked SQLite file on teardown is non-fatal.
    }
  },

  app: async ({ userDataDir, appEnv }, use) => {
    const app = await electron.launch({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
      env: withOverrides(
        {
          ...process.env,
          // Force the production file-renderer branch, never a vite dev server.
          ELECTRON_RENDERER_URL: '',
          NODE_ENV: 'production',
          // Mark the run so app code can relax network/credential gating if it checks.
          FLOW_E2E: '1',
          // EVERY PROJECT LIVES IN A WORKSPACE (the hard migration): the first
          // launch moves every registered project into the Default Workspace,
          // in the Flow folder. A spec must never do that to the developer's
          // own Flow folder, so each run gets one of its own beside its
          // profile — a spec that needs a particular one sets it in `appEnv`.
          PLAN_FLOW_HOME: join(userDataDir, 'plan-flow-home'),
          // A SPEC'S SHELL MUST NOT ASK IT A QUESTION. oh-my-zsh offers its own
          // update at login, and the offer sits where the prompt should be —
          // every terminal spec then waits 30s for a prompt that will never
          // come, and reports a product failure. The var is read by the
          // developer's own zsh config, nothing this app controls.
          DISABLE_AUTO_UPDATE: 'true',
        },
        appEnv,
      ),
    })
    await use(app)
    // Quitting is intercepted by an ASYNC disposal (`before-quit` →
    // disposeMainProcess → re-issue quit, main/index.ts:2082). If any part of
    // that never settles, `close()` never resolves and EVERY spec — whatever it
    // asserted — dies with "Tearing down app exceeded the test timeout",
    // reporting a product bug as a failure of an unrelated spec. Bound the wait
    // and reap the process, so a hung quit costs one spec's teardown and no
    // false reds. The quit itself is guarded, explicitly and on purpose, by
    // `ux/app-quit-with-project.spec.ts` (the tripwire for #1284) — this
    // bound never hides it.
    //
    // A spec may legitimately have closed the app ITSELF — a relaunch test has to,
    // to prove state survives the process (#1502). `app.process()` throws on a
    // closed app ("Cannot read properties of undefined"), and a throw in teardown
    // fails the test WHATEVER it asserted: the height-persist spec was reported as
    // a broken feature for exactly that reason, with its assertions all passing.
    // Teardown is cleanup, so it reports nothing and swallows nothing important.
    let pid: number | undefined
    try {
      pid = app.process().pid
    } catch {
      return // already closed by the spec — nothing left to reap
    }
    await Promise.race([
      app.close().catch(() => undefined),
      new Promise((settle) => setTimeout(settle, CLOSE_BUDGET_MS)),
    ])
    if (pid !== undefined) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // Already exited — the normal path.
      }
    }
  },

  window: async ({ app }, use) => {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    // Feature specs expect the shell, not the first-run wizard.
    await dismissOnboarding(window)
    await use(window)
  },
})

export { expect } from '@playwright/test'

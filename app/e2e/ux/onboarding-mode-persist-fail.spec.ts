import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { trustSeededAccount, advanceWizardTo } from './fixtures/settings'
import { mkdtempSync, rmSync, existsSync, chmodSync } from 'node:fs'
import { removeTempDir } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), MODE-STEP PERSIST-FAILURE guardrail (#229).
 *
 * The base full-flow spec drives ONLY the success branch of the "Choose a mode"
 * step: click a mode → it highlights → Next ungates. The FAILURE branch — the
 * write that persists the choice rejects — had ZERO live e2e coverage.
 *
 * Why it matters: autonomy mode gates permission-prompt bypass, so a mode the UI
 * *claims* was saved but wasn't is a safety-relevant lie. steps.ts `persist()`
 * (194-206) awaits BOTH the app-setting write and the per-project `.flowconfig`
 * write inside one try/catch (#229 — no fire-and-forget that silently mismatches
 * autopilot). On a rejection the click handler (211-216) must NOT present the
 * choice as confirmed: no highlight, Next stays GATED, and a "Couldn't save your
 * choice — try again." message is shown so the user knows to retry.
 *
 * We reproduce the failure as a real user hitting a read-only project (a plausible
 * scenario: read-only mount / permission-denied flow dir) — chmod the project's
 * config-write target so `flow.setConfig`'s `flow/.flowconfig` write throws EACCES,
 * exactly like the runbook-blessed editor-save-fail probe forces EACCES via chmod.
 * `settings.setOnboarding` (flow.db, in userData) still succeeds; the guardrail is
 * about the UI never claiming success when the config write failed. No agent
 * responses are ever faked; preconditions are the runbook-blessed pre-seeded ones.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
const ANY_OVERLAY = '.fl-settings-overlay:not([hidden])'
const SCREENS = 'e2e/ux/__screens'

/** Launch the app; a seeded account reads as signed in (see trustSeededAccount). */
async function launch(userDataDir: string): Promise<ElectronApplication> {
  const app = await launchApp(userDataDir)
  await trustSeededAccount(app)
  return app
}

function launchApp(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

async function migrateDb(userDataDir: string): Promise<void> {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.close()
}

function seedAccount(userDataDir: string): void {
  const db = join(userDataDir, 'flow.db')
  execFileSync('sqlite3', [
    db,
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-e2e', 'QA Seed Account', '/tmp/flow-e2e-noconfig', 'qa@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-e2e');`,
  ])
}

async function seedProject(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-onboard-persistfail-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  return dir
}

async function dismissFlowOverlay(win: Page): Promise<void> {
  const overlay = win.locator(ANY_OVERLAY)
  try {
    await overlay.waitFor({ state: 'visible', timeout: 2000 })
  } catch {
    return
  }
  await win.keyboard.press('Escape')
  await overlay.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined)
}

async function reopenWizard(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  const settings = win.locator(SETTINGS_OVERLAY)
  await expect(settings).toBeVisible()
  // Settings is a tabbed page; "Getting Started…" is a thing about Flow itself,
  // so it sits in the App group with the theme and the updater.
  await win.locator('.fl-settings-tab', { hasText: 'App' }).click()
  await settings.locator('button', { hasText: 'Getting Started' }).click()
  await expect(win.locator(WIZARD)).toBeVisible()
}

async function nextDisabled(win: Page): Promise<boolean> {
  return win
    .locator(`${WIZARD} .fl-wizard-btn`, { hasText: 'Next' })
    .evaluate((b) => (b as HTMLButtonElement).disabled)
    .catch(() => true)
}

/** Make (or restore) the project's `.flowconfig` write target un/writable so
 *  `flow.setConfig` throws EACCES (or succeeds). Covers all three write cases:
 *  mkdir(flow/) in a read-only root, create .flowconfig in a read-only flow/, and
 *  truncate-rewrite of a read-only .flowconfig file. */
function setConfigWriteBlocked(dir: string, blocked: boolean): void {
  const flowDir = join(dir, 'flow')
  const cfg = join(flowDir, '.flowconfig')
  const dirMode = blocked ? 0o555 : 0o755
  const fileMode = blocked ? 0o444 : 0o644
  if (existsSync(cfg)) chmodSync(cfg, fileMode)
  if (existsSync(flowDir)) chmodSync(flowDir, dirMode)
  chmodSync(dir, dirMode)
}

async function walkToModeStep(win: Page): Promise<void> {
  await reopenWizard(win)
  const wizard = win.locator(WIZARD)
  // Welcome → Connect → Project → Mode (each gate already open from seeded state).
  await advanceWizardTo(win, 'Choose a mode')
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
}

test('mode step: a failed config write is NOT presented as saved — Next stays gated, no highlight, and it recovers (#229)', async () => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-persistfail-'))
  let projectDir: string | null = null
  let app: ElectronApplication | null = null
  const errors: string[] = []
  try {
    await migrateDb(userDataDir)
    seedAccount(userDataDir)

    app = await launch(userDataDir)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    win.on('pageerror', (e) => errors.push(e.message))

    const auto = win.locator(WIZARD)
    if (await auto.count()) {
      await auto.locator('.fl-wizard-btn', { hasText: 'Skip for now' }).click()
      await expect(auto).toHaveCount(0)
    }
    projectDir = await seedProject(win)
    await dismissFlowOverlay(win)

    await walkToModeStep(win)
    const wizard = win.locator(WIZARD)
    const autonomous = wizard.locator('.fl-wizard-btn', { hasText: 'Autonomous' })

    // Baseline: the step arrives with the saved-safe default REFLECTED (#716) —
    // Manual highlighted, Next ungated. Reflection is display-only; the gate
    // asserted after the failure below comes from the explicit persist-failure
    // flag (#1078), not from selection presence.
    await expect.poll(() => nextDisabled(win)).toBe(false)
    await expect(autonomous).not.toHaveClass(/fl-wizard-btn--primary/)

    // ── force the persist to fail: make the .flowconfig write target read-only ──
    // Diagnostic so a future reader knows which write case fired.
    // eslint-disable-next-line no-console
    console.log(
      `[probe] pre-chmod: flow/=${existsSync(join(projectDir, 'flow'))} .flowconfig=${existsSync(
        join(projectDir, 'flow', '.flowconfig'),
      )}`,
    )
    setConfigWriteBlocked(projectDir, true)

    // Click Autonomous → setConfig rejects (EACCES) → guardrail path.
    await autonomous.click()

    // 1) The failure is SURFACED, not silent: retry message appears.
    await expect(wizard.locator('.fl-wizard-body')).toContainText('save your choice', {
      timeout: 5000,
    })
    // 2) The choice is NOT presented as confirmed: no highlight on the clicked mode.
    await expect(autonomous).not.toHaveClass(/fl-wizard-btn--primary/)
    // 3) Next stays GATED — the user cannot advance on an unsaved (autopilot-relevant) choice.
    await expect.poll(() => nextDisabled(win)).toBe(true)
    await win.screenshot({ path: `${SCREENS}/onboarding-mode-persist-fail.png` })

    // ── recovery: restore write access, re-pick, and the choice now lands ────────
    setConfigWriteBlocked(projectDir, false)
    await autonomous.click()
    // Now the write succeeds: the mode highlights and Next ungates — the buffer/UI
    // recovered cleanly from the transient failure (no stuck-gated dead end).
    await expect(autonomous).toHaveClass(/fl-wizard-btn--primary/, { timeout: 5000 })
    await expect.poll(() => nextDisabled(win)).toBe(false)

    // The guardrail path must not throw uncaught (persist logs console.error by
    // design; that is a console message, not a pageerror).
    expect(errors, errors.join(', ')).toHaveLength(0)
  } finally {
    if (projectDir) setConfigWriteBlocked(projectDir, false)
    if (app) await app.close()
    if (projectDir) removeTempDir(projectDir)
    rmSync(userDataDir, { recursive: true, force: true })
  }
})

import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { trustSeededAccount, advanceWizardTo } from './fixtures/settings'
import { mkdtempSync, rmSync, existsSync, chmodSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), MODE-STEP PERSIST-FAILURE **ROLLBACK + GATE**.
 *
 * `onboarding-mode-persist-fail.spec.ts` (#229) drives the same failure branch but
 * only ever inspects the WIZARD: message shown, no highlight, Next gated. It never
 * asks the two questions a user actually cares about after being told "Couldn't
 * save your choice":
 *
 *   1. Did anything get written anyway? (#1077)  `steps.ts persist()` awaits
 *      `settings.setOnboarding({autonomyBypassDefault})` FIRST and the per-project
 *      `flow.setConfig({autopilot})` SECOND, inside one try/catch. When the second
 *      write throws, the FIRST is already committed and is never rolled back — so
 *      the app-level permission-prompt bypass (`autonomy_bypass_default`, which
 *      every new thread inherits, main/index.ts 278) is left ON while the wizard
 *      says the choice wasn't saved and still shows Manual highlighted.
 *   2. Can the user walk past the error? (#1078) #229's guardrail ("Next stays gated") is
 *      derived from `ctx.state.mode === null`, but #716's reflection pre-sets
 *      `mode` from saved settings on arrival — so on the failure path Next is
 *      already ungated and Next → Finish sails straight past the error, which
 *      itself vanishes without trace on any re-render.
 *
 * The failure is reproduced the runbook-blessed way: a real read-only project
 * (chmod) makes `flow.setConfig`'s `.flowconfig` write throw EACCES — a plausible
 * user scenario (read-only mount, root-owned folder). Nothing is mocked or faked;
 * the store assertions read `flow.db` with `sqlite3` directly, never the renderer.
 *
 * Layout: one LIVE guard (the wizard surfaces the failure and does not crash),
 * plus two guards for the FIXED contracts: (#1077) the app-wide bypass is
 * confirm-gated — a mode click writes only the per-project flag, the app-level
 * flip waits for Finish, so a failed click leaves the store untouched; (#1078)
 * the failure lives in wizard state (`modePersistFailed`), so Next stays gated
 * and the message survives Back → Next until a retry succeeds.
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

/** The app-level autonomy default, read straight from flow.db — no renderer in the
 *  loop, so a UI that lies cannot make this assertion pass. */
function readBypassDefault(userDataDir: string): string {
  return execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `SELECT COALESCE((SELECT value FROM app_settings WHERE key='autonomy_bypass_default'),'<unset>');`,
  ])
    .toString()
    .trim()
}

async function seedProject(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-onboard-rollback-'))
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

/** Dismiss every boot-timed overlay (first-run wizard, per-project flow settings)
 *  and only return once none has re-appeared for a full quiet window. Boot mounts
 *  them asynchronously, so a single count()/Escape can race a not-yet-mounted one. */
async function settleOverlays(win: Page): Promise<void> {
  const overlay = win.locator(ANY_OVERLAY)
  const deadline = Date.now() + 20_000
  let quietSince = Date.now()
  while (Date.now() < deadline) {
    if (await overlay.count()) {
      const wizard = win.locator(WIZARD)
      if (await wizard.count()) {
        await wizard
          .locator('.fl-wizard-btn', { hasText: 'Skip for now' })
          .click({ timeout: 3000 })
          .catch(() => undefined)
      } else {
        await win.keyboard.press('Escape')
      }
      await overlay.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => undefined)
      quietSince = Date.now()
      continue
    }
    if (Date.now() - quietSince > 2500) return // clean for a full quiet window
    await win.waitForTimeout(250)
  }
  await expect(overlay).toHaveCount(0)
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

function highlighted(win: Page, mode: 'Manual' | 'Autonomous'): Promise<boolean> {
  return win
    .locator(`${WIZARD} .fl-wizard-btn`, { hasText: mode })
    .evaluate((b) => b.className.includes('fl-wizard-btn--primary'))
}

/** Make (or restore) the project's `.flowconfig` write target un/writable so
 *  `flow.setConfig` throws EACCES (or succeeds) — covers mkdir(flow/), file
 *  create, and truncate-rewrite. Mirrors the #229 spec's technique. */
function setConfigWriteBlocked(dir: string, blocked: boolean): void {
  const flowDir = join(dir, 'flow')
  const cfg = join(flowDir, '.flowconfig')
  const dirMode = blocked ? 0o555 : 0o755
  const fileMode = blocked ? 0o444 : 0o644
  if (existsSync(cfg)) chmodSync(cfg, fileMode)
  if (existsSync(flowDir)) chmodSync(flowDir, dirMode)
  chmodSync(dir, dirMode)
}

function readFlowConfig(dir: string): string {
  const cfg = join(dir, 'flow', '.flowconfig')
  return existsSync(cfg) ? readFileSync(cfg, 'utf8') : ''
}

interface Harness {
  app: ElectronApplication
  win: Page
  projectDir: string
  userDataDir: string
  errors: string[]
}

/** Boot a seeded app (account + one git project), walk the re-opened wizard to the
 *  "Choose a mode" step. The runbook-blessed pre-seeded preconditions. */
async function bootToModeStep(): Promise<Harness> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-onboard-rollback-'))
  await migrateDb(userDataDir)
  seedAccount(userDataDir)

  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))

  // A seeded account still leaves rootCount 0 on this boot, so the first-run
  // wizard auto-opens; adding the root then auto-opens the per-project flow
  // settings. Both are boot-timed, so a bare count() can sample BEFORE they mount
  // and leave one stacked under the wizard we open later (the hazard called out in
  // onboarding-active-project.spec.ts) — settle to a clean shell instead.
  await settleOverlays(win)
  const projectDir = await seedProject(win)
  await settleOverlays(win)

  await reopenWizard(win)
  const wizard = win.locator(WIZARD)
  // Welcome → Connect (seeded account reflects) → Project (seeded root) → Mode.
  await advanceWizardTo(win, 'Choose a mode')
  await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
  // Let #716's reflection settle so the step is in its true arrival state, not mid-fetch.
  await expect.poll(() => highlighted(win, 'Manual'), { timeout: 5000 }).toBe(true)
  return { app, win, projectDir, userDataDir, errors }
}

async function teardown(h: Harness | null): Promise<void> {
  if (!h) return
  setConfigWriteBlocked(h.projectDir, false)
  await h.app.close()
  rmSync(h.projectDir, { recursive: true, force: true })
  rmSync(h.userDataDir, { recursive: true, force: true })
}

/** Click Autonomous with the project's config write blocked, and wait for the
 *  wizard's own "couldn't save" message — the failure branch, as the user sees it. */
async function failAutonomousPersist(h: Harness): Promise<void> {
  setConfigWriteBlocked(h.projectDir, true)
  await h.win.locator(`${WIZARD} .fl-wizard-btn`, { hasText: 'Autonomous' }).click()
  await expect(h.win.locator(`${WIZARD} .fl-wizard-body`)).toContainText('save your choice', {
    timeout: 10_000,
  })
}

// ── LIVE guard: green on current main ────────────────────────────────────────
// The failure IS surfaced and the wizard survives it — the part that works today
// and must keep working after either defect below is fixed.
test('LIVE: a failed mode persist is surfaced in the wizard and never crashes it', async () => {
  test.setTimeout(120_000)
  let h: Harness | null = null
  try {
    h = await bootToModeStep()
    await failAutonomousPersist(h)

    // The message is there, the failed choice is not presented as confirmed, and
    // the pre-selected safe default is still what the wizard displays.
    await expect(h.win.locator(`${WIZARD} .fl-wizard-body`)).toContainText('try again')
    expect(await highlighted(h.win, 'Autonomous')).toBe(false)
    expect(await highlighted(h.win, 'Manual')).toBe(true)
    // The project's config really did not receive the autopilot flag.
    expect(readFlowConfig(h.projectDir)).not.toContain('autopilot')
    await h.win.screenshot({ path: `${SCREENS}/onboarding-mode-persist-rollback-failed.png` })
    expect(h.errors, h.errors.join(', ')).toHaveLength(0)
  } finally {
    await teardown(h)
  }
})

// ── guard 1 (#1077): the app-level autonomy default never flips on a failed save ──
test(
  'a failed mode persist must NOT leave the app-level permission bypass flipped ON',
  async () => {
    test.setTimeout(120_000)
    let h: Harness | null = null
    try {
      h = await bootToModeStep()
      // Baseline: nothing written yet — any later flip is attributable to the click.
      expect(readBypassDefault(h.userDataDir)).toBe('<unset>')

      await failAutonomousPersist(h)

      // The wizard says the choice was not saved; the store must agree. Pre-fix
      // this read 'true': setOnboarding landed before setConfig threw, and
      // nothing rolled it back — now the app-level write is deferred to Finish.
      expect(readBypassDefault(h.userDataDir)).not.toBe('true')

      // And the real consequence: a NEW thread must not silently inherit
      // bypassPermissions from a choice the user was told wasn't saved.
      setConfigWriteBlocked(h.projectDir, false)
      const bypass = await h.win.evaluate(async (root) => {
        const thread = (await (
          window as unknown as {
            flow: { threads: { create(i: unknown): Promise<{ bypassPermissions: boolean }> } }
          }
        ).flow.threads.create({ projectRoot: root, title: 'rollback probe' })) as {
          bypassPermissions: boolean
        }
        return thread.bypassPermissions
      }, h.projectDir)
      expect(bypass).toBe(false)
    } finally {
      await teardown(h)
    }
  },
)

// ── guard 2 (#1078): the user cannot walk straight past the error ────────────
test(
  'after a failed mode persist the wizard must not let the user advance past the error',
  async () => {
    test.setTimeout(120_000)
    let h: Harness | null = null
    try {
      h = await bootToModeStep()
      await failAutonomousPersist(h)

      // #229's guardrail: an unsaved autopilot-relevant choice must block Next.
      // Pre-fix, #716's pre-selection left `state.mode` non-null so it stayed
      // enabled; the gate now honours the explicit `modePersistFailed` flag.
      expect(await nextDisabled(h.win)).toBe(true)

      // ...and the error must not evaporate on a re-render: Back → Next returns to
      // a Mode step with no trace that the save failed.
      const wizard = h.win.locator(WIZARD)
      await wizard.locator('.fl-wizard-btn', { hasText: 'Back' }).click()
      await expect(wizard.locator('.fl-settings-header')).toContainText('Open a project')
      await wizard.locator('.fl-wizard-btn', { hasText: 'Next' }).click()
      await expect(wizard.locator('.fl-settings-header')).toContainText('Choose a mode')
      await expect(wizard.locator('.fl-wizard-body')).toContainText('save your choice')
    } finally {
      await teardown(h)
    }
  },
)

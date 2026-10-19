import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { trustSeededAccount, advanceWizardTo } from './fixtures/settings'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX sweep — flow 0 (onboarding), round 21: the **two stores** behind "Choose a
 * mode", and the summary step that should reconcile them.
 *
 * An autonomy mode is TWO writes (`mode-persist.ts` says so explicitly):
 *   - `onboarding.autonomyBypassDefault` — APP-wide (`app_settings`), committed
 *     on Finish (#1116/#1077)
 *   - `config.autopilot` — PER-PROJECT (`<root>/flow/.flowconfig`), written on
 *     click by `persist()` (steps.ts:226-238)
 *
 * #716's reopen-reflection reads only the FIRST one (`savedModeFromOnboarding`
 * maps `autonomyBypassDefault`, steps.ts:281-293) and then sets `ctx.state.mode`,
 * which satisfies `canAdvance('mode')` — so the wizard pre-selects, confirms and
 * walks past a mode derived from a store it does not write. When the two stores
 * disagree (a second project, or autopilot toggled anywhere else) the wizard
 * states the wrong autonomy for the active project and accepting it writes
 * nothing. `flow-settings-view.ts:102` already reads the right store via
 * `window.flow.flow.state({ rootId })` — the mode step just never asks.
 *
 * The final "Your project settings" step can't catch it either: `settingsStep()`
 * takes no session (steps.ts:327) and renders `FLOW_SETTINGS_SECTIONS` labels +
 * help with no VALUES, so it is byte-identical for every project and every pick.
 *
 * Live guards document what genuinely works (the per-project write, and the
 * app-level store's causal grip on the highlight); the `test.fixme` tripwires
 * are the target behavior and are red on current main. Filed as #1206 (the mode
 * step's store mismatch) and #1207 (the value-free summary). No agent responses
 * are faked; preconditions are the runbook-blessed pre-launch DB seed.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const WIZARD = '.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)'
// SETTINGS IS A PAGE, not an overlay: it moved into the editor area with its
// groups behind tabs. The name is kept so the walk below reads unchanged; what
// it names is the page.
const SETTINGS_OVERLAY = '.fl-settings-page'
const ANY_OVERLAY = '.fl-settings-overlay:not([hidden])'

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

/** First launch creates + migrates flow.db so the seed can INSERT into it. */
async function migrateDb(userDataDir: string): Promise<void> {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.close()
}

/** Seed an account (so Connect auto-detects) + the APP-level autonomy default. */
function seedAccount(userDataDir: string, bypassDefault: 'true' | 'false'): void {
  execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-e2e', 'QA Seed Account', '/tmp/flow-e2e-noconfig', 'qa@example.com', '2026-01-01T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-e2e');
     INSERT INTO app_settings (key, value) VALUES ('autonomy_bypass_default', '${bypassDefault}');`,
  ])
}

/**
 * Throwaway repo added as a project root. `autopilot` seeds the PER-PROJECT
 * `flow/.flowconfig` BEFORE the root is added, so the main-side watcher snapshots
 * it at watch-start (temp-dir chokidar is unreliable on macOS).
 */
async function seedRepo(win: Page, tag: string, autopilot?: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `flow-ux-onbmode-${tag}-`))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\n')
  if (autopilot !== undefined) {
    mkdirSync(join(dir, 'flow'), { recursive: true })
    writeFileSync(join(dir, 'flow', '.flowconfig'), `autopilot: ${autopilot}\n`)
  }
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  return dir
}

async function activate(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, dir)
}

/** Escape any overlay the app opened for us (per-project flow settings, etc.). */
async function dismissOverlays(win: Page): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    if ((await win.locator(ANY_OVERLAY).count()) === 0) return
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
  }
}

/** The project's OWN autopilot value, straight off disk — the authoritative
 *  store the mode step writes. `null` when the key is absent (= off). */
function autopilotOnDisk(dir: string): string | null {
  const path = join(dir, 'flow', '.flowconfig')
  if (!existsSync(path)) return null
  const line = readFileSync(path, 'utf-8')
    .split('\n')
    .find((l) => l.trim().startsWith('autopilot:'))
  return line ? line.split(':')[1].trim() : null
}

async function statusLine(win: Page): Promise<string> {
  return win.evaluate(() =>
    Array.from(document.querySelectorAll('.fl-flow-line .fl-flow-line-item'))
      .map((i) => (i as HTMLElement).textContent ?? '')
      .join(' | '),
  )
}

async function nextDisabled(win: Page): Promise<boolean> {
  return win
    .locator(`${WIZARD} .fl-wizard-btn`, { hasText: /^(Next|Finish)$/ })
    .first()
    .evaluate((b) => (b as HTMLButtonElement).disabled)
}

/** Settings → "Getting Started…" → walk Welcome → Connect → Project → Mode. */
async function openWizardToMode(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  const settings = win.locator(SETTINGS_OVERLAY)
  await expect(settings).toBeVisible()
  // Settings is a tabbed page; "Getting Started…" is a thing about Flow itself,
  // so it sits in the App group with the theme and the updater.
  await win.locator('.fl-settings-tab', { hasText: 'App' }).click()
  await settings.locator('button', { hasText: 'Getting Started' }).click()
  const wizard = win.locator(WIZARD)
  await expect(wizard).toBeVisible()
  for (const title of [
    'Choose your agent',
    'Connect a Claude account',
    'Open a project',
    'Choose a mode',
  ]) {
    await expect.poll(() => nextDisabled(win), { timeout: 20000 }).toBe(false)
    await wizard.locator('.fl-wizard-btn', { hasText: /^Next$/ }).click()
    await expect(wizard.locator('.fl-settings-header')).toContainText(title)
  }
  // The reflection is async (settings:getOnboarding) — let it land before reading.
  await win.waitForTimeout(1500)
}

/** Which mode button carries the selected (primary) class. */
async function highlightedMode(win: Page): Promise<string | null> {
  const modes = await win
    .locator(`${WIZARD} .fl-wizard-body .fl-wizard-btn`)
    .evaluateAll((bs) =>
      bs.map((b) => ({
        text: (b.textContent ?? '').split('—')[0].trim(),
        primary: b.classList.contains('fl-wizard-btn--primary'),
      })),
    )
  return modes.find((m) => m.primary)?.text ?? null
}

/** From the mode step: Next → the summary step; return its rendered body text. */
async function summaryBody(win: Page): Promise<string> {
  const wizard = win.locator(WIZARD)
  // Mode → (Sign in to Flow) → Settings.
  await advanceWizardTo(win, 'Your project settings')
  await expect(wizard.locator('.fl-settings-header')).toContainText('Your project settings')
  return wizard.locator('.fl-wizard-body').innerText()
}

async function finish(win: Page): Promise<void> {
  // Settings is followed by the Workspace step, which ends the wizard.
  await win.locator(`${WIZARD} .fl-wizard-btn`, { hasText: /^Next$/ }).click()
  await expect(win.locator(`${WIZARD} .fl-settings-header`)).toContainText('Your Workspace')
  await win.locator(`${WIZARD} .fl-wizard-btn`, { hasText: /^Finish$/ }).click()
  await expect(win.locator(WIZARD)).toHaveCount(0)
}

/** One booted app with a seeded account; caller drives it, we always tear down. */
async function withApp(
  bypassDefault: 'true' | 'false',
  body: (win: Page, track: (dir: string) => void) => Promise<void>,
): Promise<void> {
  const userDataDir = mkdtempSync(join(tmpdir(), 'flow-ux-onbmode-udd-'))
  const repos: string[] = []
  let app: ElectronApplication | undefined
  try {
    await migrateDb(userDataDir)
    seedAccount(userDataDir, bypassDefault)
    app = await launch(userDataDir)
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    const errors: string[] = []
    win.on('pageerror', (e) => errors.push(e.message))
    await dismissOverlays(win)
    await body(win, (d) => repos.push(d))
    expect(errors, `uncaught renderer errors: ${errors.join(' || ')}`).toHaveLength(0)
  } finally {
    await app?.close().catch(() => undefined)
    for (const r of repos) rmSync(r, { recursive: true, force: true })
    rmSync(userDataDir, { recursive: true, force: true })
  }
}

// ── live guards ─────────────────────────────────────────────────────────────

test('LIVE: a mode CLICK writes the PER-PROJECT flow/.flowconfig', async () => {
  await withApp('false', async (win, track) => {
    // Project starts explicitly in autopilot; the wizard's own click must be
    // able to turn it off for THIS project. This is the write half of the mode
    // step, and it is healthy — which is what makes the tripwires below real.
    const repo = await seedRepo(win, 'click', true)
    track(repo)
    await activate(win, repo)
    await win.waitForTimeout(2500)
    await dismissOverlays(win)
    expect(autopilotOnDisk(repo)).toBe('true')
    // (The status bar's `autopilot on|off` readout this also followed moved
    // into the composer, 2026-09-04 — the file on disk is the fact.)

    await openWizardToMode(win)
    await win.locator(`${WIZARD} .fl-wizard-btn`, { hasText: /^Manual/ }).click()

    await expect
      .poll(() => autopilotOnDisk(repo), { timeout: 10000 })
      .toBe('false')
    // …and the click is reflected in the UI it just wrote.
    expect(await highlightedMode(win)).toBe('Manual')
  })
})

// RETIRED 2026-10-09: "LIVE: the pre-selected mode is driven by the APP-LEVEL
// store, not the project" pinned #716's CAUSE as measured — and #716 is fixed:
// the mode step now reflects the ACTIVE project's own flow/.flowconfig (the
// first tripwire below passes). A pin of the bug cannot stay green beside its
// fix.

// ── tripwires (target behavior — red on current main) ───────────────────────

test(
  'the pre-selected mode must describe the ACTIVE project: autopilot ON must not show as "Manual — Autopilot off"',
  async () => {
    await withApp('false', async (win, track) => {
      const repo = await seedRepo(win, 'trip-a', true)
      track(repo)
      await activate(win, repo)
      await win.waitForTimeout(2500)
      await dismissOverlays(win)
      expect(autopilotOnDisk(repo)).toBe('true')

      await openWizardToMode(win)
      const shown = await highlightedMode(win)
      expect(
        shown,
        `project flow/.flowconfig has autopilot: true (status line: "${await statusLine(win)}") ` +
          `but the wizard confirms "${shown}"`,
      ).toBe('Autonomous')
    })
  },
)

test(
  'accepting the pre-selected mode must leave the project in the mode the wizard displayed',
  async () => {
    await withApp('true', async (win, track) => {
      const repo = await seedRepo(win, 'trip-b')
      track(repo)
      await activate(win, repo)
      await win.waitForTimeout(2500)
      await dismissOverlays(win)

      await openWizardToMode(win)
      // The user accepts whatever the wizard presents as chosen — Next, then
      // Finish, nothing clicked in the list. Whatever it SHOWED must be what the
      // project is left in. (It used to show the app-level "Autonomous" over a
      // project that was not in autopilot, and Finish then wrote nothing.)
      const shown = await highlightedMode(win)
      expect(shown === 'Autonomous' || shown === 'Manual', `shown: ${String(shown)}`).toBe(true)
      await summaryBody(win)
      await finish(win)
      await win.waitForTimeout(3000)

      const onDisk = autopilotOnDisk(repo)
      expect(
        shown === 'Autonomous' ? onDisk === 'true' : onDisk !== 'true',
        `the wizard confirmed "${String(shown)}" and the project's autopilot is "${String(onDisk)}"`,
      ).toBe(true)
    })
  },
)

test(
  '"Your project settings" must show VALUES: the summary must differ between an autopilot-on and an autopilot-off project',
  async () => {
    await withApp('false', async (win, track) => {
      const on = await seedRepo(win, 'sum-on', true)
      const off = await seedRepo(win, 'sum-off', false)
      track(on)
      track(off)

      await activate(win, on)
      await win.waitForTimeout(2500)
      await dismissOverlays(win)
      await openWizardToMode(win)
      const bodyOn = await summaryBody(win)
      await win.keyboard.press('Escape')
      await expect(win.locator(WIZARD)).toHaveCount(0)

      await activate(win, off)
      await win.waitForTimeout(2500)
      await dismissOverlays(win)
      await openWizardToMode(win)
      const bodyOff = await summaryBody(win)
      await win.keyboard.press('Escape')

      // Fix-agnostic: however values are rendered, a project WITH autopilot and
      // a project WITHOUT it cannot have an identical "your settings" summary.
      expect(
        bodyOn,
        'the summary step renders FLOW_SETTINGS_SECTIONS labels only — byte-identical for opposite project states',
      ).not.toBe(bodyOff)
    })
  },
)

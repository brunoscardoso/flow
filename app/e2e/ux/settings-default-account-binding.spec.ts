import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { test } from '../fixtures/electron'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeTempDir } from './fixtures/seed'

/**
 * UX-sweep regression probe — flow 11 (Settings / flow-settings overlays),
 * round 18. Drives the per-project account binding's PINNED-vs-INHERITED
 * distinction, which no prior settings sweep touched: rounds 8/11 drove the
 * account rows (set-default, remove, remove-bound cascade) and round 4 drove the
 * "This project" select only in the single-account/empty case, where inherited
 * and pinned happen to look the same.
 *
 * Ground truth for each case is the raw `workspace_state.account_id` row in
 * flow.db, read with sqlite3 — the UI's claim is checked against what is
 * actually stored, never against itself.
 *
 * 1. GREEN GUARD — a project explicitly PINNED to an account keeps that account
 *    when the app default moves to a different one. This is the whole promise of
 *    the accounts feature ("isolated so projects never mix accounts", cf. #237)
 *    and it works today; a regression here would silently run agent sessions
 *    under the wrong Claude login.
 *
 * 2. TRIPWIRE (#1108) — `Use default account` is unrepresentable: choosing it
 *    clears the override (verified in the DB) but the select snaps back to the
 *    concrete default account, so an inherited binding renders identically to a
 *    pinned one. FIXED: resolution now carries its source, so the control shows
 *    the STORED state ('Use default account' for an inherited default).
 *
 * Accounts are pre-seeded into flow.db before launch (the runbook technique from
 * settings-accounts-manage.spec.ts) because adding one for real spawns an
 * interactive browser sign-in Playwright cannot drive.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
// The APP settings overlay specifically: Playwright's :has-text is
// case-insensitive, so a "Settings" match also caught the auto-opened
// SETTINGS IS A PAGE. It used to be keyed off its close button's aria-label,
// because three overlays shared a class and a hidden sibling would satisfy a
// looser selector. There is one page and it has no close button — a tab is
// closed from the tab strip — so the page's own class is the whole answer.
const SETTINGS_OVERLAY = '.fl-settings-page'
const SCREENS = 'e2e/ux/__screens'

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

/** Boot once so the main process migrates flow.db, then close. */
async function migrateDb(userDataDir: string): Promise<void> {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await app.close()
}

/** Two accounts — `Personal` (default) and `Acme Co`. Config dirs never need to exist. */
function seedAccounts(userDataDir: string): void {
  execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-p', 'Personal', '/tmp/flow-e2e-nocfg-p', 'me@personal.example', '2026-01-01T00:00:00Z');
     INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-a', 'Acme Co', '/tmp/flow-e2e-nocfg-a', 'me@acme.example', '2026-01-02T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-p');`,
  ])
}

/** The stored per-project override — ground truth, independent of the UI. */
function storedOverride(userDataDir: string): string {
  return execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    'SELECT COALESCE(account_id, "") FROM workspace_state;',
  ])
    .toString()
    .trim()
}

/** A throwaway git repo with a flow/.flowconfig, so selecting it never auto-opens
 *  the per-project flow-settings onboarding overlay over the surface under test. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-acctbind-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'flow'), { recursive: true })
  writeFileSync(join(dir, 'flow', '.flowconfig'), 'push: true\ncommit: true\n')
  return dir
}

async function dismissWizard(win: Page): Promise<void> {
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if ((await wizard.count()) === 0) return
  const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
  if (await skip.count()) await skip.first().click()
  else await win.keyboard.press('Escape')
  await expect(wizard).toHaveCount(0)
}

/** Open Settings and return its "This project" section. */
async function openThisProject(win: Page) {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
  const overlay = win.locator(SETTINGS_OVERLAY)
  await expect(overlay).toBeVisible()
  const section = overlay.locator('.fl-settings-group:not([hidden]) .fl-settings-section', { hasText: 'This project' })
  await expect(section.locator('select')).toBeVisible()
  return section
}

/**
 * Leave Settings.
 *
 * ESCAPE NO LONGER CLOSES IT, and that is the change rather than a detail: it
 * is a tab, so it closes from the tab strip like every other view. Any overlay
 * that HAS stacked on top of it (the per-project flow-settings card can, for a
 * bare project) still answers Escape, and this clears those first so the tab's
 * own ✕ is reachable.
 */
async function closeSettings(win: Page): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if ((await win.locator('.fl-settings-overlay:not([hidden])').count()) === 0) break
    await win.keyboard.press('Escape')
    await win.waitForTimeout(250)
  }
  const close = win.locator('.fl-shell fl-tabs .tab', { hasText: 'Settings' }).locator('.close')
  if ((await close.count()) > 0) await close.first().click()
  // HIDDEN, NOT GONE. A view's element is kept for the life of the window and
  // hidden when its tab closes (editor/index.ts `openView`), which is what lets
  // a reopen be instant and a draft survive — so "closed" is a visibility
  // question here, not a count.
  await expect(win.locator(SETTINGS_OVERLAY)).toBeHidden()
}

test.describe('flow 11 — per-project account binding', () => {
  test.setTimeout(180_000)

  test('an explicit pin survives a change of the app default account', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-acctbind-'))
    const project = makeProject()
    let app: ElectronApplication | undefined
    const pageErrors: string[] = []
    try {
      await migrateDb(userDataDir)
      seedAccounts(userDataDir)

      app = await launch(userDataDir)
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      win.on('pageerror', (e) => pageErrors.push(e.message))
      await dismissWizard(win)

      await win.evaluate(async (p) => {
        const flow = (window as unknown as {
          flow: {
            project: {
              add(r: { path: string }): Promise<unknown>
              setActive(r: { rootPath: string }): Promise<unknown>
            }
          }
        }).flow
        await flow.project.add({ path: p })
        await flow.project.setActive({ rootPath: p })
      }, project)
      // Let the boot-time renders settle before driving the overlay.
      await expect(win.locator('.fl-settings-overlay:not([hidden])')).toHaveCount(0, {
        timeout: 15_000,
      })

      // --- PIN the project to Personal (which also happens to be the default). ---
      let section = await openThisProject(win)
      await section.locator('select').selectOption('acc-p')
      await expect
        .poll(() => storedOverride(userDataDir), { timeout: 10_000 })
        .toBe('acc-p')
      await closeSettings(win)

      // --- Move the app default to the OTHER account. ---
      section = await openThisProject(win)
      const acmeRow = win.locator('.fl-settings-account', { hasText: 'Acme Co' })
      await acmeRow.locator('button', { hasText: 'Set default' }).click()
      await expect(acmeRow.locator('.fl-settings-badge')).toHaveText('Default')
      await closeSettings(win)

      // --- The pin wins: the project still runs under Personal. ---
      // #1108's fix (a1ef5132) names the STORED state, so an explicit pin now
      // reads "Pinned to: <label>" — "Runs under: …" is the INHERITED wording.
      section = await openThisProject(win)
      await expect(section.locator('.fl-settings-hint')).toHaveText('Pinned to: Personal')
      await expect(section.locator('select')).toHaveValue('acc-p')
      expect(storedOverride(userDataDir)).toBe('acc-p')
      await win.screenshot({ path: `${SCREENS}/settings-account-pin-survives-default.png` })

      expect(pageErrors, `unexpected pageerrors: ${pageErrors.join(' | ')}`).toEqual([])
    } finally {
      if (app) await app.close()
      removeTempDir(userDataDir)
      removeTempDir(project)
    }
  })

  // #1108 — clearing the override stores nothing (correct) but the select shows
  // the concrete default account instead of "Use default account", so an
  // inherited binding is indistinguishable from a pinned one and the user's
  // choice reads as rejected. Unskip when #1108 is fixed.
  test('"Use default account" stays selected once chosen (#1108)', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-acctbind-def-'))
    const project = makeProject()
    let app: ElectronApplication | undefined
    try {
      await migrateDb(userDataDir)
      seedAccounts(userDataDir)

      app = await launch(userDataDir)
      const win = await app.firstWindow()
      await win.waitForLoadState('domcontentloaded')
      await dismissWizard(win)
      await win.evaluate(async (p) => {
        const flow = (window as unknown as {
          flow: {
            project: {
              add(r: { path: string }): Promise<unknown>
              setActive(r: { rootPath: string }): Promise<unknown>
            }
          }
        }).flow
        await flow.project.add({ path: p })
        await flow.project.setActive({ rootPath: p })
      }, project)
      await expect(win.locator('.fl-settings-overlay:not([hidden])')).toHaveCount(0, {
        timeout: 15_000,
      })

      let section = await openThisProject(win)
      await section.locator('select').selectOption('acc-a')
      await expect.poll(() => storedOverride(userDataDir), { timeout: 10_000 }).toBe('acc-a')

      // Hand the project back to the default account.
      await section.locator('select').selectOption('')
      await expect.poll(() => storedOverride(userDataDir), { timeout: 10_000 }).toBe('')
      // The stored state is "no override" — the control must say so, not name an account.
      await expect(section.locator('select')).toHaveValue('')
      await closeSettings(win)

      section = await openThisProject(win)
      await expect(section.locator('select')).toHaveValue('')
    } finally {
      if (app) await app.close()
      removeTempDir(userDataDir)
      removeTempDir(project)
    }
  })
})

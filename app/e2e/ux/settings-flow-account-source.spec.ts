import { _electron as electron, test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * UX-sweep regression probe — flow 11 (Settings / accounts / flow-settings
 * overlays), round 21.
 *
 * Flow 11 owns 18 committed specs, and every one of them drives the APP
 * Settings overlay or a flow/.flowconfig CONTROL. Exactly one of them
 * (`settings-default-account-binding.spec.ts`, round 18) drives the per-project
 * account binding's pinned-vs-inherited distinction — and only on the app
 * Settings "This project" section. The Flow settings overlay's own
 * **"Claude account"** section (added by #763 precisely because "users looking
 * at 'project settings' never found it" in app Settings) has never been asked
 * the same question. It is the same control, on the surface users actually
 * reach for, and it is missing #1108's fix.
 *
 * Ground truth is `workspace_state.account_id` read with sqlite3 and the
 * project's own `flow/.flowconfig` on disk — the panels' claims are checked
 * against what is stored, never against themselves. Accounts are pre-seeded
 * into flow.db before launch (adding one for real spawns an interactive
 * browser sign-in Playwright cannot drive).
 *
 * GREEN GUARDS (hold on main; a regression here is a real bug):
 *   1. Opening Flow settings for a NON-ACTIVE project from the sidebar's
 *      project menu edits THAT project — the toggle writes to its
 *      flow/.flowconfig and leaves the active project's file untouched. Getting
 *      this wrong would silently configure the wrong repo.
 *   2. An explicitly PINNED project keeps its account in Flow settings when the
 *      app default moves elsewhere — the whole promise of the accounts feature.
 *
 * TRIPWIRE (`test.fixme`, #1311 — verified failing vs main): the Flow settings
 * "Claude account" section renders a project that merely INHERITS the default
 * byte-identically to one explicitly PINNED to that same account ("Runs under:
 * Personal", `Personal` selected), and choosing "Use default account" snaps
 * back to a concrete account on reopen. That is exactly #1108, unfixed on the
 * sibling surface — asserted as the user-facing outcome (the two stored states
 * must not be indistinguishable), not as any particular wording.
 */

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
// Playwright's :has-text is case-insensitive, so a "Settings" match also catches
// the "Flow settings · <project>" overlay. The close button's aria-label is the
// only per-overlay unique handle.
const FLOW_OVERLAY =
  '.fl-settings-overlay:not([hidden]):has(.fl-settings-close[aria-label="Close flow settings"])'
const APP_OVERLAY =
  '.fl-settings-overlay:not([hidden]):has(.fl-settings-close[aria-label="Close settings"])'
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

/** Two accounts — `Personal` (the app default) and `Work`. Config dirs never need to exist. */
function seedAccounts(userDataDir: string): void {
  execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-personal', 'Personal', '/tmp/flow-e2e-fas-p', 'me@personal.example', '2026-01-01T00:00:00Z');
     INSERT INTO accounts (id, label, config_dir_path, identity_hint, created_at)
       VALUES ('acc-work', 'Work', '/tmp/flow-e2e-fas-w', 'me@work.example', '2026-01-02T00:00:00Z');
     INSERT INTO app_settings (key, value) VALUES ('default_account_id', 'acc-personal');`,
  ])
}

/** The stored per-project override for one root — ground truth, independent of the UI. */
function storedOverride(userDataDir: string, rootPath: string): string {
  return execFileSync('sqlite3', [
    join(userDataDir, 'flow.db'),
    `SELECT COALESCE(account_id, "") FROM workspace_state WHERE project_root = '${rootPath}';`,
  ])
    .toString()
    .trim()
}

/** A throwaway git repo that already has a flow/.flowconfig, so selecting it
 *  never auto-opens the per-project onboarding overlay over the surface under test. */
function makeProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'flow'), { recursive: true })
  writeFileSync(join(dir, 'flow', '.flowconfig'), 'model_routing: true\n')
  return dir
}

function readFlowConfig(root: string): string {
  try {
    return readFileSync(join(root, 'flow', '.flowconfig'), 'utf8')
  } catch {
    return ''
  }
}

async function dismissWizard(win: Page): Promise<void> {
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if ((await wizard.count()) === 0) return
  const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
  if (await skip.count()) await skip.first().click()
  else await win.keyboard.press('Escape')
  await expect(wizard).toHaveCount(0)
}

/** Escape until no settings-family overlay is up (they can stack). */
async function closeOverlays(win: Page): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    if ((await win.locator('.fl-settings-overlay:not([hidden])').count()) === 0) return
    await win.keyboard.press('Escape')
    await win.waitForTimeout(250)
  }
  await expect(win.locator('.fl-settings-overlay:not([hidden])')).toHaveCount(0)
}

/** Open the Flow settings overlay for a specific root — the exact event the
 *  sidebar's project ⋯ menu ▸ "Flow settings" dispatches (thread-sidebar.ts). */
async function openFlowSettings(win: Page, rootPath: string) {
  await win.evaluate(
    (r) =>
      document.dispatchEvent(
        new CustomEvent('flow:open-flow-settings', { detail: { rootPath: r } }),
      ),
    rootPath,
  )
  const overlay = win.locator(FLOW_OVERLAY)
  await expect(overlay).toBeVisible()
  return overlay
}

/** The rendered state of an account section: what the user can actually see. */
interface AccountView {
  hint: string
  selected: string
}

async function readAccountView(win: Page, overlay: string, heading: string): Promise<AccountView> {
  // The section loads its accounts asynchronously — wait for the select.
  await expect(
    win.locator(`${overlay} .fl-settings-section:has(.fl-settings-heading:text-is("${heading}")) select`),
  ).toBeVisible()
  return win.evaluate(
    ({ sel, head }) => {
      const ov = document.querySelector(sel)
      const section = [...(ov?.querySelectorAll('.fl-settings-section') ?? [])].find(
        (s) => s.querySelector('.fl-settings-heading')?.textContent === head,
      )
      const select = section?.querySelector('select') as HTMLSelectElement | null
      return {
        hint: section?.querySelector('.fl-settings-hint')?.textContent ?? '',
        selected: select?.value ?? '',
      }
    },
    { sel: overlay, head: heading },
  )
}

async function addRoots(win: Page, roots: string[], active: string): Promise<void> {
  await win.evaluate(
    async ({ list, act }) => {
      const flow = (
        window as unknown as {
          flow: {
            project: {
              add(r: { path: string }): Promise<unknown>
              setActive(r: { rootPath: string }): Promise<unknown>
            }
          }
        }
      ).flow
      for (const p of list) await flow.project.add({ path: p })
      await flow.project.setActive({ rootPath: act })
    },
    { list: roots, act: active },
  )
}

test.describe('flow 11 — Flow settings: the project account section', () => {
  test.setTimeout(180_000)

  test('edits a NON-ACTIVE project, and a pinned account survives a default change', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-fas-a-'))
    const activeProject = makeProject('flow-ux-fas-active-')
    const otherProject = makeProject('flow-ux-fas-other-')
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
      await addRoots(win, [activeProject, otherProject], activeProject)
      await closeOverlays(win)

      // --- Pin the NON-ACTIVE project to Personal from its own Flow settings. ---
      let overlay = await openFlowSettings(win, otherProject)
      await overlay
        .locator('.fl-settings-section:has(.fl-settings-heading:text-is("Claude account")) select')
        .selectOption('acc-personal')
      await expect
        .poll(() => storedOverride(userDataDir, otherProject), { timeout: 10_000 })
        .toBe('acc-personal')
      // The ACTIVE project is untouched — this panel edits the root it was opened for.
      expect(storedOverride(userDataDir, activeProject)).toBe('')

      // --- GUARD 1: a config toggle here writes to THAT project's file only. ---
      await overlay.locator('.fl-fs-row', { hasText: 'Autopilot' }).locator('.fl-fs-toggle').click()
      await expect.poll(() => readFlowConfig(otherProject), { timeout: 10_000 }).toContain('autopilot: true')
      expect(readFlowConfig(activeProject)).not.toContain('autopilot')
      await closeOverlays(win)

      // --- GUARD 2: move the app default; the explicit pin must win. ---
      await win.evaluate(() =>
        (
          window as unknown as { flow: { accounts: { setDefault(r: { id: string }): Promise<unknown> } } }
        ).flow.accounts.setDefault({ id: 'acc-work' }),
      )
      await win.waitForTimeout(500)
      await closeOverlays(win)
      overlay = await openFlowSettings(win, otherProject)
      expect((await readAccountView(win, FLOW_OVERLAY, 'Claude account')).selected).toBe('acc-personal')
      await expect(
        win.locator(`${FLOW_OVERLAY} .fl-settings-section:has(.fl-settings-heading:text-is("Claude account")) .fl-settings-hint`),
        // An explicit pin reads as a pin (#1311) — "Runs under: …" is reserved
        // for a project merely following the default, which this one is not.
      ).toHaveText('Pinned to: Personal')
      expect(storedOverride(userDataDir, otherProject)).toBe('acc-personal')

      expect(pageErrors, `unexpected pageerrors: ${pageErrors.join(' | ')}`).toEqual([])
    } finally {
      if (app) await app.close()
      rmSync(userDataDir, { recursive: true, force: true })
      rmSync(activeProject, { recursive: true, force: true })
      rmSync(otherProject, { recursive: true, force: true })
    }
  })

  // TRIPWIRE — the Flow settings "Claude account" section cannot express
  // "inherits the default": an inherited project and one pinned to that same
  // account render identically, and "Use default account" snaps back on reopen.
  // #1108's fix reached the app Settings sibling only — filed as #1311.
  // Un-`fixme` when #1311 is fixed.
  test.fixme(
    'tells a project that INHERITS the default apart from one PINNED to it',
    async () => {
      const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-fas-b-'))
      const inheritProject = makeProject('flow-ux-fas-inherit-')
      const pinnedProject = makeProject('flow-ux-fas-pinned-')
      let app: ElectronApplication | undefined
      try {
        await migrateDb(userDataDir)
        seedAccounts(userDataDir)
        app = await launch(userDataDir)
        const win = await app.firstWindow()
        await win.waitForLoadState('domcontentloaded')
        await dismissWizard(win)
        await addRoots(win, [inheritProject, pinnedProject], inheritProject)
        await closeOverlays(win)

        // Pin ONE project to the account the OTHER merely inherits.
        await win.evaluate(
          (p) =>
            (
              window as unknown as {
                flow: {
                  accounts: {
                    assignProject(r: { rootPath: string; accountId: string | null }): Promise<unknown>
                  }
                }
              }
            ).flow.accounts.assignProject({ rootPath: p, accountId: 'acc-personal' }),
          pinnedProject,
        )
        await expect
          .poll(() => storedOverride(userDataDir, pinnedProject), { timeout: 10_000 })
          .toBe('acc-personal')
        expect(storedOverride(userDataDir, inheritProject)).toBe('')

        // The APP Settings sibling gets this right (#1108) — the control that
        // proves the distinction is expressible and expected.
        await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-settings')))
        await expect(win.locator(APP_OVERLAY)).toBeVisible()
        const appView = await readAccountView(win, APP_OVERLAY, 'This project')
        expect(appView.selected).toBe('')
        expect(appView.hint).toContain('inherited default')
        await closeOverlays(win)

        // The Flow settings surface must not conflate the two stored states.
        await openFlowSettings(win, inheritProject)
        const inherited = await readAccountView(win, FLOW_OVERLAY, 'Claude account')
        await win.screenshot({ path: `${SCREENS}/flow-settings-account-inherited.png` })
        await closeOverlays(win)
        await openFlowSettings(win, pinnedProject)
        const pinned = await readAccountView(win, FLOW_OVERLAY, 'Claude account')
        await closeOverlays(win)

        expect(
          inherited,
          'a project that only inherits the default renders identically to one pinned to it',
        ).not.toEqual(pinned)

        // And the user's own choice must stick: picking "Use default account"
        // on the inherited project must still read that way after a reopen.
        const overlay = await openFlowSettings(win, inheritProject)
        await overlay
          .locator('.fl-settings-section:has(.fl-settings-heading:text-is("Claude account")) select')
          .selectOption('')
        await closeOverlays(win)
        await openFlowSettings(win, inheritProject)
        expect((await readAccountView(win, FLOW_OVERLAY, 'Claude account')).selected).toBe('')
      } finally {
        if (app) await app.close()
        rmSync(userDataDir, { recursive: true, force: true })
        rmSync(inheritProject, { recursive: true, force: true })
        rmSync(pinnedProject, { recursive: true, force: true })
      }
    },
  )
})

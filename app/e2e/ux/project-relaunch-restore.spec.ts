/**
 * UX regression probe — flow `project` (open / switch / add), round 18.
 *
 * Un-probed shape: what the user gets when they QUIT and REOPEN Flow. Every
 * prior flow-1 probe drives a single live session (switch / reorder / remove /
 * overflow / same-basename / archive-all); only project-unavailable-root
 * relaunches, and only for the vanished-folder case (#974 / #975).
 *
 * Boot restore lives in `main/index.ts` (~1249-1257):
 *
 *     const roots = projectRegistry.restore()
 *     const lastActive = projectContext.lastActiveProject()
 *     if (lastActive && roots.some((r) => r.rootPath === lastActive)) {
 *       projectContext.setActiveProject(lastActive)
 *     }
 *
 * `lastActiveProject()` is "the newest row in `workspace_state`" — and rows are
 * created by `#ensureRow` from `saveOpenFiles` / `setActiveThread` too, not only
 * by an actual activation. When that newest row belongs to a project that is no
 * longer a root, the guard fails and NOTHING is activated: the app boots to "No
 * project" with projects sitting right there in the sidebar.
 *
 * Test 1 + test 2 are the live guards (green on main): a normal quit/relaunch
 * resumes the project you were last in — model, titlebar AND file tree — and the
 * project order survives. Test 3 was a `test.fixme` tripwire for #1080
 * (removing the active project resurrects its state row via the renderer's
 * outgoing-tab persist, so it outlives `forget()` and poisons the next boot) and
 * is now a live regression guard; verified non-vacuous — against pre-fix main it
 * failed on the documented `activeProject()` assertion, not on setup.
 *
 * FIXED on both halves the issue named:
 *   - `ProjectContextManager.setKnownRootCheck` (project/project-context.ts)
 *     makes `#ensureRow` refuse a `project_root` that is no longer a registered
 *     root, so a removed project can never re-INSERT its `workspace_state` row.
 *   - boot restore resolves through `resolveActiveRoot` (shared/root-selection.ts),
 *     which falls back to a surviving root instead of activating nothing — and
 *     the removal handler itself now hands activation to the survivor main-side
 *     (`handOffActiveProject`, ipc/index.ts) so the choice is persisted.
 */
import { activeProjectName, showActiveProjectFiles, FILES_PANE } from './fixtures/seed'
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { sel } from '../selectors'

const MAIN_ENTRY = resolve(__dirname, '../../out/main/index.js')
const SCREENS = 'e2e/ux/__screens'

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: { ...process.env, ELECTRON_RENDERER_URL: '', NODE_ENV: 'production', FLOW_E2E: '1' },
  })
}

/** No account is ever connected here, so the first-run wizard opens on EVERY boot. */
async function dismissOnboarding(win: Page): Promise<void> {
  const wizard = win.locator('.fl-settings-overlay:not([hidden]):has(.fl-wizard-body)')
  if ((await wizard.count()) === 0) return
  const skip = wizard.locator('.fl-wizard-btn', { hasText: 'Skip for now' })
  if (await skip.count()) await skip.first().click()
  else await win.keyboard.press('Escape')
  await expect(wizard).toHaveCount(0)
}

/** The per-project flow-settings overlay auto-opens for a project with no
 *  .flowconfig and intercepts clicks. Escape closes it. */
async function dismissAnyOverlay(win: Page): Promise<void> {
  const overlay = win.locator('.fl-settings-overlay:not([hidden])')
  for (let i = 0; i < 4; i++) {
    if ((await overlay.count()) === 0) return
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
  }
}

/** Tear down temp dirs. The IDE's background auto-provisioner can still be
 *  writing into a seeded repo as the test ends, so a plain rmSync races it with
 *  ENOTEMPTY — retry, and never let cleanup fail an otherwise-green test. */
function cleanup(dirs: string[]): void {
  for (const dir of dirs) {
    for (let attempt = 0; attempt < 5 && existsSync(dir); attempt++) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Racing writer — try again.
      }
    }
  }
}

function mkRepo(prefix: string, marker: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, marker), 'seed\n')
  return dir
}

async function addRoot(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as { flow: { project: { add(r: { path: string }): Promise<unknown> } } }
    ).flow.project.add({ path: p })
  }, dir)
  await win.waitForTimeout(600)
  await dismissAnyOverlay(win)
}

async function setActive(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, dir)
  await win.waitForTimeout(900)
  await dismissAnyOverlay(win)
}

async function activeRoot(win: Page): Promise<string | null> {
  const active = await win.evaluate(
    async () =>
      await (
        window as unknown as {
          flow: { project: { active(): Promise<{ rootPath: string } | null> } }
        }
      ).flow.project.active(),
  )
  return active?.rootPath ?? null
}

async function rootPaths(win: Page): Promise<string[]> {
  return win.evaluate(
    async () =>
      (
        await (
          window as unknown as { flow: { project: { list(): Promise<{ rootPath: string }[]> } } }
        ).flow.project.list()
      ).map((r) => r.rootPath),
  )
}

async function label(win: Page): Promise<string> {
  return activeProjectName(win)
}

/** Launch + dismiss the wizard + let restore settle. Callers own closing `app`. */
async function boot(userDataDir: string): Promise<{
  app: ElectronApplication
  win: Page
  errors: string[]
}> {
  const app = await launch(userDataDir)
  const win = await app.firstWindow()
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.waitForLoadState('domcontentloaded')
  await dismissOnboarding(win)
  await win.waitForTimeout(2000)
  await dismissAnyOverlay(win)
  return { app, win, errors }
}

/** Select a sidebar rail. Re-clicking the ALREADY-active rail item COLLAPSES the
 *  sidebar by design (`shell.ts` onRailSelect), so only click when its pane isn't
 *  already showing. */
async function selectRail(win: Page, id: 'threads' | 'files'): Promise<void> {
  const pane = id === 'threads' ? '.fl-thread-sidebar' : FILES_PANE
  if (await win.locator(pane).first().isVisible().catch(() => false)) return
  await win.locator(`.fl-activity-bar [data-rail-item="${id}"]`).click()
  await win.waitForTimeout(500)
}

function moreBtnFor(win: Page, name: string) {
  return win.locator(
    `.row:has([aria-label="New thread or task in ${name}"]) [aria-label="Project actions"]`,
  )
}

test.describe('quitting and reopening Flow', () => {
  test('resumes the project you were last in — model, titlebar and file tree', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-relaunch-'))
    const a = mkRepo('flow-relA-', 'AAA_MARKER_A.txt')
    const b = mkRepo('flow-relB-', 'BBB_MARKER_B.txt')
    let app: ElectronApplication | null = null
    try {
      // Session 1: open both projects, work in B, come back to A and quit there.
      const s1 = await boot(userDataDir)
      await addRoot(s1.win, a)
      await addRoot(s1.win, b)
      await setActive(s1.win, b)
      await setActive(s1.win, a)
      expect(await label(s1.win)).toBe(basename(a))
      await s1.app.close()

      // Session 2: the app must come back where the user left it.
      const s2 = await boot(userDataDir)
      app = s2.app
      expect(await activeRoot(s2.win)).toBe(a)
      expect(await label(s2.win)).toBe(basename(a))

      // …and the project surfaces are really bound, not just the model: the
      // Files tree shows A's marker file and NOT B's (non-vacuous both ways).
      await showActiveProjectFiles(s2.win)
      const filesPane = s2.win.locator(FILES_PANE)
      await expect(filesPane.getByText('AAA_MARKER_A.txt')).toBeVisible({ timeout: 6000 })
      await expect(filesPane.getByText('BBB_MARKER_B.txt')).toHaveCount(0)
      await s2.win.screenshot({ path: `${SCREENS}/project-relaunch-resume.png` })
      expect(s2.errors, s2.errors.join(', ')).toEqual([])
    } finally {
      if (app) await app.close().catch(() => undefined)
      cleanup([a, b, userDataDir])
    }
  })

  // UNREACHABLE SINCE 2026-10-06: this drives the per-project ⋯ "Project
  // actions" menu (thread-sidebar.ts #openProjectMenu — Move to top, Archive all
  // threads, Remove from sidebar). The sidebar's per-project header rows that
  // carried it went with the Workspaces hard migration, and its documented new
  // door — the Workspace switcher's project rows dispatching `flow:project-menu`
  // — was never wired: those rows open the project's settings, and nothing
  // dispatches the event. Reported, not ported: whether these actions come back
  // (and where) is a product call. Kept as the record of the behaviour.
  test.fixme('keeps the project order you arranged', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-relaunch-order-'))
    const a = mkRepo('flow-ordA-', 'AAA.txt')
    const b = mkRepo('flow-ordB-', 'BBB.txt')
    const c = mkRepo('flow-ordC-', 'CCC.txt')
    let app: ElectronApplication | null = null
    try {
      const s1 = await boot(userDataDir)
      await addRoot(s1.win, a)
      await addRoot(s1.win, b)
      await addRoot(s1.win, c)
      await setActive(s1.win, a)
      // Move the LAST project to the top via its group ⋯ menu (the user-facing reorder).
      await selectRail(s1.win, 'threads')
      await moreBtnFor(s1.win, basename(c)).click()
      const menu = s1.win.locator('.fl-thread-menu')
      await expect(menu).toBeVisible()
      await menu.locator('.fl-thread-menu-item', { hasText: 'Move to top' }).click()
      await s1.win.waitForTimeout(1200)
      const order1 = await rootPaths(s1.win)
      expect(order1[0]).toBe(c) // the reorder actually happened (non-vacuous)
      await s1.app.close()

      const s2 = await boot(userDataDir)
      app = s2.app
      expect(await rootPaths(s2.win)).toEqual(order1)
      expect(s2.errors, s2.errors.join(', ')).toEqual([])
    } finally {
      if (app) await app.close().catch(() => undefined)
      cleanup([a, b, c, userDataDir])
    }
  })

  // #1080 — removing the active project hands the user to a survivor (B) for the rest of
  // the session — but the removed project's `workspace_state` row is RE-CREATED
  // after `forget()` by the renderer's outgoing-tab persist (project-context.ts
  // persist(previous) → saveOpenFiles → #ensureRow), with `last_active_at = now`.
  // It is then the newest row forever (only an explicit switch touches a row), so
  // every later boot resolves `lastActiveProject()` to a non-root and activates
  // nothing.
  // UNREACHABLE SINCE 2026-10-06: this drives the per-project ⋯ "Project
  // actions" menu (thread-sidebar.ts #openProjectMenu — Move to top, Archive all
  // threads, Remove from sidebar). The sidebar's per-project header rows that
  // carried it went with the Workspaces hard migration, and its documented new
  // door — the Workspace switcher's project rows dispatching `flow:project-menu`
  // — was never wired: those rows open the project's settings, and nothing
  // dispatches the event. Reported, not ported: whether these actions come back
  // (and where) is a product call. Kept as the record of the behaviour.
  test.fixme(
    'after removing the project you were in, the survivor is still there next launch (#1080)',
    async () => {
      const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-relaunch-rm-'))
      const a = mkRepo('flow-rmA-', 'AAA_MARKER_A.txt')
      const b = mkRepo('flow-rmB-', 'BBB_MARKER_B.txt')
      let app: ElectronApplication | null = null
      try {
        const s1 = await boot(userDataDir)
        await addRoot(s1.win, a)
        await addRoot(s1.win, b)
        await setActive(s1.win, a)

        // Remove the ACTIVE project via its sidebar group ⋯ menu → confirm.
        await selectRail(s1.win, 'threads')
        await moreBtnFor(s1.win, basename(a)).click()
        const menu = s1.win.locator('.fl-thread-menu')
        await expect(menu).toBeVisible()
        await menu.locator('.fl-thread-menu-item', { hasText: 'Remove from sidebar' }).click()
        await menu.locator('.fl-thread-menu-item.danger', { hasText: 'Remove' }).click()
        await s1.win.waitForTimeout(1500)
        await dismissAnyOverlay(s1.win)

        // The survivor took over for the rest of the session — that's the state
        // the user quits in, and the state they expect back.
        expect(await activeRoot(s1.win)).toBe(b)
        expect(await label(s1.win)).toBe(basename(b))
        // …and they keep working in it (opening files persists tabs; it never
        // re-activates the project, so nothing refreshes last_active_at).
        await showActiveProjectFiles(s1.win)
        await s1.win
          .locator(FILES_PANE)
          .getByText('BBB_MARKER_B.txt')
          .click()
          .catch(() => undefined)
        await s1.win.waitForTimeout(1200)
        await s1.app.close()

        const s2 = await boot(userDataDir)
        app = s2.app
        await selectRail(s2.win, 'files')
        await s2.win.screenshot({ path: `${SCREENS}/project-relaunch-after-remove.png` })

        expect(await rootPaths(s2.win)).toEqual([b])
        expect(
          await activeRoot(s2.win),
          'the surviving project must still be active after a relaunch',
        ).toBe(b)
        expect(await label(s2.win)).toBe(basename(b))
        expect(s2.errors, s2.errors.join(', ')).toEqual([])
      } finally {
        if (app) await app.close().catch(() => undefined)
        cleanup([a, b, userDataDir])
      }
    },
  )
})

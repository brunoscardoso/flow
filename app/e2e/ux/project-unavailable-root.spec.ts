/**
 * UX regression probe — flow `project` (open / switch / add), round 15.
 *
 * #263 shipped the `available` flag so a project root whose directory is gone
 * (renamed / moved folder, unmounted external or network drive) survives in
 * persistence and renders greyed + tagged `unavailable` in the threads sidebar,
 * where its row is INERT on purpose ("rebinding to a nonexistent directory would
 * just error"). #350 then found four more paths that ignored the flag and its fix
 * (ca1da35 / PR #352) centralized the filter — but only across
 * `src/renderer/threads/**`. Two paths outside that tree were never covered:
 *
 *   #974 — the TITLEBAR PROJECT SWITCHER (`shell.ts buildProjectSwitcher`) lists an
 *          unavailable root as a normal, clickable row and happily activates it,
 *          binding every surface to a directory that isn't there.
 *   #975 — PROJECT RESTORE keeps an unavailable root as the ACTIVE project across
 *          a relaunch, with no fallback to an available sibling and no message.
 *
 * Every prior flow-1 round drove switching, reordering, removal, disambiguation and
 * overflow against roots that all exist. This probe drives the state a real user
 * reaches by renaming a project folder while Flow is closed.
 *
 * Test 1 is the live guard: the sidebar's #263/#350 contract still holds (an
 * unavailable row does NOT activate, while an available sibling's row does) — so a
 * regression that makes the sidebar as permissive as the titlebar is caught here.
 * Tests 2 and 3 were `test.fixme` tripwires for #974 / #975 and are now LIVE
 * regression guards. Both were verified non-vacuous — against pre-fix main they
 * failed deterministically on the documented assertion, not on setup.
 *
 * FIXED by the shared activation seam `src/shared/root-selection.ts`:
 *   #974 — `buildProjectSwitcher` (shell.ts) renders an unavailable root greyed,
 *          tagged and disabled and skips setActiveProject for it, and the main
 *          `project:setActive` handler refuses it as a second layer.
 *   #975 — boot restore (main/index.ts) resolves the persisted pointer through
 *          `resolveActiveRoot`, which degrades an unreachable request to the
 *          first available root — the policy removal already used (#350).
 */
import { activeProjectName } from './fixtures/seed'
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

/** The switcher dropdown + its rows (light DOM, `shell.ts`). */
const MENU_ITEM = '.fl-project-menu .fl-project-item'

function launch(userDataDir: string): Promise<ElectronApplication> {
  return electron.launch({
    args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ELECTRON_RENDERER_URL: '',
      NODE_ENV: 'production',
      FLOW_E2E: '1',
      // A Flow folder of the run's own, as the shared fixture gives every launch:
      // without one an e2e run places no project in a Workspace (so the
      // Workspace switcher this spec reads would list nothing), and it must
      // never place them in the developer's real one.
      PLAN_FLOW_HOME: join(userDataDir, 'plan-flow-home'),
    },
  })
}

/** A fresh userData dir triggers the first-run wizard on EVERY launch here (no
 *  account is ever connected), so each boot has to dismiss it. */
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
  for (let i = 0; i < 3; i++) {
    if ((await overlay.count()) === 0) return
    await win.keyboard.press('Escape')
    await win.waitForTimeout(400)
  }
}

function mkRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# seed\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=q@a', '-c', 'user.name=q', 'commit', '-qm', 'init'], {
    cwd: dir,
  })
  return dir
}

async function addRoot(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as { flow: { project: { add(r: { path: string }): Promise<unknown> } } }
    ).flow.project.add({ path: p })
  }, dir)
  await win.waitForTimeout(600)
}

async function setActive(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, dir)
  await win.waitForTimeout(1000)
  await dismissAnyOverlay(win)
}

interface ProbeRoot {
  rootPath: string
  available?: boolean
  provisioningState?: string
}

async function roots(win: Page): Promise<ProbeRoot[]> {
  return win.evaluate(
    async () =>
      await (
        window as unknown as { flow: { project: { list(): Promise<ProbeRoot[]> } } }
      ).flow.project.list(),
  )
}

/**
 * Wait until no root is mid-provision. The IDE auto-provisions every added root
 * in a fire-and-forget background write (`.claude/…`), and that writer outlives
 * `app.close()` briefly — deleting a project folder while it runs either throws
 * ENOTEMPTY or gets the tree re-created a moment later, so the app is then
 * entirely right to report the root available and the probe measures nothing.
 */
async function settleProvisioning(win: Page): Promise<void> {
  await expect
    .poll(
      async () => (await roots(win)).map((root) => root.provisioningState ?? 'idle').join(','),
      { timeout: 30000 },
    )
    .not.toContain('provisioning')
}

/** Delete a project folder for real (retrying a racing background writer). */
function removeForReal(dir: string): void {
  for (let attempt = 0; attempt < 10 && existsSync(dir); attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A racing writer re-created part of the tree — try again.
    }
  }
  expect(existsSync(dir), 'the probe must actually remove the project folder').toBe(false)
}

/**
 * Boot once to seed `dirs` as roots with `active` selected, quit, delete `vanish`,
 * and relaunch — leaving the app in the "a project folder disappeared while Flow
 * was closed" state with a live window. Callers own closing the returned app.
 */
async function bootWithVanishedRoot(opts: {
  userDataDir: string
  dirs: string[]
  active: string
  vanish: string
}): Promise<{ app: ElectronApplication; win: Page; errors: string[] }> {
  let app = await launch(opts.userDataDir)
  let win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await dismissOnboarding(win)
  for (const dir of opts.dirs) await addRoot(win, dir)
  await setActive(win, opts.active)
  await settleProvisioning(win)
  await app.close()

  removeForReal(opts.vanish)

  app = await launch(opts.userDataDir)
  win = await app.firstWindow()
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(String(e)))
  await win.waitForLoadState('domcontentloaded')
  await dismissOnboarding(win)
  // Restore + the availability partition settle asynchronously after boot.
  await win.waitForTimeout(2500)
  await dismissAnyOverlay(win)
  return { app, win, errors }
}

test.describe('a project folder that disappeared while Flow was closed', () => {
  test('LIVE GUARD: a vanished project stays known, cannot be entered, and an available one can (#263/#350)', async () => {
    const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-unavail-'))
    const keep = mkRepo('flow-keep-')
    const other = mkRepo('flow-other-')
    const gone = mkRepo('flow-gone-')
    let app: ElectronApplication | null = null
    try {
      const booted = await bootWithVanishedRoot({
        userDataDir,
        dirs: [keep, other, gone],
        active: keep,
        vanish: gone,
      })
      app = booted.app
      const { win, errors } = booted

      // The model must know the folder is gone — everything below depends on it.
      const list = await roots(win)
      expect(list.find((r) => r.rootPath === gone)?.available).toBe(false)
      expect(list.find((r) => r.rootPath === keep)?.available).toBe(true)
      await expect.poll(() => activeProjectName(win)).toBe(basename(keep))

      // (The sidebar's per-project rows this guarded — #263's tagged, inert
      // row — went with the Workspaces hard migration; the Workspace switcher
      // test below carries the "tagged" half.) The INERT half is the app's:
      // asking to enter the vanished folder must not bind the app to it.
      await setActive(win, gone)
      await win.waitForTimeout(1200)
      await expect.poll(() => activeProjectName(win)).toBe(basename(keep))

      // …and that is the availability guard, not a dead app: an AVAILABLE
      // sibling still becomes active, and back.
      await setActive(win, other)
      await expect.poll(() => activeProjectName(win)).toBe(basename(other))
      await setActive(win, keep)
      await dismissAnyOverlay(win)
      await expect.poll(() => activeProjectName(win)).toBe(basename(keep))

      expect(errors).toEqual([])
      await win.screenshot({ path: `${SCREENS}/project-unavailable-sidebar-guard.png` })
    } finally {
      if (app) await app.close().catch(() => undefined)
      for (const d of [keep, other, userDataDir]) rmSync(d, { recursive: true, force: true })
    }
  })

  // #974 — FIXED: buildProjectSwitcher now honors the flag (greyed + tagged +
  // disabled + inert), and main refuses the activation as a second layer.
  test(
    'the switcher marks an unavailable project and the app refuses to activate it (#974)',
    async () => {
      const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-unavail-sw-'))
      const keep = mkRepo('flow-keep-')
      const gone = mkRepo('flow-gone-')
      let app: ElectronApplication | null = null
      try {
        const booted = await bootWithVanishedRoot({
          userDataDir,
          dirs: [keep, gone],
          active: keep,
          vanish: gone,
        })
        app = booted.app
        const { win } = booted

        // The switcher (the Workspace's, since the hard migration) lists the
        // project and says it is unavailable.
        await win.locator('.fl-project-current').click()
        const goneItem = win.locator('.fl-project-menu .fl-ws-project', { hasText: basename(gone) })
        await expect(goneItem).toHaveCount(1)
        // Whichever layer noticed first says so: the Workspace's own record
        // ("Not on this machine" — its checkout is no longer where it was) or
        // the app's availability flag ("Not available on this computer").
        await expect(goneItem).toContainText(/Not on this machine|Not available on this computer/)
        await win.screenshot({ path: `${SCREENS}/project-unavailable-switcher-menu.png` })
        await win.keyboard.press('Escape')

        // And asking for it never binds the app to a directory that isn't there.
        await setActive(win, gone)
        await win.waitForTimeout(2500)
        await dismissAnyOverlay(win)
        await expect.poll(() => activeProjectName(win)).toBe(basename(keep))
      } finally {
        if (app) await app.close().catch(() => undefined)
        for (const d of [keep, userDataDir]) rmSync(d, { recursive: true, force: true })
      }
    },
  )

  // #975 — FIXED: boot restore routes through resolveActiveRoot (shared seam),
  // which degrades an unreachable request to the first available root.
  test(
    'relaunching never leaves the app silently bound to a vanished active project (#975)',
    async () => {
      const userDataDir = mkdtempSync(join(tmpdir(), 'flow-e2e-unavail-boot-'))
      const keep = mkRepo('flow-keep-')
      const gone = mkRepo('flow-gone-')
      let app: ElectronApplication | null = null
      try {
        const booted = await bootWithVanishedRoot({
          userDataDir,
          dirs: [keep, gone],
          // the project that vanishes is the one that was ACTIVE
          active: gone,
          vanish: gone,
        })
        app = booted.app
        const { win } = booted
        await win.screenshot({ path: `${SCREENS}/project-unavailable-boot-active.png` })

        const active = await win.evaluate(
          async () =>
            await (
              window as unknown as {
                flow: { project: { active(): Promise<{ rootPath: string } | null> } }
              }
            ).flow.project.active(),
        )
        if (active?.rootPath === gone) {
          // Acceptable alternative to falling back: stay bound, but SAY SO where the
          // user is actually looking. The threads sidebar's own `unavailable` tag
          // does NOT count — it sits on a row the user didn't touch while the
          // titlebar chip reads exactly like a healthy project, which is the whole
          // contradiction #975 is about. So the message must appear OUTSIDE the
          // sidebar (titlebar chip, or the empty main/Files/Source-Control surface).
          const named = await win.evaluate((source) => {
            const re = new RegExp(source, 'i')
            const sidebar = document.querySelector('.fl-thread-sidebar')
            const chip = document.querySelector('.fl-project-switcher')
            if (chip && (re.test(chip.textContent ?? '') || re.test((chip as HTMLElement).title)))
              return true
            return Array.from(document.querySelectorAll('body *')).some((el) => {
              if (el.children.length > 0) return false // leaf text nodes only
              if (sidebar?.contains(el)) return false // the sidebar tag doesn't count
              return re.test(el.textContent ?? '')
            })
          }, "folder (not found|is missing|has moved)|unavailable|can't be found|isn't where")
          expect(
            named,
            'a vanished ACTIVE project must be named outside the threads sidebar',
          ).toBe(true)
        } else {
          // Preferred: fall back to an available root, as removal already does.
          expect(active?.rootPath).toBe(keep)
          await expect.poll(() => activeProjectName(win)).toBe(basename(keep))
        }
      } finally {
        if (app) await app.close().catch(() => undefined)
        for (const d of [keep, userDataDir]) rmSync(d, { recursive: true, force: true })
      }
    },
  )
})

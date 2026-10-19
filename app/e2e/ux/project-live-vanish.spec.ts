/**
 * UX regression probe — flow `project` (rotation index 1, round 19): the ACTIVE
 * project's folder disappears **while Flow is running**.
 *
 * Flow 1 is the most-probed flow in the rotation (~25 specs), but every prior
 * round drove roots that either exist for the whole run, or vanished while the
 * app was CLOSED:
 *
 *   #974 — the titlebar switcher lists an `unavailable` root as a normal row
 *   #975 — boot restore re-enters a project whose folder is gone
 *
 * Both of those are the *boot* path, and both rest on the same premise: the model
 * already KNOWS ("`roots(): available: false` ← the model KNOWS it's gone" — #975).
 * `partitionByAvailability` (main/project/root-availability.ts) is what stamps
 * that flag, and `ProjectRegistry.restore()` (project-registry.ts) is its
 * ONLY caller. `getRoots()` then stamps every live root `available: true`
 * unconditionally. So for a folder that disappears mid-session — renamed or moved
 * in Finder, a removed git worktree, an unmounted external/network drive — the
 * flag is never recomputed and the premise both prior issues depend on is FALSE:
 * nothing in the app ever notices. Filed as #1118.
 *
 * Test 1 is the live guard (green on main): the whole recipe is real for a healthy
 * project — the tree lists it, a row click opens a tab, the model reports it
 * available — so the tripwires below can only fail for the documented reason.
 * Tests 2-3 were `test.fixme` tripwires for #1118 and are now LIVE regression
 * guards. Both were verified non-vacuous: un-fixme'd against pre-fix main they
 * failed deterministically on their documented assertion, not on setup.
 *
 * FIXED by `ProjectRegistry.refreshAvailability()` (main/project/
 * project-registry.ts) — the partition is re-run from the root watcher's own
 * unlinkDir/error, a periodic backstop, and every `project:list` /
 * `project:setActive` call — plus `openFileFailedToast` /
 * `listDirFailedToast` (renderer/editor/editor-feedback.ts) so an ENOENT open or
 * listing is never console-only.
 *
 * Credential-free: `project:*` IPC + fs only. No native dialog is involved.
 */
import { basename, join } from 'node:path'
import { writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds, activeProjectName, showActiveProjectFiles } from './fixtures/seed'

const SCREENS = 'e2e/ux/__screens'

/** Files-tree rows are `.row` inside <fl-list>'s open shadow root (light DOM has none). */
async function clickTreeRow(win: Page, needle: string): Promise<boolean> {
  return win.evaluate((text) => {
    const lists = Array.from(document.querySelectorAll('fl-list')) as Array<
      HTMLElement & { shadowRoot: ShadowRoot | null }
    >
    for (const list of lists) {
      const rows = list.shadowRoot ? Array.from(list.shadowRoot.querySelectorAll('.row')) : []
      const hit = rows.find((row) => (row as HTMLElement).innerText.trim().includes(text))
      if (hit) {
        ;(hit as HTMLElement).click()
        return true
      }
    }
    return false
  }, needle)
}

/** Open editor tabs (label text), read from <fl-tabs>' shadow root. */
async function tabs(win: Page): Promise<string[]> {
  return win.evaluate(() => {
    const el = document.querySelector('fl-tabs') as
      | (HTMLElement & { shadowRoot: ShadowRoot | null })
      | null
    return el?.shadowRoot
      ? Array.from(el.shadowRoot.querySelectorAll('.tab')).map((tab) =>
          ((tab.querySelector('.label') as HTMLElement) ?? (tab as HTMLElement)).innerText.trim(),
        )
      : []
  })
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
 * Make a seeded project's folder REALLY disappear, the way a Finder move or an
 * `rm -rf` does for a user.
 *
 * The IDE auto-provisions every added root in the background (`.claude/…`), and
 * that writer races a plain `rmSync`: the delete either throws ENOTEMPTY or the
 * provisioner re-creates the tree a moment later, so the folder is still there
 * and the app is right to keep reporting it available. Wait for provisioning to
 * settle first, then delete until the path is actually gone. Environment-only —
 * nothing here weakens what the tests below assert.
 */
async function vanish(win: Page, dir: string): Promise<void> {
  await expect
    .poll(async () => (await roots(win)).find((r) => r.rootPath === dir)?.provisioningState, {
      timeout: 25000,
    })
    .not.toBe('provisioning')
  for (let attempt = 0; attempt < 8 && existsSync(dir); attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A racing background writer re-created part of the tree — try again.
    }
    await win.waitForTimeout(300)
  }
  expect(existsSync(dir), 'the probe must actually remove the project folder').toBe(false)
}

/** Seed a project with real files, activate it, and show the Files tree. */
async function seedAndShow(win: Page, prefix: string): Promise<string> {
  const dir = await seedProject(win, prefix, (d) => {
    writeFileSync(join(d, 'one.txt'), 'one\n')
    writeFileSync(join(d, 'two.txt'), 'two\n')
    mkdirSync(join(d, 'sub'))
    writeFileSync(join(d, 'sub', 'three.txt'), 'three\n')
  })
  return dir
}

async function showFilesRail(win: Page): Promise<void> {
  // The active project's tree — pressing it in the Workspace picker when the
  // panel shows one (no thread is selected in these specs).
  await showActiveProjectFiles(win)
  await win.waitForTimeout(800)
}

test.describe('the active project folder disappears while Flow is running', () => {
  test.afterAll(() => cleanupSeeds())

  test('LIVE GUARD: a healthy project is live — tree row opens a tab, model reports it available', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const project = await seedAndShow(window, 'flow-ux-livectl-')
    await activateProject(window, project)
    await showFilesRail(window)

    await expect.poll(() => activeProjectName(window)).toBe(basename(project))
    const listed = await roots(window)
    expect(listed.find((r) => r.rootPath === project)?.available).toBe(true)

    // The real Files-tree open path: click the row, get a tab.
    expect(await clickTreeRow(window, 'one.txt'), 'the tree must list one.txt').toBe(true)
    await expect(async () => {
      expect(await tabs(window)).toContain('one.txt')
    }).toPass({ timeout: 5000 })

    expect(errors).toEqual([])
  })

  // #1118 — availability is now re-evaluated live: the periodic backstop, the
  // root watcher's own unlinkDir/error, and every roots()/setActiveProject call
  // re-run the partition (ProjectRegistry.refreshAvailability).
  test(
    'Flow notices when the active project folder disappears mid-session (#1118)',
    async ({ window }) => {
      const project = await seedAndShow(window, 'flow-ux-livegone-')
      const sibling = await seedProject(window, 'flow-ux-livekeep-')
      await activateProject(window, project)
      await showFilesRail(window)
      expect(await clickTreeRow(window, 'one.txt')).toBe(true)
      await expect(async () => {
        expect(await tabs(window)).toContain('one.txt')
      }).toPass({ timeout: 5000 })

      // The folder goes away (Finder rename/move, removed worktree, unmounted drive).
      await vanish(window, project)
      await window.waitForTimeout(3500)

      // Switching away and back is the strongest "please re-read this project"
      // signal a user can send — it must not leave the stale flag either.
      await activateProject(window, sibling)
      await window.waitForTimeout(1200)
      await activateProject(window, project)
      await window.waitForTimeout(2500)
      await dismissFlowOverlay(window)
      await window.screenshot({ path: `${SCREENS}/project-live-vanish-unnoticed.png` })

      const listed = await roots(window)
      const gone = listed.find((r) => r.rootPath === project)
      if (gone?.available === false) return // model noticed — the preferred fix

      // Otherwise the app must at least SAY so where the user is looking. The
      // threads sidebar's `unavailable` tag is the app's own established vocabulary
      // (#263) — but any surface naming the problem satisfies this.
      const named = await window.evaluate(
        (pattern) => new RegExp(pattern, 'i').test(document.body.innerText),
        "unavailable|folder (not found|is missing|has moved)|no longer (exists|available)|can't be found|doesn't exist",
      )
      expect(
        named,
        'a project folder that vanished mid-session must be flagged `available: false` or named in the UI',
      ).toBe(true)
    },
  )

  // #1118, second facet — the failure used to be console-only.
  test(
    'opening a file from a vanished project gives user-visible feedback (#1118)',
    async ({ window }) => {
      const project = await seedAndShow(window, 'flow-ux-livesilent-')
      await activateProject(window, project)
      await showFilesRail(window)

      await vanish(window, project)
      await window.waitForTimeout(3000)

      // `flow:open-file` is exactly what a Files-tree row click ends up calling —
      // reachable for a user through restored tabs, the git panel, a blueprint peek
      // or a thread's file reference after the folder is gone.
      await window.evaluate((rootPath) => {
        document.dispatchEvent(
          new CustomEvent('flow:open-file', { detail: { rootPath, relPath: 'two.txt' } }),
        )
      }, project)
      await window.waitForTimeout(2000)
      await window.screenshot({ path: `${SCREENS}/project-live-vanish-silent-open.png` })

      const feedback = await window.evaluate(() => ({
        toast: (document.querySelector('.fl-flow-toasts') as HTMLElement | null)?.innerText ?? '',
        body: document.body.innerText,
      }))
      expect(
        /couldn't open|could not open|failed to open|not found|no longer|doesn't exist|does not exist/i.test(
          `${feedback.toast}\n${feedback.body}`,
        ),
        'a file open that fails with ENOENT must not be console-only',
      ).toBe(true)
    },
  )
})

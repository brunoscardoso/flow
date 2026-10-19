import { basename, join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, dismissFlowOverlay, cleanupSeeds, activeProjectName, showActiveProjectFiles, FILES_PANE } from './fixtures/seed'
import { openProjectActions, switcherListsProject } from './fixtures/project-actions'

/**
 * UX sweep — flow 1 (Project: open / switch / add), round 23:
 * **removing the project you are CURRENTLY IN**, and the empty state you land
 * in when it was your last one.
 *
 * Flow 1 is the most-probed flow in the rotation (25+ specs), but every prior
 * removal probe drives one of the two EASY cases: `project-active-invariants`
 * removes a NON-active project (the active one must not move), and #323/#1080
 * cover removing the LAST project's effect on the titlebar / next launch.
 * Nobody had driven the whole removal END TO END through the real ⋯ menu and
 * then looked at what the app kept.
 *
 * Coverage here:
 *  - test 1 (LIVE): removing the active project hands off to the surviving one —
 *    the group leaves the sidebar, the titlebar switcher follows, and the Files
 *    tree rebinds (`handOffActiveProject`, main/ipc/index.ts:477, #1080). The
 *    app never passes through "No project" on the way to a good sibling.
 *  - test 2 (LIVE): the editor lets go — a tab open on a file inside the removed
 *    project is closed, so the user cannot keep typing into (and saving to) a
 *    project the app says it is not in (the #426-class silent mis-target).
 *  - test 3 (TRIPWIRE #1358): the one-time "Run a basic discovery?" ask (`learn/index.ts`)
 *    has no project lifecycle — it is dismissed only when ANSWERED. Remove the
 *    project it names and the card stays on screen over a "No project" window,
 *    still offering to spend an agent run on a folder that is no longer a
 *    project; main's `answerBasicDiscovery` (main/index.ts:476-478) returns early
 *    for an unknown root, so the click is a silent dead click — no toast, no
 *    inbox entry, nothing. Contrast lives in
 *    `project-basic-discovery-ask.spec.ts` test 1: on a live project the same
 *    click is loud ("Basic discovery started · Learning N module(s)").
 *  - test 4 (TRIPWIRE #1359): the no-project empty state of the Source Control panel
 *    is internal jargon with no way forward — "No project roots"
 *    (`git-panel.ts:240,355`) — while its two rail siblings say it plainly and
 *    the Files pane even offers the button ("No project open" + "Open Folder…",
 *    "Open a project to start — ＋ Open Project… in the titlebar"). Same class as
 *    #978, which fixed exactly this for the threads pane.
 *
 * Account-independent, agent-independent, no network. Roots are attached via
 * `project:add` — the same code path `project:open` runs after
 * the user picks a folder in the native dialog Playwright cannot drive; the
 * removal itself is driven entirely through the real UI. Files open via the
 * decoupled `flow:open-file` event (independent of the #663/#664 activity-bar
 * markup). Monaco's benign internal "Canceled" rejection on model dispose is
 * filtered — see editor.spec.ts.
 */

const SCREENS = 'e2e/ux/__screens'

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

/** Errors that matter to a user (Monaco disposes models on every rebind). */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => !m.includes('Canceled'))
}

async function switcherLabel(win: Page): Promise<string> {
  return activeProjectName(win)
}

/** The switcher lists `name`, waiting out the roots broadcast it is drawn from. */
async function expectSwitcherLists(win: Page, name: string): Promise<void> {
  await expect
    .poll(() => switcherListsProject(win, name).catch(() => false), { timeout: 15_000 })
    .toBe(true)
}

/** Show a rail pane. IDEMPOTENT on purpose: the rail buttons TOGGLE, and
 *  Threads is the boot default (aria-pressed=true) — clicking it again would
 *  collapse the sidebar entirely. */
async function selectRail(win: Page, id: 'threads' | 'files' | 'source-control'): Promise<void> {
  const rail = win.locator(`.fl-activity-bar [data-rail-item="${id}"]`)
  if ((await rail.getAttribute('aria-pressed')) === 'true') return
  await rail.click()
}

/** Editor tabs in the shell tab strip. */
function editorTabs(win: Page) {
  return win.locator('.fl-shell fl-tabs .tab')
}

/** Open a project file through the app's real decoupled `flow:open-file` event. */
async function openFile(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

/** Drive the real destructive removal: ⋯ → Remove from sidebar → Remove. */
async function removeProjectViaUi(win: Page, name: string): Promise<void> {
  const menu = await openProjectActions(win, name)
  await expect(menu).toBeVisible()
  await menu.locator('.fl-thread-menu-item', { hasText: 'Remove from sidebar' }).click()
  // Destructive → in-menu confirmation naming the project (never a silent act).
  const confirm = menu.locator('.fl-thread-menu-confirm')
  await expect(confirm).toBeVisible()
  await expect(confirm).toContainText(name)
  await menu.locator('.fl-thread-menu-actions .fl-thread-menu-item', { hasText: 'Remove' }).click()
  await expect(menu).toHaveCount(0)
}

/** A repo with `src/<name>` module dirs — the shape the basic-discovery ask
 *  selects (mirrors project-basic-discovery-ask.spec.ts). */
function withModules(names: string[]) {
  return (dir: string): void => {
    for (const name of names) {
      mkdirSync(join(dir, 'src', name), { recursive: true })
      writeFileSync(join(dir, 'src', name, 'index.ts'), `export const ${name} = 1\n`)
    }
    writeFileSync(join(dir, 'package.json'), '{"name":"probe","version":"1.0.0"}\n')
  }
}

/** Everything the user could read as "something happened". */
async function feedback(win: Page): Promise<{ toasts: string[]; inbox: string[] }> {
  return win.evaluate(() => ({
    toasts: Array.from(document.querySelectorAll('.fl-flow-toast')).map((n) =>
      (n.textContent ?? '').trim(),
    ),
    inbox: Array.from(document.querySelectorAll('.fl-flow-inbox-entry')).map((n) =>
      (n.textContent ?? '').trim(),
    ),
  }))
}

/** The visible text of whichever sidebar pane the rail is showing. */
async function visiblePaneText(win: Page): Promise<string> {
  return win.evaluate(() =>
    (Array.from(document.querySelectorAll('.fl-sidebar-pane')) as HTMLElement[])
      .filter((pane) => pane.offsetParent !== null)
      .map((pane) => (pane.innerText ?? '').trim())
      .join(' || '),
  )
}

test.describe('removing the project you are currently in', () => {
  test.afterAll(() => cleanupSeeds())

  // The door: the ⋯ on the project's row in the Workspace switcher
  // (`flow:project-menu` → thread-sidebar.ts #openProjectMenu).
  test('hands off to the surviving project — sidebar, titlebar and file tree', async ({
    window,
  }) => {
    const errors = trackErrors(window)

    // Two projects, each with a distinctly-named marker file so the file tree
    // unambiguously identifies which project is bound.
    const a = await seedProject(window, 'flow-ux-rma-')
    writeFileSync(join(a, 'AAA_MARKER_A.txt'), 'a\n')
    const b = await seedProject(window, 'flow-ux-rmb-')
    writeFileSync(join(b, 'BBB_MARKER_B.txt'), 'b\n')
    await activateProject(window, b)
    await activateProject(window, a) // A is the project the user is IN

    expect(await switcherLabel(window)).toBe(basename(a))
    await selectRail(window, 'threads')
    // THE SWITCHER'S LIST ARRIVES AFTER `project.active()` HAS ANSWERED. Measured
    // here: immediately after activating A the menu listed only B, and ~600ms
    // later it listed both — so a one-shot read asserted a list that was still
    // being delivered, and failed on the project the test had just switched to.
    // `switcherListsProject` throws when the menu does not open, and `expect.poll`
    // abandons a thrown error rather than retrying it, so the throw is answered
    // as "not listed yet" and the poll is left to decide.
    await expectSwitcherLists(window, basename(a))
    await expectSwitcherLists(window, basename(b))

    // Remove the ACTIVE project through the real ⋯ menu + confirmation.
    await removeProjectViaUi(window, basename(a))
    await dismissFlowOverlay(window)

    // 1. The removed project leaves the switcher; the sibling stays.
    await expect.poll(() => switcherListsProject(window, basename(a)), { timeout: 5000 }).toBe(false)
    expect(await switcherListsProject(window, basename(b))).toBe(true)

    // 2. The app lands IN the survivor — never in a "No project" limbo (#1080).
    await expect(async () => {
      expect(await switcherLabel(window)).toBe(basename(b))
    }).toPass({ timeout: 5000 })

    // 3. The project surfaces rebind: B's tree, not A's.
    await showActiveProjectFiles(window)
    const filesPane = window.locator(FILES_PANE)
    await expect(filesPane.getByText('BBB_MARKER_B.txt')).toBeVisible({ timeout: 8000 })
    await expect(filesPane.getByText('AAA_MARKER_A.txt')).toHaveCount(0)

    await window.screenshot({ path: `${SCREENS}/project-remove-active-handoff.png` })
    expect(appErrors(errors), appErrors(errors).join(', ')).toEqual([])
  })

  // The door: the ⋯ on the project's row in the Workspace switcher
  // (`flow:project-menu` → thread-sidebar.ts #openProjectMenu).
  test('the editor lets go of the removed project’s open file', async ({ window }) => {
    const errors = trackErrors(window)

    const a = await seedProject(window, 'flow-ux-rma2-')
    writeFileSync(join(a, 'ONLY_IN_A.ts'), 'export const a = 1\n')
    const b = await seedProject(window, 'flow-ux-rmb2-')
    writeFileSync(join(b, 'ONLY_IN_B.ts'), 'export const b = 2\n')
    await activateProject(window, b)
    await activateProject(window, a)

    // The user has A's file open in the editor.
    await openFile(window, a, 'ONLY_IN_A.ts')
    const tabs = editorTabs(window)
    await expect(tabs.filter({ hasText: 'ONLY_IN_A.ts' })).toHaveCount(1, { timeout: 10_000 })

    // Now they remove the project that file lives in.
    await selectRail(window, 'threads')
    await removeProjectViaUi(window, basename(a))
    await dismissFlowOverlay(window)

    await expect(async () => {
      expect(await switcherLabel(window)).toBe(basename(b))
    }).toPass({ timeout: 5000 })

    await window.screenshot({ path: `${SCREENS}/project-remove-active-editor.png` })

    // The removed project's file must not stay open over a project that no
    // longer contains it — otherwise the user edits and saves into a project
    // the app says it is not in.
    await expect(tabs.filter({ hasText: 'ONLY_IN_A.ts' })).toHaveCount(0, { timeout: 8000 })

    expect(appErrors(errors), appErrors(errors).join(', ')).toEqual([])
  })

  test.fixme(
    'the "Run a basic discovery?" ask does not outlive the project it names (#1358)',
    async ({ window }) => {
      const project = await seedProject(
        window,
        'flow-ux-rm-ask-',
        withModules(['api', 'core', 'ui']),
      )
      await activateProject(window, project)

      // The one-time ask fires when provisioning reports ready.
      const card = window.locator('.fl-learn-card')
      await card.waitFor({ state: 'visible', timeout: 60_000 })
      await expect(card).toContainText(basename(project))

      // The user removes that project before answering.
      await selectRail(window, 'threads')
      await removeProjectViaUi(window, basename(project))
      await dismissFlowOverlay(window)
      await expect(async () => {
        expect(await switcherLabel(window)).toBe('No project')
      }).toPass({ timeout: 5000 })
      await window.screenshot({ path: `${SCREENS}/project-remove-stale-learn-ask.png` })

      // Either the ask goes with its project …
      if ((await card.count()) === 0) return

      // … or, if it stays, its primary action must still say something. It does
      // not: answerBasicDiscovery returns early for an unknown root.
      await window.locator('.fl-learn-card fl-button', { hasText: 'Run discovery' }).click()
      await window.waitForTimeout(9000)
      const seen = await feedback(window)
      expect(
        [...seen.toasts, ...seen.inbox],
        'the ask card outlived its project and "Run discovery" produced no user-visible feedback anywhere',
      ).not.toEqual([])
    },
  )

  test.fixme('the no-project Source Control panel says so in plain words (#1359)', async ({ window }) => {
    // Fresh launch, no project — the state a user is also left in after removing
    // their last project.
    await selectRail(window, 'threads')
    expect(await visiblePaneText(window)).toContain('Open a project')
    await selectRail(window, 'files')
    expect(await visiblePaneText(window)).toContain('No project open')

    await selectRail(window, 'source-control')
    const sc = await visiblePaneText(window)
    await window.screenshot({ path: `${SCREENS}/project-noproject-source-control.png` })
    expect(sc, 'Source Control reports the no-project state as "No project roots"').not.toContain(
      'No project roots',
    )
    expect(sc).toMatch(/project/i)
  })
})

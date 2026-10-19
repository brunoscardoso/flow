import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, openEmptyThread } from './fixtures/seed'
import type { Page } from '@playwright/test'
import { basename } from 'node:path'
import { openProjectActions, switcherListsProject } from './fixtures/project-actions'

/**
 * UX sweep — flow 12 (Panel toggles & keyboard shortcuts), round 23.
 *
 * Flow 12 is the most-covered flow in the rotation (23 rounds): ⌘B, ⌘J, ⌃`,
 * ⌘⇧`, rail digits ⌘1-3, focus mode ⌘⌥Z and every leak through it (#836 ⌘B,
 * #924 digits, #967 ⌘⌥C, #968 the titlebar button, #1161 Escape, #1201 the
 * palette), ⌘⌥D (#626), modal isolation (#525, #1002), per-project persistence
 * (#767), restart persistence (#454), the bottom-slot arbitration (#1034),
 * hidden chat (#1071), ⌘R (#1072), the palette reveal contract (#1202/#1313),
 * zoom vs the titlebar (#1352) and the non-empty guard (#1351).
 *
 * Every one of those drives a shortcut against a PANEL, a MODAL, or focus mode.
 * Nobody had driven a shortcut against an open POPUP MENU — even though the app
 * keeps an explicit registry of them (`ESCAPE_OWNING_POPUPS`, focus-escape.ts:27)
 * that only the Escape branch consults. Two findings, both confirmed live:
 *
 *  1. **#1400 — a panel shortcut strands an open popup over an unrelated panel,
 *     still able to act.** `#mountMenu` (thread-sidebar.ts:2287) appends the menu
 *     to `document.body` at a one-shot absolute position computed from its
 *     anchor's rect, and wires dismissal to exactly two things: an outside
 *     `mousedown` and `attachMenuKeyboard` (Escape/arrows). Nothing watches the
 *     anchor. So ⌘B — which removes the whole activity sidebar the anchor lives
 *     in — leaves the menu at the identical rect, fully interactive, floating
 *     over the conversation panel. Measured: the project ⋯ menu's destructive
 *     "Remove from sidebar" fired through the orphan and really removed the
 *     project (project roots 2 → 1), its confirm ("Remove <project> from the
 *     sidebar?") rendered over the chat with no sidebar on screen. The sidebar's
 *     New-task FORM behaves the same, typed draft and Create button intact.
 *
 *  2. **#1401 — the rail's Terminal item is a toggle that reports no state, so
 *     clicking the icon named "Terminal" makes the terminal disappear.**
 *     `buildActivityBar` (shell.ts:1276) splits the rail into SIDEBAR_ITEMS
 *     (which get `.active` + `aria-pressed`) and ACTION_ITEMS, commented "never
 *     get the active indicator". Tasks and Blueprint are open-only, so that is
 *     right for them; Terminal is wired to `toggleTerminal`, which HIDES an
 *     already-visible panel — and the terminal is docked-visible by default.
 *     Measured: className `fl-rail-item`, `aria-pressed` null and title
 *     "Terminal" — byte-identical before and after the panel vanished. #1212
 *     established this exact rule ("the rail must not keep an item lit over a
 *     pane that is not rendered") for the three items above the separator.
 *
 * The live guards below pin the healthy halves so neither tripwire can pass
 * vacuously: the menu really opens and really closes on Escape; ⌘B really
 * removes the sidebar; and the rail really can express state (Threads active,
 * Files not).
 *
 * NOTE (2026-09-04): the per-row ⋯ buttons and the footer terminal button were
 * both removed. Project actions are on RIGHT-CLICK — the same menu, one fewer
 * control — so the guards drive that gesture instead.
 */

const SCREENS = 'e2e/ux/__screens'

const menu = (win: Page) => win.locator('.fl-thread-menu')
const sidebar = (win: Page) => win.locator('.fl-activity-sidebar')
/**
 * Open a project's actions menu — through its door since the Workspaces
 * sidebar (2026-10-06): the ⋯ on its row in the Workspace switcher.
 */
const openProjectMenu = async (win: Page, name: string): Promise<void> => {
  await openProjectActions(win, name)
}

const railState = (win: Page) =>
  win.evaluate(() =>
    Array.from(document.querySelectorAll('.fl-activity-bar button[data-rail-item]')).map((b) => ({
      label: b.getAttribute('aria-label'),
      title: (b as HTMLElement).title,
      cls: b.className,
      pressed: b.getAttribute('aria-pressed'),
    })),
  )

/** Project roots straight from the real IPC bridge — the ground truth for
 *  whether an orphaned "Remove from sidebar" actually removed anything. */
const rootPaths = (win: Page) =>
  win.evaluate(async () => {
    const roots = await (window as unknown as {
      flow: { project: { list(): Promise<Array<{ rootPath: string }>> } }
    }).flow.project.list()
    return (roots ?? []).map((r) => r.rootPath)
  })

async function seeded(win: Page, prefix: string): Promise<string> {
  const root = await seedProject(win, prefix)
  await activateProject(win, root)
  await expect(sidebar(win)).toBeVisible()
  return root
}

/** The editor top bar's Terminal toggle (it left the rail; #1401 gave it state). */
const terminalAction = (win: Page) =>
  win.locator('.fl-editor-actions .fl-rail-item[aria-label="Terminal"]')

test.describe('flow 12 — popups vs panel shortcuts, and the rail Terminal toggle', () => {
  test.afterAll(() => cleanupSeeds())

  // ── LIVE GUARDS ─────────────────────────────────────────────────────────

  // The dismissal path that DOES work. If this ever breaks, the orphan
  // tripwires below would pass for the wrong reason.
  //
  // The PROJECT actions menu this guard used to open has no door since the
  // Workspaces sidebar (2026-10-06): the per-project group header it hung off
  // is gone and nothing dispatches `flow:project-menu`. A THREAD row's
  // right-click menu is the same `#mountMenu` popup — body-mounted, anchored
  // to a sidebar row — so it carries the guard now.
  test('a sidebar row menu opens on right-click, and Escape closes it without touching the sidebar', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))

    const root = await seeded(window, 'flow-ux-popupA-')
    await openEmptyThread(window, root, 'Popup anchor thread')
    await window
      .locator('.fl-thread-sidebar')
      .getByText('Popup anchor thread', { exact: true })
      .first()
      .click({ button: 'right' })
    await expect(menu(window)).toBeVisible()
    await expect(menu(window).locator('.fl-thread-menu-item', { hasText: 'Rename' })).toBeVisible()

    await window.keyboard.press('Escape')
    await expect(menu(window)).toHaveCount(0)
    // Escape is owned by the popup, not by the layout (#1161) — sidebar intact.
    await expect(sidebar(window)).toBeVisible()
    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  // ⌘B really removes the sidebar in the normal layout — so "the menu survived
  // ⌘B" below is measuring a real layout mutation, not a dead key.
  test('⌘B removes the activity sidebar in the normal layout', async ({ window }) => {
    const root = await seeded(window, 'flow-ux-popupB-')
    expect(root).toBeTruthy()
    await expect(sidebar(window)).toBeVisible()
    await window.keyboard.press('ControlOrMeta+KeyB')
    await expect(sidebar(window)).toHaveCount(0)
    await window.keyboard.press('ControlOrMeta+KeyB')
    await expect(sidebar(window)).toBeVisible()
  })

  // The rail CAN express state — #1212 gave it to its sidebar items. The rail
  // now holds ONLY those (Tasks, Blueprint and Terminal moved to the editor's
  // top bar), and #1401's Terminal toggle there reports its state too.
  test('the rail expresses state for its sidebar items (#1212), the Terminal action for itself (#1401)', async ({
    window,
  }) => {
    await seeded(window, 'flow-ux-railA-')
    const state = await railState(window)
    const byLabel = (l: string) => state.find((s) => s.label === l)
    expect(state.map((s) => s.label)).toEqual(['Threads', 'Files', 'Source Control'])
    expect(byLabel('Threads')?.cls).toContain('active')
    expect(byLabel('Threads')?.pressed).toBe('true')
    expect(byLabel('Files')?.pressed).toBe('false')
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await expect(terminalAction(window)).toHaveAttribute('aria-pressed', 'true')
  })

  // THE FOOTER TERMINAL BUTTON IS GONE (2026-09-04, with the rest of the status
  // bar). #705 added it as a one-click reveal; it was a fourth door to a panel
  // the activity bar, ⌃` and the palette all already open, and the bar it sat
  // in is now the notification corner and nothing else. The rail item below is
  // the control this file is actually about.

  // Documents the measured behaviour of the rail item itself: it IS a toggle.
  test('the Terminal action toggles the docked terminal off and back on', async ({ window }) => {
    await seeded(window, 'flow-ux-railC-')
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await window.screenshot({ path: `${SCREENS}/rail-terminal-before.png` })

    await terminalAction(window).click()
    await expect(window.locator(sel.terminalRoot)).toBeHidden()
    await expect(terminalAction(window)).toHaveAttribute('aria-pressed', 'false')
    await window.screenshot({ path: `${SCREENS}/rail-terminal-after.png` })

    await terminalAction(window).click()
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    // …and the control says so again (it used to stay dark — the paint ran
    // before the terminal was re-attached).
    await expect(terminalAction(window)).toHaveAttribute('aria-pressed', 'true')
  })

  // ── TRIPWIRES (RED on main — flip live when fixed) ──────────────────────
  // The project ⋯ menu these drive is opened from the Workspace switcher's
  // project row (2026-10-09); the per-project "+" went with the sidebar's
  // project headers, so the New-task form is reached through that menu.

  test(
    'an open ⋯ menu must not survive ⌘B hiding the sidebar it is anchored inside',
    async ({ window }) => {
      const errors: string[] = []
      window.on('pageerror', (e) => errors.push(String(e)))

      const root = await seeded(window, 'flow-ux-popupC-')
      await openProjectMenu(window, basename(root))
      await expect(menu(window)).toBeVisible()
      const before = await menu(window).boundingBox()

      await window.keyboard.press('ControlOrMeta+KeyB')
      await expect(sidebar(window)).toHaveCount(0)
      await window.screenshot({ path: `${SCREENS}/popup-orphaned-by-cmdb.png` })

      const after = await menu(window).count()
      const box = after ? await menu(window).boundingBox() : null
      expect(
        after,
        `the ⋯ menu is still on screen after ⌘B removed the sidebar it belongs to ` +
          `(was ${JSON.stringify(before)}, now ${JSON.stringify(box)})`,
      ).toBe(0)
      expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
    },
  )

  test(
    'the orphaned menu must not be able to remove a project the user cannot see',
    async ({ window }) => {
      const a = await seeded(window, 'flow-ux-popupD-')
      const b = await seedProject(window, 'flow-ux-popupE-')
      await expect.poll(() => switcherListsProject(window, basename(b)), { timeout: 20000 }).toBe(true)
      expect(a).toBeTruthy()
      const rootsBefore = await rootPaths(window)
      expect(rootsBefore).toHaveLength(2)

      await openProjectMenu(window, basename(b))
      await expect(menu(window)).toBeVisible()
      await window.keyboard.press('ControlOrMeta+KeyB')
      await expect(sidebar(window)).toHaveCount(0)

      // Act through whatever is left on screen.
      const remove = menu(window).locator('.fl-thread-menu-item', { hasText: 'Remove from sidebar' })
      if (await remove.count()) {
        await remove.click()
        const confirm = menu(window).locator('button', { hasText: /^Remove$/ })
        if (await confirm.count()) await confirm.first().click()
      }
      const rootsAfter = await rootPaths(window)
      expect(
        rootsAfter,
        `a destructive action fired through a popup left floating over the chat panel ` +
          `— roots went ${rootsBefore.length} → ${rootsAfter.length}`,
      ).toHaveLength(2)
    },
  )

  test(
    'the New-task form must not be left floating after ⌘B hides its project row',
    async ({ window }) => {
      const root = await seeded(window, 'flow-ux-popupF-')
      await openProjectMenu(window, basename(root))
      await expect(menu(window)).toBeVisible()
      const newTask = menu(window).locator('.fl-thread-menu-item', { hasText: /New task/ })
      await newTask.first().click()
      const title = menu(window).locator('input[type="text"]').first()
      await expect(title).toBeVisible()
      await title.fill('ORPHAN_DRAFT_77')

      await window.keyboard.press('ControlOrMeta+KeyB')
      await expect(sidebar(window)).toHaveCount(0)
      await window.screenshot({ path: `${SCREENS}/newtask-form-orphaned.png` })

      const text = (await menu(window).count())
        ? await menu(window).innerText()
        : ''
      expect(
        await menu(window).count(),
        `the New-task form is still floating over the chat panel after its project row ` +
          `left the screen (showing: ${text.replace(/\n/g, ' | ').slice(0, 160)})`,
      ).toBe(0)
    },
  )

  // (#1401's tripwire — the Terminal control reporting its state — is live now:
  // the toggle guard above asserts aria-pressed both ways.)
})

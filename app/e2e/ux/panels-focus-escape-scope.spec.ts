import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds, pickFilesProject } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX regression probe — flow 12 (panel toggles & keyboard shortcuts), round 19:
 * the two seams focus mode (⌘⌥Z, #616) still owns that no prior probe drove —
 * **who owns Escape while focus mode is on**, and **what the activity rail does
 * while focus mode is on**.
 *
 * Prior flow-12 rounds hammered focus mode from every other direction: it hides
 * the Chat panel and shows the exit pill (#616/#713), ⌘B no longer leaks through
 * it (#836 keyboard, #968 the titlebar button), the rail digits ⌘1-3 no longer
 * leak (#924), ⌘⌥C/⌘⌥D are inert under it (#967), and the docked terminal is
 * deliberately in scope (round 11). Every one of those asks "does shortcut X
 * mutate the layout behind the overlay?". Nobody asked the inverse: when the
 * user presses Escape *for something else that is on screen in focus mode*, or
 * clicks the rail that focus mode left on screen, what happens?
 *
 * Both answers are defects, driven end-to-end here:
 *
 *  - **#1161 — Escape is unscoped.** `shell.ts` registers the focus-mode exit on
 *    `window` in the CAPTURE phase, so it runs before every deeper Escape
 *    handler in the app. Its own comment claims it is "skipped while a panel
 *    menu is open (that Escape closes the menu)" — no such guard exists. Focus
 *    mode is the editor-only view, so Monaco's find widget (⌘F, the most-used
 *    in-editor control) is exactly the thing on screen, and the one Escape that
 *    dismisses it ALSO tears the user out of focus mode. Same for the titlebar
 *    project dropdown. VS Code binds Zen-mode exit to a double-Escape chord
 *    precisely to avoid this collision.
 *  - **#1162 — the rail is left on screen but half of it is dead.** #713 gated
 *    `activitySidebarWrapper` on `layout.focusMode`, but the activity BAR is
 *    appended to `main` (shell.ts ~579), outside the root split, so it is never
 *    hidden. Its three sidebar icons route through `onRailSelect`, which returns
 *    early under focus mode (#924) — visible, enabled, `aria-pressed` intact,
 *    and completely inert with zero feedback — while its three sibling icons in
 *    the SAME rail (Tasks / Blueprint / Terminal) still work.
 *
 * The live `test`s below are the guards that pass on `main` (the healthy halves
 * plus the measured-today behavior that is safe to pin). The `test.fixme` blocks
 * state the EXPECTED behavior and fail on `main` today — flip them live with the
 * fixes.
 */

const SCREENS = 'e2e/ux/__screens'
const rail = '.fl-activity-bar'
const railBtn = (label: string) => `${rail} button[title^="${label}"], ${rail} button[aria-label^="${label}"]`

function appErrors(errors: string[]): string[] {
  return errors.filter((m) => m !== 'Canceled')
}

/** Click a file-tree row by filename (self-heals against the late flow overlay). */
async function openFromTree(win: Page, name: string): Promise<void> {
  const row = win.locator('.fl-sidebar-pane:visible').getByText(name, { exact: true })
  for (let attempt = 0; attempt < 3; attempt++) {
    const overlay = win.locator('.fl-settings-overlay:not([hidden])')
    if (await overlay.count()) {
      await win.keyboard.press('Escape')
      await overlay.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => undefined)
    }
    const files = win.locator('[data-rail-item="files"]')
    const cls = (await files.getAttribute('class')) ?? ''
    if (!/\bactive\b/.test(cls)) await files.click().catch(() => undefined)
    await pickFilesProject(win)
    try {
      await row.waitFor({ state: 'visible', timeout: 8000 })
      await row.click({ timeout: 4000 })
      return
    } catch (error) {
      if (attempt === 2) throw error
    }
  }
}

function findWidget(win: Page) {
  return win.locator('.monaco-editor .find-widget').first()
}

/** True while focus mode is on (the exit pill is its only visible marker). */
async function inFocusMode(win: Page): Promise<boolean> {
  return win.locator(sel.focusHint).isVisible()
}

test.afterAll(() => cleanupSeeds())

// RETIRED 2026-10-09: "one Escape dismisses the widget AND drops focus mode"
// pinned the #1161 DEFECT as measured on the day it was filed. #1161 is fixed
// (shell.ts asks focus-escape.ts who owns Escape first), so that pin now fails
// by design; the EXPECTED test below is the guard.

test(
  'EXPECTED (#1161): Escape that dismisses the find widget must not also exit focus mode',
  async ({ window }) => {
    const dir = await seedProject(window)
    writeFileSync(join(dir, 'alpha.ts'), 'export const HEAD = "focus-escape-head"\nconst hit = "needle-token"\n')
    await activateProject(window, dir)
    await openFromTree(window, 'alpha.ts')
    await expect(window.locator('.monaco-editor .view-lines')).toContainText('focus-escape-head', {
      timeout: 15000,
    })

    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    await expect(window.locator(sel.focusHint)).toBeVisible()

    await window.locator('.monaco-editor .view-lines').click()
    await window.keyboard.press('ControlOrMeta+KeyF')
    await expect(findWidget(window)).toHaveClass(/\bvisible\b/, { timeout: 5000 })

    await window.keyboard.press('Escape')
    // The widget closes…
    await expect(findWidget(window)).not.toHaveClass(/\bvisible\b/, { timeout: 5000 })
    // …and focus mode SURVIVES: Escape only reaches the overlay when nothing
    // nearer claimed it. A second Escape then exits.
    await expect(window.locator(sel.focusHint)).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(window.locator(sel.focusHint)).toBeHidden()
  },
)

test('focus mode + a tab context menu: Escape closes the menu and KEEPS focus mode', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  // The titlebar project dropdown this used to drive is gone — the project
  // switcher moved onto the activity rail, which focus mode hides (#1162). The
  // popup focus mode DOES leave on screen is the editor's own: a tab's
  // right-click menu. It lives in <fl-tabs>' shadow root, which is exactly
  // where a document-level "is a menu open?" check cannot see.
  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.ts'), 'export const HEAD = "focus-escape-head"\n')
  await activateProject(window, dir)
  await openFromTree(window, 'alpha.ts')
  await expect(window.locator('.monaco-editor .view-lines')).toContainText('focus-escape-head', {
    timeout: 15000,
  })

  await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
  await expect(window.locator(sel.focusHint)).toBeVisible()

  const tab = window.locator('.fl-shell fl-tabs .tab', { hasText: 'alpha.ts' })
  await tab.click({ button: 'right' })
  const menu = window.locator('.fl-shell fl-tabs .ctx-menu')
  await expect(menu).toBeVisible()
  // The menu arms its dismiss listeners a macrotask after opening (so the
  // opening click cannot close it); a person never presses Escape inside that.
  await window.waitForTimeout(100)

  // Escape — the menu's own dismiss.
  await window.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)

  // #1161: that Escape belonged to the menu, so focus mode stays…
  await expect(window.locator(sel.focusHint)).toBeVisible()

  // …and the pill's promise survives the guard: with the menu gone, the very
  // next Escape exits, so the advertised single-Escape exit still works.
  await window.keyboard.press('Escape')
  await expect(window.locator(sel.focusHint)).toBeHidden()

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test('focus mode hides the activity rail with the sidebar body (#1162)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  writeFileSync(join(dir, 'alpha.ts'), 'export const HEAD = "rail-probe"\n')
  await activateProject(window, dir)

  // Sidebar open on Files, so there is something for focus mode to hide.
  await window.locator('[data-rail-item="files"]').click()
  await pickFilesProject(window)
  await expect(window.locator('.fl-activity-sidebar')).toBeVisible()

  await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
  await expect(window.locator(sel.focusHint)).toBeVisible()
  // #713 hid the sidebar body; #1162 takes the rail with it. The rail used to
  // survive fully visible and fully ENABLED, with three dead sidebar icons next
  // to three working siblings, and the previously selected item still painted
  // `active` beside a pane that wasn't there.
  await expect(window.locator('.fl-activity-sidebar')).toHaveCount(0)
  await expect(window.locator(rail)).toBeHidden()
  await window.screenshot({ path: `${SCREENS}/panels-focus-rail-hidden.png` })

  // Exiting restores the rail AND the sidebar the user had open.
  await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
  await expect(window.locator(sel.focusHint)).toBeHidden()
  await expect(window.locator(rail)).toBeVisible()
  await expect(window.locator('.fl-activity-sidebar')).toBeVisible()

  const appErrs = appErrors(errors)
  expect(appErrs, appErrs.join(', ')).toHaveLength(0)
})

test(
  'EXPECTED (#1162): focus mode either hides the rail or its icons stay usable',
  async ({ window }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    await window.locator('[data-rail-item="files"]').click()
    await pickFilesProject(window)
    await expect(window.locator('.fl-activity-sidebar')).toBeVisible()

    await window.keyboard.press('ControlOrMeta+Alt+KeyZ')
    await expect(window.locator(sel.focusHint)).toBeVisible()

    // VS Code's Zen mode hides the activity bar outright. Either that, or the
    // click must do what it says. What must NOT happen is what happens today:
    // an enabled control that silently does nothing.
    const railVisible = await window.locator(rail).isVisible()
    if (!railVisible) return
    await window.locator('[data-rail-item="threads"]').click()
    await expect(window.locator('.fl-activity-sidebar')).toBeVisible()
    expect(await inFocusMode(window)).toBe(false)
  },
)

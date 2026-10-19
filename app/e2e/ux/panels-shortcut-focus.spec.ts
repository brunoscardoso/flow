import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 12 (Panel toggles & keyboard shortcuts): global shortcuts must
 * fire REGARDLESS OF FOCUS.
 *
 * `shell.ts`'s panel-shortcut keydown listener is registered on `window` in the
 * CAPTURE phase (line ~502, `true`) specifically so ⌘B / ⌃` / ⌘1-5 keep working
 * while the keyboard is "inside" Monaco or the xterm textarea — those widgets
 * otherwise swallow keys before they reach the document (the xterm helper
 * textarea is known to eat Escape, see the QA ledger). If a focused editor or
 * terminal could suppress ⌘B or ⌃`, a user actively typing would find the panel
 * toggles dead — a real, high-frequency UX break.
 *
 * Every existing flow-12 spec (panels / panels-rail-shortcuts / panels-focus-mode
 * / panels-shortcut-isolation / panels-editor-terminal) presses these shortcuts
 * with the shell body focused — none with Monaco or xterm actually holding
 * keyboard focus. This guards that invariant end-to-end:
 *   A. ⌘B toggles the sidebar while Monaco holds focus.
 *   B. ⌘B toggles the sidebar AND ⌃` toggles the terminal while xterm holds focus.
 *
 * Confirmed by driving the built app during the flow-12 UX sweep (round 8) — the
 * capture-phase handler wins over both widgets, no bug found in this surface.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const SCREENS = 'e2e/ux/__screens'

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

/** Monaco's benign internal CancellationError on rapid model dispose is not
 *  user-facing (see editor.spec.ts). Any other error is a real bug. */
function appErrors(errors: string[]): string[] {
  return errors.filter((m) => !/Canceled/.test(m))
}

/** Open a project file through the app's real decoupled `flow:open-file` event —
 *  independent of the #663/#664 activity-bar markup (leaves the rail on Threads,
 *  so the sidebar stays visible for the ⌘B assertions). */
async function openFile(win: Page, rootPath: string, relPath: string): Promise<void> {
  await win.evaluate(
    ({ rootPath, relPath }) => {
      document.dispatchEvent(new CustomEvent('flow:open-file', { detail: { rootPath, relPath } }))
    },
    { rootPath, relPath },
  )
}

/** Is the keyboard focus currently inside a node matching `selector`? */
async function focusIsInside(win: Page, selector: string): Promise<boolean> {
  return win.evaluate(
    (sel) => !!(document.activeElement && document.activeElement.closest(sel)),
    selector,
  )
}

test.describe('global panel shortcuts fire regardless of focus (flow 12)', () => {
  test.afterAll(() => cleanupSeeds())

  test('⌘B toggles the sidebar while Monaco holds keyboard focus', async ({ window }) => {
    const errors = trackErrors(window)

    const dir = await seedProject(window)
    const MARKER = 'SHORTCUT_FOCUS_TARGET'
    writeFileSync(join(dir, 'sample.ts'), `export const ${MARKER} = 'x'\n`)
    await activateProject(window, dir)

    // Open the file and wait for Monaco to render, then click into it so the
    // keyboard focus is genuinely inside the editor (not the shell body).
    await openFile(window, dir, 'sample.ts')
    const viewLines = window.locator('.monaco-editor .view-lines')
    await expect(viewLines).toContainText(MARKER, { timeout: 15000 })
    await viewLines.click()
    expect(
      await focusIsInside(window, '.monaco-editor'),
      'expected keyboard focus inside Monaco before pressing ⌘B',
    ).toBe(true)

    // Sidebar visible → ⌘B (Monaco focused) must hide it → ⌘B shows it again.
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeHidden()
    await window.screenshot({ path: `${SCREENS}/panels-shortcut-focus-monaco.png` })
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeVisible()

    expect(appErrors(errors), appErrors(errors).join('\n')).toEqual([])
  })

  test('⌘B and ⌃` fire while the xterm textarea holds keyboard focus', async ({ window }) => {
    const errors = trackErrors(window)

    const dir = await seedProject(window)
    await activateProject(window, dir)

    // The terminal is docked-visible by default (#674) but only auto-starts a
    // shell on a USER reveal — cycle ⌃` (hide → reveal) so a live xterm exists,
    // then click into it so xterm's helper textarea owns the keyboard.
    if (await window.locator(sel.terminalRoot).isVisible()) {
      await window.keyboard.press('Control+`')
      await expect(window.locator(sel.terminalRoot)).toBeHidden()
    }
    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    const host = window.locator('.fl-term-host:not([hidden])')
    await expect(host.locator('.xterm').first()).toBeVisible({ timeout: 15000 })
    await host.click()
    expect(
      await focusIsInside(window, '.fl-term-host'),
      'expected keyboard focus inside the terminal before pressing shortcuts',
    ).toBe(true)

    // ⌘B while xterm focused must still toggle the sidebar (capture-phase wins).
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeHidden()
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeVisible()

    // ⌃` while xterm focused must still toggle the terminal itself (VS Code parity:
    // the terminal is dismissable by its own shortcut even from inside it).
    await host.click()
    expect(await focusIsInside(window, '.fl-term-host')).toBe(true)
    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeHidden()
    await window.screenshot({ path: `${SCREENS}/panels-shortcut-focus-xterm.png` })
    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeVisible()

    expect(appErrors(errors), appErrors(errors).join('\n')).toEqual([])
  })
})

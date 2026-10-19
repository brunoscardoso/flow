import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, cleanupSeeds } from './fixtures/seed'

/**
 * Flow 12 — global panel shortcuts vs. the modal Flow-settings overlay (#525).
 *
 * The shell registers its VS-Code-parity shortcuts (⌘B sidebar, ⌃`/⌘J terminal)
 * as a WINDOW capture-phase `keydown` listener that fires regardless of focus
 * (shell.ts). The per-project Flow-settings overlay auto-opens the first time a
 * project becomes active and presents as a modal (click-catching backdrop, ✕
 * button, document-level Escape-to-close).
 *
 * #525 (fixed in fb2e181) gates that listener while a modal overlay is open —
 * `if (document.querySelector('.fl-settings-overlay:not([hidden])')) return` at
 * the top of the handler. The result a real user depends on:
 *
 *  - Global panel shortcuts (⌃`, ⌘B) become NO-OPS while the modal is up — they
 *    no longer mutate the layout behind it, and ⌃` no longer opens a terminal
 *    behind the modal that steals focus to xterm (which then swallowed Escape and
 *    stranded the modal — the original #525 symptom).
 *  - Escape STILL closes the modal (it reaches the modal's own handler because
 *    the shell listener bailed out early instead of consuming it).
 *
 * The terminal is docked-visible by default (#674), so the control asserts a
 * round-trip toggle rather than a hidden→shown reveal.
 *
 * (This spec supersedes the pre-fix version written ~2.5h before fb2e181 landed,
 * which asserted the OLD broken leak behavior and a hidden-by-default terminal —
 * both stale after #525 + #674, so it went silently red on main while CI was
 * billing-blocked. This guards the current, correct isolation instead.)
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Activate a seeded root WITHOUT dismissing the auto-opened Flow-settings modal. */
async function activateRawWithModal(win: Page, root: string) {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, root)
  const overlay = win.locator('.fl-settings-overlay:not([hidden])')
  await overlay.waitFor({ state: 'visible', timeout: 4000 })
  return overlay
}

test.describe('panel shortcuts vs. the Flow-settings modal (#525)', () => {
  test.afterAll(() => cleanupSeeds())

  test('control: with no modal open, ⌘B toggles the sidebar and ⌃` the terminal', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    const root = await seedProject(window)
    // activateProject would dismiss the modal for us, but here we drive raw then
    // close it via ✕ so the control starts from a clean, modal-free shell.
    const overlay = await activateRawWithModal(window, root)
    await overlay.locator('.fl-settings-close').click()
    await expect(overlay).toHaveCount(0)

    // ⌘B toggles the sidebar both directions (starts visible).
    await expect(window.locator(sel.threadSidebar)).toBeVisible()
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeHidden()
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator(sel.threadSidebar)).toBeVisible()

    // ⌃` toggles the terminal both directions. Its starting state is persisted
    // layout, not a constant — establish it here rather than assuming a default,
    // so this control measures the SHORTCUT and not the seeded profile.
    if (!(await window.locator(sel.terminalRoot).isVisible())) {
      await window.keyboard.press('Control+`')
    }
    await expect(window.locator(sel.terminalRoot)).toBeVisible()
    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeHidden()
    await window.keyboard.press('Control+`')
    await expect(window.locator(sel.terminalRoot)).toBeVisible()

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  test('the Flow-settings modal isolates ⌃`/⌘B and Escape still closes it (#525)', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    const root = await seedProject(window)
    const overlay = await activateRawWithModal(window, root)

    // Snapshot the layout + focus BEFORE any shortcut — the modal must isolate
    // them, so we assert "unchanged" relative to these (robust to window reuse).
    const termVisibleBefore = await window.locator(sel.terminalRoot).isVisible()
    const sidebarVisibleBefore = await window.locator(sel.threadSidebar).isVisible()

    // ⌃` while the modal owns the keyboard is a NO-OP: the terminal's visibility
    // does not change, and — critically — focus is NOT stolen to xterm (the
    // original #525 symptom that killed Escape). Give the old leak a window to
    // manifest, then prove it didn't.
    await window.keyboard.press('Control+`')
    await window.waitForTimeout(500)
    expect(await window.locator(sel.terminalRoot).isVisible()).toBe(termVisibleBefore)
    const focusAfterBacktick = await window.evaluate(() => document.activeElement?.className ?? '')
    expect(focusAfterBacktick).not.toContain('xterm-helper-textarea')

    // ⌘B while the modal is up is also a no-op — the sidebar behind it is untouched.
    await window.keyboard.press(`${mod}+b`)
    await window.waitForTimeout(300)
    expect(await window.locator(sel.threadSidebar).isVisible()).toBe(sidebarVisibleBefore)

    // The modal survived the shortcuts…
    await expect(overlay).toHaveCount(1)
    // …and Escape STILL closes it (the shell listener bailed out early, so Escape
    // reaches the modal's own handler instead of being consumed / swallowed).
    await window.keyboard.press('Escape')
    await expect(overlay).toHaveCount(0)

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })

  test('the ✕ button also closes the Flow-settings modal', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    const root = await seedProject(window)
    const overlay = await activateRawWithModal(window, root)

    // The explicit dismiss affordance works independently of the keyboard path.
    await overlay.locator('.fl-settings-close').click()
    await expect(overlay).toHaveCount(0)

    expect(errors.filter((e) => !/Canceled/.test(e))).toEqual([])
  })
})

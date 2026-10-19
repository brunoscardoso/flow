import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { seedProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — flow 12 (panel toggles & keyboard shortcuts), round 24:
 * the EDITOR's window-level shortcuts vs. an open modal overlay.
 *
 * `modal-overlay.ts` states the invariant in one sentence — "while it is open,
 * global panel shortcuts are inert, the terminal will not steal focus, and Tab
 * is contained inside it" — and exists as a shared registry precisely because
 * enumerating one overlay class left surfaces unguarded by accident (#1002).
 * Three callers joined it: the shell's capture-phase panel shortcuts (#525),
 * the terminal's autofocus (#683), and the app menu's ⌘W (#1198, whose fix
 * comment ends "The app menu was the one caller that never joined it").
 *
 * It was not. `editor/index.ts` registers a FOURTH window-level `keydown`
 * listener — ⌘N (new scratch note), ⌘S (save), ⌘⇧V (markdown preview), ⌃Tab
 * (cycle tabs) — and never asks `isModalOverlayOpen()`. The shell's guard
 * `return`s without `stopPropagation()`, so bailing out of the shell handler
 * hands the identical keystroke straight to the editor's.
 *
 * ⌘N is the sharp one: `newScratchNote()` dispatches `flow:show-editor` (a
 * layout mutation behind the modal — exactly what #525 forbids), adds an
 * untitled tab, activates it, and explicitly focuses Monaco. The overlay focus
 * trap cannot undo that steal when the user hasn't yet focused anything inside
 * the overlay — which is the state the Flow-settings modal AUTO-OPENS in the
 * first time a project becomes active — so the keyboard silently moves to an
 * invisible buffer and the form the user is looking at goes dead.
 *
 * LIVE control (green on main, so the tripwires below are non-vacuous): with no
 * modal up, ⌘N really opens an untitled note and ⌃Tab really cycles tabs.
 *
 * Tripwires (`test.fixme`, each verified genuinely RED vs main):
 *  • three ⌘N presses under the modal create Untitled-1/2/3 behind it;
 *  • text typed after ⌘N lands in that hidden note, not in the modal's fields;
 *  • ⌃Tab re-activates a different tab behind the modal.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'

/** Open editor tab labels, read from the tab strip's shadow DOM. */
async function tabLabels(win: Page): Promise<string[]> {
  return win.evaluate(() => {
    const strip = document.querySelector('fl-tabs')
    if (!strip?.shadowRoot) return []
    return Array.from(strip.shadowRoot.querySelectorAll('.tab .label')).map((n) =>
      (n.textContent ?? '').trim(),
    )
  })
}

/** The active tab's label, or null. */
async function activeTab(win: Page): Promise<string | null> {
  return win.evaluate(() => {
    const strip = document.querySelector('fl-tabs')
    return strip?.shadowRoot?.querySelector('.tab.active .label')?.textContent?.trim() ?? null
  })
}

/** Activate a seeded root WITHOUT dismissing the auto-opened Flow-settings
 *  modal — the same recipe panels-shortcut-isolation.spec.ts (#525) uses, and
 *  the state a real first-run user is in: the modal opened itself, so nothing
 *  inside it has been focused yet. */
async function activateRawWithModal(win: Page, root: string) {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, root)
  const overlay = win.locator('.fl-settings-overlay:not([hidden])')
  await overlay.waitFor({ state: 'visible', timeout: 6000 })
  return overlay
}

test.describe('editor shortcuts vs. a modal overlay (flow 12)', () => {
  test.afterAll(() => cleanupSeeds())

  test('control: with no modal open, ⌘N opens a note and ⌃Tab cycles tabs', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    const root = await seedProject(window)
    const overlay = await activateRawWithModal(window, root)
    await overlay.locator('.fl-settings-close').click()
    await expect(overlay).toHaveCount(0)

    await window.keyboard.press(`${mod}+n`)
    await expect.poll(() => tabLabels(window).then((t) => t.length), { timeout: 6000 }).toBe(1)
    await window.keyboard.press(`${mod}+n`)
    await expect.poll(() => tabLabels(window).then((t) => t.length), { timeout: 6000 }).toBe(2)
    expect((await tabLabels(window)).every((t) => t.startsWith('Untitled'))).toBe(true)

    const before = await activeTab(window)
    await window.keyboard.press('Control+Tab')
    await expect.poll(() => activeTab(window), { timeout: 4000 }).not.toBe(before)
    expect(errors).toEqual([])
  })

  test('⌘N is inert while the Flow-settings modal owns the keyboard', async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(String(e)))
    const root = await seedProject(window)
    const overlay = await activateRawWithModal(window, root)

    const before = await tabLabels(window)
    // A user in a modal reaching for "new" — three presses, as anyone does
    // when the first appears to have done nothing.
    await window.keyboard.press(`${mod}+n`)
    await window.keyboard.press(`${mod}+n`)
    await window.keyboard.press(`${mod}+n`)
    await window.waitForTimeout(800)

    await expect(overlay).toBeVisible()
    expect(await tabLabels(window)).toEqual(before)
    expect(errors).toEqual([])
  })

  test('after ⌘N, typing stays with the modal — not a hidden note', async ({ window }) => {
    const root = await seedProject(window)
    const overlay = await activateRawWithModal(window, root)

    await window.keyboard.press(`${mod}+n`)
    await window.waitForTimeout(800)
    await window.keyboard.type('my webhook url')
    await window.waitForTimeout(400)

    const where = await window.evaluate(() => {
      const monaco = Array.from(document.querySelectorAll('.monaco-editor .view-line'))
        .map((n) => n.textContent ?? '')
        .join('\n')
      const el = document.querySelector('.fl-settings-overlay:not([hidden])')
      const values = Array.from(el?.querySelectorAll('input, textarea') ?? []).map(
        (n) => (n as HTMLInputElement).value,
      )
      const active = document.activeElement
      return {
        monaco,
        values,
        inTerminalOrEditor: !!active?.closest('.monaco-editor'),
        // Nothing inside the auto-opened modal is focused yet, so the keyboard
        // is either still on the page body or already inside the modal — never
        // anywhere else.
        keyboardWithModal: active === document.body || !!(el && active && el.contains(active)),
      }
    })
    await expect(overlay).toBeVisible()
    // The keyboard belongs to the modal: nothing typed may appear in a buffer
    // the user cannot see.
    expect(where.monaco).not.toContain('my webhook url')
    expect(where.inTerminalOrEditor).toBe(false)
    expect(where.keyboardWithModal).toBe(true)
    // (This used to also expect the text in the modal's first field — the
    // webhook URL input, retired with webhook delivery on 2026-03-19. The
    // modal's first controls are now a colour picker and buttons, so nothing
    // auto-receives free typing; what matters is that no hidden buffer does.)
  })

  test('⌃Tab does not cycle editor tabs behind the modal', async ({ window }) => {
    const root = await seedProject(window)
    const overlay = await activateRawWithModal(window, root)
    await overlay.locator('.fl-settings-close').click()
    await expect(overlay).toHaveCount(0)

    await window.keyboard.press(`${mod}+n`)
    await expect.poll(() => tabLabels(window).then((t) => t.length), { timeout: 6000 }).toBe(1)
    await window.keyboard.press(`${mod}+n`)
    await expect.poll(() => tabLabels(window).then((t) => t.length), { timeout: 6000 }).toBe(2)
    const before = await activeTab(window)

    // The project's Flow-settings MODAL (Settings itself is a tab page now, so
    // `flow:open-settings` no longer puts an overlay up).
    await window.evaluate(
      (rootPath) =>
        document.dispatchEvent(new CustomEvent('flow:open-flow-settings', { detail: { rootPath } })),
      root,
    )
    const settings = window.locator('.fl-settings-overlay:not([hidden])')
    await settings.waitFor({ state: 'visible', timeout: 6000 })
    await window.keyboard.press('Control+Tab')
    await window.waitForTimeout(500)

    expect(await activeTab(window)).toBe(before)
  })
})

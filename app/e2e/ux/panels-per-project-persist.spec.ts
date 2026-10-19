import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, dismissFlowOverlay } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 12 (Panel toggles & keyboard shortcuts): panel-toggle state
 * must be PER PROJECT and survive a project switch.
 *
 * shell.ts persists layout in a v5 per-root store (`hydrate(rootId)` on every
 * `project:activeChanged`). Toggling the sidebar (⌘B) in project A,
 * switching to B, and switching back to A should restore A's sidebar-hidden
 * state — each project owns its own panel layout.
 *
 * Saves are DEBOUNCED (200ms) with a `flushSave` only on `pagehide`. `hydrate`
 * reassigns `activeRootId` + overwrites `state` WITHOUT flushing the outgoing
 * project's pending save — the #454 debounce-drop gap, on switch instead of
 * unload. This probe drives that seam with a FAST switch (inside the debounce
 * window) and a SLOW switch (after the debounce settles) to isolate whether the
 * change is lost only in the race, or never persisted per project.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const SAVE_DEBOUNCE_MS = 200

async function switchTo(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (window as unknown as { flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } } })
      .flow.project.setActive({ rootPath: p })
  }, dir)
  await dismissFlowOverlay(win)
}

/** Whether project A's sidebar is actually present in the root split. */
async function sidebarPresent(win: Page): Promise<boolean> {
  return win.locator('.fl-activity-sidebar').first().isVisible().catch(() => false)
}

function trackErrors(win: Page): string[] {
  const errors: string[] = []
  win.on('pageerror', (e) => errors.push(e.message))
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
  })
  return errors
}

test('sidebar-hidden state survives a SLOW (post-debounce) project round-trip', async ({ window }) => {
  const errors = trackErrors(window)
  try {
    const dirA = await seedProject(window, 'flow-ux-ppSlowA-')
    const dirB = await seedProject(window, 'flow-ux-ppSlowB-')

    await activateProject(window, dirA)
    await window.waitForTimeout(300)
    expect(await sidebarPresent(window), 'sidebar shown by default in A').toBe(true)

    // Hide the sidebar in A, then WAIT past the debounce so the save lands.
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator('.fl-activity-sidebar')).toHaveCount(0)
    await window.waitForTimeout(SAVE_DEBOUNCE_MS + 250)

    await switchTo(window, dirB)
    await window.waitForTimeout(300)
    await switchTo(window, dirA)
    await window.waitForTimeout(400)

    await window.screenshot({ path: 'e2e/ux/__screens/pp-slow-back-to-A.png' })
    // A hid its sidebar and the save settled — round-trip MUST restore hidden.
    expect(await sidebarPresent(window), 'A sidebar should still be hidden after a post-debounce round-trip').toBe(false)
    expect(errors, `pageerrors: ${errors.join('; ')}`).toEqual([])
  } finally {
    cleanupSeeds()
  }
})

// KNOWN BUG #767 — `hydrate()` on project switch reassigns `activeRootId` +
// overwrites `state` WITHOUT flushing the outgoing project's pending debounced
// save, so a panel toggle made <200ms before a switch is silently dropped.
// Guard for #767 (fixed): `hydrate` now calls `flushSave()` first (the #454
// fix, applied to the switch path), so the in-debounce toggle persists.
test('sidebar-hidden state survives a FAST (in-debounce) project round-trip', async ({ window }) => {
  const errors = trackErrors(window)
  try {
    const dirA = await seedProject(window, 'flow-ux-ppFastA-')
    const dirB = await seedProject(window, 'flow-ux-ppFastB-')

    await activateProject(window, dirA)
    await window.waitForTimeout(300)
    expect(await sidebarPresent(window), 'sidebar shown by default in A').toBe(true)

    // Hide the sidebar in A, then IMMEDIATELY switch (inside the 200ms debounce).
    await window.keyboard.press(`${mod}+b`)
    await expect(window.locator('.fl-activity-sidebar')).toHaveCount(0)
    await switchTo(window, dirB)
    await window.waitForTimeout(60)
    await switchTo(window, dirA)
    await window.waitForTimeout(400)

    await window.screenshot({ path: 'e2e/ux/__screens/pp-fast-back-to-A.png' })
    expect(await sidebarPresent(window), 'A sidebar should still be hidden after a fast round-trip').toBe(false)
    expect(errors, `pageerrors: ${errors.join('; ')}`).toEqual([])
  } finally {
    cleanupSeeds()
  }
})

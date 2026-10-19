/**
 * UX regression probe — the activity rail's active indicator vs. the sidebar's
 * actual visibility (found while sweeping flow 2, round 21).
 *
 * `shell.ts` already states the rule for the titlebar sidebar button:
 *
 *   // Reflect EFFECTIVE visibility: focus mode hides everything, so the sidebar
 *   // button must not read "active" while it's on (it would lie, #616).
 *   sidebarToggle.classList.toggle('active', sidebarOpen && !layout.focusMode)
 *
 * The activity rail never got that rule. `activityBar.setActive(activeRailItem)`
 * only tracks WHICH item is selected, never whether the sidebar is on screen, so
 * both ordinary collapse paths — ⌘B and the app's own "re-click the active rail
 * item collapses the sidebar" gesture (`onRailSelect`) — leave the rail icon lit
 * (`class="fl-rail-item active"`, `aria-pressed="true"`) beside a pane that
 * isn't rendered, while the titlebar button one row up correctly goes dark.
 *
 * Distinct from #1162, which is the FOCUS-MODE path (rail visible + dead clicks
 * under ⌘⌥Z); this reproduces with focus mode off, on the everyday toggle.
 *
 * Credential-free.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

const SCREENS = 'e2e/ux/__screens'

test.afterAll(() => cleanupSeeds())

interface ShellState {
  railActive: string[]
  railPressed: string[]
  titlebarToggleActive: boolean
  sidebarVisible: boolean
}

async function shellState(win: Page): Promise<ShellState> {
  return win.evaluate(() => {
    // The SIDEBAR items only: `.fl-rail-item` is also the editor area's view
    // actions (Terminal reads active while the dock is shown) and the Workspace
    // switcher, neither of which is a sidebar panel.
    const items = Array.from(document.querySelectorAll('.fl-activity-bar .fl-rail-item[data-rail-item]'))
    return {
      railActive: items
        .filter((el) => el.classList.contains('active'))
        .map((el) => el.getAttribute('aria-label') ?? ''),
      railPressed: items
        .filter((el) => el.getAttribute('aria-pressed') === 'true')
        .map((el) => el.getAttribute('aria-label') ?? ''),
      titlebarToggleActive:
        document.querySelector('.fl-titlebar-icon[title^="Toggle sidebar"]')?.classList.contains('active') ?? false,
      sidebarVisible:
        (document.querySelector('.fl-thread-sidebar') as HTMLElement | null)?.checkVisibility?.() ===
        true,
    }
  })
}

test('the rail must not claim a panel is open while the sidebar is collapsed', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window, 'flow-ux-rail-')
  await activateProject(window, dir)

  // CONTROL — sidebar open: everything agrees.
  const open = await shellState(window)
  expect(open.sidebarVisible).toBe(true)
  expect(open.railActive).toEqual(['Threads'])
  expect(open.titlebarToggleActive).toBe(true)

  // ⌘B collapses the sidebar. The titlebar button correctly goes dark (#616).
  await window.keyboard.press('ControlOrMeta+b')
  await expect.poll(async () => (await shellState(window)).sidebarVisible, { timeout: 5000 }).toBe(false)
  const collapsed = await shellState(window)
  expect(collapsed.titlebarToggleActive, 'titlebar toggle honours #616').toBe(false)
  await window.screenshot({ path: `${SCREENS}/panels-rail-collapsed-cmdb.png` })

  // (#1212 fixed in #1272. Since 4f1ae0e7 the rail is the sidebar's first line,
  // so a collapsed sidebar takes the rail with it — a lit icon beside a hidden
  // pane can no longer be drawn. The assertions below still hold the rule.)

  expect(collapsed.railActive, '⌘B: no rail item may read active with no panel shown').toEqual([])
  expect(collapsed.railPressed, '⌘B: no rail item may report aria-pressed=true').toEqual([])

  // Second path: re-clicking the ACTIVE rail item is the app's own collapse
  // gesture (onRailSelect) — same expectation.
  await window.keyboard.press('ControlOrMeta+b')
  await expect.poll(async () => (await shellState(window)).sidebarVisible, { timeout: 5000 }).toBe(true)
  await window.locator('.fl-rail-item[aria-label="Threads"]').click()
  await expect.poll(async () => (await shellState(window)).sidebarVisible, { timeout: 5000 }).toBe(false)
  const reclicked = await shellState(window)
  expect(reclicked.railActive, 're-click: no rail item may read active').toEqual([])

  expect(errors, errors.join(', ')).toHaveLength(0)
})

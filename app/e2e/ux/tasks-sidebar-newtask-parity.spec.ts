/**
 * UX sweep — flow 9 (Tasks board), round 22: the OTHER "New task" form.
 *
 * Flow 9 is the most-covered flow in the rotation (30+ specs). Every one of them
 * drives the BOARD's `+ New task` modal (`kanban-board.ts #openNewTaskForm`):
 * its source tabs (#442), its empty-required-field gate (#412), its preserved
 * draft (#561/#591/#830/#996), its Enter keys (#311/#1103), its inline connect
 * form (#709/#710), its import errors (#731), its double-click guard (#443).
 *
 * The app ships a SECOND New-task form for the same job — the thread sidebar's
 * checklist-icon popover (`thread-sidebar.ts #promptNewTask`). It is the one
 * with the most entry points: the sidebar toolbar button, the project ⋯ menu's
 * "New task", and the command palette's "New task" command (`flow:new-task`).
 * No spec had ever driven it except in passing (`threads-task-create-under-
 * search.spec.ts` types a title and clicks Create to prove #1121's reveal).
 *
 * Driving it against the board's own fixed behaviour found the two fixes that
 * never crossed over:
 *
 *  1. **#1343 — empty required field = silent dead click.** `submit()` is
 *     `if (!title) return` / `if (!value) return` — the "Create task" and
 *     "Import" buttons stay fully enabled, carry no hint, and swallow the
 *     click: no task, no toast, no inline error, the form just sits there.
 *     That is verbatim #412, fixed on the board (Create disabled + "Enter a
 *     task title") and #709, fixed on the inline connect form.
 *
 *  2. **#1344 — any dismiss destroys what was typed.** `#mountMenu`'s outside-mousedown
 *     handler calls `#closeMenu()`, which removes the popup; nothing snapshots
 *     the fields, and reopening renders empty inputs. The board's modal keeps a
 *     per-project draft for exactly this (#561, "Closing the new ticket dialog
 *     does not save a draft"), restores it on reopen, and clears it only on a
 *     successful create.
 *
 * Live guards (pass today) pin the board's fixed behaviour as the parity anchor
 * plus the sidebar form's working happy path; the `test.fixme` tripwires state
 * the expected UX of the two gaps and are verified RED against current `main`.
 *
 * Credential-free: `tasks.create` is immediate IPC, no agent turn.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, dismissFlowOverlay } from './fixtures/seed'
import { openProjectActions } from './fixtures/project-actions'
import { basename } from 'node:path'
import type { Page } from '@playwright/test'

const SCREENS = 'e2e/ux/__screens'

function sidebarPopover(win: Page) {
  return win.locator('.fl-thread-menu')
}
function boardModal(win: Page) {
  return win.locator('.fl-board-modal')
}

/** Every task the store holds for a project — the truth behind the paint. */
async function taskTitles(win: Page, projectRoot: string): Promise<string[]> {
  return win.evaluate(async (root) => {
    const api = (
      window as unknown as {
        flow: { tasks: { list(i: { projectRoot: string }): Promise<Array<{ title: string }>> } }
      }
    ).flow
    const tasks = await api.tasks.list({ projectRoot: root })
    return tasks.map((t) => t.title)
  }, projectRoot)
}

async function seedAndActivate(win: Page): Promise<string> {
  const dir = await seedProject(win)
  await activateProject(win, dir)
  await dismissFlowOverlay(win)
  return dir
}

/**
 * Open the sidebar's New-task popover.
 *
 * VIA THE PROJECT'S OWN ACTIONS, not a toolbar button: the ⋯ on its row in the
 * Workspace switcher opens the project menu and "New task" is on it, so the
 * route this parity guard walks is the route a person walks.
 */
async function openSidebarNewTask(win: Page, dir: string): Promise<void> {
  await openProjectActions(win, basename(dir))
  await sidebarPopover(win).locator('.fl-thread-menu-item', { hasText: /^New task$/ }).click()
  await expect(sidebarPopover(win).locator('input.fl-thread-menu-input').first()).toBeVisible({
    timeout: 5000,
  })
}

/** Open the board tab, then its own "+ New task" modal. */
async function openBoardNewTask(win: Page): Promise<void> {
  await win.evaluate(() => document.dispatchEvent(new CustomEvent('flow:open-board')))
  await expect(win.locator('.fl-board')).toBeVisible({ timeout: 8000 })
  await win.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(boardModal(win)).toBeVisible({ timeout: 5000 })
}

test.afterAll(() => cleanupSeeds())

// ── Live guards ─────────────────────────────────────────────────────────────

// The sidebar's New-task popover, opened from the project's actions menu (the
// Workspace switcher's project row → `flow:project-menu`).
test('sidebar New-task popover creates the task it was given (happy path)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  const dir = await seedAndActivate(window)

  await openSidebarNewTask(window, dir)
  await sidebarPopover(window).locator('input.fl-thread-menu-input').first().fill('wire the export job')
  await sidebarPopover(window)
    .locator('.fl-thread-menu-item', { hasText: /^Create task$/ })
    .click()

  await expect
    .poll(() => taskTitles(window, dir), { timeout: 10000 })
    .toContain('wire the export job')
  // A successful create closes the popup — the form is not left hanging.
  await expect(sidebarPopover(window)).toHaveCount(0, { timeout: 5000 })

  expect(errors, errors.join(', ')).toEqual([])
})

test('the BOARD modal refuses an empty title out loud (#412 — the parity anchor)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  const dir = await seedAndActivate(window)

  await openBoardNewTask(window)
  const create = boardModal(window).locator('.fl-board-new', { hasText: 'Create task' })
  // Inert, and it SAYS why — the fix #412 shipped for this exact form.
  await expect(create).toBeDisabled()
  await expect(create).toHaveAttribute('title', /Enter a task title/i)
  await expect.poll(() => taskTitles(window, dir), { timeout: 5000 }).toEqual([])

  expect(errors, errors.join(', ')).toEqual([])
})

test('the BOARD modal restores a dismissed draft (#561 — the parity anchor)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  await seedAndActivate(window)

  await openBoardNewTask(window)
  await boardModal(window).locator('input[placeholder="Task title"]').fill('half-written idea')
  await window.keyboard.press('Escape')
  await expect(boardModal(window)).toHaveCount(0, { timeout: 5000 })

  // The board's New-task control lives on Todo's column head now, not on a
  // toolbar — `.fl-board-new` is the primary-button class the modals share.
  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(boardModal(window)).toBeVisible({ timeout: 5000 })
  await expect(boardModal(window).locator('input[placeholder="Task title"]')).toHaveValue(
    'half-written idea',
  )

  expect(errors, errors.join(', ')).toEqual([])
})

// ── Tripwires (expected UX; RED on current main) ────────────────────────────

test.fixme(
  '#1343 — sidebar New-task popover: an empty title must not be a silent dead click (#412 parity)',
  async ({ window }) => {
    const dir = await seedAndActivate(window)

    await openSidebarNewTask(window, dir)
    const create = sidebarPopover(window).locator('.fl-thread-menu-item', {
      hasText: /^Create task$/,
    })
    await window.screenshot({ path: `${SCREENS}/tasks-sidebar-newtask-empty-dead.png` })
    // The board's form greys the button and names the missing field. This one is
    // fully enabled and hint-less (measured: disabled=false, title=null,
    // opacity 1, cursor pointer), so the click is swallowed with no way to learn
    // what is missing.
    await expect(create).toBeDisabled()
    await expect(create).toHaveAttribute('title', /Enter a task title/i)

    // Whatever the gate becomes, the click must never create a phantom task.
    await create.click({ force: true })
    expect(await taskTitles(window, dir)).toEqual([])

    // Same contract on the import tabs (#709's shape).
    await sidebarPopover(window).locator('button', { hasText: /^Jira$/ }).click()
    await expect(
      sidebarPopover(window).locator('.fl-thread-menu-item', { hasText: /^Import$/ }),
    ).toBeDisabled()
  },
)

test.fixme(
  '#1344 — sidebar New-task popover: a dismissed draft must survive a reopen (#561 parity)',
  async ({ window }) => {
    const dir = await seedAndActivate(window)

    await openSidebarNewTask(window, dir)
    await sidebarPopover(window)
      .locator('input.fl-thread-menu-input')
      .first()
      .fill('rework the billing retry')
    await sidebarPopover(window).locator('textarea.fl-thread-menu-input').fill('lots of context')
    // An outside click is the accidental dismiss this popup is most exposed to
    // — it closes on any mousedown outside itself.
    await window.locator('.fl-titlebar').click({ position: { x: 300, y: 8 } })
    await expect(sidebarPopover(window)).toHaveCount(0, { timeout: 5000 })

    await openSidebarNewTask(window, dir)
    await window.screenshot({ path: `${SCREENS}/tasks-sidebar-newtask-draft-lost.png` })
    await expect(sidebarPopover(window).locator('input.fl-thread-menu-input').first()).toHaveValue(
      'rework the billing retry',
    )
    await expect(sidebarPopover(window).locator('textarea.fl-thread-menu-input')).toHaveValue(
      'lots of context',
    )
  },
)

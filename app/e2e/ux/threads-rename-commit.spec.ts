import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 2: Threads, the inline Rename commit affordance (#719).
 *
 * The ⋯ / right-click → Rename action swaps the row for a bare inline text field
 * whose ONLY commit path is the Enter key — no Save button, no "⏎ to save" hint.
 * Clicking away (the near-universal rename-on-blur gesture: Finder, VS Code, the
 * file tree) silently tears the field down and DISCARDS the typed name with zero
 * feedback. Its sibling menu affordances (Delete confirm, the pickers) all expose
 * explicit buttons, so rename is the odd one out with an undiscoverable commit.
 *
 * Live guards below encode the CORRECT, stable behavior (Enter commits; Escape
 * discards; the Delete confirm exposes explicit Cancel + Delete buttons while the
 * rename field exposes none) and pass on current `main`. The `test.fixme` tripwire
 * encodes the #719 defect — click-away should commit (rename-on-blur) — and flips
 * green when the fix lands.
 *
 * All actions run credential-free: threads.create / threads.update are immediate IPC.
 */

const SCREENS = 'e2e/ux/__screens'

function threadRow(win: Page, title: string) {
  return win.locator('fl-list').getByText(title, { exact: true })
}
async function openRowMenu(win: Page, title: string) {
  await threadRow(win, title).first().click({ button: 'right' })
  const menu = win.locator('.fl-thread-menu')
  await expect(menu).toBeVisible()
  return menu
}
async function threadTitles(win: Page, root: string): Promise<string[]> {
  return win.evaluate(async (r) => {
    const api = (window as unknown as {
      flow: { threads: { list(x: { projectRoot: string }): Promise<Array<{ title: string }>> } }
    }).flow
    return (await api.threads.list({ projectRoot: r })).map((t) => t.title)
  }, root)
}


/**
 * Make an EMPTY thread called "New thread" in the active project and open it —
 * what the toolbar "+" used to do. Since 2026-09-04 "+" opens the new-thread
 * PAGE, whose Create sends a first message; this spec is about the thread list,
 * not about starting a conversation, so the thread is made over the same IPC
 * the page ends in and opened by its row.
 */
async function newThread(win: Page): Promise<void> {
  await win.evaluate(async () => {
    const flow = (
      window as unknown as {
        flow: {
          project: { active(): Promise<{ rootPath: string } | null> }
          threads: { create(i: { projectRoot: string; title: string }): Promise<unknown> }
        }
      }
    ).flow
    const active = await flow.project.active()
    if (active === null) throw new Error('newThread: no active project')
    await flow.threads.create({ projectRoot: active.rootPath, title: 'New thread' })
  })
  await openThreadByTitle(win, 'New thread')
}

test.afterAll(() => cleanupSeeds())

test('rename: Enter commits, Escape discards (the two wired paths)', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })

  // Escape discards: title unchanged.
  let menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  let input = window.locator('.fl-thread-menu-input')
  // The field takes focus on the task after the Rename click — what a person
  // types into. Typing before that lands skips the focus the blur-commit
  // (#719) is armed by, so wait for it rather than race it.
  await expect(input).toBeFocused()
  await input.fill('DISCARDED_BY_ESC')
  await input.press('Escape')
  await window.waitForTimeout(300)
  expect(await threadTitles(window, dir)).toEqual(['New thread'])

  // Enter commits: title changes and persists.
  menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  input = window.locator('.fl-thread-menu-input')
  await expect(input).toBeFocused()
  await input.fill('COMMITTED_BY_ENTER')
  await input.press('Enter')
  await expect(threadRow(window, 'COMMITTED_BY_ENTER').first()).toBeVisible({ timeout: 5000 })
  expect(await threadTitles(window, dir)).toContain('COMMITTED_BY_ENTER')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('affordance contrast: Delete confirm has explicit buttons; Rename field has no Save', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })

  // The Delete confirmation exposes an explicit Cancel + Delete — no ambiguity.
  let menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item.danger', { hasText: 'Delete' }).first().click()
  await expect(window.locator('.fl-thread-menu-confirm')).toHaveText('Delete this thread?')
  const confirmBtns = await window
    .locator('.fl-thread-menu-actions .fl-thread-menu-item')
    .allInnerTexts()
  expect(confirmBtns).toEqual(expect.arrayContaining(['Cancel', 'Delete']))
  await window.keyboard.press('Escape') // dismiss without deleting

  // The Rename field, by contrast, is a lone input with NO button of any kind.
  menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  const input = window.locator('.fl-thread-menu-input')
  await expect(input).toBeFocused()
  await expect(input).toBeVisible()
  // No Save/commit button lives beside the rename input.
  await expect(window.locator('.fl-thread-menu button')).toHaveCount(0)
  await window.screenshot({ path: `${SCREENS}/threads-rename-no-commit-affordance.png` })
  await input.press('Escape')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * Guard for #719 (fixed): after typing a new name, clicking away (the
 * rename-on-blur gesture) COMMITS the rename — the input's blur now commits,
 * one-shot-guarded so Enter/Escape teardown doesn't double-fire.
 */
test('rename: clicking away commits the typed name (rename-on-blur) — #719', async ({
  window,
}) => {
  const dir = await seedProject(window)
  await activateProject(window, dir)
  await newThread(window)
  await expect(threadRow(window, 'New thread').first()).toBeVisible({ timeout: 10000 })

  const menu = await openRowMenu(window, 'New thread')
  await menu.locator('.fl-thread-menu-item', { hasText: 'Rename' }).click()
  const input = window.locator('.fl-thread-menu-input')
  await expect(input).toBeFocused()
  await input.fill('RENAMED_ON_BLUR')

  // Click away — the natural "I'm done, save it" gesture (no Enter).
  await window.locator('.fl-thread-list').click({ position: { x: 5, y: 5 } })
  await window.waitForTimeout(600)

  // The rename must have committed.
  await expect(threadRow(window, 'RENAMED_ON_BLUR').first()).toBeVisible({ timeout: 5000 })
  expect(await threadTitles(window, dir)).toContain('RENAMED_ON_BLUR')
  expect(await threadTitles(window, dir)).not.toContain('New thread')
})

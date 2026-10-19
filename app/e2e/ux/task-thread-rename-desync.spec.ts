import { test as flowTest, expect, type Page } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — flow `tasks` (rotation index 9, round 24): the ONE NAME a task and
 * its 1:1 chat share, and the single route that splits it in two.
 *
 * Flow 9 is the app's most-covered flow (40+ committed specs). They drive
 * creation (board modal + sidebar popover), movement (drag, lane menu, Status
 * row), the detail modal, imports, archive and delete. The task↔thread COUPLING
 * has been swept twice — `task-rename-syncs-thread` (task ⋯ Rename → the chat
 * follows) and `task-thread-delete-orphan` (#1061, deleting a task's chat from
 * the sidebar). Nobody ever renamed a task's chat from the THREAD side.
 *
 * The precondition is #1061's own observation, still true: searching drops the
 * sidebar's task layer, so a task's chat "appears as an ordinary row" with the
 * ordinary thread menu — Pin · Rename · Add folder to context… · Archive ·
 * Delete. #1061 taught DELETE about the task it belongs to (the confirm now
 * names it). Rename was left alone, and it is the one item that writes a field
 * BOTH stores hold:
 *
 *   ipc/index.ts:380  tasks:update  { title } → threadStore.updateThread(title)   ← syncs
 *   ipc/index.ts:296  threads:update{ title } → thread only                       ← does not
 *
 * Measured on this build (Playwright, seeded project, no account needed):
 *   · task "Alpha widget" → search "Alpha" → the flattened row's ⋯ → Rename →
 *     "Ticket 42 rewrite auth".
 *   · The write lands on the thread. The TASK keeps "Alpha widget" — and the
 *     task title is what the board card, the detail modal and the un-searched
 *     sidebar row all render.
 *   · #977 then clears the now-non-matching filter, so the row snaps straight
 *     back to "Alpha widget": the name the user just typed is on screen nowhere.
 *     The rename reads as a no-op that silently succeeded.
 *   · Search is now self-contradicting. Typing the name the row DISPLAYS
 *     ("Alpha widget") returns `No threads match “Alpha widget”`; typing the
 *     invisible one ("Ticket 42") is the only way to find the chat again.
 *
 * Filed as #1447. Fix-agnostic: the guards assert the two names agree and that
 * the chat is findable by its displayed name — never which store wins.
 *
 * Layout note: the guards read the board card and the detail modal (task-side
 * names) and the sidebar row (task title when idle, thread title while
 * searching) — that split is exactly the symptom.
 */

const test_ = flowTest
test_.afterAll(() => cleanupSeeds())

/** Seed a project, create `titles` as manual tasks, open the Tasks board. */
async function boardWith(window: Page, titles: string[]): Promise<string> {
  const root = await seedProject(window, 'flow-task-rename-')
  await activateProject(window, root)
  for (const title of titles) {
    await window.evaluate(
      async ([p, t]) =>
        await (
          window as unknown as {
            flow: { tasks: { create(r: { projectRoot: string; title: string }): Promise<unknown> } }
          }
        ).flow.tasks.create({ projectRoot: p, title: t }),
      [root, title],
    )
  }
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  await expect(window.locator('.fl-board-card')).toHaveCount(titles.length)
  return root
}

const search = (window: Page): ReturnType<Page['locator']> =>
  window.locator('input[aria-label="Search threads"]')

/** The store's own view of the pair, read through the app's IPC bridge. */
async function storedNames(
  window: Page,
  root: string,
): Promise<{ taskTitles: string[]; threadTitles: string[] }> {
  return window.evaluate(async (projectRoot) => {
    const flow = (
      window as unknown as {
        flow: {
          tasks: { list(r: unknown): Promise<Array<{ title: string }>> }
          threads: { list(r?: unknown): Promise<Array<{ title: string }>> }
        }
      }
    ).flow
    const tasks = await flow.tasks.list({ projectRoot, includeArchived: false })
    const threads = await flow.threads.list({})
    return { taskTitles: tasks.map((t) => t.title), threadTitles: threads.map((t) => t.title) }
  }, root)
}

/**
 * A sidebar row's menu, opened the way a person opens it.
 *
 * THE ⋯ COLUMN IS GONE (`feat(ide): empty the status bar, retire the ⋯ column`)
 * and every row's actions moved to right-click. This file used the presence of
 * `[aria-label="Task actions"]` vs `[aria-label="Thread actions"]` for two
 * different jobs — opening a menu, and telling which KIND of row is drawn — so
 * both had to be re-expressed against something the sidebar still has: the
 * gesture is a right-click, and the kind is the lane glyph only a task row has.
 */
async function openRowMenu(window: Page, title: string): Promise<void> {
  await window.locator('fl-list').getByText(title, { exact: true }).first().click({ button: 'right' })
  await expect(window.locator('.fl-thread-menu')).toBeVisible()
}

/**
 * How many TASK rows the sidebar is drawing.
 *
 * READ OFF THE ROW, not off a menu. A task row carries a lane glyph titled
 * "Lane: <lane>" and a flattened thread row carries none, so this is a fact
 * about the list rather than the result of opening something. Polling by
 * opening menus raced the render the debounced search was still doing.
 */
const taskRows = (window: Page) => window.locator('fl-list [title^="Lane: "]')

/** Search for `query`, then open the menu of the flattened thread row. */
async function openFlattenedThreadMenu(window: Page, query: string): Promise<void> {
  await search(window).fill(query)
  // The sidebar search is debounced; the flattened row replaces the task row.
  await expect(taskRows(window)).toHaveCount(0)
  await openRowMenu(window, query === 'Alpha' ? 'Alpha widget' : query)
  await expect(window.locator('.fl-thread-menu-item', { hasText: 'Rename' })).toHaveCount(1)
}

/** Rename through whichever inline form is open. The two menus build their
 *  field differently — the thread's is labelled, the task's is an
 *  `.fl-thread-menu-input` identified by placeholder — so pass the selector. */
const RENAME_FIELD = {
  thread: '[aria-label="Thread name"]',
  task: 'input.fl-thread-menu-input[placeholder="Task name"]',
} as const

async function submitRename(
  window: Page,
  which: keyof typeof RENAME_FIELD,
  value: string,
): Promise<void> {
  const input = window.locator(RENAME_FIELD[which])
  await expect(input).toBeVisible()
  await input.fill(value)
  await window.keyboard.press('Enter')
}

// ── LIVE GUARD 1 ────────────────────────────────────────────────────────────
// The contract the bug breaks, driven from the side that honours it: renaming
// the TASK renames its chat too, so one object keeps one name across the board
// card, the detail modal, the sidebar row and the thread store. This is what
// makes the thread-side rename a defect rather than a design choice.
test_('a task rename reaches every surface AND the chat', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  const root = await boardWith(window, ['Alpha widget'])

  await openRowMenu(window, 'Alpha widget')
  await window.locator('.fl-thread-menu-item', { hasText: 'Rename' }).first().click()
  await submitRename(window, 'task', 'Alpha widget v2')

  // Board card + detail modal (task-side) …
  await expect(window.locator('.fl-board-card-title')).toHaveText('Alpha widget v2')
  await window.locator('.fl-board-card').first().click()
  await expect(window.locator('.fl-board-detail')).toBeVisible()
  await expect(window.locator('.fl-board-modal-title').first()).toHaveText('Alpha widget v2')
  await window.keyboard.press('Escape')
  await expect(window.locator('.fl-board-detail')).toHaveCount(0)

  // … and the thread store, which the task rename syncs (ipc/index.ts:380).
  await expect
    .poll(async () => (await storedNames(window, root)).threadTitles)
    .toEqual(['Alpha widget v2'])
  expect((await storedNames(window, root)).taskTitles).toEqual(['Alpha widget v2'])

  // Findable by the one name it now has, everywhere.
  // Search is debounced, so drive the same real transition tripwire B uses:
  // force "no matches", then type the displayed name and require it to clear.
  const emptyHint = window.locator('.fl-thread-empty')
  await search(window).fill('zzz-no-such-thread-zzz')
  await expect(emptyHint).toBeVisible()
  await search(window).fill('Alpha widget v2')
  await expect(emptyHint).toBeHidden()
  // A matched row, not just an absent hint (while a query is active the row is
  // the flattened thread row).
  await expect(taskRows(window)).toHaveCount(0)
  await search(window).fill('')

  expect(errors).toEqual([])
})

// ── LIVE GUARD 2 ────────────────────────────────────────────────────────────
// The precondition #1061 named, pinned so a future sidebar change can't quietly
// remove the reproduction path: while a query is active a task's chat IS an
// ordinary thread row, with the ordinary thread menu, and its Rename really
// does write — the thread store takes the new title. Nothing here is broken;
// it is the propagation the tripwires below cover.
test_('searching flattens a task chat into an ordinary thread row whose Rename writes', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  const root = await boardWith(window, ['Alpha widget'])

  // Idle: a TASK row — it carries a lane glyph, which a thread row never does.
  await expect(taskRows(window)).toHaveCount(1)

  // Searching: the task layer drops and the chat stands alone.
  await openFlattenedThreadMenu(window, 'Alpha')
  await expect(window.locator('.fl-thread-menu-item')).toContainText([
    'Pin',
    'Rename',
    'Add folder to context…',
    'Archive',
    'Delete',
  ])

  await window.locator('.fl-thread-menu-item', { hasText: 'Rename' }).first().click()
  await submitRename(window, 'thread', 'Ticket 42 rewrite auth')

  // The write lands — this half works.
  await expect
    .poll(async () => (await storedNames(window, root)).threadTitles)
    .toEqual(['Ticket 42 rewrite auth'])

  await search(window).fill('')
  expect(errors).toEqual([])
})

// ── TRIPWIRE A (#1447) ──────────────────────────────────────────────────────
// RED on this build: the task — and therefore the board card, the detail modal
// and the idle sidebar row — keeps the old name forever, so one object carries
// two names. Un-fixme when #1447 is fixed.
test_.fixme(
  'renaming a task chat renames the task: board card and detail modal follow (#1447)',
  async ({ window }) => {
    const root = await boardWith(window, ['Alpha widget'])

    await openFlattenedThreadMenu(window, 'Alpha')
    await window.locator('.fl-thread-menu-item', { hasText: 'Rename' }).first().click()
    await submitRename(window, 'thread', 'Ticket 42 rewrite auth')
    await expect
      .poll(async () => (await storedNames(window, root)).threadTitles)
      .toEqual(['Ticket 42 rewrite auth'])

    // One object, one name: whichever store a fix makes authoritative, these
    // two must agree.
    const stored = await storedNames(window, root)
    expect(stored.taskTitles).toEqual(stored.threadTitles)

    // And the surfaces the user actually looks at must show it.
    await search(window).fill('')
    await window.locator(statusButtonByText('Tasks')).click()
    await expect(window.locator('.fl-board-card-title')).toHaveText('Ticket 42 rewrite auth')
    await window.locator('.fl-board-card').first().click()
    await expect(window.locator('.fl-board-modal-title').first()).toHaveText(
      'Ticket 42 rewrite auth',
    )
  },
)

// ── TRIPWIRE B (#1447) ──────────────────────────────────────────────────────
// RED on this build: after the rename the sidebar row still reads "Alpha
// widget", but searching that exact string answers `No threads match “Alpha
// widget”`. The chat is findable only by a name displayed nowhere.
test_.fixme(
  'after renaming a task chat, the sidebar can still find it by the name it displays (#1447)',
  async ({ window }) => {
    await boardWith(window, ['Alpha widget'])

    await openFlattenedThreadMenu(window, 'Alpha')
    await window.locator('.fl-thread-menu-item', { hasText: 'Rename' }).first().click()
    await submitRename(window, 'thread', 'Ticket 42 rewrite auth')

    // #977 clears the non-matching filter, so we are back on the full list —
    // showing the row under whatever name it renders.
    await expect(search(window)).toHaveValue('')
    const sidebar = window.locator(sel.threadSidebar)
    await expect(taskRows(window)).toHaveCount(1)
    await expect(sidebar.getByText('Alpha widget').first()).toBeVisible()

    // Query the sidebar for the name it is DISPLAYING. Search is debounced, so
    // drive a real transition instead of sampling a possibly-stale list: force
    // the "no matches" state with a string nothing can match, then type the
    // displayed name and require the hint to go away.
    const emptyHint = window.locator('.fl-thread-empty')
    await search(window).fill('zzz-no-such-thread-zzz')
    await expect(emptyHint).toBeVisible()
    await search(window).fill('Alpha widget')
    await expect(emptyHint).toBeHidden()
    await search(window).fill('')
  },
)

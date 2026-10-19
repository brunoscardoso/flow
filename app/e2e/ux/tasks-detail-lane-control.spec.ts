import { test, expect, type Page } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — tasks board (flow 9), the TWO LANE AFFORDANCES #1153 added: the
 * detail modal's "Status" row and the card's right-click / Shift+F10 lane menu.
 *
 * Flow 9 is the most-covered flow in the suite (30+ specs: drag-persist,
 * lane-complete roundtrip, the New-task modal's fields/tabs/drafts, detail-modal
 * scroll #204, file links #961, briefs #1026, integrations #709/#710/#1152,
 * rail mount #664, no-project #622, task↔thread sync, the exit/entry routes
 * #1152, the drag-only a11y gap #1153, the background re-sort #1192, the silent
 * failed move #1193). Every one of them changes a lane by DRAGGING, or drives a
 * surface that existed before #1153. The two controls #1153 shipped as the
 * answer to "a mouse drag is the ONLY way to change a lane" had zero coverage.
 *
 * Two defects this pins down:
 *
 *  A. The Status row FREEZES at the lane the modal opened with (#1299). #204
 *     made `taskDetailSignature` skip the modal rebuild when the task's rendered
 *     content is unchanged, and it deliberately excludes `lane` ("they don't
 *     appear in the modal"). #1153 then made `lane` appear in the modal without
 *     updating the signature — so `rerender()` compares a digest that cannot see
 *     the field the new row renders. The move really happens (store + board
 *     counts follow), but the modal keeps marking the OLD lane as current: it
 *     reports the wrong status, the button clicked never settles, and the old
 *     lane stays `disabled` — so the one lane the task is not in is the one
 *     button that cannot be pressed.
 *
 *  B. The lane menu is mouse-only (#1300). `role="menu"`, first item focused,
 *     and then: arrows dead, Tab walks out to the titlebar controls BEHIND the
 *     still-open popup, Escape returns focus nowhere. The sibling thread-sidebar
 *     row menu — same "Move to Todo/Doing/Done" items, same task — got exactly
 *     this chrome in #1173 (`#mountMenu`: `focusItem`, Arrow keys, Tab
 *     containment, `anchor.focus()` on Escape).
 *
 * Account-independent: tasks are created over `tasks:create`, moves go through
 * the real `tasks:update` IPC, no agent. The live guards hold before AND after a
 * fix — they are the controls that keep the two `fixme` tripwires from passing
 * vacuously on a board where the affordances are simply broken/absent.
 */

test.afterAll(() => {
  // Best-effort: the app provisions `.claude/` + the `flow` symlink into a fresh
  // root, so the rm can race those writes (ENOTEMPTY).
  try {
    cleanupSeeds()
  } catch {
    /* temp dirs are OS-cleaned */
  }
})

const TITLE = 'Rotate the API keys'

/** Seed a project with one manual task and open the board on it. */
async function openBoardWithTask(win: Page): Promise<string> {
  const root = await seedProject(win)
  await activateProject(win, root)
  await win.evaluate(async (r) => {
    await (
      window as unknown as {
        flow: { tasks: { create(a: { projectRoot: string; title: string }): Promise<unknown> } }
      }
    ).flow.tasks.create({ projectRoot: r, title: 'Rotate the API keys' })
  }, root)
  await win.locator(statusButtonByText('Tasks')).click()
  await expect(win.locator(sel.board)).toBeVisible()
  await expect(win.locator('.fl-board-card', { hasText: TITLE })).toBeVisible()
  return root
}

/** The task's lane as the STORE has it — the write, not the optimistic paint. */
async function storeLane(win: Page, root: string): Promise<string> {
  return win.evaluate(async (p) => {
    const list = await (
      window as unknown as {
        flow: {
          tasks: {
            list(a: { projectRoot: string; includeArchived: boolean }): Promise<
              { id: string; lane: string }[]
            >
          }
        }
      }
    ).flow.tasks.list({ projectRoot: p, includeArchived: false })
    return list[0]?.lane ?? 'NONE'
  }, root)
}

/** The lane the Status row CLAIMS is current ("Todo" | "Doing" | "Done"). */
async function claimedLane(win: Page): Promise<string> {
  return win
    .locator('.fl-board-detail-lane .fl-board-lane-btn')
    .evaluateAll(
      (els) =>
        els.find((e) => e.classList.contains('current'))?.textContent?.trim() ?? 'NONE-MARKED',
    )
}

test('the detail modal Status row moves the task, and reports the lane it moved it to', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const root = await openBoardWithTask(window)
  await window.locator('.fl-board-card', { hasText: TITLE }).click()
  const modal = window.locator('.fl-board-detail')
  await expect(modal).toBeVisible()

  const laneRow = modal.locator('.fl-board-detail-lane')
  await expect(laneRow.locator('.fl-board-lane-btn')).toHaveText(['Todo', 'Doing', 'Blocked', 'Review', 'Done'])
  expect(await claimedLane(window)).toBe('Todo') // opened on a Todo task

  // ── LIVE GUARD: the row's control really reaches main and really moves the
  // task. Without this, the tripwire below would pass on a modal whose buttons
  // do nothing at all.
  await laneRow.locator('.fl-board-lane-btn', { hasText: 'Done' }).click()
  await expect
    .poll(() => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents(), { timeout: 8000 })
    .toEqual(['0', '0', '0', '0', '1'])
  await expect
    .poll(() => storeLane(window, root), { timeout: 8000 })
    .toBe('done')

  // ── LIVE GUARD: the row CAN render every lane as current — reopening the
  // modal shows Done marked. So a stale readout is staleness, not an unrendered
  // state.
  await window.keyboard.press('Escape')
  await expect(modal).toBeHidden()
  await window.locator('.fl-board-card', { hasText: TITLE }).click()
  await expect(modal).toBeVisible()
  expect(await claimedLane(window)).toBe('Done')

  expect(errors).toEqual([])
})

// FIXED (#1299): `taskDetailSignature` excluded `lane` — correctly, until
// #1153 made the modal RENDER the lane and didn't tell it. The signature now
// names every field the modal renders, so a lane move (foreground or
// background) rebuilds the row.
test(
  'the Status row reports the lane the task is actually in, right after moving it',
  async ({ window }) => {
    const root = await openBoardWithTask(window)
    await window.locator('.fl-board-card', { hasText: TITLE }).click()
    const modal = window.locator('.fl-board-detail')
    await expect(modal).toBeVisible()
    const laneRow = modal.locator('.fl-board-detail-lane')

    await laneRow.locator('.fl-board-lane-btn', { hasText: 'Doing' }).click()
    await expect
      .poll(() => storeLane(window, root), { timeout: 8000 })
      .toBe('doing')

    // The readout follows the move it just performed.
    await expect
      .poll(() => claimedLane(window), { timeout: 5000 })
      .toBe('Doing')

    // …and the enabled/disabled split follows with it: the lane the task is in
    // is the no-op, every other lane is a live route. Right now `Todo` stays
    // disabled, so the way back is the one button that cannot be pressed.
    const disabled = await laneRow
      .locator('.fl-board-lane-btn')
      .evaluateAll((els) =>
        els.filter((e) => (e as HTMLButtonElement).disabled).map((e) => e.textContent?.trim()),
      )
    expect(disabled).toEqual(['Doing'])

    // A BACKGROUND move (what every agent turn does via makeOnTurnStart) is
    // equally visible — the modal is not a snapshot of when it opened.
    await window.evaluate(async (p) => {
      const w = window as unknown as {
        flow: {
          tasks: {
            list(a: { projectRoot: string; includeArchived: boolean }): Promise<{ id: string }[]>
            update(a: { taskId: string; patch: { lane: string } }): Promise<unknown>
          }
        }
      }
      const list = await w.flow.tasks.list({ projectRoot: p, includeArchived: false })
      await w.flow.tasks.update({ taskId: list[0].id, patch: { lane: 'done' } })
    }, root)
    await expect
      .poll(() => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents(), { timeout: 8000 })
      .toEqual(['0', '0', '0', '0', '1'])
    await expect
      .poll(() => claimedLane(window), { timeout: 5000 })
      .toBe('Done')
  },
)

test('the card lane menu opens by right-click and by keyboard, with the current lane marked', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  await openBoardWithTask(window)
  const card = window.locator('.fl-board-card', { hasText: TITLE })
  const menu = window.locator('.fl-board-menu')

  // ── LIVE GUARD: right-click opens the menu, all five lanes by name, the
  // current one marked + disabled (#1153's vocabulary, copied from the sidebar).
  await card.click({ button: 'right' })
  await expect(menu).toBeVisible()
  // THE LANES COME FIRST, and the menu has grown two lifecycle items after
  // them. Asserting the whole list as four entries was really asserting that
  // nothing else may ever be on this menu — which was never the rule, and made
  // Archive's arrival look like the lane control breaking.
  await expect(menu.locator('.fl-board-menu-item').filter({ hasText: /Move to / })).toHaveText([
    '● Move to Todo',
    'Move to Doing',
    'Move to Blocked',
    'Move to Review',
    'Move to Done',
  ])
  await expect(menu.locator('.fl-board-menu-item', { hasText: 'Archive' })).toHaveCount(1)
  await expect(menu.locator('.fl-board-menu-item.danger')).toHaveCount(1)
  await expect(menu.locator('.fl-board-menu-item').first()).toBeDisabled()
  await window.keyboard.press('Escape')
  await expect(menu).toBeHidden()

  // ── LIVE GUARD: the KEYBOARD route exists and acts — Shift+F10 on a focused
  // card opens the menu, and Enter on the focused item really moves the task.
  // Without this the keyboard tripwire below could pass on a menu that never
  // opens by keyboard at all.
  await card.focus()
  expect(await window.evaluate(() => document.activeElement?.className)).toContain('fl-board-card')
  await window.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  expect(
    await window.evaluate(() => !!document.activeElement?.closest('.fl-board-menu')),
  ).toBe(true)
  await window.keyboard.press('Enter')
  await expect
    .poll(() => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents(), { timeout: 8000 })
    .toEqual(['0', '1', '0', '0', '0'])

  expect(errors).toEqual([])
})

// FIXED (#1300): the lane menu now goes through the same keyboard path #1173
// gave the sidebar's row menu — arrows, contained Tab, and an Escape that
// returns focus to the card — instead of a third hand-rolled popup.
test('the lane menu is keyboard-navigable and does not leak Tab behind itself', async ({
  window,
}) => {
  await openBoardWithTask(window)
  const card = window.locator('.fl-board-card', { hasText: TITLE })
  const menu = window.locator('.fl-board-menu')

  const focusedItem = async (): Promise<string> =>
    window.evaluate(() => document.activeElement?.textContent?.trim() ?? 'NONE')
  const focusInsideMenu = async (): Promise<boolean> =>
    window.evaluate(() => !!document.activeElement?.closest('.fl-board-menu'))

  await card.focus()
  await window.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  const first = await focusedItem()

  // Arrows move through the items — the sibling row menu's contract (#1173).
  await window.keyboard.press('ArrowDown')
  expect(await focusedItem()).not.toBe(first)
  await window.keyboard.press('ArrowUp')
  expect(await focusedItem()).toBe(first)

  // Tab is contained while the popup is on screen: it must never focus the
  // shell controls the menu is covering.
  for (let i = 0; i < 4; i += 1) {
    await window.keyboard.press('Tab')
    expect(await focusInsideMenu()).toBe(true)
  }

  // Escape puts the user back where they were, not on <body>.
  await window.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  expect(await window.evaluate(() => document.activeElement?.className)).toContain('fl-board-card')
})

// The lane menu used to hold the card it was opened from as a NODE. Anything
// that re-rendered the board while the menu was open — another task written,
// a lane moved elsewhere — replaced that node, and Escape found it detached
// and focused nothing: the keyboard user was dropped on <body>. Seen in a
// full shard, where an earlier spec's writes landed mid-menu.
test('Escape returns focus to the card even when the board re-rendered under the menu', async ({
  window,
}) => {
  const root = await openBoardWithTask(window)
  const card = window.locator('.fl-board-card', { hasText: TITLE })
  const menu = window.locator('.fl-board-menu')

  await card.focus()
  await window.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  const before = await card.elementHandle()

  // A second task written while the menu is open re-renders every card.
  await window.evaluate(async (r) => {
    await (
      window as unknown as {
        flow: { tasks: { create(a: { projectRoot: string; title: string }): Promise<unknown> } }
      }
    ).flow.tasks.create({ projectRoot: r, title: 'Renew the certificates' })
  }, root)
  await expect(window.locator('.fl-board-card', { hasText: 'Renew the certificates' })).toBeVisible()
  // The positive first (#28): the card the menu was opened from IS gone.
  expect(await before?.evaluate((node) => node.isConnected)).toBe(false)
  await expect(menu).toBeVisible()

  await window.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  expect(
    await window.evaluate(() => document.activeElement?.closest('.fl-board-card')?.textContent ?? 'NONE'),
  ).toContain(TITLE)
})

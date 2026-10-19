import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { ElectronApplication, Page } from '@playwright/test'

/**
 * UX sweep — flow 9: the tasks board's CARD POSITION and the honesty of a lane
 * move (round 20).
 *
 * Flow 9 is the most-covered flow in the rotation (30+ specs: drag persistence,
 * lane round trips, the New-task modal's fields/tabs/drafts/Enter key, the
 * detail modal's scroll/file-links/brief lifecycle, integrations, the rail
 * mount, the no-project empty state, task↔thread sync). Every one of them
 * drives a control the user operates. None drives what the board does to
 * itself while the user is looking at it.
 *
 * Two things it does, found by driving it:
 *
 *  1. **Card position is a function of `updatedAt`, and everything bumps it.**
 *     `#render()` sorts each lane `b.updatedAt.localeCompare(a.updatedAt)` and
 *     `TaskStore.updateTask` stamps `updatedAt = now` on EVERY patch — including
 *     the app's own background automation (`makeOnTurnStart` → `lane: 'doing'`,
 *     `makeOnTurnComplete` → `suggestDone: true`, task-service.ts:237/250). So an
 *     agent finishing a turn in a background thread yanks that task to the top of
 *     its lane and shifts every card below it down one row, under the user's
 *     cursor. Position therefore carries no stable identity — and the cards hold
 *     a one-click WRITE (the "Done?" chip, #1102), so a click already committed
 *     to can land on a different task and mark the wrong one Done (#1192).
 *
 *     This is the accepted-and-fixed #164 defect on an unfixed twin surface:
 *     `ThreadStore.updateThread` grew a metadata-only carve-out ("Only real
 *     activity … bumps it", thread-store.ts:412) so a metadata toggle stops
 *     reordering the sidebar. `TaskStore.updateTask` never got one — while
 *     `setBriefStatus`, ten lines below it in the SAME file, already documents
 *     the hazard: "Does not bump updated_at so it never reorders the board."
 *
 *  2. **A lane move that fails to persist is silent** (#1193). The optimistic
 *     paint is correctly rolled back — but with no toast, no inline message, no
 *     console-visible user feedback of any kind, so the card simply jumps back
 *     and the user reads it as a missed drop target. Its sibling read failure
 *     (`tasks:list`) raises "Could not load tasks" (#205).
 *
 * Live guards (the healthy behaviour these lock):
 *   1. with nothing changing underneath, a click at a card's screen position
 *      opens THAT card's detail modal — the control that makes tripwire A
 *      non-vacuous (position→identity holds when the board is quiet);
 *   2. a lane move whose write fails is rolled back on screen — the board never
 *      keeps showing a lane the store does not hold (the correct half of #1193).
 *
 * The `test.fixme` blocks are fix-agnostic tripwires: they assert the user-facing
 * outcome (the card you aimed at is the one that acts; a failed move says so),
 * not any particular sort key or notification API.
 *
 * Account-independent: `tasks:create` / `tasks:update` are the same store calls
 * the agent hooks make, so no credentials or live turn is needed.
 */

const SCREENS = 'e2e/ux/__screens'

type Bridge = {
  flow: {
    tasks: {
      list(r: { projectRoot: string; includeArchived: boolean }): Promise<
        Array<{ id: string; title: string; lane: string; suggestDone: boolean }>
      >
      create(r: { projectRoot: string; title: string }): Promise<{ id: string }>
      update(r: { taskId: string; patch: Record<string, unknown> }): Promise<unknown>
    }
  }
}

const lane = (win: Page, n: number) => win.locator('.fl-board-column:not(.fl-board-remote) .fl-board-cards').nth(n)
const laneTitles = (win: Page, n: number) => lane(win, n).locator('.fl-board-card-title')

/** How long a debounced `tasks:updated` → `refresh()` → re-render is given. */
const RESORT_WINDOW = 1_500

test.afterAll(() => cleanupSeeds())

async function openBoard(window: Page, prefix: string): Promise<string> {
  const root = await seedProject(window, prefix)
  await activateProject(window, root)
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  return root
}

/** Create tasks oldest→newest in the given lane (a 25ms gap keeps `updatedAt` distinct). */
async function seedLane(
  window: Page,
  root: string,
  titles: string[],
  target: 'todo' | 'doing',
): Promise<Record<string, string>> {
  return window.evaluate(
    async ({ projectRoot, list, target }) => {
      const api = (window as unknown as Bridge).flow
      const out: Record<string, string> = {}
      for (const title of list) {
        const created = await api.tasks.create({ projectRoot, title })
        out[title] = created.id
        if (target !== 'todo') await api.tasks.update({ taskId: created.id, patch: { lane: target } })
        await new Promise((r) => setTimeout(r, 25))
      }
      return out
    },
    { projectRoot: root, list: titles, target },
  )
}

/** The exact patch `makeOnTurnComplete` applies when a background turn ends cleanly. */
async function backgroundTurnCompleted(window: Page, taskId: string): Promise<void> {
  await window.evaluate(
    async (id) =>
      void (await (window as unknown as Bridge).flow.tasks.update({
        taskId: id,
        patch: { suggestDone: true },
      })),
    taskId,
  )
}

async function storeLanes(window: Page, root: string): Promise<Record<string, string>> {
  return window.evaluate(async (projectRoot) => {
    const tasks = await (window as unknown as Bridge).flow.tasks.list({
      projectRoot,
      includeArchived: false,
    })
    return Object.fromEntries(tasks.map((t) => [t.title, t.lane]))
  }, root)
}

/** Drive the native HTML5 drag a card→lane move goes through. */
async function dragToLane(window: Page, cardText: string, laneIndex: number): Promise<void> {
  await window.evaluate(
    ({ cardText, laneIndex }) => {
      const card = [...document.querySelectorAll('.fl-board-card')].find((c) =>
        c.textContent?.includes(cardText),
      ) as HTMLElement | undefined
      const target = document.querySelectorAll('.fl-board-column:not(.fl-board-remote) .fl-board-cards')[laneIndex] as HTMLElement
      if (!card || !target) throw new Error(`no card "${cardText}" or lane ${laneIndex}`)
      const dataTransfer = new DataTransfer()
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer }))
      card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
    },
    { cardText, laneIndex },
  )
}

/** Make the REAL `tasks:update` handler reject — a locked DB / main-process fault. */
async function breakTaskUpdate(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('tasks:update')
    ipcMain.handle('tasks:update', () => {
      throw new Error('database is locked')
    })
  })
}

// ── Live guard 1 — position→identity holds while the board is quiet ─────────

test('a click at a card position opens THAT card while nothing changes underneath', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await openBoard(window, 'flow-ux-boardquiet-')
  await seedLane(window, root, ['Older task', 'Middle task', 'Newest task'], 'todo')
  await expect.poll(async () => laneTitles(window, 0).count()).toBe(3)

  // Aim at the middle card and remember its screen point.
  const middle = lane(window, 0).locator('.fl-board-card').nth(1)
  const aimedAt = await middle.locator('.fl-board-card-title').textContent()
  const box = await middle.boundingBox()
  expect(box, 'the middle card must be on screen').not.toBeNull()

  // Nothing happens in the background; the aim stays true.
  await window.waitForTimeout(RESORT_WINDOW)
  await window.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)

  const modal = window.locator('.fl-board-detail')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.fl-board-modal-title')).toHaveText(aimedAt ?? '')
  expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([])
})

// ── Live guard 2 — a failed move is rolled back, never left painted ─────────

test('a lane move whose write fails is rolled back — the board never shows an unpersisted lane', async ({
  app,
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await openBoard(window, 'flow-ux-boardfail-')
  await seedLane(window, root, ['Cannot be moved'], 'todo')
  await expect(window.locator('.fl-board-card', { hasText: 'Cannot be moved' })).toBeVisible()

  await breakTaskUpdate(app)
  await dragToLane(window, 'Cannot be moved', 1)

  // The optimistic paint must not survive the rejected write.
  await expect
    .poll(async () => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents(), { timeout: 8_000 })
    .toEqual(['1', '0', '0', '0', '0'])
  await expect(lane(window, 1).locator('.fl-board-card')).toHaveCount(0)
  expect(await storeLanes(window, root)).toEqual({ 'Cannot be moved': 'todo' })
  // The whole window, so the absence of any failure notice is part of the record.
  await window.screenshot({ path: `${SCREENS}/tasks-board-move-failed-silent.png` })
  expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([])
})

// ── Tripwire A (#1192) — a background turn must not move cards under the user ─

test(
  'a background turn completing on another task does not reorder the lane, so a committed click still hits the task it was aimed at',
  async ({ window }) => {
    const root = await openBoard(window, 'flow-ux-boardshift-')
    const ids = await seedLane(
      window,
      root,
      ['Delete the prod bucket', 'Rename a label', 'Bump a version'],
      'doing',
    )

    // Two background threads already finished cleanly: oldest + newest carry the
    // one-click "Done?" chip. Rendered newest-first → Bump / Rename / Delete, so
    // the chip-less Rename sits BETWEEN the two chips — when its own turn
    // completes below, a card that grows a row would shift Delete's chip out
    // from under the committed click (#1512).
    await backgroundTurnCompleted(window, ids['Delete the prod bucket'])
    await backgroundTurnCompleted(window, ids['Bump a version'])
    await expect.poll(async () => lane(window, 1).locator('.fl-board-card').count()).toBe(3)
    await expect
      .poll(async () => lane(window, 1).locator('.fl-board-badge-suggest').count())
      .toBe(2)
    await window.waitForTimeout(RESORT_WINDOW)

    const orderBefore = await laneTitles(window, 1).allTextContents()
    // The user reaches for the LOWER of the two "Done?" chips.
    const chips = lane(window, 1).locator('.fl-board-badge-suggest')
    const aimedAt = await window.evaluate(() => {
      const doing = document.querySelectorAll('.fl-board-column:not(.fl-board-remote) .fl-board-cards')[1]
      const withChip = [...doing.querySelectorAll('.fl-board-card')].filter((c) =>
        c.querySelector('.fl-board-badge-suggest'),
      )
      return withChip[withChip.length - 1]?.querySelector('.fl-board-card-title')?.textContent ?? null
    })
    expect(aimedAt).toBe('Delete the prod bucket')
    const chipBox = await chips.last().boundingBox()
    expect(chipBox).not.toBeNull()

    // A THIRD task's turn finishes in the background. The user did nothing.
    await backgroundTurnCompleted(window, ids['Rename a label'])
    await window.waitForTimeout(RESORT_WINDOW)

    // The lane must not have re-ordered itself around the reader.
    expect(await laneTitles(window, 1).allTextContents()).toEqual(orderBefore)

    // …and the click the user had already committed to must act on the task it
    // was aimed at, not on whatever slid into that position.
    await window.mouse.click(chipBox!.x + chipBox!.width / 2, chipBox!.y + chipBox!.height / 2)
    await expect.poll(async () => (await storeLanes(window, root))[aimedAt!]).toBe('done')
    expect((await storeLanes(window, root))['Bump a version']).toBe('doing')
  },
)

// ── Tripwire B (#1193) — a failed move must tell the user ───────────────────

test('a lane move that fails to persist tells the user why', async ({ app, window }) => {
  const root = await openBoard(window, 'flow-ux-boardmute-')
  await seedLane(window, root, ['Silently reverts'], 'todo')
  await expect(window.locator('.fl-board-card', { hasText: 'Silently reverts' })).toBeVisible()

  await breakTaskUpdate(app)
  await dragToLane(window, 'Silently reverts', 1)
  await expect
    .poll(async () => window.locator('.fl-board-column:not(.fl-board-remote) .fl-board-count').allTextContents(), { timeout: 8_000 })
    .toEqual(['1', '0', '0', '0', '0'])

  // The sibling read failure says "Could not load tasks" (#205). A write failure
  // that silently undoes the user's drag must be at least as loud.
  await expect
    .poll(async () => /couldn.t|could not|failed|unable/i.test(await window.locator('body').innerText()), {
      timeout: 5_000,
    })
    .toBe(true)
  expect(await storeLanes(window, root)).toEqual({ 'Silently reverts': 'todo' })
})

// ── Evidence capture (screenshots for the filed issues) ─────────────────────

test('capture: the board holding still under the reader', async ({ window }) => {
  const root = await openBoard(window, 'flow-ux-boardshot-')
  const ids = await seedLane(
    window,
    root,
    ['Delete the prod bucket', 'Rename a label', 'Bump a version'],
    'doing',
  )
  await backgroundTurnCompleted(window, ids['Delete the prod bucket'])
  await backgroundTurnCompleted(window, ids['Bump a version'])
  await expect.poll(async () => lane(window, 1).locator('.fl-board-card').count()).toBe(3)
  await window.waitForTimeout(RESORT_WINDOW)
  await window.screenshot({ path: `${SCREENS}/tasks-board-resort-before.png` })

  const chips = lane(window, 1).locator('.fl-board-badge-suggest')
  const chipBox = await chips.last().boundingBox()
  await backgroundTurnCompleted(window, ids['Rename a label'])
  await window.waitForTimeout(RESORT_WINDOW)
  if (chipBox) await window.mouse.click(chipBox.x + chipBox.width / 2, chipBox.y + chipBox.height / 2)
  await window.waitForTimeout(RESORT_WINDOW)
  await window.screenshot({ path: `${SCREENS}/tasks-board-resort-after.png` })
  // #1192 (fixed): the lane no longer re-sorts, so the click lands on the card
  // it was aimed at. Recorded here so the screenshot pair stays self-explaining.
  console.log('STORE AFTER CLICK:', JSON.stringify(await storeLanes(window, root)))
})

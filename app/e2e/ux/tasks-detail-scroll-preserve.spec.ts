import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * Tasks board — task-detail modal scroll preservation on background updates
 * (flow 9 of the progressive UX sweep, guarding #204).
 *
 * `tasks:updated` broadcasts globally and debounced for ANY task mutation (a
 * different task changing, a lane move, a bumped `updatedAt`). The board's
 * `refresh()` re-renders the open detail modal on every one of those. Before
 * #204 that meant `modal.textContent = ''` rebuilt every node and snapped the
 * reader's scroll back to the top mid-read — most disruptively while an agent is
 * actively touching tasks in the background. The fix:
 *   - `taskDetailSignature` captures only the fields the modal renders, so an
 *     update that doesn't change THIS task's visible content (a lane move, a
 *     sibling task's change) is SKIPPED — no rebuild, scroll untouched.
 *   - A genuine change to THIS task still rebuilds, but the reader's scroll
 *     position (modal + the independently-scrollable description) is captured
 *     and restored across the rebuild.
 *
 * Every prior flow-9 probe drives lane drags, the New-task modal, the import
 * error banner, open-chat, the rail action, and the no-project empty state —
 * NONE drive what happens to an OPEN detail modal when tasks change underneath
 * it. This is the first live E2E guard for the #204 scroll seam.
 *
 * All no-account paths (manual create + `tasks:update` IPC), so it runs headless
 * in CI. A `pageerror` listener fails the flow on any uncaught renderer error.
 */
test.afterAll(() => cleanupSeeds())

// A description tall enough to overflow the modal's scroller,
// so there is a real scroll offset to preserve.
const LONG_DESC = Array.from(
  { length: 50 },
  (_, i) =>
    `Paragraph ${i + 1} — lorem ipsum dolor sit amet, consectetur adipiscing elit, ` +
    `sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
).join('\n\n')

type TasksBridge = {
  flow: {
    tasks: {
      list(r: { projectRoot: string; includeArchived: boolean }): Promise<Array<{ id: string; lane: string; title: string }>>
      update(r: { taskId: string; patch: Record<string, unknown> }): Promise<unknown>
    }
  }
}

/** Seed a project, open the board, and create one manual task with a long body. */
async function seedTaskAndOpenBoard(window: Page, title: string): Promise<string> {
  const root = await seedProject(window, 'flow-ux-detailscroll-')
  await activateProject(window, root)

  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  await window.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(window.locator('.fl-board-modal')).toBeVisible()
  await window.locator('.fl-board-modal-body input[type="text"]').first().fill(title)
  await window.locator('.fl-board-modal-body textarea').fill(LONG_DESC)
  await window.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' }).click()
  await expect(window.locator('.fl-board-modal')).toBeHidden()

  // Reopen the board and confirm the card landed.
  await window.locator(statusButtonByText('Tasks')).click()
  await expect(window.locator(sel.board)).toBeVisible()
  await expect(window.locator('.fl-board-card', { hasText: title })).toBeVisible()
  return root
}

/** Read the seeded task's id back from the store (cards carry no data-id). */
async function taskId(window: Page, root: string): Promise<string> {
  return window.evaluate(async (p) => {
    const list = await (window as unknown as TasksBridge).flow.tasks.list({
      projectRoot: p,
      includeArchived: false,
    })
    return list[0]!.id
  }, root)
}

test.describe('tasks board — detail modal scroll preservation (#204)', () => {
  test('a background lane move / title change never snaps the open detail scroll to the top', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      // The board's own diagnostics are console.error by design, not pageerrors;
      // Monaco emits benign "Canceled" rejections on teardown. Neither is a bug.
      if (m.type() === 'error' && !/Canceled|failed to (load|move|generate)/i.test(m.text())) {
        errors.push(`console.error: ${m.text()}`)
      }
    })

    const title = 'Scroll-preserve task'
    const root = await seedTaskAndOpenBoard(window, title)
    const id = await taskId(window, root)

    // Open the detail modal and scroll its description to the bottom.
    await window.locator('.fl-board-card', { hasText: title }).click()
    const detail = window.locator('.fl-board-detail')
    await expect(detail).toBeVisible()
    await expect(detail.locator('.fl-board-modal-title')).toHaveText(title)

    // THE MODAL HAS ONE SCROLLER NOW. It used to scroll, and the description
    // inside it scrolled independently at 32vh, and a wide table inside THAT
    // scrolled sideways — three bars, with no way to tell which one you were in
    // or how much was left. The property this file guards is unchanged: a
    // background update must not throw the reader to the top.
    const desc = detail.locator('.fl-board-detail-scroll')
    await expect(desc).toBeVisible()
    // Precondition: the description genuinely overflows (otherwise the test is
    // vacuous — there's no scroll offset to preserve).
    const overflows = await desc.evaluate((el) => el.scrollHeight > el.clientHeight + 8)
    expect(overflows).toBe(true)
    await desc.evaluate((el) => {
      el.scrollTop = el.scrollHeight
    })
    const scrolled = await desc.evaluate((el) => el.scrollTop)
    expect(scrolled).toBeGreaterThan(0)

    // ── A background LANE MOVE of THIS task must not throw the reader to the
    // top — the exact "a lane move never touches it" case in #204, read as the
    // reader sees it: their place, kept.
    await window.evaluate(async (taskIdArg) => {
      await (window as unknown as TasksBridge).flow.tasks.update({
        taskId: taskIdArg,
        patch: { lane: 'doing', suggestDone: false },
      })
    }, id)
    // Wait for the tasks:updated round-trip to actually land (lane is now 'doing'),
    // so we're asserting AFTER refresh()/rerender() had its chance to reset scroll.
    await expect
      .poll(async () =>
        window.evaluate(async (p) => {
          const list = await (window as unknown as TasksBridge).flow.tasks.list({
            projectRoot: p,
            includeArchived: false,
          })
          return list[0]!.lane
        }, root),
      )
      .toBe('doing')
    await expect(detail).toBeVisible()
    await expect(detail.locator('.fl-board-modal-title')).toHaveText(title)
    // The reader is still at the bottom they scrolled to. (The modal's Status
    // row reports the lane, so a lane move DOES re-render it now — the lane is no
    // longer outside the detail signature — and the bottom can move a few pixels;
    // the reader moves with it rather than being thrown to the top.)
    const kept = await desc.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }))
    expect(
      kept.top === scrolled || Math.abs(kept.top - kept.max) <= 1,
      `kept ${kept.top} (was ${scrolled}, bottom ${kept.max})`,
    ).toBe(true)

    // ── Rebuild-preserve path: a background TITLE change of THIS task IS a visible
    // change, so the modal rebuilds — the new title shows AND the reader's scroll
    // position is restored across the rebuild (not thrown to the top).
    const newTitle = `${title} (edited)`
    await window.evaluate(
      async ([taskIdArg, t]) => {
        await (window as unknown as TasksBridge).flow.tasks.update({
          taskId: taskIdArg,
          patch: { title: t },
        })
      },
      [id, newTitle] as const,
    )
    await expect(detail.locator('.fl-board-modal-title')).toHaveText(newTitle)
    // The scroller was rebuilt; the reader is where they were. They had scrolled
    // to the BOTTOM, and the rebuilt modal's content is not byte-identical in
    // height (the edited title, the lane row), so "where they were" is the same
    // offset when it still fits, else the new bottom — never the top.
    const after = await detail.locator('.fl-board-detail-scroll').evaluate((el) => ({
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
    }))
    expect(
      after.top === scrolled || Math.abs(after.top - after.max) <= 1,
      `restored ${after.top} (was ${scrolled}, new bottom ${after.max})`,
    ).toBe(true)
    expect(after.top).toBeGreaterThan(0)

    expect(errors).toEqual([])
  })
})

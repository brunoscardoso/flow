import type { Page } from '@playwright/test'
import { test, expect } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * UX sweep — a task and its chat are 1:1, and the sidebar lets you delete the
 * chat on its own.
 *
 * Task-owned threads are hidden from the threads list normally, but the sidebar
 * DELIBERATELY drops the task layer while searching (`thread-sidebar.ts`
 * `#groupRows`), so a task's thread surfaces as an ordinary chat row with the
 * full ⋯ menu. Deleting it leaves the task alive with `thread_id` nulled by the
 * FK (`ON DELETE SET NULL`) — the card stays on the board, but its only action
 * ("Open chat") is guarded by `if (task.threadId)` on both surfaces and becomes
 * a silent no-op (#1061).
 *
 * The 28 prior board specs all drive a task whose thread is intact. These drive
 * the thread-deleted shape with the real user levers (board "+ New task",
 * sidebar search, the row's ⋯ → Delete → confirm).
 */

test.afterAll(() => {
  // Best-effort: the app provisions `.claude/` and the `flow` symlink into a
  // freshly-added root, so the rm can race those writes (ENOTEMPTY). A leftover
  // temp dir must not fail a run whose assertions all passed.
  try {
    cleanupSeeds()
  } catch {
    /* temp dirs are OS-cleaned */
  }
})

type FlowApi = {
  tasks: {
    list(r: { projectRoot: string }): Promise<
      Array<{ id: string; title: string; threadId: string | null }>
    >
  }
  threads: { get(r: { threadId: string }): Promise<unknown> }
  project: { active(): Promise<{ activeThreadId: string | null } | null> }
}

/** Create a task from the board's own "+ New task" modal. */
async function newTask(w: Page, title: string): Promise<void> {
  await w.locator('.fl-board-lane-btn[aria-label="New task"]').click()
  await expect(w.locator('.fl-board-modal')).toBeVisible()
  await w.locator('.fl-board-modal-body input[type="text"]').first().fill(title)
  await w.locator('.fl-board-modal .fl-board-new', { hasText: 'Create task' }).click()
  await expect(w.locator('.fl-board-modal')).toBeHidden()
  await expect(w.locator('.fl-board-card', { hasText: title })).toBeVisible()
}

const listTasks = (w: Page, root: string): Promise<Array<{ title: string; threadId: string | null }>> =>
  w.evaluate(
    (p) => (window as unknown as { flow: FlowApi }).flow.tasks.list({ projectRoot: p }),
    root,
  )

/** The project's persisted active thread — what "Open chat" is supposed to move. */
const activeThread = (w: Page): Promise<string | null> =>
  w.evaluate(async () => {
    const ctx = await (window as unknown as { flow: FlowApi }).flow.project.active()
    return ctx?.activeThreadId ?? null
  })

/** Seed a project, open the board, and return its root. */
async function openBoard(w: Page, prefix: string): Promise<string> {
  const root = await seedProject(w, prefix)
  await activateProject(w, root)
  await w.locator(statusButtonByText('Tasks')).click()
  await expect(w.locator(sel.board)).toBeVisible()
  return root
}

/**
 * The real user gesture: search the sidebar for the task's title (which flattens
 * task threads into plain rows), open the row's menu and delete the thread.
 * Returns the confirm copy the user was shown.
 *
 * RIGHT-CLICK, NOT A ⋯ BUTTON. The ⋯ column was retired app-wide (`feat(ide):
 * empty the status bar, retire the ⋯ column`) and every row's actions moved to
 * the context menu; this file kept clicking a button that no longer exists, so
 * three guards failed on the gesture rather than on the thing they guard.
 */
async function openFlattenedThreadMenu(w: Page, title: string): Promise<void> {
  await w.locator('.fl-thread-search input').fill(title)
  const row = w.locator('fl-list').getByText(title, { exact: true }).first()
  await expect(row).toBeVisible()
  // SEARCH IS DEBOUNCED, and until it lands the row is still the TASK row —
  // whose menu offers lanes and no plain Delete. Waiting for the row to be
  // visible is not waiting for it to have become a thread, so this polls the
  // menu itself until the task layer has dropped.
  // SEARCH IS DEBOUNCED, and until it lands the row is still the TASK row —
  // whose menu offers lanes and no plain Delete. Waiting for the row to be
  // visible is not waiting for it to have become a thread.
  //
  // The wait reads the ROW, not a menu. Polling by opening menus meant every
  // attempt raced the render that the search was still doing, and the menu the
  // caller then clicked was sometimes already detached. A task row carries a
  // lane glyph titled "Lane: <lane>"; a flattened thread row carries none, so
  // the task layer having dropped is a fact about the list.
  await expect(w.locator('fl-list [title^="Lane: "]')).toHaveCount(0)
  await row.click({ button: 'right' })
  await expect(w.locator('.fl-thread-menu')).toBeVisible()
}

async function deleteThreadViaSearch(w: Page, title: string): Promise<string> {
  await openFlattenedThreadMenu(w, title)
  await w.locator('.fl-thread-menu-item', { hasText: /^Delete$/ }).click()
  await expect(w.locator('.fl-thread-menu-confirm')).toBeVisible()
  const confirmText = (await w.locator('.fl-thread-menu-confirm').textContent()) ?? ''
  await w.locator('.fl-thread-menu-item.danger', { hasText: /^Delete$/ }).click()
  await w.locator('.fl-thread-search input').fill('')
  return confirmText
}

test(
  'control: a task\'s detail "Open chat" switches the conversation to that task\'s thread',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

    const root = await openBoard(window, 'flow-ux-orphan-ctl-')
    await newTask(window, 'Ship the widget')
    // A second task, created last, is the one the conversation is parked on.
    await newTask(window, 'Second task')

    const tasks = await listTasks(window, root)
    const widget = tasks.find((t) => t.title === 'Ship the widget')!
    const second = tasks.find((t) => t.title === 'Second task')!
    expect(widget.threadId).not.toBeNull()
    await expect.poll(() => activeThread(window), { timeout: 8_000 }).toBe(second.threadId)

    await window.locator('.fl-board-card', { hasText: 'Ship the widget' }).click()
    await expect(window.locator('.fl-board-detail')).toBeVisible()
    await window.locator('.fl-board-detail button', { hasText: 'Open chat' }).click()

    // The button really works — so a later assertion that it did NOT is meaningful.
    await expect.poll(() => activeThread(window), { timeout: 8_000 }).toBe(widget.threadId)
    expect(errors).toEqual([])
  },
)

test(
  'deleting a task\'s 1:1 thread never leaves the task pointing at a dead thread',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

    const root = await openBoard(window, 'flow-ux-orphan-fk-')
    await newTask(window, 'Ship the widget')
    const before = await listTasks(window, root)
    const threadId = before[0].threadId!

    await deleteThreadViaSearch(window, 'Ship the widget')

    // The thread is really gone.
    await expect
      .poll(
        () =>
          window.evaluate(
            (t) => (window as unknown as { flow: FlowApi }).flow.threads.get({ threadId: t }),
            threadId,
          ),
        { timeout: 8_000 },
      )
      .toBeNull()

    // Fix-agnostic invariant: whatever the product decides to do with the task
    // (keep it, cascade it away), it must never keep a pointer to the deleted
    // thread — that dangling id is what makes "Open chat" dispatch an open for a
    // thread that no longer exists (#1061).
    const after = await listTasks(window, root)
    const task = after.find((t) => t.title === 'Ship the widget')
    if (task) expect(task.threadId).toBeNull()

    // …and the board agrees with the store: no phantom card for a deleted task,
    // no missing card for a surviving one.
    await expect
      .poll(async () => window.locator('.fl-board-card', { hasText: 'Ship the widget' }).count(), {
        timeout: 8_000,
      })
      .toBe(task ? 1 : 0)
    expect(errors).toEqual([])
  },
)

test(
  '#1061 — after its chat is deleted, a task\'s "Open chat" reaches a conversation or says why not',
  async ({ window }) => {
    const root = await openBoard(window, 'flow-ux-orphan-dead-')
    await newTask(window, 'Ship the widget')
    await newTask(window, 'Second task')
    const tasks = await listTasks(window, root)
    const second = tasks.find((t) => t.title === 'Second task')!
    await expect.poll(() => activeThread(window), { timeout: 8_000 }).toBe(second.threadId)

    await deleteThreadViaSearch(window, 'Ship the widget')
    await expect(window.locator('.fl-board-card', { hasText: 'Ship the widget' })).toBeVisible()

    await window.locator('.fl-board-card', { hasText: 'Ship the widget' }).click()
    await expect(window.locator('.fl-board-detail')).toBeVisible()
    // Toasts from creating the tasks are still on screen — only a toast raised
    // BY this click counts as feedback.
    const toastsBefore = await window.locator('.fl-flow-toast').allTextContents()
    await window.locator('.fl-board-detail button', { hasText: 'Open chat' }).click()

    // Either the conversation moved somewhere (a fresh thread for this task), or
    // the user was told why it couldn't. POLLED, not sampled once after a fixed
    // wait: recovery is three IPC round-trips deep (tasks:ensureThread →
    // threads:get → project:setActiveThread, the last fire-and-forget), so a
    // single read races the persist. The control test above polls the very same
    // pointer for the very same reason.
    await expect
      .poll(
        async () => {
          const moved = (await activeThread(window)) !== second.threadId
          const toastsAfter = await window.locator('.fl-flow-toast').allTextContents()
          return moved || toastsAfter.some((text) => !toastsBefore.includes(text))
        },
        {
          timeout: 10_000,
          message:
            'clicking "Open chat" on a task whose chat was deleted neither reached a ' +
            'conversation nor said why — the modal closed onto nothing',
        },
      )
      .toBe(true)

    // …and specifically: the task is workable again, not merely noisy. It owns a
    // live thread once more, and that is the one the conversation moved to.
    const recovered = (await listTasks(window, root)).find((t) => t.title === 'Ship the widget')
    expect(recovered?.threadId).not.toBeNull()
    await expect.poll(() => activeThread(window), { timeout: 8_000 }).toBe(recovered!.threadId)
  },
)

test(
  '#1061 — deleting a TASK-OWNED thread warns that a task owns it',
  async ({ window }) => {
    await openBoard(window, 'flow-ux-orphan-warn-')
    await newTask(window, 'Ship the widget')

    await openFlattenedThreadMenu(window, 'Ship the widget')
    await window.locator('.fl-thread-menu-item', { hasText: /^Delete$/ }).click()
    await expect(window.locator('.fl-thread-menu-confirm')).toBeVisible()

    // The task side of this pair is candid ("Delete task + thread"); the thread
    // side says only "Delete this thread?", so nothing warns the user that the
    // task will be left with no chat.
    await expect(window.locator('.fl-thread-menu-confirm')).toContainText(/task/i)
  },
)

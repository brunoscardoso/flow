import { test, expect, type Page } from '../fixtures/electron'
import { sel, statusButtonByText } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

/**
 * thread-agent-status — a board card SHOWS what its agent is doing.
 *
 * The render half, driven end-to-end through the real app: a card reads its
 * owning thread's `status` (the board already holds the thread summaries), and
 * turns `working` into a pulsing accent dot and `needs-decision` into the amber
 * "Needs your input" chip. A resting status draws neither.
 *
 * Account-independent and agent-free: the task (and its 1:1 thread) is created
 * over `tasks:create`, and the thread's status is set through the real
 * `threads:update` IPC — the same status the AgentManager writes on a live turn,
 * without needing an LLM. This exercises the model join (buildBoardModel's
 * threadStatusById) and the render (cardChips + workingPulse) in the packaged UI.
 *
 * The LANE auto-move (needs-decision → Blocked → restore) rides the manager's
 * status EMISSION, which only a real agent turn produces, so it is covered by the
 * unit suites (task-lane-sync.test.ts, agent-manager.test.ts) rather than here.
 */

test.afterAll(() => {
  try {
    cleanupSeeds()
  } catch {
    /* temp dirs are OS-cleaned */
  }
})

const TITLE = 'Rotate the API keys'

interface TasksApi {
  flow: {
    tasks: {
      create(a: { projectRoot: string; title: string }): Promise<unknown>
      list(a: {
        projectRoot: string
        includeArchived: boolean
      }): Promise<{ id: string; threadId: string | null }[]>
    }
    threads: {
      update(a: { threadId: string; patch: { status: string } }): Promise<unknown>
    }
  }
}

/** Seed a project with one manual task, open the board, and return [root, threadId]. */
async function openBoardWithTask(win: Page): Promise<{ root: string; threadId: string }> {
  const root = await seedProject(win)
  await activateProject(win, root)
  await win.evaluate(async (r) => {
    await (window as unknown as TasksApi).flow.tasks.create({ projectRoot: r, title: 'Rotate the API keys' })
  }, root)
  await win.locator(statusButtonByText('Tasks')).click()
  await expect(win.locator(sel.board)).toBeVisible()
  await expect(win.locator('.fl-board-card', { hasText: TITLE })).toBeVisible()
  const threadId = await win.evaluate(async (r) => {
    const list = await (window as unknown as TasksApi).flow.tasks.list({
      projectRoot: r,
      includeArchived: false,
    })
    return list[0]?.threadId ?? ''
  }, root)
  expect(threadId).not.toBe('')
  return { root, threadId }
}

async function setStatus(win: Page, threadId: string, status: string): Promise<void> {
  await win.evaluate(
    async (a) => {
      await (window as unknown as TasksApi).flow.threads.update({
        threadId: a.threadId,
        patch: { status: a.status },
      })
    },
    { threadId, status },
  )
}

test('a card shows the working pulse and the "Needs your input" chip as its agent status changes', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const { threadId } = await openBoardWithTask(window)
  const card = window.locator('.fl-board-card', { hasText: TITLE })

  // Resting (idle): no working dot, no needs-input chip.
  await expect(card.locator('.fl-board-card-working')).toHaveCount(0)
  await expect(card.locator('.fl-board-badge', { hasText: 'Needs your input' })).toHaveCount(0)

  // Working: the accent pulse dot appears.
  await setStatus(window, threadId, 'working')
  await expect(card.locator('.fl-board-card-working')).toHaveCount(1)
  await expect(card.locator('.fl-board-badge', { hasText: 'Needs your input' })).toHaveCount(0)

  // Needs a decision: the amber chip appears and the working dot goes.
  await setStatus(window, threadId, 'needs-decision')
  await expect(card.locator('.fl-board-badge', { hasText: 'Needs your input' })).toHaveCount(1)
  await expect(card.locator('.fl-board-card-working')).toHaveCount(0)

  // Answered / idle again: both are gone.
  await setStatus(window, threadId, 'idle')
  await expect(card.locator('.fl-board-card-working')).toHaveCount(0)
  await expect(card.locator('.fl-board-badge', { hasText: 'Needs your input' })).toHaveCount(0)

  expect(errors).toEqual([])
})

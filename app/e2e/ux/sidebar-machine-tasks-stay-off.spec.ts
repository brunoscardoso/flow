/**
 * A MACHINE-FILED CARD IS NOT A CONVERSATION, EVEN AFTER ITS CHAT EXISTS.
 *
 * WHAT THE USER WAS LOOKING AT. A thread sidebar with rows named `FE-2 —
 * guardResults.candidates type`, `P4 — Per-row field-presence validator`,
 * `P5 …`, `P6 …` — an agent's task list, filed onto the board by the mirror,
 * showing up in the list of chats. Their words: "tasks being created automatic
 * and showing as threads — that should not be happening."
 *
 * WHY THE EXISTING RULE DID NOT CATCH IT. #1789 already kept a CHATLESS
 * mirrored card off the sidebar, and mirrored cards really are created without
 * a thread. But the board's "Open chat" calls `ensureThread`, which creates and
 * links one — and the rule let anything owning a thread through, on the
 * reasoning that a chat exists so the row opens something real. Merely LOOKING
 * at a card therefore filed a permanent chat. Measured on the reporter's
 * machine: four such threads, each created 30 minutes to 3 hours after its
 * card, holding zero messages between them.
 *
 * So the rule now reads provenance alone, and this is the end-to-end proof:
 * the pure rule is unit-tested next to itself, but nothing there knows whether
 * the sidebar consults it, or whether a hidden task's thread quietly reappears
 * as an ordinary chat row instead (it must not — the sidebar excludes every
 * thread a task owns, whether or not the task earns a row).
 *
 * A ledger queue item is used to stand in for the mirror: it takes the SAME
 * machine-created branch of the rule (`manual` source carrying an
 * `externalKey`) and, unlike an agent's TaskCreate, it can be filed without
 * pointing a spec at anyone's credentials.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

test.afterAll(() => cleanupSeeds())

/** File a card the way machinery does — a queue item, no person involved. */
async function fileMachineTask(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ([projectRoot, name]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const result = await flow.tasks.createFromQueueItem({
        projectRoot,
        externalKey: `flow/loops/queue.jsonl#${name}`,
        itemId: name,
        title: name,
        queueKind: 'ledger',
      })
      return result.task.id as string
    },
    [root, title],
  ) as Promise<string>
}

/** Type a task the way a person does, through the same store. */
async function fileManualTask(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ([projectRoot, name]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const task = await flow.tasks.create({ projectRoot, title: name })
      return task.id as string
    },
    [root, title],
  ) as Promise<string>
}

/** What the board's "Open chat" does: create and link the card's 1:1 thread. */
async function openChatFor(win: Page, taskId: string): Promise<string | null> {
  return win.evaluate(async (id: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    const updated = await flow.tasks.ensureThread({ taskId: id })
    return (updated.threadId ?? null) as string | null
  }, taskId)
}

/**
 * Every row title the thread sidebar is currently showing.
 *
 * Through a LOCATOR, not `page.evaluate`: the rows live inside an `<fl-list>`
 * web component's shadow root, which `querySelectorAll` does not pierce and
 * Playwright's selector engine does. Read the wrong way this returns an empty
 * list for a sidebar full of rows — which reads exactly like the thing under
 * test passing.
 */
async function sidebarTitles(win: Page): Promise<string[]> {
  return win
    .locator('.fl-thread-sidebar .row span[title]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''))
}

/**
 * Make the sidebar rebuild from the store, then settle.
 *
 * WITHOUT THIS THE TEST IS VACUOUS, and it was: `ensureThread` writes in main,
 * and if the list has not re-rendered by the time the assertion runs, "the row
 * is absent" is true for a reason that has nothing to do with the rule. Proved
 * by putting the OLD rule back — the spec still passed. Re-activating the
 * project is the same refresh a person causes by clicking the project, so the
 * assertion is made against a list that has actually been rebuilt.
 */
async function forceSidebarRepaint(win: Page, root: string): Promise<void> {
  await win.evaluate(async (rootPath: string) => {
    const flow = (window as unknown as { flow: Record<string, any> }).flow
    await flow.project.setActive({ rootPath })
  }, root)
  await win.waitForTimeout(2000)
}

async function openThreadsRail(win: Page): Promise<void> {
  const rail = win.locator('[data-rail-item="threads"]')
  const cls = (await rail.getAttribute('class')) ?? ''
  if (!/\bactive\b/.test(cls)) await rail.click()
  await expect(win.locator('.fl-thread-sidebar')).toBeVisible()
}

const MACHINE = 'Per-row field-presence validator'
const MINE = 'Something I typed myself'

/**
 * Is the machine card in the list — matched on a SUBSTRING, deliberately.
 *
 * The row's title is not the title the card was filed under: a queue record is
 * stored through `titleWithCode`, so it renders as
 * `flow/loops/queue.jsonl#… — #… : <title>`. An equality check against the
 * filed title therefore never matches, and "absent" comes out true whatever the
 * rule says — which is exactly how the first version of this spec passed
 * against the OLD rule and proved nothing.
 */
function hasMachineRow(titles: readonly string[]): boolean {
  return titles.some((title) => title.includes(MACHINE))
}

test('a machine-filed card never joins the conversation list, chat or no chat', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  const root = await seedProject(window, 'flow-ux-mtask-')
  await activateProject(window, root)
  await openThreadsRail(window)

  const machineId = await fileMachineTask(window, root, MACHINE)
  await fileManualTask(window, root, MINE)

  // A person's own task is a conversation and shows; the machine's does not.
  await expect
    .poll(async () => (await sidebarTitles(window)).includes(MINE), { timeout: 15_000 })
    .toBe(true)
  expect(hasMachineRow(await sidebarTitles(window)), 'a machine-filed card is board work').toBe(
    false,
  )

  // THE REPORTED STEP: opening the card's chat creates its thread. That used to
  // promote it into the sidebar and is exactly what must no longer happen.
  const threadId = await openChatFor(window, machineId)
  expect(threadId, 'the card does get a chat — it is reachable from the board').not.toBeNull()

  // Give the sidebar every chance to render it, then confirm it did not — and
  // that the thread did not slip in as a plain chat row under its own name.
  await forceSidebarRepaint(window, root)
  const titles = await sidebarTitles(window)
  expect(hasMachineRow(titles), 'owning a chat does not earn a row').toBe(false)
  expect(titles, 'and the person’s own task is untouched').toContain(MINE)

  expect(errors, errors.join(', ')).toHaveLength(0)
})

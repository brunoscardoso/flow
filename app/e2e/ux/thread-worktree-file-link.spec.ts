/**
 * A FILE THE AGENT WROTE IN THE THREAD'S CHECKOUT OPENS WHEN YOU CLICK IT.
 *
 * WHAT THE USER WAS LOOKING AT. An agent working in a thread's own worktree
 * wrote `handbook-section-4-security.md`, named it back in the chat as a file
 * chip, and said "(in the worktree root)". Clicking the chip produced a red
 * toast: "File not found — Couldn't locate handbook-section-4-security.md in
 * this project." The file existed. The agent had just written it. The click
 * asked the PROJECT directory, and the file was in the thread's checkout,
 * which is a different directory on disk.
 *
 * WHY THIS IS A SPEC AND NOT A UNIT TEST. Every piece of it worked in
 * isolation: the resolver searches correctly, the chip dispatches correctly,
 * the thread really does own a checkout, and main really does treat that
 * checkout as addressable. The defect was that the renderer never ASKED about
 * it — a wiring fact that only shows up when a real thread with a real worktree
 * meets a real click. The unit rule lives in `file-ref-roots.test.ts`; this is
 * the half that proves it is plugged in.
 *
 * The second test is the ordering, which is the part that could silently
 * regress into a worse bug than the one it fixes: the SAME path present in both
 * checkouts must open the thread's copy, because that is the tree the agent is
 * editing and the one the Source Control panel shows. Opening the project's
 * copy would put the user's edits in a checkout their thread never touches.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { activateProject, cleanupSeeds, openThreadByTitle } from './fixtures/seed'
import {
  AGENT_AUTH_ISOLATED,
  cleanupCheckouts,
  seedCommittedRepo,
  settleWorktree,
  waitForCheckout,
} from './fixtures/worktree'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

test.use({ appEnv: AGENT_AUTH_ISOLATED })

/** The file from the report, by name. */
const AGENT_FILE = 'handbook-section-4-security.md'

/** A name that exists in BOTH checkouts, to pin which one wins. */
const SHARED_FILE = 'shared-note.md'

test.afterAll(() => {
  cleanupCheckouts()
  cleanupSeeds()
})

/** Make a thread over the real create seam and give it a checkout of its own. */
async function threadWithCheckout(win: Page, projectRoot: string, title: string): Promise<string> {
  return win.evaluate(
    async ([root, name]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const thread = await flow.threads.create({ projectRoot: root, title: name })
      await flow.threads.prepareWorktree({
        threadId: thread.id,
        carry: 'clean',
        requested: true,
      })
      return thread.id as string
    },
    [projectRoot, title],
  ) as Promise<string>
}

async function appendMessage(win: Page, threadId: string, content: string): Promise<void> {
  await win.evaluate(
    async ([id, body]: string[]) => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      await flow.messages.append({ threadId: id, role: 'assistant', content: body })
    },
    [threadId, content],
  )
}

/** Activate a thread the way the user does — click its row in the sidebar.
 *  (The row's title span no longer carries a `title` attribute; the shared
 *  helper finds the row by its text and waits for it to be the current one.) */
const openThread = openThreadByTitle

/**
 * Record which absolute path the editor actually opens.
 *
 * `flow:editor-file-opened` is the app's own signal, dispatched by the single
 * function every open source funnels through — so this observes the real
 * outcome rather than a proxy for it.
 */
async function watchOpens(win: Page): Promise<void> {
  await win.evaluate(() => {
    const store = (window as unknown as { __opened?: string[] }).__opened ?? []
    ;(window as unknown as { __opened: string[] }).__opened = store
    document.addEventListener('flow:editor-file-opened', (event) => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (typeof path === 'string') store.push(path)
    })
  })
}

async function openedPaths(win: Page): Promise<string[]> {
  return win.evaluate(() => (window as unknown as { __opened?: string[] }).__opened ?? [])
}

test('a file written in the thread’s checkout opens from its chat chip', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  const project = await seedCommittedRepo(window, 'flow-wtlink')
  await activateProject(window, project)
  await settleWorktree(window, project)

  const threadId = await threadWithCheckout(window, project, 'Worktree file link')
  const record = await waitForCheckout(window, project, threadId)
  const worktree = record.worktreePath as string

  // THE AGENT'S WRITE. Only in the thread's checkout — the project directory
  // genuinely does not have this file, which is exactly the reported shape.
  writeFileSync(join(worktree, AGENT_FILE), '# Section 4\n\nWritten by the agent.\n', 'utf8')

  await appendMessage(window, threadId, `Done. Written to \`${AGENT_FILE}\` (in the worktree root).`)
  await openThread(window, 'Worktree file link')
  await watchOpens(window)

  const chip = window.locator('.fl-md-file', { hasText: AGENT_FILE })
  await expect(chip).toBeVisible({ timeout: 20_000 })
  await chip.click()

  // It opens, and it opens the copy in the thread's checkout.
  await expect
    .poll(async () => (await openedPaths(window)).join('|'), { timeout: 15_000 })
    .toContain(AGENT_FILE)
  const opened = await openedPaths(window)
  expect(opened[0], 'the file opens from the thread’s own checkout').toBe(
    join(worktree, AGENT_FILE),
  )
  // And the dead-end the user hit is gone.
  await expect(window.getByText('File not found')).toHaveCount(0)
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('a path in both checkouts opens the thread’s copy, not the project’s', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (error) => errors.push(error.message))

  const project = await seedCommittedRepo(window, 'flow-wtboth')
  await activateProject(window, project)
  await settleWorktree(window, project)

  const threadId = await threadWithCheckout(window, project, 'Both copies')
  const record = await waitForCheckout(window, project, threadId)
  const worktree = record.worktreePath as string

  // The same name in both trees. The thread's is the one being worked on.
  writeFileSync(join(project, SHARED_FILE), '# the project’s copy\n', 'utf8')
  writeFileSync(join(worktree, SHARED_FILE), '# the thread’s copy\n', 'utf8')

  await appendMessage(window, threadId, `Updated \`${SHARED_FILE}\`.`)
  await openThread(window, 'Both copies')
  await watchOpens(window)

  const chip = window.locator('.fl-md-file', { hasText: SHARED_FILE })
  await expect(chip).toBeVisible({ timeout: 20_000 })
  await chip.click()

  await expect
    .poll(async () => (await openedPaths(window)).join('|'), { timeout: 15_000 })
    .toContain(SHARED_FILE)
  const opened = await openedPaths(window)
  expect(opened[0], 'the thread’s copy wins over the project’s').toBe(join(worktree, SHARED_FILE))
  expect(errors, errors.join(', ')).toHaveLength(0)
})

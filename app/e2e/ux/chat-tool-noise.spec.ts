import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

/**
 * UX -- chat tool-call NOISE reduction (the "too much Edit file referencing" fix, #17).
 *
 * Drives the real renderer end-to-end (the same threads:stream tool-start/tool-end
 * lever the conversation-tool-card probe uses -- no Claude account) and locks:
 *   - N contiguous same-file edits fold under ONE group header, not N lines,
 *   - expanding the group reveals the individual cards,
 *   - expanding a card shows the changed code as a red/green QUOTE, not raw JSON,
 *   - a contiguous read-only run collapses into one muted context row.
 */

interface ToolCallRecord {
  id: string
  threadId: string
  messageId: string | null
  toolName: string
  inputJson: string | null
  outputJson: string | null
  status: 'pending' | 'running' | 'success' | 'error' | 'denied'
  startedAt: string
  completedAt: string | null
}

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

/** Open the Compact work row and its first step (plan_chat-cleanup: a request
 *  is one row, its tools inside a step), so the cards inside are reachable. */
async function openRequestFold(win: Page): Promise<void> {
  const row = win.locator('.fl-request-row').first()
  await expect(row).toBeVisible()
  if (!(await row.evaluate((el) => el.classList.contains('expanded')))) {
    await row.locator('.fl-request-row-header').click()
  }
  const step = row.locator('.fl-request-row-step').first()
  if (!(await step.evaluate((el) => el.classList.contains('expanded')))) {
    await step.locator('.fl-request-row-step-header').click()
  }
}

async function emitStream(app: ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', event)
  }, ev)
}

/** Drive one tool call start-to-end through the live stream. */
async function runTool(
  app: ElectronApplication,
  threadId: string,
  id: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<void> {
  const startedAt = new Date().toISOString()
  const base: ToolCallRecord = {
    id,
    threadId,
    messageId: null,
    toolName,
    inputJson: JSON.stringify(input),
    outputJson: null,
    status: 'running',
    startedAt,
    completedAt: null,
  }
  await emitStream(app, { kind: 'tool-start', threadId, toolCall: base })
  await emitStream(app, {
    kind: 'tool-end',
    threadId,
    toolCall: { ...base, status: 'success', outputJson: JSON.stringify({ ok: true }), completedAt: new Date().toISOString() },
  })
}

test.afterAll(() => cleanupSeeds())

test('N same-file edits fold under one group header; the group reveals cards; a card shows a red/green quote', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Tool Noise Thread')
  await openThread(window, 'Tool Noise Thread')

  // The edits belong to a RUNNING turn. Compact folds live work into the
  // request's work row only while a turn runs; tools with no turn around them
  // are a background agent's and land in the feed (turn-liveness.ts), so
  // without this there is no work row for openRequestFold to open.
  await emitStream(app, { kind: 'status', threadId, status: 'working' })

  // Three edits of the SAME file, contiguous.
  await runTool(app, threadId, 'ed-1', 'Edit', {
    file_path: '/src/foo.ts',
    old_string: 'const a = 1',
    new_string: 'const a = 2',
  })
  await runTool(app, threadId, 'ed-2', 'Edit', {
    file_path: '/src/foo.ts',
    old_string: 'const b = 1',
    new_string: 'const b = 2',
  })
  await runTool(app, threadId, 'ed-3', 'Edit', {
    file_path: '/src/foo.ts',
    old_string: 'const c = 1',
    new_string: 'const c = 2',
  })

  // ONE group header, not three lines. No lone tool cards at the feed level.
  const group = window.locator('.fl-tool-group')
  await expect(group).toHaveCount(1)
  await expect(window.locator('.fl-tool-card:visible')).toHaveCount(0)
  await expect(group.locator('.fl-tool-group-label')).toHaveText('Edited /src/foo.ts · 3 changes')

  // FOUR FOLDS DEEP NOW. In Compact the request folds first — one work row,
  // then the step inside it (plan_chat-cleanup) — so the activity group is
  // reachable only after both are opened. What this test guards is unchanged:
  // three edits of one file are ONE group, and opening it reveals exactly three
  // cards.
  await openRequestFold(window)
  await expect(group.locator('.fl-tool-group-header')).toBeVisible()

  // Expand the group, the three individual cards are revealed.
  await group.locator('.fl-tool-group-header').click()
  await expect(group.locator('.fl-tool-card')).toHaveCount(3)

  // Expand a child card, the change renders as a red/green QUOTE, not raw JSON.
  const firstCard = group.locator('.fl-tool-card').first()
  await firstCard.locator('.fl-tool-line').click()
  const diff = firstCard.locator('.fl-tool-diff')
  await expect(diff).toBeVisible()
  await expect(diff.locator('.fl-tool-diff-removed')).toContainText('const a = 1')
  await expect(diff.locator('.fl-tool-diff-added')).toContainText('const a = 2')

  expect(errors, 'pageerrors during edit-group flow: ' + errors.join('; ')).toEqual([])
})

test('a contiguous read-only run collapses into one muted context row', async ({ window, app }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Context Run Thread')
  await openThread(window, 'Context Run Thread')

  await runTool(app, threadId, 'cx-1', 'Read', { file_path: '/src/a.ts' })
  await runTool(app, threadId, 'cx-2', 'Grep', { pattern: 'foo' })
  await runTool(app, threadId, 'cx-3', 'Glob', { pattern: '**/*.ts' })

  const group = window.locator('.fl-tool-group')
  await expect(group).toHaveCount(1)
  await expect(group.locator('.fl-tool-group-label')).toHaveText('Gathered context · 3 steps')
  await expect(window.locator('.fl-tool-card:visible')).toHaveCount(0)

  expect(errors, 'pageerrors during context-run flow: ' + errors.join('; ')).toEqual([])
})

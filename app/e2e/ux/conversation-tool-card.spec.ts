import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation TOOL-CALL CARD (round 10).
 *
 * Watching the agent work is the primary agentic surface of the conversation
 * pane, yet every prior flow-4 probe (conversation.spec history/scroll/chunking,
 * conversation-states earlier/empty/queued/system-tail, conversation-lifecycle
 * delete/switch/rich-render, conversation-file-links #656, conversation-nested-list
 * #690, conversation-external-link safety, round-8 error+status injection) drove
 * message/error/status surfaces — NONE drove the tool-call card
 * (`fl-tool-card`, tool-card.ts + conversation-pane.ts #onStream tool-start/tool-end
 * at 692-722). It is fully drivable credential-lessly by emitting the real
 * `threads:stream` tool-start/tool-end events the agent-manager sends (same lever
 * the composer-idle-queue-label probe uses for status events) — no Claude account.
 *
 * Locks down the invariants a real user relies on while an agent runs a tool:
 *  - tool-start renders a collapsed card (icon + tool NAME + one-line input
 *    summary + a RUNNING status glyph), and the "Working…/Thinking…" loader is
 *    SUPPRESSED (the card is its own running indicator — a duplicate loader would
 *    be confusing double-feedback),
 *  - clicking the card line EXPANDS it to show the pretty-printed Input JSON,
 *  - tool-end UPDATES THE SAME CARD IN PLACE (same ToolCallRecord id — one card,
 *    not two), flips the status glyph to success, and reveals the Output section,
 *  - a second concurrent tool renders its own distinct card.
 */

const SCREENS = 'e2e/ux/__screens'

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

/** Pick a density through the control a person uses. */
async function setDensity(win: Page, density: 'compact' | 'balanced' | 'detailed'): Promise<void> {
  await win.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
  await win.locator('.fl-settings-tab', { hasText: 'App' }).click()
  await win.locator('select[aria-label="Conversation density"]').selectOption(density)
  await win.keyboard.press('Escape')
  await win.waitForTimeout(300)
}

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

/** Emit a real `threads:stream` event to the active window, exactly as the
 *  agent-manager does — the renderer can't tell an injected event from a live one. */
async function emitStream(app: ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', event)
  }, ev)
}

test.afterAll(() => cleanupSeeds())

test('tool-start renders a collapsed running card and ONE running indicator; expand shows Input; tool-end updates in place + reveals Output', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Tool Card Thread')
  // BALANCED: the per-turn fold this test was written against. In Compact a
  // running request is one live row that IS the running indicator, and the
  // loader steps aside — chat-request-fold.spec.ts guards that.
  await setDensity(window, 'balanced')
  await openThread(window, 'Tool Card Thread')

  const nowIso = new Date().toISOString()
  const running: ToolCallRecord = {
    id: 'tc-bash-1',
    threadId,
    messageId: null,
    toolName: 'Bash',
    inputJson: JSON.stringify({ command: 'npm run build', description: 'build the app' }),
    outputJson: null,
    status: 'running',
    startedAt: nowIso,
    completedAt: null,
  }

  // First bring the turn to a working state so the "Working…" loader is actually
  // SHOWING — this makes the suppression assertion below non-vacuous (the loader
  // is genuinely visible, then the tool card must hide it, not merely stay hidden).
  await emitStream(app, { kind: 'status', threadId, status: 'working' })
  const loader = window.locator('.fl-conv-activity')
  await expect(loader).toBeVisible()
  await expect(loader.locator('.fl-conv-activity-label')).toHaveText('Working…')

  // ── tool-start ────────────────────────────────────────────────────────────
  await emitStream(app, { kind: 'tool-start', threadId, toolCall: running })

  const card = window.locator('.fl-tool-card')
  await expect(card).toHaveCount(1)
  // Name + one-line input summary (the `command` key wins per SUMMARY_KEYS).
  await expect(card.locator('.fl-tool-name')).toHaveText('Bash')
  await expect(card.locator('.fl-tool-summary')).toHaveText('npm run build')
  await expect(card).toHaveAttribute('data-status', 'running')

  // ONE RUNNING INDICATOR, AND IT MOVED. This asserted the opposite until the
  // live turn began folding: the card's spinner was the indicator, so the
  // loader was suppressed to avoid double-feedback. Now the card is inside a
  // collapsed turn row and nobody can see its spinner, so the loader is the one
  // that survives — the rule is unchanged, the survivor is not. A folded turn
  // AND a hidden loader would leave nothing moving while the agent works.
  await expect(loader).toBeVisible()
  await expect(card).toBeHidden()

  await window.screenshot({ path: `${SCREENS}/conv-tool-card-running.png` })

  // ── expand ──────────────────────────────────────────────────────────────
  // Two folds now: the turn, then the card inside it.
  await window.locator('.fl-turn-row-header').first().click()
  await expect(card).toBeVisible()
  // Detail is collapsed until the user opens it.
  await expect(card.locator('.fl-tool-detail')).toBeHidden()
  await card.locator('.fl-tool-line').click()
  await expect(card.locator('.fl-tool-detail')).toBeVisible()
  // Input section shows the pretty-printed JSON; Output is hidden (none yet).
  const inputPre = card.locator('.fl-tool-section').nth(0).locator('pre')
  await expect(inputPre).toContainText('npm run build')
  await expect(card.locator('.fl-tool-section').nth(1)).toBeHidden()

  // ── tool-end (same id → update in place, NOT a second card) ───────────────
  const done: ToolCallRecord = {
    ...running,
    outputJson: JSON.stringify({ stdout: 'build succeeded', exitCode: 0 }),
    status: 'success',
    completedAt: new Date().toISOString(),
  }
  await emitStream(app, { kind: 'tool-end', threadId, toolCall: done })

  // Still exactly one card — updated in place (a duplicate would be the bug).
  await expect(window.locator('.fl-tool-card')).toHaveCount(1)
  await expect(card).toHaveAttribute('data-status', 'success')
  // The card stays expanded across the update and the Output section now shows.
  await expect(card.locator('.fl-tool-detail')).toBeVisible()
  const outputSection = card.locator('.fl-tool-section').nth(1)
  await expect(outputSection).toBeVisible()
  await expect(outputSection.locator('pre')).toContainText('build succeeded')
  // Tool no longer running → the card hands the "still working" indication back
  // to the loader (the turn hasn't emitted `done`), so it reappears.
  await expect(loader).toBeVisible()

  await window.screenshot({ path: `${SCREENS}/conv-tool-card-done.png` })

  // ── a second concurrent tool gets its own distinct card ───────────────────
  const readTool: ToolCallRecord = {
    id: 'tc-read-2',
    threadId,
    messageId: null,
    toolName: 'Read',
    inputJson: JSON.stringify({ file_path: '/src/index.ts' }),
    outputJson: null,
    status: 'running',
    startedAt: new Date().toISOString(),
    completedAt: null,
  }
  await emitStream(app, { kind: 'tool-start', threadId, toolCall: readTool })
  await expect(window.locator('.fl-tool-card')).toHaveCount(2)
  await expect(window.locator('.fl-tool-card').nth(1).locator('.fl-tool-summary')).toHaveText(
    '/src/index.ts',
  )

  expect(errors, `pageerrors during tool-card flow: ${errors.join('; ')}`).toEqual([])
})

import { test, expect, type ElectronApplication } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation, the MODEL LABEL shown with a turn.
 *
 * Three user-visible surfaces render the same `modelLabel()` output
 * (`src/renderer/threads/model-label.ts`):
 *
 *  - the cost/usage footer under the transcript (`.fl-conv-usage`, "↑ … · ↓ …
 *    tokens · <model>"),
 *  - the composer's live "· using <model>" indicator (`.fl-composer-model-indicator`),
 *  - the per-assistant-message badge in history (`.fl-conv-model-badge`).
 *
 * The string they label is NEVER the alias the user picked. `stream-bridge`
 * forwards the SDK's `system/init` model verbatim (stream-bridge.ts:109-110)
 * and the per-message badge stores the Anthropic message's own `model`
 * (stream-bridge.ts:234-235) — both are fully-qualified DATED snapshot ids
 * (`claude-…-YYYYMMDD`). So dated ids are the ONLY input this code ever sees in
 * production; the alias forms in its unit test never occur on this path.
 *
 * `withVersion()` reads the version as `-<major>(-<minor>)?` right after the
 * family word, which cannot tell a minor version from a date stamp:
 *
 *   claude-haiku-4-5-20251001  → 'Haiku 4.5'          ✅ minor present, date dropped
 *   claude-opus-4-20250514     → 'Opus 4.20250514'    ❌ date read as the minor
 *   claude-3-5-sonnet-20241022 → 'Sonnet 20241022'    ❌ date read as the major
 *
 * Live guards below lock in the shapes that work today. The `test.fixme`
 * tripwires cover the shapes that render a date as a version number — they flip
 * green once the label drops an 8-digit date segment.
 */

const SCREENS = 'e2e/ux/__screens'

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

async function appendMessage(
  win: Page,
  threadId: string,
  role: 'user' | 'assistant' | 'system',
  content: string,
): Promise<void> {
  await win.evaluate(
    async ({ threadId, role, content }) => {
      await (
        window as unknown as {
          flow: {
            messages: {
              append(i: { threadId: string; role: string; content: string }): Promise<unknown>
            }
          }
        }
      ).flow.messages.append({ threadId, role, content })
    },
    { threadId, role, content },
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

/** Emit a real `threads:stream` event, exactly as the stream-bridge does. */
async function emitStream(app: ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', event)
  }, ev)
}

/** Run one turn end-to-end (init model → text → usage) and return the footer text. */
async function runTurn(
  win: Page,
  app: ElectronApplication,
  threadId: string,
  model: string,
  messageId: string,
): Promise<string> {
  await emitStream(app, { kind: 'message-start', threadId, messageId })
  await emitStream(app, { kind: 'model', threadId, model })
  await emitStream(app, { kind: 'message-delta', threadId, messageId, text: 'All set.' })
  await emitStream(app, { kind: 'usage', threadId, inputTokens: 12345, outputTokens: 678 })
  const usage = win.locator('.fl-conv-usage')
  await expect(usage).toBeVisible()
  return (await usage.textContent()) ?? ''
}

test.afterAll(() => cleanupSeeds())

test.describe('conversation model label', () => {
  test('a dated snapshot id with a minor version labels the family + version, date dropped', async ({
    window,
    app,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedProject(window)
    await activateProject(window, dir)
    const threadId = await createThread(window, dir, 'Model Label Minor')
    await appendMessage(window, threadId, 'user', 'Which model answered this?')
    await openThread(window, 'Model Label Minor')

    // The dominant real shape: family, major, minor, then the date snapshot.
    const text = await runTurn(window, app, threadId, 'claude-haiku-4-5-20251001', 'ml-minor-1')

    expect(text).toContain('Haiku 4.5')
    // The date snapshot is an implementation detail — it must never reach the user.
    expect(text, `usage footer leaked a date stamp: ${text}`).not.toContain('20251001')
    expect(errors, errors.join(', ')).toHaveLength(0)
  })

  test('the usage footer reports the turn cost alongside the model', async ({ window, app }) => {
    const dir = await seedProject(window)
    await activateProject(window, dir)
    const threadId = await createThread(window, dir, 'Model Label Cost')
    await appendMessage(window, threadId, 'user', 'How much did that cost?')
    await openThread(window, 'Model Label Cost')

    const text = await runTurn(window, app, threadId, 'claude-sonnet-4-5-20250929', 'ml-cost-1')

    expect(text).toContain('12.3k')
    expect(text).toContain('678')
    expect(text).toContain('Sonnet 4.5')
  })

  // TRIPWIRE — a dated snapshot with NO minor version (`claude-opus-4-20250514`,
  // `claude-sonnet-4-20250514`) renders the 8-digit date as the minor version:
  // "Opus 4.20250514". Flip to a live `test(...)` once the label drops the date.
  test.fixme(
    'a dated snapshot id with no minor version does not render the date as a version',
    async ({ window, app }) => {
      const dir = await seedProject(window)
      await activateProject(window, dir)
      const threadId = await createThread(window, dir, 'Model Label Major Only')
      await appendMessage(window, threadId, 'user', 'Which model answered this?')
      await openThread(window, 'Model Label Major Only')

      const text = await runTurn(window, app, threadId, 'claude-opus-4-20250514', 'ml-major-1')
      await window.screenshot({ path: `${SCREENS}/conversation-model-label-date.png` })

      expect(text, `usage footer leaked a date stamp: ${text}`).not.toContain('20250514')
      expect(text).toContain('Opus 4')
    },
  )

  // TRIPWIRE — the `claude-3-x` id shape puts the version BEFORE the family word,
  // so the version regex matches the date instead: "Sonnet 20241022".
  test.fixme(
    'a claude-3 generation id does not render the date as a version',
    async ({ window, app }) => {
      const dir = await seedProject(window)
      await activateProject(window, dir)
      const threadId = await createThread(window, dir, 'Model Label Gen3')
      await appendMessage(window, threadId, 'user', 'Which model answered this?')
      await openThread(window, 'Model Label Gen3')

      const text = await runTurn(window, app, threadId, 'claude-3-5-sonnet-20241022', 'ml-gen3-1')

      expect(text, `usage footer leaked a date stamp: ${text}`).not.toContain('20241022')
    },
  )
})

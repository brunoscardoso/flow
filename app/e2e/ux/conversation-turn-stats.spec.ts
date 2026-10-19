import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'
import type { ElectronApplication } from '@playwright/test'

/**
 * UX sweep — flow 4: the conversation's PER-TURN STATS LINE (round 20).
 *
 * `.fl-conv-usage` is the only surface that tells a user what a turn cost —
 * "↑ 4674 · ↓ 3257 tokens · Opus 4.5" plus the optional brain-savings segment
 * ("~12.4k saved") — and it is un-probed: every prior flow-4 round drove
 * message/tool/error/permission/question/markdown/attachment surfaces
 * (conversation-tool-card, -error-card, -permission-card, -question-card,
 * -md-blocks, -codeblock, -file-links, -external-link, -stream-scroll,
 * -background-turn, -reconcile-reader-state, -attachment-transcript), never the
 * stats footer. It is fully drivable credential-free by emitting the real
 * `threads:stream` model/usage/brain-savings events the agent-manager sends.
 *
 * Locks the invariants a user relies on when reading turn cost:
 *  - a completed turn renders the token counts AND the model that produced them,
 *  - a positive brain-savings estimate appends the "~Nk saved" segment,
 *  - the NEXT turn's usage replaces both numbers and drops the previous turn's
 *    savings segment (stale savings must never ride along on new numbers),
 *  - the stats of thread A never leak into thread B.
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

async function openThread(win: Page, title: string): Promise<void> {
  await win.getByText(title, { exact: true }).first().click()
  await expect(win.locator(sel.conversation)).toBeVisible()
}

/** Emit a real `threads:stream` event, exactly as the agent-manager does. */
async function emitStream(app: ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, event) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', event)
  }, ev)
}

test.afterAll(() => cleanupSeeds())

test('the per-turn stats line reports tokens + the model that ran, appends brain savings, and resets cleanly on the next turn', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await seedProject(window, 'flow-ux-stats-')
  await activateProject(window, root)

  const threadId = await createThread(window, root, 'Stats Line Thread')
  await openThread(window, 'Stats Line Thread')

  const usage = window.locator('.fl-conv-usage')
  const saved = window.locator('.fl-conv-usage-saved')

  // Nothing has run — no cost chrome on a fresh thread.
  await expect(usage).toBeHidden()

  // ── Turn 1: model (init) then usage (end), the real agent-manager order ──
  await emitStream(app, { kind: 'model', threadId, model: 'claude-opus-4-5' })
  await emitStream(app, {
    kind: 'usage',
    threadId,
    inputTokens: 4674,
    cachedInputTokens: 0,
    outputTokens: 3257,
  })

  await expect(usage).toBeVisible()
  // Both directions are reported, and the line names the model that ran —
  // token counts without the model say nothing about what they cost.
  await expect(usage).toContainText('4674')
  await expect(usage).toContainText('3257')
  await expect(usage).toContainText('Opus 4.5')
  await expect(saved).toBeHidden()

  // ── brain-savings appends the estimate segment ───────────────────────────
  await emitStream(app, { kind: 'brain-savings', threadId, savedTokens: 12400 })
  await expect(saved).toBeVisible()
  await expect(saved).toContainText('~12.4k saved')

  // #1280: an UNCALIBRATED estimate must not publish a token figure — below
  // the sample minimum every hit is priced at a flat 8,000, so "~8k saved" was
  // a constant wearing an estimate's clothes ("Always showing 8k tokens
  // saved"). The segment reports the hits it actually counted instead.
  await emitStream(app, {
    kind: 'brain-savings',
    threadId,
    savedTokens: 8000,
    calibrated: false,
    hits: 1,
  })
  await expect(saved).toContainText('1 knowledge hit')
  await expect(saved).not.toContainText('8k')
  await expect(saved).not.toContainText('~')
  // …and a calibrated one still publishes the number.
  await emitStream(app, {
    kind: 'brain-savings',
    threadId,
    savedTokens: 12400,
    calibrated: true,
    hits: 2,
  })
  await expect(saved).toContainText('~12.4k saved')
  await window.screenshot({ path: `${SCREENS}/conversation-turn-stats-line.png` })

  // ── Turn 2 replaces the numbers; the stale savings segment must drop ─────
  await emitStream(app, { kind: 'message-start', threadId, messageId: 'm2' })
  await emitStream(app, { kind: 'message-delta', threadId, messageId: 'm2', text: 'second turn' })
  await emitStream(app, { kind: 'model', threadId, model: 'claude-haiku-4-5' })
  await emitStream(app, {
    kind: 'usage',
    threadId,
    inputTokens: 120,
    cachedInputTokens: 0,
    outputTokens: 40,
  })

  await expect(usage).toContainText('120')
  await expect(usage).toContainText('40')
  await expect(usage).toContainText('Haiku 4.5')
  // Turn 1's savings must not ride along on turn 2's numbers.
  await expect(saved).toBeHidden()
  await expect(usage).not.toContainText('4674')

  // ── Thread B never inherits thread A's cost line ─────────────────────────
  await createThread(window, root, 'Second Stats Thread')
  await openThread(window, 'Second Stats Thread')
  await expect(usage).toBeHidden()

  expect(errors, `pageerrors during the stats-line flow: ${errors.join(' | ')}`).toEqual([])
})

test('a cached turn reports the whole input, with the cached portion broken out (#1136)', async ({
  window,
  app,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const root = await seedProject(window, 'flow-ux-stats-cache-')
  await activateProject(window, root)

  const threadId = await createThread(window, root, 'Cached Stats Thread')
  await openThread(window, 'Cached Stats Thread')

  const usage = window.locator('.fl-conv-usage')

  // The turn-3 shape from #1136: 2 uncached tokens riding on a 7,412-token
  // cached prefix. The footer used to read "↑ 2" — a number three orders of
  // magnitude below what the turn actually sent.
  await emitStream(app, { kind: 'model', threadId, model: 'claude-sonnet-5' })
  await emitStream(app, {
    kind: 'usage',
    threadId,
    inputTokens: 7414,
    cachedInputTokens: 7412,
    outputTokens: 47,
  })

  await expect(usage).toBeVisible()
  await expect(usage).toContainText('↑ 7414 (7412 cached)')
  await expect(usage).toContainText('↓ 47 tokens')
  // The uncached remainder must never be the headline number again.
  await expect(usage).not.toContainText('↑ 2 ')

  expect(errors, `pageerrors during the cached-stats flow: ${errors.join(' | ')}`).toEqual([])
})

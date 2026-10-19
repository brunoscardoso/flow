import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 4: Conversation FOLLOW-UP send-button label (round 8).
 *
 * When the user sends a follow-up during a conversation, the composer's primary
 * button relabels Send → "Queue" while the agent's turn is working (#472) — the
 * message enqueues instead of racing the running turn. That relabel is correct
 * WHILE a turn runs.
 *
 * The bug (#722): the label never reverts. `#syncEnabled` sets the label to
 * "Queue" on `working` (composer.ts ~1384) but the only reset back to "Send"
 * lives in `#setSendMode`'s pending→send branch (~1408), which early-returns
 * when the button is already in `send` mode. Once a turn has run in a thread,
 * the terminal status (`idle` / `done` / `failed`) leaves the button reading
 * "Queue" on an IDLE composer — implying the follow-up will be queued behind a
 * running turn when nothing is running. Clicking it actually sends (the real
 * `#send` gates on `#status === 'working'`, not the label), so it's a mislabel,
 * not a dead click — but it's misleading and sticks across a thread switch too.
 *
 * The agent is unreachable without credentials, so the turn lifecycle is driven
 * by emitting the real `threads:stream` status events the agent-manager emits
 * (working on start, `idle`/`failed` on end — agent-manager.ts:318 / 724). The
 * composer's status-driven relabel can't tell an injected status from a live one.
 *
 * Guard 1 (live): the relabel works WHILE working — baseline "Send" → working
 * "Queue". Guard 2 (test.fixme tripwire for #722): after the turn ends (idle),
 * an idle composer with content must read "Send", not "Queue". Flip it live once
 * the label reverts on the terminal status.
 */

const SCREENS = 'e2e/ux/__screens'

async function createThread(win: Page, root: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ root, title }) => {
      const created = (await (
        window as unknown as {
          flow: { threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> } }
        }
      ).flow.threads.create({ projectRoot: root, title })) as { id: string }
      return created.id
    },
    { root, title },
  )
}

/** Trimmed text of the composer's primary (variant="primary") button label. */
async function primaryLabel(win: Page): Promise<string> {
  return (
    await win
      .locator(`${sel.composer} fl-button[variant="primary"] span`)
      .first()
      .innerText()
      .catch(() => '')
  ).trim()
}

async function emitStream(app: import('@playwright/test').ElectronApplication, ev: Record<string, unknown>): Promise<void> {
  await app.evaluate(({ BrowserWindow }, ev) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('threads:stream', ev)
  }, ev)
}

test.afterAll(() => cleanupSeeds())

test('composer button relabels Send → Queue WHILE the turn is working', async ({ app, window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Label live')
  await window.getByText('Label live', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()

  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.fill('a follow-up message')
  await window.waitForTimeout(80)
  // Baseline: idle composer with content reads "Send".
  expect(await primaryLabel(window)).toBe('Send')

  // Turn starts working → relabels "Queue" (message would enqueue, #472).
  await emitStream(app, { kind: 'status', threadId, status: 'working' })
  await expect
    .poll(() => primaryLabel(window), { timeout: 2000 })
    .toBe('Queue')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

// Guard for #722 (fixed): after the turn ends, the idle composer's primary
// button reads "Send" again — the label is now decided every #syncEnabled sync
// (working ? 'Queue' : 'Send') instead of only on a pending→send transition.
test('after the turn ends, an idle composer reads "Send" (not stale "Queue")', async ({ app, window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedProject(window)
  await activateProject(window, dir)
  const threadId = await createThread(window, dir, 'Label revert')
  await window.getByText('Label revert', { exact: true }).click()
  await expect(window.locator(sel.composer)).toBeVisible()

  const textarea = window.locator(`${sel.composer} textarea`)
  await textarea.click()
  await textarea.fill('a follow-up message')

  // working → idle: the exact status pair a completed turn produces.
  await emitStream(app, { kind: 'status', threadId, status: 'working' })
  await expect.poll(() => primaryLabel(window), { timeout: 2000 }).toBe('Queue')
  await emitStream(app, { kind: 'status', threadId, status: 'idle' })
  await window.waitForTimeout(150)

  await window.screenshot({ path: `${SCREENS}/composer-idle-queue-label.png` })
  // The turn is over and nothing is queued — the button must invite a Send.
  expect(await primaryLabel(window)).toBe('Send')
  expect(errors, errors.join(', ')).toHaveLength(0)
})

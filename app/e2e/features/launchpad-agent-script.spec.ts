import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, openEmptyThread, seedProject } from '../ux/fixtures/seed'

/**
 * "Fix with the agent" on a Launchpad one-time action — the REAL page, with
 * the agent simulated at its two ends:
 *   - the press's message is caught before the composer sends it (no real
 *     turn starts), and its text is read;
 *   - the agent's `launchpad_set_script` answer is the broadcast main sends,
 *     sent here from main exactly as the tool's delivery does.
 * Covers: the button off without a conversation, the press (one message,
 * waiting state, read-only editor), the script arriving untouched (replaced,
 * lines marked, dirty, Undo), arriving after the person typed (offered), and
 * arriving while the page is closed (shown when it opens again).
 */

const SHOTS =
  process.env['FLOW_AGENT_SCRIPT_SHOTS'] ??
  join(tmpdir(), 'flow-e2e-shots')

test.afterAll(() => cleanupSeeds())

async function sendProposal(app: ElectronApplication, threadId: string, action: string, script: string): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('run:scriptProposal', payload)
    },
    { threadId, action, script },
  )
}

/** Catch every `flow:send-prompt` before the composer sends it; the texts are kept on window. */
async function catchPrompts(window: Page): Promise<void> {
  await window.evaluate(() => {
    const w = window as unknown as { __prompts: Array<{ threadId: string; text: string }> }
    w.__prompts = []
    document.addEventListener(
      'flow:send-prompt',
      (event) => {
        event.stopImmediatePropagation()
        w.__prompts.push((event as CustomEvent<{ threadId: string; text: string }>).detail)
      },
      { capture: true },
    )
  })
}

async function prompts(window: Page): Promise<Array<{ threadId: string; text: string }>> {
  return window.evaluate(() => (window as unknown as { __prompts: Array<{ threadId: string; text: string }> }).__prompts)
}

async function openSetup(window: Page): Promise<void> {
  await window.locator('.fl-run-pill-run').click({ timeout: 30_000 })
  const entry = window.locator('.fl-run-menu [data-menu-entry="set-up"]')
  await expect(entry).toBeVisible({ timeout: 30_000 })
  await entry.click()
  await expect(window.locator('.fl-run-setup')).toBeVisible({ timeout: 10_000 })
  const notNow = window.getByRole('button', { name: 'Not now' }).first()
  if (await notNow.isVisible().catch(() => false)) await notNow.click()
}

async function addScriptAction(window: Page, name: string): Promise<void> {
  await window.locator('.fl-run-setup button', { hasText: '+ Add a one-time action' }).click()
  const card = window.locator('.fl-run-card.once').last()
  await card.locator('.fl-run-name').fill(name)
  await card.locator('.fl-run-name').press('Tab')
  await card.locator('.fl-run-segment-btn', { hasText: 'Script' }).click()
}

/** Each test holds exactly one one-time action at a time, so the last one is it. */
const card = (window: Page, _name: string) => window.locator('.fl-run-card.once').last()

test('Fix with the agent: ask, wait, and review the script the agent writes', async ({ window, app }) => {
  test.setTimeout(150_000)
  mkdirSync(SHOTS, { recursive: true })
  const root = await seedProject(window, 'flow-e2e-agent-script-', undefined, { onboarded: true })
  await activateProject(window, root)
  await expect(window.locator('.fl-term-root')).toBeVisible({ timeout: 30_000 })

  // ── In a conversation ─────────────────────────────────────────────────────
  const threadId = await openEmptyThread(window, root, 'Agent script')
  await catchPrompts(window)
  await openSetup(window)
  await addScriptAction(window, 'reset-database')

  const action = card(window, 'reset-database')
  const agentButton = action.locator('.fl-run-agent-btn')
  // Empty script: "Write with the agent", enabled in a conversation.
  await expect(agentButton).toHaveText('Write with the agent')
  await expect(agentButton).toBeEnabled()
  const editor = action.locator('.fl-run-editor-input')
  await editor.fill('#!/usr/bin/env bash\nset -euo pipefail\ndocker compose down -v\ndocker compose up --build -d\nuv run alembic upgrade head')
  await expect(agentButton).toHaveText('Fix with the agent')
  await expect(action.locator('.fl-run-script-lines')).toHaveText('5 lines')
  await action.screenshot({ path: join(SHOTS, 'agent-script-button.png') })

  // ── The press: one message, the action waits, the editor is read-only ───
  await agentButton.click()
  await expect.poll(async () => (await prompts(window)).length).toBe(1)
  const [sent] = await prompts(window)
  expect(sent?.threadId).toBe(threadId)
  expect(sent?.text).toContain('Fix the Launchpad action "reset-database"')
  expect(sent?.text).toContain('docker compose down -v')
  expect(sent?.text).toContain('launchpad_set_script')
  expect(sent?.text).toContain('Do not run it.')
  // The page stays open.
  await expect(window.locator('.fl-run-setup')).toBeVisible()
  const note = action.locator('.fl-run-agent-note')
  await expect(note).toContainText('The agent is writing this script.')
  await expect(note.locator('button', { hasText: 'Stop waiting' })).toBeVisible()
  await expect(action.locator('.fl-run-editor-input')).toHaveJSProperty('readOnly', true)
  await expect(action.locator('.fl-run-agent-btn')).toBeDisabled()
  await action.screenshot({ path: join(SHOTS, 'agent-script-waiting.png') })

  // ── The script arrives, untouched since the press: replaced and marked ──
  const agentScript =
    '#!/usr/bin/env bash\nset -euo pipefail\nexport COMPOSE_PROJECT_NAME=core\ndocker compose down -v\ndocker compose up --build -d\nuntil docker compose exec -T postgres pg_isready; do sleep 1; done\nuv run alembic upgrade head'
  await sendProposal(app, threadId, 'reset-database', agentScript)
  await expect(action.locator('.fl-run-agent-note')).toHaveText(/Written by the agent: 2 lines changed\. Not saved yet\./)
  await expect(action.locator('.fl-run-editor-input')).toHaveValue(agentScript)
  await expect(action.locator('.fl-run-editor-input')).toHaveJSProperty('readOnly', false)
  const marks = action.locator('.fl-run-editor-mark')
  await expect(marks).toHaveCount(2)
  // Each mark sits on its line: 8px padding + line × 20px (lines 3 and 6 are indexes 2 and 5).
  await expect(marks.nth(0)).toHaveAttribute('style', /top: 48px/)
  await expect(marks.nth(1)).toHaveAttribute('style', /top: 108px/)
  await expect(action.locator('.fl-run-script-lines')).toHaveText('7 lines')
  // Not saved: Save is offered, nothing ran.
  await expect(window.locator('.fl-run-setup-foot button', { hasText: /^Save$/ })).toBeEnabled()
  await action.screenshot({ path: join(SHOTS, 'agent-script-result.png') })

  // Undo puts the old script back.
  await action.locator('.fl-run-agent-note button', { hasText: 'Undo' }).click()
  await expect(action.locator('.fl-run-editor-input')).toHaveValue(/^#!\/usr\/bin\/env bash\nset -euo pipefail\ndocker compose down -v/)
  await expect(action.locator('.fl-run-agent-note')).toHaveCount(0)
  await expect(action.locator('.fl-run-editor-mark')).toHaveCount(0)

  // ── The person types after "Stop waiting": the script is only offered ───
  await action.locator('.fl-run-agent-btn').click()
  await expect.poll(async () => (await prompts(window)).length).toBe(2)
  await action.locator('.fl-run-agent-note button', { hasText: 'Stop waiting' }).click()
  await expect(action.locator('.fl-run-agent-note')).toHaveCount(0)
  await action.locator('.fl-run-editor-input').fill('echo mine')
  await sendProposal(app, threadId, 'reset-database', agentScript)
  const offer = action.locator('.fl-run-agent-note')
  await expect(offer).toContainText('The agent wrote a new script.')
  await expect(action.locator('.fl-run-editor-input')).toHaveValue('echo mine')
  await action.screenshot({ path: join(SHOTS, 'agent-script-offer.png') })
  await offer.locator('button', { hasText: 'Use the agent’s script' }).click()
  await expect(action.locator('.fl-run-editor-input')).toHaveValue(agentScript)
  // Typing takes the marks away.
  await expect(action.locator('.fl-run-editor-mark')).not.toHaveCount(0)
  await action.locator('.fl-run-editor-input').press('End')
  await action.locator('.fl-run-editor-input').pressSequentially(' ')
  await expect(action.locator('.fl-run-editor-mark')).toHaveCount(0)

  // ── A script that arrives while the page is closed waits for it ─────────
  await window.locator('.fl-run-setup-foot button', { hasText: 'Cancel' }).click()
  await expect(window.locator('.fl-run-setup')).toHaveCount(0)
  await sendProposal(app, threadId, 'lint', 'npm run lint')
  await openSetup(window)
  const lint = card(window, 'lint')
  await expect(lint).toHaveCount(1)
  await expect(lint.locator('.fl-run-editor-input')).toHaveValue('npm run lint')
  await expect(lint.locator('.fl-run-agent-note')).toContainText('Written by the agent: 1 line changed.')
})

test('without a conversation the agent button is off and says why', async ({ window }) => {
  test.setTimeout(90_000)
  const root = await seedProject(window, 'flow-e2e-agent-script-off-', undefined, { onboarded: true })
  await activateProject(window, root)
  await expect(window.locator('.fl-term-root')).toBeVisible({ timeout: 30_000 })
  await openSetup(window)
  await addScriptAction(window, 'seed')
  const button = card(window, 'seed').locator('.fl-run-agent-btn')
  await expect(button).toHaveText('Write with the agent')
  await expect(button).toBeDisabled()
  await expect(button).toHaveAttribute('title', 'Needs a conversation. Open this from a conversation to ask the agent.')
  await card(window, 'seed').screenshot({ path: join(SHOTS, 'agent-script-off.png') })
  // A command: the same button, at the end of the line under the command.
  await card(window, 'seed').locator('.fl-run-segment-btn', { hasText: 'Command' }).click()
  await card(window, 'seed').locator('.fl-run-command').fill('make seed')
  await expect(card(window, 'seed').locator('.fl-run-card-line.small .fl-run-agent-btn')).toHaveText('Make a script with the agent')
  await card(window, 'seed').screenshot({ path: join(SHOTS, 'agent-script-command.png') })
})

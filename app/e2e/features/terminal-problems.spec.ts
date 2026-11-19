import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Page } from '@playwright/test'

import { test, expect } from '../fixtures/electron'
import { activateProject, cleanupSeeds, seedProject } from '../ux/fixtures/seed'

/**
 * Terminal errors and warnings in Problems — the REAL path. A Launchpad step
 * prints a loguru-style WARNING five times (different timestamps) and a red
 * ConnectionRefusedError after two traceback lines. Main reads the output,
 * the counters add it, Problems lists one warning row ×5 and one error row,
 * an open row shows its context, Copy puts the agreed text on the clipboard,
 * and Clear empties the section.
 */

const SHOTS =
  process.env['FLOW_TERMINAL_PROBLEMS_SHOTS'] ??
  join(tmpdir(), 'flow-e2e-shots')

test.afterAll(() => cleanupSeeds())

interface RunBridge {
  flow: {
    run: {
      save(request: unknown): Promise<{ ok: boolean; reason?: string }>
      start(request: unknown): Promise<unknown>
      stop(request: unknown): Promise<unknown>
    }
  }
}

const WARNING_MESSAGE = 'Stop signal resubscribe failed: Error 61 connecting to localhost:6379. Connection refused.'
const ERROR_MESSAGE = 'ConnectionRefusedError: [Errno 61] Connection refused'

const STEP_COMMAND = [
  `for i in 1 2 3 4 5; do printf '2026-11-18 20:56:0%s.890 | WARNING  | jupiter_core.harness.runtime.stop_signal:_resubscribe:588 - ${WARNING_MESSAGE}\\n' $i; sleep 0.3; done`,
  `printf '  File "uvloop/loop.pyx", line 2020, in uvloop.loop.Loop.create_connection\\n    await waiter\\n'`,
  `printf '\\033[31m${ERROR_MESSAGE}\\033[0m\\n'`,
  'sleep 600',
].join('; ')

async function runStep(window: Page, root: string): Promise<void> {
  const saved = await window.evaluate(
    async ({ rootPath, command }) => {
      const bridge = window as unknown as RunBridge
      const scope = { rootPath, threadId: null }
      const answer = await bridge.flow.run.save({
        scope,
        change: { layer: 'shared', steps: [{ id: 'core-dev', name: 'core-dev', command, start: 'now' }] },
      })
      if (answer.ok) await bridge.flow.run.start({ scope })
      return answer
    },
    { rootPath: root, command: STEP_COMMAND },
  )
  expect(saved.ok).toBe(true)
}

test('terminal errors and warnings: counters, rows with counts, context, Copy and Clear', async ({ window, app }) => {
  test.setTimeout(120_000)
  const root = await seedProject(window, 'flow-e2e-term-problems-', undefined, { onboarded: true })
  await activateProject(window, root)
  await expect(window.locator('.fl-term-root')).toBeVisible({ timeout: 30_000 })
  await window.getByRole('button', { name: 'Not now' }).click({ timeout: 3_000 }).catch(() => undefined)
  await runStep(window, root)

  // ── The counters count the terminal's problems ──────────────────────────
  const toggle = window.locator('.fl-problems-toggle')
  await expect(toggle).toHaveAttribute('data-errors', '1', { timeout: 30_000 })
  await expect(toggle).toHaveAttribute('data-warnings', '1')
  await expect(toggle).toHaveClass(/has-errors/)
  await expect(toggle).toHaveAttribute('title', /1 error: 1 from terminals\. 1 warning: 1 from terminals\./)
  mkdirSync(SHOTS, { recursive: true })
  await window.locator('.fl-term-header').screenshot({ path: join(SHOTS, 'terminal-problems-counters.png') })

  // ── Problems: one group, a warning row ×5 and an error row ───────────────
  await toggle.click()
  await expect(window.locator('.fl-term-root')).toHaveClass(/fl-problems-mode/)
  await expect(window.locator('.fl-problems-chip')).toHaveText(['All', 'Terminals', 'Files', 'Errors', 'Warnings'])
  const group = window.locator('.fl-problems-tgroup')
  await expect(group).toHaveCount(1)
  await expect(group.locator('.fl-problems-thead b')).toHaveText('core-dev')
  await expect(group.locator('.fl-problems-thead span')).toHaveText(/ · Launchpad$/)
  const warningRow = group.locator('.fl-problems-trow[data-severity="warning"]')
  const errorRow = group.locator('.fl-problems-trow[data-severity="error"]')
  await expect(warningRow).toHaveCount(1)
  await expect(warningRow.locator('.fl-problems-tmsg')).toHaveText(WARNING_MESSAGE)
  await expect(warningRow.locator('.fl-problems-times')).toHaveText('×5')
  await expect(warningRow.locator('.fl-problems-tmeta')).toHaveText(/^jupiter_core\.harness\.runtime\.stop_signal · last \d\d:\d\d:\d\d$/)
  await expect(errorRow.locator('.fl-problems-tmsg')).toHaveText(ERROR_MESSAGE)
  await expect(errorRow.locator('.fl-problems-times')).toHaveText('×1')
  // Newest first: the error came last.
  await expect(group.locator('.fl-problems-trow').first()).toHaveAttribute('data-severity', 'error')
  await window.locator('.fl-term-root').screenshot({ path: join(SHOTS, 'terminal-problems-list.png') })

  // ── The filters: Warnings off hides the warning row ──────────────────────
  await window.locator('.fl-problems-chip[data-severity="warning"]').click()
  await expect(errorRow).toHaveCount(1)
  await expect(warningRow).toHaveCount(0)
  await window.locator('.fl-problems-chip[data-severity="warning"]').click()
  await expect(warningRow).toHaveCount(1)

  // ── An open row: its context, the problem line last ─────────────────────
  await errorRow.click()
  const context = window.locator('.fl-problems-context')
  await expect(context).toBeVisible()
  await expect(context.locator('div').first()).toContainText('Stop signal resubscribe failed')
  await expect(context).toContainText('  File "uvloop/loop.pyx", line 2020, in uvloop.loop.Loop.create_connection')
  await expect(context.locator('.fl-problems-hl')).toHaveText(ERROR_MESSAGE)
  await expect(window.locator('.fl-problems-dbar button')).toHaveText(['Copy', 'Show in terminal', 'Fix with agent'])
  // No conversation is open: Fix with agent says why it cannot act.
  await expect(window.locator('.fl-problems-dbar [data-action="fix"]')).toBeDisabled()
  await window.locator('.fl-term-root').screenshot({ path: join(SHOTS, 'terminal-problems-open-row.png') })

  // ── Copy: the agreed text on the clipboard, and a toast ─────────────────
  await app.evaluate(({ clipboard }) => clipboard.writeText(''))
  await window.locator('.fl-problems-dbar [data-action="copy"]').click()
  await expect
    .poll(async () => app.evaluate(({ clipboard }) => clipboard.readText()), { timeout: 5_000 })
    .toMatch(
      new RegExp(
        String.raw`^core-dev \(flow-e2e-term-problems-[^)]+\) — seen once, at \d\d:\d\d:\d\d\n` +
          String.raw`ConnectionRefusedError: \[Errno 61\] Connection refused\n\n`,
      ),
    )
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText())
  expect(copied.split('\n').slice(-2)).toEqual([
    '  File "uvloop/loop.pyx", line 2020, in uvloop.loop.Loop.create_connection',
    '    await waiter',
  ])
  await expect(window.getByText('Copied.').first()).toBeVisible({ timeout: 5_000 })

  // ── Show in terminal: the terminal view, with that step on screen ───────
  await window.locator('.fl-problems-dbar [data-action="show"]').click()
  await expect(window.locator('.fl-term-root')).not.toHaveClass(/fl-problems-mode/)
  await expect(window.locator('.fl-lp-pane:not([hidden]) .fl-lp-head b', { hasText: 'core-dev' }).first()).toBeVisible({
    timeout: 10_000,
  })
  await toggle.click()
  await expect(window.locator('.fl-term-root')).toHaveClass(/fl-problems-mode/)

  // ── Clear terminal problems ─────────────────────────────────────────────
  await window.locator('.fl-problems-clear-terminals').click()
  await expect(group).toHaveCount(0)
  await expect(toggle).toHaveAttribute('data-errors', '0')
  await expect(toggle).toHaveAttribute('data-warnings', '0')
  await expect(window.locator('.fl-problems-empty')).toBeVisible()
  // …and it stays clear after main's broadcast and a fresh read.
  await window.waitForTimeout(800)
  await expect(toggle).toHaveAttribute('data-errors', '0')

  await window.evaluate(async (rootPath) => {
    await (window as unknown as RunBridge).flow.run.stop({ scope: { rootPath, threadId: null } })
  }, root)
})

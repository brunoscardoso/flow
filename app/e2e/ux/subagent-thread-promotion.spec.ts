/**
 * SUB-AGENTS ARE CHATS, NOT SIDE PANELS (#1931 D-4/D-5).
 *
 * Clicking a persisted sub-agent row in the Background activity popover must
 * switch the MAIN pane to the promoted CHILD thread — the full conversation,
 * with the continuing-from-sub-agent banner and the back-to-parent link — and
 * must NOT open (or leave open) the old right-side activity tab.
 *
 * Two cases, split by the origin tool call's status:
 *   - finished ('success')  → banner reads "Continuing from sub-agent", and the
 *     composer stays usable
 *   - still running          → banner says the sub-agent is still running and
 *     the composer's input is LOCKED until it finishes (the send gate)
 *
 * Seeded with the sqlite3 CLI (same mechanics as
 * background-activity-agent-vocabulary.spec.ts): better-sqlite3 here is built
 * for Electron's ABI and will not load in Playwright's plain-Node process.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

async function seedAgentThread(
  window: Page,
  userDataDir: string,
  root: string,
  title: string,
  options: { callId: string; description: string; status: 'success' | 'running' },
): Promise<string> {
  const threadId: string = await window.evaluate(
    async ({ r, t }) => {
      const t2 = await (window as any).flow.threads.create({ projectRoot: r, title: t })
      return t2.id
    },
    { r: root, t: title },
  )
  await window.waitForTimeout(1200)

  const { execFileSync } = await import('node:child_process')
  const { join } = await import('node:path')
  const dbPath = join(userDataDir, 'flow.db')
  const t0 = Date.parse('2026-10-07T12:00:00.000Z')
  const iso = (n: number): string => new Date(t0 + n * 1000).toISOString()
  const q = (v: string): string => `'${v.replace(/'/g, "''")}'`
  const agentInput = JSON.stringify({
    description: options.description,
    subagent_type: 'general-purpose',
    prompt: 'go research',
  })
  const finished = options.status === 'success'
  const output = finished ? "'\"done\"'" : 'NULL'
  const completed = finished ? q(iso(40)) : 'NULL'
  const mid = `m-${options.callId}`
  const sql = [
    `INSERT INTO messages (id,thread_id,role,content,created_at,model) VALUES (${q(`${mid}a`)},${q(threadId)},'user',${q('research this in the background')},${q(iso(0))},NULL);`,
    `INSERT INTO messages (id,thread_id,role,content,created_at,model) VALUES (${q(`${mid}b`)},${q(threadId)},'assistant',${q('Spawned a research sub-agent.')},${q(iso(10))},'claude-opus-5');`,
    `INSERT INTO tool_calls (id,thread_id,message_id,tool_name,input_json,output_json,status,started_at,completed_at) VALUES (${q(options.callId)},${q(threadId)},${q(`${mid}b`)},'Agent',${q(agentInput)},${output},${q(options.status)},${q(iso(11))},${completed});`,
    // The sub-agent's own captured rows, tagged with the spawn (what the
    // promotion re-homes into the child's transcript).
    `INSERT INTO messages (id,thread_id,role,content,created_at,model,parent_tool_call_id) VALUES (${q(`${mid}c`)},${q(threadId)},'assistant',${q('Inner sub-agent finding')},${q(iso(20))},'claude-opus-5',${q(options.callId)});`,
  ].join('\n')
  execFileSync('sqlite3', [dbPath], { input: sql })
  return threadId
}

async function openSeededThread(window: Page, title: string): Promise<void> {
  await window.waitForTimeout(800)
  const row = window.locator('.fl-thread-list fl-list .row', { hasText: title }).first()
  await row.waitFor({ timeout: 20_000 })
  // Title-area click — a center click can hit the hover-revealed Archive row
  // action under the Workspace-scope layout (see the vocabulary spec).
  await row.click({ position: { x: 40, y: 14 } })
  await window.waitForTimeout(2500)
}

/**
 * Open a RUNNING sub-agent's chat from the Sub-agents activity strip.
 *
 * Still the live door, and only the live one: the strip reports what is
 * running, so a test that reaches for it must have something running.
 */
async function clickPopoverRow(window: Page, description: string): Promise<void> {
  const chip = window.locator('button.fl-bgactivity-strip')
  await expect(chip).toBeVisible()
  await chip.click()
  const item = window
    .locator('.fl-fmenu .fl-bgactivity-list .fl-fmenu-item', { hasText: description })
    .first()
  await item.waitFor({ timeout: 10_000 })
  await item.click()
  await window.waitForTimeout(2000)
}

/**
 * Open a FINISHED sub-agent's chat the way a person now can.
 *
 * THE DOOR MOVED (user, 2026-10-13). This used to press the Sub-agents
 * activity strip and pick a row from its popover; the strip now shows only
 * while something is running, so for a finished sub-agent that door is
 * closed — and the one in the conversation, which was always there, is the
 * one that stays. Both dispatch the same `flow:open-subagent-thread`, so what
 * the tests below assert about promotion is unchanged.
 *
 * In Compact (the default) a settled request folds its tools into one work
 * row, so reaching the spawn's line means opening the row and then its step.
 */
async function openFinishedSubagent(window: Page, description: string): Promise<void> {
  await window.locator('.fl-conv-feed .fl-request-row-header').first().click()
  await window.locator('.fl-conv-feed .fl-request-row-step-header').first().click()
  await window.waitForTimeout(500)
  const line = window
    .locator('.fl-conv-feed .fl-tool-card.fl-tool-subagent-chip', { hasText: description })
    .first()
  await line.waitFor({ timeout: 10_000 })
  await line.locator('.fl-tool-line').click()
  await window.waitForTimeout(2000)
}

test('clicking a finished sub-agent row opens the child-thread chat in the main pane', async ({
  window,
  userDataDir,
}) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'subagent-promote-')
    await activateProject(window, root)
    await seedAgentThread(window, userDataDir, root, 'Promotion source', {
      callId: 'call-done',
      description: 'Deep research pass',
      status: 'success',
    })
    await openSeededThread(window, 'Promotion source')
    await openFinishedSubagent(window, 'Deep research pass')

    // The MAIN pane switched: the continuing-from-sub-agent banner is up, named
    // after the sub-agent, with the back-to-parent link.
    const banner = window.locator('.fl-conv-subagent-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Continuing from sub-agent: Deep research pass')
    await expect(banner.locator('.fl-conv-subagent-banner-back')).toBeVisible()

    // The re-homed transcript reads as the child's own history.
    await expect(window.locator('.fl-conv-feed')).toContainText('Inner sub-agent finding')

    // The right-side activity tab did NOT open (D-5: the chat supersedes it).
    await expect(window.locator('.fl-bgactivity-tab')).toHaveCount(0)

    // A finished origin leaves the composer usable — no lock.
    await expect(window.locator('.fl-composer textarea')).toBeEnabled()
  } finally {
    cleanupSeeds()
  }
})

test('a finished spawn card collapses to a one-line chip, and the chip opens the child (#1931 follow-up)', async ({
  window,
  userDataDir,
}) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'subagent-chipline-')
    await activateProject(window, root)
    await seedAgentThread(window, userDataDir, root, 'Chip line source', {
      callId: 'call-chipline',
      description: 'Deep research pass',
      status: 'success',
    })
    await openSeededThread(window, 'Chip line source')

    // The settled request folds its tools into one work row (chat cleanup,
    // Compact) — open the row, then its step, to reach the card.
    await window.locator('.fl-conv-feed .fl-request-row-header').first().click()
    await window.locator('.fl-conv-feed .fl-request-row-step-header').first().click()
    await window.waitForTimeout(500)

    // ── COLLAPSED TO ONE LINE ───────────────────────────────────────────────
    // A terminal spawn renders as the compact chip: description + the subtle
    // state word, and the JSON detail never opens — the card's body is the
    // child thread now.
    const chip = window.locator('.fl-conv-feed .fl-tool-card.fl-tool-subagent-chip')
    await expect(chip).toHaveCount(1)
    await expect(chip).toHaveAttribute('data-subagent-chip', 'finished')
    const chipLine = chip.locator('.fl-tool-line')
    await expect(chipLine).toContainText('Deep research pass')
    await expect(chipLine).toContainText('finished')
    await expect(chip.locator('.fl-tool-detail')).toBeHidden()

    // ── THE CHIP IS THE DOOR ────────────────────────────────────────────────
    // Clicking the collapsed line opens the promoted child-thread chat via the
    // one existing open flow — same banner the popover route shows.
    await chipLine.click()
    await window.waitForTimeout(2000)
    const banner = window.locator('.fl-conv-subagent-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Continuing from sub-agent: Deep research pass')
    await expect(window.locator('.fl-conv-feed')).toContainText('Inner sub-agent finding')
  } finally {
    cleanupSeeds()
  }
})

test('a RUNNING sub-agent child locks the composer until the origin finishes', async ({
  window,
  userDataDir,
}) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'subagent-running-')
    await activateProject(window, root)
    await seedAgentThread(window, userDataDir, root, 'Running source', {
      callId: 'call-live',
      description: 'Long migration sweep',
      status: 'running',
    })
    await openSeededThread(window, 'Running source')

    // While the origin RUNS the spawn card keeps its full presentation — the
    // collapsed chip is for terminal spawns only (#1931 follow-up).
    await expect(window.locator('.fl-tool-subagent-chip')).toHaveCount(0)

    await clickPopoverRow(window, 'Long migration sweep')

    // Banner explains why replies wait…
    const banner = window.locator('.fl-conv-subagent-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Sub-agent still running')

    // …and the composer's input is locked while the origin tool call runs.
    await expect(window.locator('.fl-composer textarea')).toBeDisabled({ timeout: 10_000 })

    // The LIVE child stays a visible sidebar row — exactly ONE row for the
    // running work (#1931 follow-up: a live task that resolves to a promoted
    // child dedupes into the child row), carrying the agent-task spinner in
    // place of the ↳ glyph. The thread-row disclosure folds FINISHED children
    // only, so nothing here is foldable and no chevron renders anywhere.
    const liveChildRow = window.locator('.fl-thread-list fl-list .row', {
      hasText: 'Long migration sweep',
    })
    await expect(liveChildRow).toHaveCount(1)
    await expect(liveChildRow.first().locator('fl-icon[name="spinner"]')).toHaveCount(1)
    await expect(liveChildRow.first()).not.toContainText('↳')
    await expect(window.locator('.fl-thread-list fl-list .fl-children-toggle')).toHaveCount(0)

    // LIVE WHILE OPEN (#1931 follow-up, bug A): a row written to the child by
    // somebody else — here through the same store write the parent's session
    // uses — must appear in the OPEN child pane without switching away/back.
    // Before the fix, the refetch debounce could be starved for the whole
    // stream and busy panes dropped the event outright.
    await window.evaluate(async () => {
      const flow = (window as unknown as { flow: Record<string, any> }).flow
      const active = document.querySelector('.fl-conv-subagent-banner')
      if (!active) throw new Error('child pane not open')
      // The open child is the only child of the seeded parent.
      const threads = await flow.threads.list({ includeChildren: true })
      const child = threads.find(
        (t: { parentThreadId?: string | null }) => t.parentThreadId,
      )
      if (!child) throw new Error('promoted child not found')
      await flow.messages.append({
        threadId: child.id,
        role: 'assistant',
        content: 'Mid-run sub-agent update lands live',
      })
    })
    await expect(window.locator('.fl-conv-feed')).toContainText(
      'Mid-run sub-agent update lands live',
      { timeout: 10_000 },
    )
  } finally {
    cleanupSeeds()
  }
})

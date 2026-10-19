/**
 * THE PROMOTED CHILD IS A REAL THREAD, AND THE CHIP IS NOT A ONE-OPEN WONDER
 * (#1931 Definition of Done, points 1/2/6).
 *
 * Two guards the promotion spec leaves open:
 *
 *  1. CHIP PERSISTENCE — the Background activity chip is derived from the OPEN
 *     thread's persisted tool calls, so switching to another thread and back
 *     must show it again with the same count. The regression this pins: a chip
 *     fed from a one-shot cache (set on first history load, never on re-open)
 *     would pass the vocabulary spec and still vanish on the second visit.
 *
 *  2. NESTING + BACK-NAV — after promotion the child thread appears NESTED
 *     under its parent in the sidebar (the ↳ child row, exactly once — never a
 *     second copy in the top-level list), the banner's back link returns the
 *     main pane to the parent, and clicking parent/child sidebar rows switches
 *     between the two conversations.
 *
 * Seeded with the sqlite3 CLI (same mechanics as
 * subagent-thread-promotion.spec.ts): better-sqlite3 here is built for
 * Electron's ABI and will not load in Playwright's plain-Node process.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import type { Page } from '@playwright/test'

async function seedAgentThread(
  window: Page,
  userDataDir: string,
  root: string,
  title: string,
  /** `status` is the spawn's own: 'success' (finished) unless a test wants a
   *  sub-agent still running — which is now the only state that shows the
   *  Sub-agents activity strip (user, 2026-10-13). */
  options: { callId: string; description: string; status?: 'success' | 'running' },
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
  const { join: joinPath } = await import('node:path')
  const dbPath = joinPath(userDataDir, 'flow.db')
  const t0 = Date.parse('2026-10-07T12:00:00.000Z')
  const iso = (n: number): string => new Date(t0 + n * 1000).toISOString()
  const q = (v: string): string => `'${v.replace(/'/g, "''")}'`
  const agentInput = JSON.stringify({
    description: options.description,
    subagent_type: 'general-purpose',
    prompt: 'go research',
  })
  const mid = `m-${options.callId}`
  const status = options.status ?? 'success'
  // A running spawn has not completed, so it carries no completion time — the
  // activity model reads the STATUS, and a row that claims both would be a
  // fixture no real turn produces.
  const completed = status === 'running' ? 'NULL' : q(iso(40))
  const sql = [
    `INSERT INTO messages (id,thread_id,role,content,created_at,model) VALUES (${q(`${mid}a`)},${q(threadId)},'user',${q('research this in the background')},${q(iso(0))},NULL);`,
    `INSERT INTO messages (id,thread_id,role,content,created_at,model) VALUES (${q(`${mid}b`)},${q(threadId)},'assistant',${q('Spawned a research sub-agent.')},${q(iso(10))},'claude-opus-5');`,
    `INSERT INTO tool_calls (id,thread_id,message_id,tool_name,input_json,output_json,status,started_at,completed_at) VALUES (${q(options.callId)},${q(threadId)},${q(`${mid}b`)},'Agent',${q(agentInput)},'"done"',${q(status)},${q(iso(11))},${completed});`,
    // The sub-agent's own captured row — what promotion re-homes into the child.
    `INSERT INTO messages (id,thread_id,role,content,created_at,model,parent_tool_call_id) VALUES (${q(`${mid}c`)},${q(threadId)},'assistant',${q('Inner sub-agent finding')},${q(iso(20))},'claude-opus-5',${q(options.callId)});`,
  ].join('\n')
  execFileSync('sqlite3', [dbPath], { input: sql })
  return threadId
}

/**
 * The finished sub-agent's line in the conversation — the door that stays open.
 *
 * THE ACTIVITY STRIP REPORTS ONLY WHAT IS RUNNING (user, 2026-10-13), so a
 * finished spawn is opened where it happened. In Compact a settled request
 * folds into one work row, so the row and its step are opened first — but only
 * when the line is not already showing, because pressing an open row closes it.
 */
async function subagentLineInChat(window: Page, description: string) {
  const line = window
    .locator('.fl-conv-feed .fl-tool-card.fl-tool-subagent-chip', { hasText: description })
    .first()
  if ((await line.count()) === 0) {
    await window.locator('.fl-conv-feed .fl-request-row-header').first().click()
    await window.locator('.fl-conv-feed .fl-request-row-step-header').first().click()
    await window.waitForTimeout(500)
  }
  await line.waitFor({ timeout: 10_000 })
  return line
}

/** Click a thread's sidebar row and give the pane time to load its history. */
async function openSidebarThread(window: Page, title: string): Promise<void> {
  const row = window.locator('.fl-thread-list fl-list .row', { hasText: title }).first()
  await row.waitFor({ timeout: 20_000 })
  // Title-area click — a center click can hit the hover-revealed Archive row
  // action under the Workspace-scope layout (see the vocabulary spec).
  await row.click({ position: { x: 40, y: 14 } })
  await window.waitForTimeout(2500)
}

/** Screenshot into the evidence dir when one is configured (CI/manual runs). */
async function evidence(window: Page, name: string): Promise<void> {
  const dir = process.env['E2E_EVIDENCE_DIR']
  if (dir === undefined || dir.length === 0) return
  mkdirSync(dir, { recursive: true })
  await window.screenshot({ path: join(dir, `${name}.png`) })
}

test('the Sub-agents activity chip survives switching away and back while one RUNS (DoD 1)', async ({
  window,
  userDataDir,
}) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'subagent-chip-persist-')
    await activateProject(window, root)
    // RUNNING, because that is now the only state the strip reports. The
    // property under test is unchanged: the chip is derived from the open
    // thread's persisted rows rather than cached once.
    await seedAgentThread(window, userDataDir, root, 'Chip source', {
      callId: 'call-chip',
      description: 'Chip research pass',
      status: 'running',
    })
    // A second, plain thread to switch away to.
    await window.evaluate(async (r) => {
      await (window as any).flow.threads.create({ projectRoot: r, title: 'Plain detour' })
    }, root)
    await window.waitForTimeout(1200)

    // First open: the chip shows with its count.
    await openSidebarThread(window, 'Chip source')
    const chip = window.locator('button.fl-bgactivity-strip')
    await expect(chip).toBeVisible()
    await expect(chip.locator('.fl-bgactivity-strip-count')).toHaveText('1')
    await evidence(window, 'dod1-chip-first-open')

    // Away: a thread with no background work shows no chip.
    await openSidebarThread(window, 'Plain detour')
    await expect(chip).toBeHidden()

    // …and back: the chip is derived from the open thread's persisted rows, so
    // it returns with the same count — not a one-shot cache.
    await openSidebarThread(window, 'Chip source')
    await expect(chip).toBeVisible()
    await expect(chip.locator('.fl-bgactivity-strip-count')).toHaveText('1')
    await evidence(window, 'dod1-chip-back-again')
  } finally {
    cleanupSeeds()
  }
})

test('a thread whose sub-agents have finished shows no activity chip, and the chat holds them', async ({
  window,
  userDataDir,
}) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'subagent-chip-finished-')
    await activateProject(window, root)
    // Two threads, one spawn each: one still running, one finished. The pair is
    // what makes the absence evidence rather than an empty app — the strip is
    // proven to appear in this very build before it is expected to be gone
    // (allowed-pattern #28, and the shadow-DOM lesson of e2e-absence lies).
    await seedAgentThread(window, userDataDir, root, 'Still running', {
      callId: 'call-live',
      description: 'Map backend notification system',
      status: 'running',
    })
    await seedAgentThread(window, userDataDir, root, 'All finished', {
      callId: 'call-done',
      description: 'Map frontend notification system',
      status: 'success',
    })
    await window.waitForTimeout(1200)

    const chip = window.locator('button.fl-bgactivity-strip')
    await openSidebarThread(window, 'Still running')
    await expect(chip).toBeVisible()

    // THE REPORT (user, 2026-10-13): the strip stayed up after the sub-agents
    // finished, reading as something still running.
    await openSidebarThread(window, 'All finished')
    await expect(chip).toBeHidden()

    // AND NOTHING WAS LOST WITH IT: the finished spawn is a one-line chip in
    // the transcript, at the point it happened, and it names the sub-agent.
    // In Compact the settled request folds into one work row, so the row and
    // its step open first — the same two presses the user's own screenshot of
    // the folded "Worked 8 min" row shows.
    await window.locator('.fl-conv-feed .fl-request-row-header').first().click()
    await window.locator('.fl-conv-feed .fl-request-row-step-header').first().click()
    await window.waitForTimeout(500)
    const line = window.locator('.fl-conv-feed .fl-tool-card.fl-tool-subagent-chip')
    await expect(line).toHaveCount(1)
    await expect(line).toContainText('Map frontend notification system')
    await evidence(window, 'finished-subagents-no-chip')
  } finally {
    cleanupSeeds()
  }
})

test('promotion nests the child under its parent, and back-nav works both ways (DoD 2/6)', async ({
  window,
  userDataDir,
}) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'subagent-nesting-')
    await activateProject(window, root)
    await seedAgentThread(window, userDataDir, root, 'Nesting source', {
      callId: 'call-nest',
      description: 'Deep research pass',
    })
    await openSidebarThread(window, 'Nesting source')

    // Promote: open the finished sub-agent from its line in the conversation.
    const line = await subagentLineInChat(window, 'Deep research pass')
    await line.locator('.fl-tool-line').click()
    await window.waitForTimeout(2000)

    // The main pane is on the child.
    const banner = window.locator('.fl-conv-subagent-banner')
    await expect(banner).toBeVisible()
    await expect(banner).toContainText('Continuing from sub-agent: Deep research pass')

    // ── NESTED, NOT LOOSE, NO DUPES (DoD 6) ─────────────────────────────────
    // The child renders as the ↳ child row under its parent — exactly one row
    // anywhere in the sidebar carries its title: a duplicate in the top-level
    // list (a child served without `parent_thread_id` filtering) would make
    // this count 2.
    //
    // #1931 follow-up: a FINISHED child folds behind a disclosure chevron ON
    // THE PARENT THREAD ROW — no extra rows of its own. It is visible RIGHT
    // NOW only because it is the selection — the fold must never hide the
    // open thread.
    const childRow = window.locator('.fl-thread-list fl-list .row', {
      hasText: 'Deep research pass',
    })
    await expect(childRow).toHaveCount(1)
    await expect(childRow.first()).toContainText('↳')
    // Nested means BELOW its parent row in the tree.
    const parentRow = window
      .locator('.fl-thread-list fl-list .row', { hasText: 'Nesting source' })
      .first()
    // The parent thread row carries the chevron — the fold's single control.
    const chevron = parentRow.locator('.fl-children-toggle')
    await expect(chevron).toHaveCount(1)
    const parentBox = await parentRow.boundingBox()
    const childBox = await childRow.first().boundingBox()
    expect(parentBox).not.toBeNull()
    expect(childBox).not.toBeNull()
    expect(childBox!.y).toBeGreaterThan(parentBox!.y)
    await evidence(window, 'dod6-child-nested-under-parent')

    // ── BACK LINK → PARENT (DoD 2a) ─────────────────────────────────────────
    await banner.locator('.fl-conv-subagent-banner-back').click()
    await window.waitForTimeout(2000)
    await expect(banner).toBeHidden()
    // The parent's own transcript — including the spawn message — is back, and
    // the re-homed sub-agent row is NOT in it (it belongs to the child now).
    const feed = window.locator('.fl-conv-feed')
    await expect(feed).toContainText('Spawned a research sub-agent.')
    await expect(feed).not.toContainText('Inner sub-agent finding')
    await evidence(window, 'dod2-back-link-parent')

    // ── FINISHED CHILDREN DECLUTTER (#1931 follow-up) ───────────────────────
    // With the selection back on the parent, the finished child folds away
    // entirely — ZERO extra rows beneath the thread; the parent row's chevron
    // is the single entry point.
    await expect(childRow).toHaveCount(0)
    await expect(chevron).toHaveCount(1)
    await evidence(window, 'followup-children-collapsed')

    // ── SIDEBAR CHILD ROW → CHILD (DoD 2b) ──────────────────────────────────
    // Expand via the parent row's chevron first, then open the revealed child
    // row. The chevron itself must NOT navigate — the pane stays on the parent.
    await chevron.click()
    await window.waitForTimeout(500)
    await expect(banner).toBeHidden()
    await expect(feed).toContainText('Spawned a research sub-agent.')
    await expect(childRow).toHaveCount(1)
    // Label-area click — the finished child row carries a right-edge hover ✕.
    await childRow.first().click({ position: { x: 60, y: 14 } })
    await window.waitForTimeout(2000)
    await expect(banner).toBeVisible()
    await expect(feed).toContainText('Inner sub-agent finding')
    await evidence(window, 'dod2-sidebar-child-row')

    // ── SIDEBAR PARENT ROW → PARENT (DoD 2b) ────────────────────────────────
    await parentRow.click({ position: { x: 40, y: 14 } })
    await window.waitForTimeout(2000)
    await expect(banner).toBeHidden()
    await expect(feed).toContainText('Spawned a research sub-agent.')

    // ── HOVER ✕ DISMISSES A FINISHED CHILD (#1931 follow-up) ────────────────
    // The group is still expanded from the chevron click above, so the child
    // row shows with the parent selected. Hover reveals the ✕ (the same
    // fl-row-hover idiom the top-level rows use); pressing it ARCHIVES the
    // child: the row vanishes entirely, and — as the LAST finished child —
    // takes the thread-row caret with it (nothing foldable).
    await expect(childRow).toHaveCount(1)
    const dismiss = childRow.first().locator('button[aria-label="Dismiss"]')
    await childRow.first().hover()
    await expect(dismiss).toBeVisible()
    await dismiss.click()
    await window.waitForTimeout(1500)
    await expect(childRow).toHaveCount(0)
    await expect(parentRow.locator('.fl-children-toggle')).toHaveCount(0)
    await evidence(window, 'followup-dismiss-x')

    // Still reachable from its line in the chat — and re-opening UN-ARCHIVES
    // it (openSubagentThread), so the ↳ row returns, selected. This is the
    // promise the sidebar's Dismiss tooltip makes, and the reason that tooltip
    // now names the chat rather than the activity strip.
    const reopenLine = await subagentLineInChat(window, 'Deep research pass')
    await reopenLine.locator('.fl-tool-line').click()
    await window.waitForTimeout(2000)
    await expect(banner).toBeVisible()
    await expect(childRow).toHaveCount(1)

    // ── DISMISS WHILE SELECTED → BACK TO PARENT ─────────────────────────────
    // Dismissing the conversation ON SCREEN walks back to the parent through
    // the banner's own back path — the pane never sits on a hidden thread.
    await childRow.first().hover()
    await childRow.first().locator('button[aria-label="Dismiss"]').click()
    await window.waitForTimeout(2500)
    await expect(banner).toBeHidden()
    await expect(feed).toContainText('Spawned a research sub-agent.')
    await expect(childRow).toHaveCount(0)
    await evidence(window, 'followup-dismiss-selected')
  } finally {
    cleanupSeeds()
  }
})

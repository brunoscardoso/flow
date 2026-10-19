/**
 * ONE WORK ROW PER REQUEST (plan_chat-cleanup, FR-1–FR-6).
 *
 * A request that speaks before every tool round used to render as N pairs of
 * "a sentence + Ran N tools", with the model name under each sentence. In
 * Compact it is now: the person's message, ONE work row
 * (`Worked … · 3 tools · 1 failed …  Opus 4.8`), the final answer.
 *
 * Seeded into the store with the sqlite3 CLI (better-sqlite3 is built for
 * Electron's ABI and does not load in Playwright's Node), as chat-feed-signal
 * does. The final answer carries the stored turn-end mark (`ends_turn = 1`).
 *
 * Phase 6 cases: wake-ups (`No change.` hidden, a real reply replaces the
 * answer), cards outside the fold, Detailed and Balanced.
 */
import { test, expect } from '../fixtures/electron'
import type { Page } from '@playwright/test'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

const STEPS = [
  'Discovery is clear. Let me read the backend files first.',
  'Backend is clear. Now the frontend wiring.',
  'I have every quote I need. Let me write the plan.',
]
const ANSWER = 'Plan created: 3 phases, 7 change notes. Review the notes, then execute the plan.'

test('a request folds into one work row with the answer under it', async ({ window, userDataDir }) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'orbit-app-')
    await activateProject(window, root)
    const threadId: string = await window.evaluate(async (r) => {
      const t = await (window as any).flow.threads.create({ projectRoot: r, title: 'Request fold' })
      return t.id
    }, root)
    await window.waitForTimeout(1200)

    const { execFileSync } = await import('node:child_process')
    const { join } = await import('node:path')
    const dbPath = join(userDataDir, 'flow.db')
    const t0 = Date.parse('2026-10-08T12:00:00.000Z')
    const iso = (seconds: number): string => new Date(t0 + seconds * 1000).toISOString()
    const q = (v: string): string => `'${v.replace(/'/g, "''")}'`
    const message = (id: string, role: string, content: string, at: number, endsTurn = 0): string =>
      `INSERT INTO messages (id,thread_id,role,content,created_at,model,ends_turn) VALUES (${q(id)},${q(threadId)},${q(role)},${q(content)},${q(iso(at))},${role === 'assistant' ? q('claude-opus-4-8') : 'NULL'},${endsTurn});`
    const tool = (id: string, messageId: string, command: string, status: string, at: number): string =>
      `INSERT INTO tool_calls (id,thread_id,message_id,tool_name,input_json,output_json,status,started_at,completed_at) VALUES (${q(id)},${q(threadId)},${q(messageId)},'Bash',${q(JSON.stringify({ command }))},'"ok"',${q(status)},${q(iso(at))},${q(iso(at + 1))});`
    const sql = [
      message('u1', 'user', '/create-plan @flow/discovery/discovery_sort_v1.md', 0),
      message('s1', 'assistant', STEPS[0], 10),
      tool('c1', 's1', 'cat backend/views.py', 'success', 11),
      message('s2', 'assistant', STEPS[1], 60),
      tool('c2', 's2', 'cat frontend/hooks.ts', 'success', 61),
      message('s3', 'assistant', STEPS[2], 120),
      tool('c3', 's3', 'git commit -m plan', 'error', 121),
      message('a1', 'assistant', ANSWER, 360, 1),
    ].join('\n')
    execFileSync('sqlite3', [dbPath], { input: sql })

    // Open the thread so its history loads from the store.
    const thread = window.getByText('Request fold', { exact: true }).first()
    await thread.waitFor({ timeout: 20_000 })
    await thread.click()
    await window.locator('.fl-conv-entry').first().waitFor({ timeout: 20_000 })
    await window.waitForTimeout(1000)

    // ── Closed: ONE row for the whole request, then the answer ─────────────
    const rows = window.locator('.fl-request-row')
    await expect(rows).toHaveCount(1)
    const header = rows.first().locator('.fl-request-row-header')
    const label = (await header.textContent()) ?? ''
    expect(label).toContain('Worked 6 min')
    expect(label).toContain('3 tools')
    expect(label).toContain('1 failed')
    // The model once, on the row — never under each message (FR-4).
    await expect(rows.first().locator('.fl-request-row-model')).toHaveText('Opus 4.8')
    await expect(window.locator('.fl-conv-model-badge')).toHaveCount(0)
    // Positive first: the answer IS shown, so the absences below are evidence.
    await expect(window.getByText(ANSWER)).toBeVisible()
    for (const step of STEPS) await expect(window.getByText(step, { exact: true })).toBeHidden()
    // No per-message turn rows in Compact any more.
    await expect(window.locator('.fl-conv-entry-turn')).toHaveCount(0)

    // The failure is tinted on the closed row.
    const tint = await window.evaluate(() => {
      const el = document.querySelector('.fl-request-row-header .fl-request-row-failed')
      if (el === null) return null
      const probe = document.createElement('span')
      probe.style.color = 'var(--fl-color-error)'
      document.body.appendChild(probe)
      const expected = getComputedStyle(probe).color
      probe.remove()
      return { actual: getComputedStyle(el).color, expected }
    })
    expect(tint).not.toBeNull()
    expect(tint?.actual).toBe(tint?.expected)

    await window.locator('.fl-conv-scroller, .fl-conversation').first().screenshot({
      path: 'e2e/results/chat-request-fold.png',
    }).catch(async () => window.screenshot({ path: 'e2e/results/chat-request-fold.png' }))

    // ── Opened: the numbered steps, each with its count ────────────────────
    await header.click()
    const steps = rows.first().locator('.fl-request-row-step')
    await expect(steps).toHaveCount(3)
    await expect(steps.nth(0).locator('.fl-request-row-step-text')).toHaveText(STEPS[0])
    await expect(steps.nth(0).locator('.fl-request-row-step-count')).toHaveText('1 tool')
    await expect(steps.nth(2).locator('.fl-request-row-step-count')).toHaveText(/1 tool.*1 failed/)
    await expect(steps.nth(2)).toHaveClass(/failed/)
    // A step opens to its message and its tools, built on open.
    await steps.nth(2).locator('.fl-request-row-step-header').click()
    await expect(steps.nth(2).locator('.fl-request-row-step-detail .fl-conv-entry-tool').first()).toBeVisible()

    await window.screenshot({ path: 'e2e/results/chat-request-fold-open.png' })
  } finally {
    cleanupSeeds()
  }
})

test('a live request is one live row whose second line is the newest step', async ({ app, window }) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'orbit-app-')
    await activateProject(window, root)
    const threadId: string = await window.evaluate(async (r) => {
      const t = await (window as any).flow.threads.create({ projectRoot: r, title: 'Live fold' })
      return t.id
    }, root)
    const thread = window.getByText('Live fold', { exact: true }).first()
    await thread.waitFor({ timeout: 20_000 })
    await thread.click()
    await window.waitForTimeout(1000)

    // Two spoken blocks, each with a tool, as the bridge streams them.
    await app.evaluate(({ BrowserWindow }, id) => {
      const w = BrowserWindow.getAllWindows()[0]
      const send = (e: unknown): void => w?.webContents.send('threads:stream', e)
      const call = (n: number, status: string): unknown => ({
        id: `lc${n}`,
        threadId: id,
        messageId: `lm${n}`,
        toolName: 'Bash',
        inputJson: JSON.stringify({ command: `ls ${n}` }),
        outputJson: null,
        status,
        startedAt: new Date().toISOString(),
        completedAt: null,
      })
      send({ kind: 'status', threadId: id, status: 'working' })
      send({ kind: 'model', threadId: id, model: 'claude-opus-4-8' })
      send({ kind: 'message-start', threadId: id, messageId: 'lm1' })
      send({ kind: 'message-delta', threadId: id, messageId: 'lm1', text: 'Reading the backend files.\nMore detail.' })
      send({ kind: 'tool-start', threadId: id, toolCall: call(1, 'running') })
      send({ kind: 'tool-end', threadId: id, toolCall: { ...(call(1, 'error') as object), completedAt: new Date().toISOString() } })
      send({ kind: 'message-start', threadId: id, messageId: 'lm2' })
      send({ kind: 'message-delta', threadId: id, messageId: 'lm2', text: 'Reading the **frontend** hooks…' })
      send({ kind: 'tool-start', threadId: id, toolCall: call(2, 'running') })
    }, threadId)
    await window.waitForTimeout(800)

    const rows = window.locator('.fl-request-row')
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toHaveClass(/live/)
    const header = (await rows.first().locator('.fl-request-row-header').textContent()) ?? ''
    expect(header).toContain('Working')
    expect(header).toContain('2 tools')
    expect(header).toContain('1 failed')
    await expect(rows.first().locator('.fl-request-row-now')).toHaveText('Reading the frontend hooks…')
    // The text is inside the row, not appended to the feed as a message.
    await expect(window.locator('.fl-conv-feed > .fl-conv-entry-assistant, .fl-conv-entry-assistant:visible')).toHaveCount(0)
    await expect(window.getByText('Reading the backend files.', { exact: true })).toBeHidden()
    // No second "Working…" loader under a row that already pulses.
    const loader = await window.evaluate(() => {
      const el = document.querySelector('.fl-conv-activity') as HTMLElement | null
      return el === null ? null : !el.hidden
    })
    expect(loader).toBe(false)
    await window.screenshot({ path: 'e2e/results/chat-request-fold-live.png' })
  } finally {
    cleanupSeeds()
  }
})

// ── Phase 6 extensions ─────────────────────────────────────────────────────
//
// Each case below seeds the same three-step request as the first test, adds
// what it is about, and opens the thread by its title (the list row selector
// finds a row whose list then empties in this environment).


/** The SQL builders for one thread, closed over its id. */
function sqlFor(threadId: string): {
  message: (id: string, role: string, content: string, at: number, endsTurn?: number) => string
  tool: (id: string, messageId: string, command: string, status: string, at: number) => string
  base: () => string[]
} {
  const t0 = Date.parse('2026-10-08T12:00:00.000Z')
  const iso = (seconds: number): string => new Date(t0 + seconds * 1000).toISOString()
  const q = (v: string): string => `'${v.replace(/'/g, "''")}'`
  const message = (id: string, role: string, content: string, at: number, endsTurn = 0): string =>
    `INSERT INTO messages (id,thread_id,role,content,created_at,model,ends_turn) VALUES (${q(id)},${q(threadId)},${q(role)},${q(content)},${q(iso(at))},${role === 'assistant' ? q('claude-opus-4-8') : 'NULL'},${endsTurn});`
  const tool = (id: string, messageId: string, command: string, status: string, at: number): string =>
    `INSERT INTO tool_calls (id,thread_id,message_id,tool_name,input_json,output_json,status,started_at,completed_at) VALUES (${q(id)},${q(threadId)},${q(messageId)},'Bash',${q(JSON.stringify({ command }))},'"ok"',${q(status)},${q(iso(at))},${q(iso(at + 1))});`
  const base = (): string[] => [
    message('u1', 'user', '/create-plan @flow/discovery/discovery_sort_v1.md', 0),
    message('s1', 'assistant', STEPS[0], 10),
    tool('c1', 's1', 'cat backend/views.py', 'success', 11),
    message('s2', 'assistant', STEPS[1], 60),
    tool('c2', 's2', 'cat frontend/hooks.ts', 'success', 61),
    message('s3', 'assistant', STEPS[2], 120),
    tool('c3', 's3', 'git commit -m plan', 'error', 121),
    message('a1', 'assistant', ANSWER, 360, 1),
  ]
  return { message, tool, base }
}

/** Create a thread, seed the base request plus `extra`, and open it. */
async function seedAndOpen(
  window: Page,
  userDataDir: string,
  title: string,
  extra: (s: ReturnType<typeof sqlFor>) => string[] = () => [],
  density: 'compact' | 'balanced' | 'detailed' = 'compact',
): Promise<string> {
  const root = await seedProject(window, 'orbit-app-')
  await activateProject(window, root)
  const threadId: string = await window.evaluate(async ({ r, t }) => {
    const created = await (window as any).flow.threads.create({ projectRoot: r, title: t })
    return created.id
  }, { r: root, t: title })
  await window.waitForTimeout(1200)
  const s = sqlFor(threadId)
  const { execFileSync } = await import('node:child_process')
  const { join } = await import('node:path')
  execFileSync('sqlite3', [join(userDataDir, 'flow.db')], { input: [...s.base(), ...extra(s)].join('\n') })
  if (density !== 'compact') await setDensity(window, density)
  const thread = window.getByText(title, { exact: true }).first()
  await thread.waitFor({ timeout: 20_000 })
  await thread.click()
  await window.locator('.fl-conv-entry').first().waitFor({ timeout: 20_000 })
  await window.waitForTimeout(1000)
  return threadId
}

/** Change density through the control a person uses. */
async function setDensity(window: Page, density: 'compact' | 'balanced' | 'detailed'): Promise<void> {
  await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
  await window.locator('.fl-settings-tab', { hasText: 'App' }).click()
  await window.locator('select[aria-label="Conversation density"]').selectOption(density)
  await window.keyboard.press('Escape')
  await window.waitForTimeout(800)
}

/** The text of every assistant entry a reader sees OUTSIDE a work row. */
async function shownOutsideRows(window: Page): Promise<string[]> {
  return window.evaluate(() =>
    Array.from(document.querySelectorAll('.fl-conv-entry-assistant'))
      .filter((el) => el.closest('.fl-request-row') === null && (el as HTMLElement).offsetParent !== null)
      .map((el) => (el.textContent ?? '').trim()),
  )
}

test('a wake-up that ends with exactly "No change." is not shown; the answer stays', async ({ window, userDataDir }) => {
  test.setTimeout(180_000)
  try {
    await seedAndOpen(window, userDataDir, 'Wake no change', (s) => [
      s.message('w1', 'assistant', 'The helpers reported. Checking the notes again.', 900),
      s.tool('c4', 'w1', 'cat flow/plans/plan_sort_v1.md', 'success', 901),
      s.message('w2', 'assistant', 'No change.', 960, 1),
    ])
    // Positive first: the earlier answer IS shown, outside the row.
    const shown = await shownOutsideRows(window)
    expect(shown.some((text) => text.includes(ANSWER))).toBe(true)
    // …and the wake-up's tools joined the one row.
    await expect(window.locator('.fl-request-row')).toHaveCount(1)
    expect((await window.locator('.fl-request-row-header').textContent()) ?? '').toContain('4 tools')
    // The exact `No change.` reply is nowhere a reader sees it.
    expect(shown.some((text) => text === 'No change.' || text.includes('No change.'))).toBe(false)
    await expect(window.getByText('No change.', { exact: true })).toHaveCount(0)
    await window.screenshot({ path: 'e2e/results/chat-request-fold-no-change.png' })
  } finally {
    cleanupSeeds()
  }
})

const NEW_ANSWER = 'The helpers found two more call sites. Plan updated: 3 phases, 9 change notes.'

test('a wake-up with a real reply replaces the shown answer; the earlier one is a step', async ({ window, userDataDir }) => {
  test.setTimeout(180_000)
  try {
    await seedAndOpen(window, userDataDir, 'Wake new answer', (s) => [
      s.tool('c4', 'a1', 'cat flow/plans/plan_sort_v1.md', 'success', 901),
      s.message('w1', 'assistant', NEW_ANSWER, 960, 1),
    ])
    // Positive first: the new answer is shown, outside the row.
    const shown = await shownOutsideRows(window)
    expect(shown.some((text) => text.includes(NEW_ANSWER))).toBe(true)
    // The earlier answer is no longer shown as THE answer.
    expect(shown.some((text) => text.includes(ANSWER))).toBe(false)
    const row = window.locator('.fl-request-row')
    await expect(row).toHaveCount(1)
    // …it is inside the row, as a step.
    await row.locator('.fl-request-row-header').click()
    const steps = row.locator('.fl-request-row-step')
    await expect(steps).toHaveCount(4)
    await expect(steps.nth(3).locator('.fl-request-row-step-text')).toHaveText(ANSWER)
    await expect(steps.nth(3).locator('.fl-request-row-step-count')).toHaveText('1 tool')
    await window.screenshot({ path: 'e2e/results/chat-request-fold-new-answer.png' })
  } finally {
    cleanupSeeds()
  }
})

test('a question and a permission ask mid-request stay outside the fold', async ({ app, window }) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'orbit-app-')
    await activateProject(window, root)
    const threadId: string = await window.evaluate(async (r) => {
      const t = await (window as any).flow.threads.create({ projectRoot: r, title: 'Card fold' })
      return t.id
    }, root)
    const thread = window.getByText('Card fold', { exact: true }).first()
    await thread.waitFor({ timeout: 20_000 })
    await thread.click()
    await window.waitForTimeout(1000)

    const stream = async (events: unknown[]): Promise<void> => {
      await app.evaluate(({ BrowserWindow }, list) => {
        const w = BrowserWindow.getAllWindows()[0]
        for (const e of list) w?.webContents.send('threads:stream', e)
      }, events)
    }
    const call = (n: number, status: string): unknown => ({
      id: `qc${n}`,
      threadId,
      messageId: `qm${n}`,
      toolName: 'Bash',
      inputJson: JSON.stringify({ command: `ls ${n}` }),
      outputJson: null,
      status,
      startedAt: new Date().toISOString(),
      completedAt: null,
    })
    await stream([
      { kind: 'status', threadId, status: 'working' },
      { kind: 'model', threadId, model: 'claude-opus-4-8' },
      { kind: 'message-start', threadId, messageId: 'qm1' },
      { kind: 'message-delta', threadId, messageId: 'qm1', text: 'Reading the backend files.' },
      { kind: 'tool-start', threadId, toolCall: call(1, 'running') },
    ])
    await window.waitForTimeout(500)
    await app.evaluate(({ BrowserWindow }, id) => {
      const w = BrowserWindow.getAllWindows()[0]
      w?.webContents.send('threads:dialogRequest', {
        requestId: 'fold-ask-1',
        threadId: id,
        questions: [
          {
            question: 'Which rollout strategy should I use?',
            header: 'Rollout',
            multiSelect: false,
            options: [
              { label: 'Canary', description: 'Ship to 5% of traffic first' },
              { label: 'Big bang', description: 'Ship to everyone now' },
            ],
          },
        ],
      })
      w?.webContents.send('threads:permissionRequest', {
        requestId: 'fold-perm-1',
        threadId: id,
        toolName: 'Bash',
        summary: 'rm -rf ./tmp',
        input: { command: 'rm -rf ./tmp' },
      })
    }, threadId)
    await window.waitForTimeout(800)

    // Positive first: the request IS folded into its live row, and both cards are on screen.
    const row = window.locator('.fl-request-row')
    await expect(row).toHaveCount(1)
    await expect(row.first()).toHaveClass(/live/)
    await expect(window.locator('.fl-qcard')).toBeVisible()
    await expect(window.locator('.fl-permission-card')).toBeVisible()
    // …and neither card is inside the fold.
    await expect(window.locator('.fl-request-row .fl-qcard')).toHaveCount(0)
    await expect(window.locator('.fl-request-row .fl-permission-card')).toHaveCount(0)

    // The work goes on after the ask; the cards stay where they are, visible.
    await stream([
      { kind: 'message-start', threadId, messageId: 'qm2' },
      { kind: 'message-delta', threadId, messageId: 'qm2', text: 'Reading the frontend hooks.' },
      { kind: 'tool-start', threadId, toolCall: call(2, 'running') },
    ])
    await window.waitForTimeout(800)
    await expect(window.locator('.fl-qcard')).toBeVisible()
    await expect(window.locator('.fl-request-row .fl-qcard')).toHaveCount(0)
    await window.screenshot({ path: 'e2e/results/chat-request-fold-cards.png' })
  } finally {
    cleanupSeeds()
  }
})

test('Detailed shows every tool and the model under each message', async ({ window, userDataDir }) => {
  test.setTimeout(180_000)
  try {
    await seedAndOpen(window, userDataDir, 'Detailed fold', () => [], 'detailed')
    // Positive first: every message and every tool is on screen.
    for (const step of STEPS) await expect(window.getByText(step, { exact: true })).toBeVisible()
    await expect(window.getByText(ANSWER)).toBeVisible()
    await expect(window.locator('.fl-tool-card')).toHaveCount(3)
    // The model under each of the four assistant messages.
    const badges = window.locator('.fl-conv-model-badge')
    await expect(badges).toHaveCount(4)
    await expect(badges.first()).toHaveText('Opus 4.8')
    // Nothing folded at this density.
    await expect(window.locator('.fl-request-row')).toHaveCount(0)
    await expect(window.locator('.fl-conv-entry-turn')).toHaveCount(0)
    await window.screenshot({ path: 'e2e/results/chat-request-fold-detailed.png' })
  } finally {
    cleanupSeeds()
  }
})

test('Balanced keeps the per-message turn rows, with no model badge', async ({ window, userDataDir }) => {
  test.setTimeout(180_000)
  try {
    await seedAndOpen(window, userDataDir, 'Balanced fold', () => [], 'balanced')
    // Positive first: every step's message is shown, each with its own turn row.
    for (const step of STEPS) await expect(window.getByText(step, { exact: true })).toBeVisible()
    await expect(window.getByText(ANSWER)).toBeVisible()
    const turns = window.locator('.fl-conv-entry-turn')
    await expect(turns).toHaveCount(3)
    await expect(turns.nth(2)).toContainText('1 failed')
    // No request row, and the model is not repeated under each message.
    await expect(window.locator('.fl-request-row')).toHaveCount(0)
    await expect(window.locator('.fl-conv-model-badge')).toHaveCount(0)
    await window.screenshot({ path: 'e2e/results/chat-request-fold-balanced.png' })
  } finally {
    cleanupSeeds()
  }
})

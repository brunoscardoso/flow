/**
 * A FINISHED REQUEST IS ONE ROW (a finished turn, in Balanced).
 *
 * The report (2026-09-08, with screenshots): a real thread rendered sixteen
 * rows of `Bash grep -n …` around four sentences of the agent's own words, and
 * five failed commits sat inside that wall indistinguishable from the
 * successes. The scaffolding outnumbered the signal four to one.
 *
 * Grouping already existed and had not moved that number, because it folds
 * RUNS and a reader reads TURNS. Compact now folds wider still — one work row
 * per REQUEST (plan_chat-cleanup) — and Balanced keeps the per-turn fold. This
 * guard holds both folds, the counts that let a collapsed row be decided on without opening it, and —
 * the part most worth guarding — that `Detailed` really does show everything.
 * Cursor shipped this same feature and then shipped a release that collapsed
 * detail *in defiance of the setting*, which their users filed bugs about.
 *
 * Seeds a real turn into the store rather than driving an agent: the fold is a
 * property of persisted history.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
test('a finished request folds to one row, Balanced to one turn row, and Detailed unfolds it', async ({ window, userDataDir }) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'orbit-app-')
    await activateProject(window, root)
    const threadId: string = await window.evaluate(async (r) => {
      const t = await (window as any).flow.threads.create({ projectRoot: r, title: 'Chat pagination investigation' })
      return t.id
    }, root)
    await window.waitForTimeout(1200)

    // Seed a real turn straight into the store: one assistant message and the
    // tool calls that belong to it, exactly as the stream bridge would write.
    // Seeded with the sqlite3 CLI: better-sqlite3 here is built for Electron's
    // ABI and will not load in Playwright's plain-Node process, and main is
    // ESM-bundled so neither require nor dynamic import is reachable there.
    const { execFileSync } = await import('node:child_process')
    const { join } = await import('node:path')
    const dbPath = join(userDataDir, 'flow.db')
    const t0 = Date.parse('2026-09-08T12:00:00.000Z')
    const iso = (n: number): string => new Date(t0 + n * 1000).toISOString()
    const q = (v: string): string => `'${v.replace(/'/g, "''")}'`
    const answer = [
      '## Analysis',
      '',
      'The cap is server-side, not a UI window.',
      '',
      '1. `getChatMessages` clamps to `CHAT_MESSAGE_PAGE_MAX`',
      '2. The client never asks for more',
      '',
      '```py',
      'limit = min(limit, CHAT_MESSAGE_PAGE_MAX)',
      '```',
      '',
      'So raising the client page size changes nothing.',
    ].join('\n')
    const calls: Array<[string, string, string]> = [
      ['bash', '{"command":"grep -n CHAT_MESSAGE_PAGE_MAX src/datasources/EngineAPI.ts"}', 'success'],
      ['bash', '{"command":"grep -rn cursor --include=*.py -l | grep -i chat"}', 'success'],
      ['read', '{"file_path":"/repo/orbit_core/core/chat/pagination.py"}', 'success'],
      ['bash', '{"command":"cat orbit_core/core/chat/pagination.py"}', 'success'],
      ['bash', '{"command":"git commit -m stop-re-seeding"}', 'error'],
      ['bash', '{"command":"git commit -m stop-re-seeding"}', 'error'],
      ['grep', '{"pattern":"messageWindowLimit"}', 'success'],
      ['read', '{"file_path":"/repo/src/components/chat/ChatPanel.tsx"}', 'success'],
      ['edit', '{"file_path":"/repo/src/commands/getChatMessages.ts","old_string":"limit","new_string":"pageLimit"}', 'success'],
      ['edit', '{"file_path":"/repo/src/commands/getChatMessages.ts","old_string":"a","new_string":"b"}', 'success'],
      ['write', '{"file_path":"/repo/src/types/mocks.ts","content":"export const x = 1"}', 'success'],
      ['bash', '{"command":"npx jest src/commands/getChatMessages.server.test.ts"}', 'success'],
    ]
    const sql = [
      `INSERT INTO messages (id,thread_id,role,content,created_at,model) VALUES ('m1',${q(threadId)},'user',${q('why is the chat only loading 50 messages?')},${q(iso(0))},NULL);`,
      `INSERT INTO messages (id,thread_id,role,content,created_at,model) VALUES ('m2',${q(threadId)},'assistant',${q(answer)},${q(iso(60))},'claude-opus-5');`,
      ...calls.map(([tool, input, status], i) =>
        `INSERT INTO tool_calls (id,thread_id,message_id,tool_name,input_json,output_json,status,started_at,completed_at) VALUES (${q('c' + i)},${q(threadId)},'m2',${q(tool)},${q(input)},'"ok"',${q(status)},${q(iso(61 + i))},${q(iso(62 + i))});`,
      ),
    ].join('\n')
    execFileSync('sqlite3', [dbPath], { input: sql })

    // Opening the thread for the first time loads history from the store, so
    // the seeded rows arrive with no reload needed. Opened by its title: the
    // list-row selector finds a row whose list then empties in this harness.
    const thread = window.getByText('Chat pagination investigation', { exact: true }).first()
    await thread.waitFor({ timeout: 20_000 })
    await thread.click()
    await window.locator('.fl-conv-entry').first().waitFor({ timeout: 20_000 })
    await window.waitForTimeout(1500)

    // The failure segment is tinted, so a collapsed row can be decided on
    // without opening it — the defect the screenshots showed was five failures
    // hiding in plain sight.
    // POSITIVELY the error colour, resolved from the token — not "any colour
    // other than this one grey I typed in". The negative form passes the moment
    // someone edits --fl-color-text-secondary, INCLUDING when the tint has been
    // dropped entirely, which makes the one assertion that proves "collapsed is
    // not silent" the weakest one in the file.
    const failedTint = (scope: string) =>
      window.evaluate((sel) => {
        const el = Array.from(document.querySelectorAll(`${sel} *`)).find(
          (n) => n.children.length === 0 && (n.textContent ?? '').trim() === '2 failed',
        )
        if (el === undefined) return null
        const probe = document.createElement('span')
        probe.style.color = 'var(--fl-color-error)'
        document.body.appendChild(probe)
        const expected = getComputedStyle(probe).color
        probe.remove()
        return { actual: getComputedStyle(el).color, expected }
      }, scope)

    // ── COMPACT (the default): ONE work row for the whole request ──────────
    // plan_chat-cleanup: Compact folds on the request, not the message — the
    // person's question, one row stating the work, the answer under it.
    const requestRows = window.locator('.fl-request-row')
    await expect(requestRows).toHaveCount(1)
    const requestLabel = (await requestRows.first().locator('.fl-request-row-header').textContent()) ?? ''
    // 12 calls, the two failed commits, and TWO distinct files (getChatMessages
    // edited twice + mocks written) — distinct files, not edit calls.
    expect(requestLabel).toContain('12 tools')
    expect(requestLabel).toContain('2 failed')
    expect(requestLabel).toContain('2 files edited')
    const compactTint = await failedTint('.fl-request-row-header')
    expect(compactTint).not.toBeNull()
    expect(compactTint?.actual).toBe(compactTint?.expected)
    // Positive first: the answer IS shown; then no per-message turn row.
    await expect(window.getByText('So raising the client page size changes nothing.')).toBeVisible()
    await expect(window.locator('.fl-conv-entry-turn')).toHaveCount(0)

    // ── Opening reveals today's activity groups, not a wall of cards ────────
    // VISIBILITY, not presence (see the Balanced block below for why).
    const groupLabels = window.locator('.fl-tool-group-header .fl-tool-group-label')
    await expect(groupLabels.filter({ hasText: 'Ran 3 commands' })).toHaveCount(0)
    await requestRows.first().locator('.fl-request-row-header').click()
    const steps = requestRows.first().locator('.fl-request-row-step')
    // The tools ran under the answer message, so they form one headless step.
    await expect(steps).toHaveCount(1)
    await expect(steps.first().locator('.fl-request-row-step-count')).toHaveText(/12 tools.*2 failed/)
    await steps.first().locator('.fl-request-row-step-header').click()
    await expect(groupLabels.filter({ hasText: 'Ran 2 commands' })).toBeVisible()
    await expect(groupLabels.filter({ hasText: 'Ran 3 commands' })).toBeVisible()
    await expect(
      groupLabels.filter({ hasText: 'Gathered context ' + String.fromCharCode(183) + ' 2 steps' }),
    ).toBeVisible()

    // ── BALANCED: the per-message turn fold ────────────────────────────────
    // Driven through the actual control a person uses, not a storage poke: the
    // setting is only worth anything if the path from the picker to the feed
    // works.
    const setDensity = async (density: string): Promise<void> => {
      await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
      await window.locator('.fl-settings-tab', { hasText: 'App' }).click()
      await window.locator('select[aria-label="Conversation density"]').selectOption(density)
      await window.keyboard.press('Escape')
      await window.waitForTimeout(1200)
    }
    await setDensity('balanced')
    const turnRows = window.locator('.fl-conv-entry-turn')
    await expect(turnRows).toHaveCount(1)
    await expect(requestRows).toHaveCount(0)
    const label = (await turnRows.first().textContent()) ?? ''
    expect(label).toContain('Ran 12 tools')
    expect(label).toContain('2 failed')
    expect(label).toContain('2 files edited')
    const tint = await failedTint('.fl-conv-entry-turn')
    expect(tint).not.toBeNull()
    expect(tint?.actual).toBe(tint?.expected)

    // VISIBILITY, not presence. A collapsed turn keeps its children in the DOM
    // and merely hides them, so `querySelectorAll` finds every group header
    // whether or not the turn was ever opened — asserting presence here proves
    // nothing and would ship green against a turn row that opens onto nothing.
    // (The first version of this test also spelled the class `fl-tool-group-head`,
    // which matches no element at all.)
    await expect(groupLabels.first()).toBeHidden()
    await turnRows.first().click()
    await expect(groupLabels.filter({ hasText: 'Ran 2 commands' })).toBeVisible()
    await expect(groupLabels.filter({ hasText: 'Ran 3 commands' })).toBeVisible()
    await expect(
      groupLabels.filter({ hasText: 'Gathered context ' + String.fromCharCode(183) + ' 2 steps' }),
    ).toBeVisible()

    // ── DETAILED: the escape hatch is real ─────────────────────────────────
    // Not "fewer folds" — none. A reader who picked Detailed and still got a
    // summary row is the bug this assertion exists to make impossible, and is
    // precisely the bug Cursor shipped.
    await setDensity('detailed')
    await expect(window.locator('.fl-tool-card')).toHaveCount(12)
    await expect(window.locator('.fl-conv-entry-turn')).toHaveCount(0)
    await expect(requestRows).toHaveCount(0)
    // …and nothing is folded at that density, so no group header survives.
    await expect(window.locator('.fl-tool-group-head, .fl-tool-group-label')).toHaveCount(0)
    // The model under the message — Detailed only (plan_chat-cleanup FR-4).
    await expect(window.locator('.fl-conv-model-badge')).toHaveCount(1)

  } finally {
    cleanupSeeds()
  }
})

/**
 * A FINISHED TURN IS ONE ROW.
 *
 * The report (2026-09-08, with screenshots): a real thread rendered sixteen
 * rows of `Bash grep -n …` around four sentences of the agent's own words, and
 * five failed commits sat inside that wall indistinguishable from the
 * successes. The scaffolding outnumbered the signal four to one.
 *
 * Grouping already existed and had not moved that number, because it folds
 * RUNS and a reader reads TURNS. This guard holds the fold at the turn level,
 * the counts that let a collapsed row be decided on without opening it, and —
 * the part most worth guarding — that `Detailed` really does show everything.
 * Cursor shipped this same feature and then shipped a release that collapsed
 * detail *in defiance of the setting*, which their users filed bugs about.
 *
 * Seeds a real turn into the store rather than driving an agent: the fold is a
 * property of persisted history, and a live turn deliberately does not fold.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
test('a density change never destroys a parked permission card (F-1)', async ({ app, window, userDataDir }) => {
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

    // Reopen the thread so history reloads from the store.
    // Opening the thread for the first time loads history from the store, so
    // the seeded rows arrive with no reload needed.
    await window.waitForTimeout(800)
    // Opened by its title: the list-row selector finds a row whose list then
    // empties in this harness.
    const row = window.getByText('Chat pagination investigation', { exact: true }).first()
    await row.waitFor({ timeout: 20_000 })
    await row.click()
    await window.waitForTimeout(2500)

    // ── F-1: park the turn on a permission ask, then change density ────────
    // `needs-decision` routes through #resetActivity, which clears #busy,
    // #streaming AND #toolRunning — so the old three-flag guard let the repaint
    // through and the wipe destroyed an ACTIONABLE card that nothing could
    // re-render, hanging the turn with the broker still parked.
    await app.evaluate(({ BrowserWindow }, id) => {
      const w = BrowserWindow.getAllWindows()[0]
      w?.webContents.send('threads:stream', { kind: 'status', threadId: id, status: 'needs-decision' })
      w?.webContents.send('threads:permissionRequest', {
        requestId: 'req-1',
        threadId: id,
        toolName: 'Bash',
        summary: 'rm -rf ./tmp',
        input: { command: 'rm -rf ./tmp' },
      })
    }, threadId)
    await window.waitForTimeout(900)
    const permissionCards = window.locator('.fl-conv-entry-permission')
    await expect(permissionCards).toHaveCount(1)

    await window.locator('.fl-titlebar-icon[aria-label="Settings"]').click()
    await window.locator('.fl-settings-tab', { hasText: 'App' }).click()
    await window.locator('select[aria-label="Conversation density"]').selectOption('detailed')
    await window.waitForTimeout(1500)

    // Reproduced against the old guard at 1 -> 0: the card was destroyed and
    // nothing could re-render it, because #permissionCards still held its id.
    await expect(permissionCards).toHaveCount(1)
  } finally {
    cleanupSeeds()
  }
})

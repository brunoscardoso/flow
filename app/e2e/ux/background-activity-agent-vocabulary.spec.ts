/**
 * THE CHIP MUST SPEAK THE SDK'S REAL VOCABULARY (#1931).
 *
 * The bug this guards against, observed live: the "Background activity" chip
 * never showed for real sessions because the model filtered persisted rows on
 * `toolName === 'Task'`, while @anthropic-ai/claude-agent-sdk 0.3.204 names
 * the sub-agent tool_use 'Agent' (its legacy rename map carries Task → Agent)
 * and the stream bridge persists `toolUse.name` verbatim. Every real row was
 * 'Agent', so the strip stayed hidden — the user's reported symptom.
 *
 * This spec seeds a thread with an 'Agent'-named tool_call row — exactly what
 * a real session persists — and asserts the chip is VISIBLE with the right
 * count, and that its popover opens and lists the row. Unit tests pin the
 * filter; only a real app run pins that the filter's vocabulary matches what
 * the binary actually stores.
 *
 * The row is seeded STILL RUNNING. Since 6e662a4e the strip is a live
 * indicator — it shows only while a run is going, and a finished spawn lives
 * on as the chat's own chip — so a seeded finished row would leave the strip
 * hidden whatever the vocabulary, and this spec would guard nothing.
 *
 * Seeded with the sqlite3 CLI (same mechanics as chat-feed-signal.spec.ts):
 * better-sqlite3 here is built for Electron's ABI and will not load in
 * Playwright's plain-Node process.
 */
import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'

test("an 'Agent'-named tool call row shows the Background activity chip and populates its popover", async ({ window, userDataDir }) => {
  test.setTimeout(180_000)
  try {
    const root = await seedProject(window, 'agent-vocab-')
    await activateProject(window, root)
    const threadId: string = await window.evaluate(async (r) => {
      const t = await (window as any).flow.threads.create({ projectRoot: r, title: 'Agent vocabulary guard' })
      return t.id
    }, root)
    await window.waitForTimeout(1200)

    // Seed straight into the store, exactly as the stream bridge writes a
    // sub-agent spawn still in flight: tool_name 'Agent' — the live SDK's name.
    const { execFileSync } = await import('node:child_process')
    const { join } = await import('node:path')
    const dbPath = join(userDataDir, 'flow.db')
    const t0 = Date.parse('2026-10-07T12:00:00.000Z')
    const iso = (n: number): string => new Date(t0 + n * 1000).toISOString()
    const q = (v: string): string => `'${v.replace(/'/g, "''")}'`
    const agentInput = JSON.stringify({
      description: 'Deep research pass',
      subagent_type: 'general-purpose',
      prompt: 'go research',
    })
    const sql = [
      `INSERT INTO messages (id,thread_id,role,content,created_at,model) VALUES ('m1',${q(threadId)},'user',${q('research this in the background')},${q(iso(0))},NULL);`,
      `INSERT INTO messages (id,thread_id,role,content,created_at,model) VALUES ('m2',${q(threadId)},'assistant',${q('Spawned a research sub-agent.')},${q(iso(10))},'claude-opus-5');`,
      `INSERT INTO tool_calls (id,thread_id,message_id,tool_name,input_json,output_json,status,started_at,completed_at) VALUES ('c1',${q(threadId)},'m2','Agent',${q(agentInput)},NULL,'running',${q(iso(11))},NULL);`,
    ].join('\n')
    execFileSync('sqlite3', [dbPath], { input: sql })

    // Open the seeded thread: first open loads history from the store.
    await window.waitForTimeout(800)
    const row = window.locator('.fl-thread-list fl-list .row', { hasText: 'Agent vocabulary guard' }).first()
    await row.waitFor({ timeout: 20_000 })
    // Click the TITLE area, not the row's center: the hover-revealed row
    // actions (pin/archive) sit mid-row under the Workspace-scope layout, and
    // a center click can land on Archive and silently archive the thread
    // instead of opening it (observed live in the main-merge gate).
    await row.click({ position: { x: 40, y: 14 } })
    await window.waitForTimeout(2500)

    // ── The chip is VISIBLE, with the right count ───────────────────────────
    const chip = window.locator('button.fl-bgactivity-strip')
    await expect(chip).toBeVisible()
    await expect(chip).not.toHaveAttribute('hidden', /.*/)
    await expect(chip.locator('.fl-bgactivity-strip-count')).toHaveText('1')
    await expect(chip).toHaveAttribute('aria-label', '1 of 1 sub-agent activity running')

    // ── The popover opens and lists the seeded sub-agent by its description ─
    await chip.click()
    const list = window.locator('.fl-fmenu .fl-bgactivity-list')
    await expect(list).toBeVisible()
    const item = list.locator('.fl-fmenu-item')
    await expect(item).toHaveCount(1)
    await expect(item.first()).toContainText('Deep research pass')
    await expect(item.first()).toContainText('general-purpose')
  } finally {
    cleanupSeeds()
  }
})

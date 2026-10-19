// LIVE probe (brain-savings chip fix, per the live-testing directive): drive
// the REAL orbit-app project — whose flow/brain/.structure/brain-usage.json
// genuinely carries cumulative savedTokens from past agent turns — and prove
// the savings chip actually shows:
//
//  1. TURN-BOUNDED PRICING: a thread whose turn 1 is a hit brain-search and
//     whose turn 2 is unrelated grep exploration must price the search as a
//     HIT (the pre-fix classifier read the later burst as the search's miss →
//     thread total 0 → chip hidden — the live orbit-app bug). Tool-call +
//     user-message rows are seeded straight into the harness's WAL SQLite via
//     the sqlite3 CLI (a live agent turn is impractical in CI), then asserted
//     both via `threads:brainSavings` and via the rendered chip DOM.
//  2. KEEP-VISIBLE CONTRACT: a second, empty thread on the same project must
//     still show the chip — the root's cumulative total in the subtler
//     `--root` style.
//
// Untracked probe — skipped wholesale when orbit-app is absent (CI).
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures/electron'
import { activateProject } from './ux/fixtures/seed'
import { liveRoot, noLiveProject } from './fixtures/live-root'

const LIVE_PROJECT = liveRoot()

/** ISO timestamp `seconds` past a fixed base minute — lexically ordered. */
function at(seconds: number): string {
  return `2026-07-29T10:00:${seconds.toFixed(0).padStart(2, '0')}.000Z`
}

async function createThread(win: Page, projectRoot: string, title: string): Promise<string> {
  return win.evaluate(
    async ({ projectRoot, title }) => {
      const created = await (
        window as unknown as {
          flow: {
            threads: { create(i: { projectRoot: string; title: string }): Promise<{ id: string }> }
          }
        }
      ).flow.threads.create({ projectRoot, title })
      return created.id
    },
    { projectRoot, title },
  )
}

async function openThread(win: Page, title: string): Promise<void> {
  await win
    .locator('.fl-thread-sidebar .row', { has: win.locator(`span[title="${title}"]`) })
    .first()
    .click()
}

/** Seed one message/tool_call row into the harness DB (app holds it in WAL —
 *  a second writer with a busy timeout is safe). */
function seedSql(userDataDir: string, sql: string): void {
  execFileSync('sqlite3', ['-cmd', '.timeout 10000', join(userDataDir, 'flow.db'), sql])
}

test('live: savings chip shows — turn-bounded hit pricing + root keep-visible fallback', async ({
  window,
  userDataDir,
}) => {
  test.skip(LIVE_PROJECT === '', noLiveProject())
  // Fresh e2e userData → the auto-provisioner may run on the live root before
  // the surfaces settle (same allowance as live-multi-project-probe).
  test.setTimeout(360_000)

  await window.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, LIVE_PROJECT)
  await activateProject(window, LIVE_PROJECT)

  const titleA = 'Savings probe — searched thread'
  const titleB = 'Savings probe — empty thread'
  const threadA = await createThread(window, LIVE_PROJECT, titleA)
  await createThread(window, LIVE_PROJECT, titleB)

  // Seed thread A with two REAL turns' worth of rows: turn 1 = a hit brain
  // search (+ a Read), turn 2 = unrelated grep exploration. Under the pre-fix
  // full-list classification the turn-2 burst flipped the turn-1 search to a
  // miss (thread total 0); turn-bounded pricing must keep it a HIT.
  const searchInput = JSON.stringify({
    command: 'planflow-ai brain search "conversation pane savings"',
  }).replaceAll("'", "''")
  const searchOutput = JSON.stringify('1. ● fresh symbol conversation-pane.ts:1').replaceAll(
    "'",
    "''",
  )
  const grepInput = JSON.stringify({ pattern: 'savings' }).replaceAll("'", "''")
  const rows = [
    `INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('probe-msg-1', '${threadA}', 'user', 'find the savings chip', '${at(0)}')`,
    `INSERT INTO tool_calls (id, thread_id, tool_name, input_json, output_json, status, started_at) VALUES ('probe-call-1', '${threadA}', 'Bash', '${searchInput}', '${searchOutput}', 'success', '${at(1)}')`,
    `INSERT INTO tool_calls (id, thread_id, tool_name, input_json, output_json, status, started_at) VALUES ('probe-call-2', '${threadA}', 'Read', '{"file_path":"/x"}', null, 'success', '${at(2)}')`,
    `INSERT INTO messages (id, thread_id, role, content, created_at) VALUES ('probe-msg-2', '${threadA}', 'user', 'now explore something else', '${at(10)}')`,
    `INSERT INTO tool_calls (id, thread_id, tool_name, input_json, output_json, status, started_at) VALUES ('probe-call-3', '${threadA}', 'Grep', '${grepInput}', '"many results"', 'success', '${at(11)}')`,
  ]
  seedSql(userDataDir, rows.join('; '))

  // Programmatic proof over the real IPC: the hit search prices > 0 (exact
  // value = the live root's own baseline — never asserted, it's the project's
  // real rolling median), and the root cumulative rides along.
  const savings = await window.evaluate(async (threadId) => {
    return (
      window as unknown as {
        flow: {
          threads: {
            brainSavings(i: {
              threadId: string
            }): Promise<{ savedTokens: number; rootSavedTokens: number }>
          }
        }
      }
    ).flow.threads.brainSavings({ threadId })
  }, threadA)
  expect(savings.savedTokens).toBeGreaterThan(0)
  expect(savings.rootSavedTokens).toBeGreaterThan(0)

  // The rendered chip: thread A shows ITS OWN total (no --root modifier)…
  const chip = window.locator('.fl-conv-savings-chip')
  await openThread(window, titleA)
  await expect(chip).toBeVisible()
  await expect(chip).toHaveText(/^~/)
  await expect(chip).not.toHaveClass(/fl-conv-savings-chip--root/)
  await chip.screenshot({ path: '/tmp/savings-chip.png' })
  await window.screenshot({ path: '/tmp/savings-chip-pane.png' })

  // …and the EMPTY thread B keeps the indicator via the root fallback.
  await openThread(window, titleB)
  await expect(chip).toBeVisible()
  await expect(chip).toHaveText(/^~/)
  await expect(chip).toHaveClass(/fl-conv-savings-chip--root/)
})

import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { waitForFlowState } from './fixtures/seed'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Flow status line — cross-root BLOCKED-precedence UX regression guard (flow 13
 * of the progressive sweep). The single aggregate status line summarizes the
 * FlowState across ALL open roots, and `pickDisplayState` ranks them:
 *
 *   tier 1  a BLOCKED root (pending prompt) — it needs the user, regardless of recency
 *   tier 2  a RUNNING root (active skill) — over a merely-recent idle sibling (#680)
 *   tier 3  the most-recently-changed root
 *
 * The two existing status-line tests cover a single-root lifecycle and tier 2
 * (running over idle, #680). Neither drives the tier-1 > tier-2 boundary: what
 * happens when one project is BLOCKED (awaiting a reply) while a *different*
 * project is actively running a skill AND ticking more recently. This is the
 * "is my blocked task still visible when another project is busy?" guarantee —
 * if a running sibling's routine tick could steal the line away from a blocked
 * project, the user could miss the prompt gating their task indefinitely.
 *
 * Driven end-to-end via the real seed path (a project whose flow/ dir exists so
 * the FlowObserver watcher starts on it; STATE.md → active skill/phase,
 * .heartbeat-prompt.md → blocked prompt) — exactly what the daemon writes. No
 * Claude account / agent is needed. Live guard — passes on current main.
 */

const seededDirs: string[] = []
test.afterAll(() => {
  for (const d of seededDirs) rmSync(d, { recursive: true, force: true })
})

/**
 * Git repo with a PRE-EXISTING flow/ dir (so the watcher starts on it) seeded
 * with the given files, marked onboarded (so no flow-settings overlay auto-opens),
 * then added as a project root. Mirrors status-line.spec's helper.
 */
async function seedWithFlow(win: Page, files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-slbp-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  const flowDir = join(dir, 'flow')
  mkdirSync(flowDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(flowDir, name), content, 'utf-8')
  }
  seededDirs.push(dir)
  await win.evaluate(async (p) => {
    try {
      const key = 'flow.onboarded'
      const seen: string[] = JSON.parse(localStorage.getItem(key) ?? '[]')
      if (!seen.includes(p)) seen.push(p)
      localStorage.setItem(key, JSON.stringify(seen))
    } catch {
      /* convenience only */
    }
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  return dir
}

test.describe('flow status line — cross-root blocked precedence', () => {
  test('a blocked project stays surfaced over a running sibling that ticks more recently', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const flowLine = window.locator(sel.flowLine)
    await expect(flowLine).toBeVisible()
    // The `flow: <skill> · <phase>` readout this spec ranked was retired from
    // the status line (2026-09-04); what is left to guard is the BLOCKED chip,
    // which ORs across roots and must not be dropped by a ticking sibling.
    const blocked = flowLine.locator('.fl-flow-line-blocked')
    await expect(blocked).toBeHidden()

    // Project A: actively RUNNING discovery-plan (no prompt).
    const a = await seedWithFlow(window, {
      'STATE.md':
        '# State\n\n- **Active Skill**: discovery-plan\n- **Current Phase**: Phase 2 — requirements\n',
      '.flowconfig': 'autopilot: false\n',
    })
    // Project B: actively RUNNING execute-plan (will become blocked below).
    const b = await seedWithFlow(window, {
      'STATE.md':
        '# State\n\n- **Active Skill**: execute-plan\n- **Current Phase**: Phase 7 — deploy\n',
      '.flowconfig': 'autopilot: true\n',
    })
    const bPromptPath = join(b, 'flow', '.heartbeat-prompt.md')

    // Both running and observed by main.
    await waitForFlowState(window, a, (state) => state.activeSkill === 'discovery-plan')
    await waitForFlowState(window, b, (state) => state.activeSkill === 'execute-plan')

    // B blocks on a prompt → tier 1. Red blocked indicator + sticky reply card.
    writeFileSync(
      bPromptPath,
      '**Task**: deploy-check\n\nApprove the production deploy before continuing? Reply yes/no.\n',
      'utf-8',
    )
    await expect(blocked).toBeVisible({ timeout: 6000 })

    // A (still running) now ticks MOST RECENTLY — a naive "most-recent-root" line
    // would flip to A's discovery-plan and the blocked project would vanish from
    // the line. Tier 1 must keep B surfaced regardless of recency.
    writeFileSync(
      join(a, 'flow', 'STATE.md'),
      '# State\n\n- **Active Skill**: discovery-plan\n- **Current Phase**: Phase 3 — data model\n',
      'utf-8',
    )
    await window.waitForTimeout(2500)
    await expect(blocked, 'blocked indicator OR-s across roots — must stay lit').toBeVisible()

    // Answer B's prompt via the sticky card → observer deletes the prompt file,
    // re-reads state, B is no longer blocked, and tier 1 relaxes.
    const reply = window.locator('.fl-flow-reply')
    await expect(reply).toHaveCount(1)
    await reply.fill('yes, approved')
    // The T1 "Run a basic discovery?" learn card (fixed bottom-right, z 1003)
    // can pop over the prompt card's actions row and intercept the click —
    // clear it first, retrying since it can arrive a beat late (harness only).
    await expect(async () => {
      const notNow = window.locator('.fl-learn-card fl-button', { hasText: 'Not now' })
      if (await notNow.count()) {
        await notNow
          .first()
          .click({ timeout: 2_000 })
          .catch(() => undefined)
      }
      await window
        .locator('.fl-flow-prompt fl-button[variant="primary"]')
        .click({ timeout: 3_000 })
    }).toPass({ timeout: 20_000 })
    await expect(blocked).toBeHidden({ timeout: 8000 })
    expect(existsSync(bPromptPath), 'prompt file deleted after reply').toBe(false)

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })
})

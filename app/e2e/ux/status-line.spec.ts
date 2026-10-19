import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { waitForFlowState } from './fixtures/seed'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Flow status line UX regression guard — flow 13 of the progressive sweep.
 *
 * The status line (bottom-right of the status bar) summarizes the aggregate
 * FlowState across all project roots: `flow: <skill> · <phase>`, `autopilot
 * on/off`, a red `blocked` indicator, and the inbox button. Its inputs come
 * from each root's `flow/` dir (STATE.md / .flowconfig / .heartbeat-prompt.md),
 * read by the main-process FlowObserver and pushed as `flow:stateChanged`. We
 * drive it end-to-end by seeding a project whose `flow/` dir already exists (so
 * the chokidar watcher starts on it) and writing those files — exactly what the
 * plan-flow daemon does at runtime.
 *
 * Test 1 (live guard, passes on main): the line reflects an active skill/phase,
 * autopilot on, and the blocked → reply → clear lifecycle (reply deletes the
 * prompt file, the observer re-reads, and the red indicator clears).
 *
 * Test 2 (#680, live guard): with two projects open, an idle sibling's routine
 * flow-file tick must NOT mask a project that is actively running a skill. The
 * aggregate line used to rank "most recently changed root" above "root with an
 * active skill", flipping to `flow: idle`; #680 fixed the precedence (active
 * skill ranks above recency, pickDisplayState tier 2) and this now-passing test
 * guards against a regression.
 */

const seededDirs: string[] = []
test.afterAll(() => {
  for (const d of seededDirs) rmSync(d, { recursive: true, force: true })
})

/**
 * Create a git repo with a PRE-EXISTING `flow/` dir (so the FlowObserver watcher
 * starts on it) seeded with the given files, mark it onboarded (so the per-project
 * flow-settings overlay never auto-opens), then add it as a project root.
 */
async function seedWithFlow(win: Page, files: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-sl-'))
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

test.describe('flow status line UX', () => {
  test('the blocked → reply → clear lifecycle', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const flowLine = window.locator(sel.flowLine)
    await expect(flowLine).toBeVisible()
    // The `flow: <skill> · <phase>` and `autopilot on|off` readouts this spec
    // also covered were retired from the status line (2026-09-04, status-line.ts);
    // what is left there is the notification part — blocked, and the inbox.
    const blocked = flowLine.locator('.fl-flow-line-blocked')

    // Baseline: not blocked.
    await expect(blocked).toBeHidden()

    // Seed a project whose flow/ already reports an active skill + autopilot on.
    const dir = await seedWithFlow(window, {
      'STATE.md':
        '# State\n\n- **Active Skill**: execute-plan\n- **Current Phase**: Phase 3 — API layer\n',
      '.flowconfig': 'autopilot: true\n',
    })
    const flowDir = join(dir, 'flow')

    // 1 + 2. Main has observed the seeded skill/phase and autopilot.
    await waitForFlowState(
      window,
      dir,
      (state) => state.activeSkill === 'execute-plan' && state.autopilot,
    )

    // 3. A blocked prompt appears → red blocked indicator + sticky reply card.
    const promptPath = join(flowDir, '.heartbeat-prompt.md')
    writeFileSync(
      promptPath,
      '**Task**: deploy-check\n\nApprove the migration before continuing? Reply yes/no.\n',
      'utf-8',
    )
    await expect(blocked).toBeVisible({ timeout: 6000 })
    const reply = window.locator('.fl-flow-reply')
    await expect(reply).toHaveCount(1, { timeout: 6000 })

    // 4. Reply via the sticky card → observer deletes the prompt file, re-reads
    //    state, and the red blocked indicator clears (+ the card goes away).
    await reply.fill('yes')
    await window.locator('.fl-flow-prompt fl-button[variant="primary"]').click()
    await expect(blocked).toBeHidden({ timeout: 8000 })
    await expect(window.locator('.fl-flow-reply')).toHaveCount(0, { timeout: 8000 })
    expect(existsSync(promptPath), 'prompt file should be deleted after reply').toBe(false)

    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })

  // RETIRED 2026-10-09: "#680 — an actively-running project is not hidden by
  // an idle sibling ticking" ranked which project the `flow: <skill>` readout
  // showed; that readout left the status line (2026-09-04).
})

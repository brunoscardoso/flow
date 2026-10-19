import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { waitForFlowState } from './fixtures/seed'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Flow status line — WHO is `blocked`? (flow 13 of the progressive UX sweep,
 * round 22.)
 *
 * #1204 taught the line to name the project it is describing, but only for the
 * half that `pickDisplayState` picks: the `flow: <skill> · <phase>` item and the
 * `autopilot on|off` item. The red `⚠ blocked` chip beside them is computed on a
 * completely different axis — `renderStatus` (flow/index.ts) counts EVERY root
 * with a `pendingPrompt` and hands the total to `status-line.ts`, which renders
 * a bare `blocked` span with no chip, no tooltip, no data attribute.
 *
 * So in the exact shape #1204's own spec drives (active project A mid-
 * execute-plan, background root B blocked), the line reads
 *
 *     flow: execute-plan · Phase 9 — production deploy   autopilot on   ⚠ blocked
 *
 * and the `blocked` is B's, not A's — while the skill/autopilot next to it are
 * A's and deliberately unprefixed (tier 0 of pickDisplayState). Flip which
 * project is blocked and the chip's markup is byte-identical.
 *
 * Test 1 (live guard, green on main): the cross-root blocked lifecycle really
 * works end-to-end — a background root's prompt raises the indicator, the reply
 * CARD names that root (#1074's attribution, the machinery the line does not
 * use), and resolving the prompt clears the indicator.
 *
 * Test 2 (`test.fixme`, reproduces #1354): the `blocked` chip must
 * distinguish "the project you are in is waiting on you" from "a background
 * project is". Verified failing against main.
 */

const seededDirs: string[] = []
// Retry on ENOTEMPTY: the IDE's fire-and-forget auto-provisioner can still be
// writing its scaffold into a just-attached root when teardown runs.
test.afterAll(() => {
  for (const d of seededDirs) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(d, { recursive: true, force: true })
        break
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOTEMPTY') break
        execFileSync('sleep', ['0.3'])
      }
    }
  }
})

/** Git repo with a pre-existing flow/ dir (so the observer watches it), marked
 *  onboarded, then added as a project root. Mirrors status-line.spec's helper. */
async function seedWithFlow(
  win: Page,
  prefix: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\n')
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

async function activate(win: Page, root: string): Promise<void> {
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { setActive(r: { rootPath: string }): Promise<unknown> } }
      }
    ).flow.project.setActive({ rootPath: p })
  }, root)
}

/** Poke the observer to re-read a root's flow/ files (the temp-dir chokidar
 *  watcher is unreliable on macOS — see fixtures/seed.ts). */
async function nudge(win: Page, root: string, autopilot: string): Promise<void> {
  await win.evaluate(
    async ({ p, ap }) => {
      await (
        window as unknown as {
          flow: {
            flow: {
              setConfig(r: { rootId: string; updates: Record<string, string> }): Promise<void>
            }
          }
        }
      ).flow.flow.setConfig({ rootId: p, updates: { autopilot: ap } })
    },
    { p: root, ap: autopilot },
  )
}

/** Everything the status line renders — text, tooltips, attributes, markup. */
async function readLine(win: Page) {
  return await win.locator(sel.flowLine).evaluate((el) => {
    const items = [...el.querySelectorAll('.fl-flow-line-item')]
    const blocked = el.querySelector('.fl-flow-line-blocked') as HTMLElement | null
    return {
      text: (el as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
      skill: items[0]?.textContent?.trim() ?? '',
      skillTitle: items[0]?.getAttribute('title') ?? '',
      blockedText: blocked?.textContent?.trim() ?? '',
      blockedTitle: blocked?.getAttribute('title') ?? '',
      blockedAttrs: blocked
        ? [...blocked.attributes].map((a) => `${a.name}=${a.value}`).join(' ')
        : '',
      /** The chip's markup, which is what a reader actually gets. */
      blockedHtml: blocked?.outerHTML ?? '',
    }
  })
}

const A_STATE =
  '# State\n\n- **Active Skill**: execute-plan\n- **Current Phase**: Phase 9 — production deploy\n'

/**
 * The world both tests need: A is the ACTIVE project, mid-execute-plan with
 * autopilot on and NOT blocked; B is a background root that IS blocked.
 */
async function seedWorld(win: Page): Promise<{ a: string; b: string }> {
  const flowLine = win.locator(sel.flowLine)
  await expect(flowLine).toBeVisible()
  await expect(flowLine.locator('.fl-flow-line-blocked')).toBeHidden()

  const a = await seedWithFlow(win, 'flow-slba-A-', {
    'STATE.md': A_STATE,
    '.flowconfig': 'autopilot: true\n',
  })
  await activate(win, a)
  await nudge(win, a, 'true')
  // Observed by main (the status bar's skill readout that showed it is gone).
  await waitForFlowState(win, a, (state) => state.activeSkill === 'execute-plan' && state.autopilot)

  const b = await seedWithFlow(win, 'flow-slba-B-', {
    'STATE.md': '# State\n\n- **Status**: waiting\n',
    '.flowconfig': 'autopilot: false\n',
    '.heartbeat-prompt.md': '**Task**: nightly-sweep\n\nProceed with the sweep? Reply yes/no.\n',
  })
  await nudge(win, b, 'false')
  await expect(flowLine.locator('.fl-flow-line-blocked')).toBeVisible({ timeout: 8000 })
  return { a, b }
}

test.describe('flow status line — which project is `blocked`?', () => {
  test('a background root’s prompt raises, names (on the card) and clears the indicator', async ({
    window,
  }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    window.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console.error: ${m.text()}`)
    })

    const { a, b } = await seedWorld(window)
    const flowLine = window.locator(sel.flowLine)
    const blocked = flowLine.locator('.fl-flow-line-blocked')

    // The chip says WHOSE task is waiting (#1354): B is not the project the
    // user is in, so it is named.
    await expect(blocked).toContainText(`${basename(b)} blocked`)

    // The blocked-prompt CARD does name the root it belongs to (#1074).
    const card = window.locator('.fl-flow-toast[data-root-id]')
    await expect(card).toHaveCount(1)
    await expect(card.locator('.fl-flow-project-chip')).toHaveText(basename(b))
    await window.screenshot({
      path: 'e2e/ux/__screens/status-line-blocked-background-root.png',
    })

    // Resolving B's prompt clears the indicator — the line is live, not stuck.
    rmSync(join(b, 'flow', '.heartbeat-prompt.md'), { force: true })
    await nudge(window, b, 'false')
    await expect(blocked).toBeHidden({ timeout: 8000 })

    expect(basename(a)).toBeTruthy()
    expect(errors, `uncaught renderer errors:\n${errors.join('\n')}`).toEqual([])
  })

  test.fixme(
    'the `blocked` chip says WHOSE task is waiting — background root vs the active project (#1354)',
    async ({ window }) => {
      const { a, b } = await seedWorld(window)
      const flowLine = window.locator(sel.flowLine)
      const blocked = flowLine.locator('.fl-flow-line-blocked')

      // State 1 — only the BACKGROUND root B is blocked; A is running fine.
      const backgroundBlocked = await readLine(window)

      // State 2 — flip it: B is answered, the ACTIVE project A is blocked.
      rmSync(join(b, 'flow', '.heartbeat-prompt.md'), { force: true })
      await nudge(window, b, 'false')
      await expect(blocked).toBeHidden({ timeout: 8000 })
      writeFileSync(
        join(a, 'flow', '.heartbeat-prompt.md'),
        '**Task**: production-deploy\n\nApprove the production deploy? Reply yes/no.\n',
        'utf-8',
      )
      await nudge(window, a, 'true')
      await expect(blocked).toBeVisible({ timeout: 8000 })
      const activeBlocked = await readLine(window)

      // Expected: the chip either names the blocked root, or the two states are
      // at least told apart somehow (text, tooltip, or an attribute a reader can
      // see). Today both render `<span class="… fl-flow-line-blocked">⚠ blocked`
      // byte for byte, so "is MY project waiting on me?" is unanswerable from
      // the one always-visible readout.
      const namesB =
        backgroundBlocked.blockedText.includes(basename(b)) ||
        backgroundBlocked.blockedTitle.includes(basename(b)) ||
        backgroundBlocked.blockedAttrs.includes(basename(b))
      expect(
        namesB || backgroundBlocked.blockedHtml !== activeBlocked.blockedHtml,
        `\`blocked\` renders identically whether the ACTIVE project or a background one is waiting:\n` +
          `  background-blocked: ${backgroundBlocked.blockedHtml}\n` +
          `  active-blocked:     ${activeBlocked.blockedHtml}`,
      ).toBe(true)
    },
  )
})

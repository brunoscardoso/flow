import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { waitForFlowState } from './fixtures/seed'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'

/**
 * Notifications — what the app RECORDS about a blocked prompt once it stops
 * being blocked (flow 13 of the progressive sweep, round 21).
 *
 * Two closed fixes meet here, and this spec guards the seam between them:
 *
 *  - #1165 made a prompt resolved OUT OF BAND (the daemon consuming it, a
 *    Telegram reply, a CLI session archiving `.heartbeat-prompt.md`) announce
 *    itself instead of silently removing the card, carrying any unsent draft
 *    into the announcement "so nothing you wrote is lost".
 *  - #1075 made the inbox the durable record for a body the 6s toast throws
 *    away: a multi-line body is retained on the entry and expands on click.
 *
 * The renderer has exactly ONE signal that a prompt is gone — a FlowState with
 * no `pendingPrompt` (`flow/index.ts` `applyState` → `center.dismissPrompt`).
 * `flow:respondPrompt` produces that same signal itself: main unlinks the
 * prompt file and calls `refresh()` before the invoke resolves
 * (`flow-observer.ts` respondPrompt). So the announcement path cannot tell "the
 * user just answered this in-app" from "somebody else answered it" — see the
 * `test.fixme` tripwires, both verified failing against main.
 *
 * Credential-free: real `.heartbeat-prompt.md` writes, the real
 * `flow:respondPrompt` IPC and the real `flow:notify` renderer bridge. No
 * Claude account, no agent turn.
 */

const seededDirs: string[] = []
test.afterAll(() => {
  // Retry ENOTEMPTY: the IDE's fire-and-forget auto-provisioner can still be
  // writing its scaffold into a seeded root at teardown (same rationale as
  // fixtures/seed.ts cleanupSeeds). Never fail the run on cleanup.
  for (const dir of seededDirs) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true })
        break
      } catch {
        execFileSync('sleep', ['0.3'])
      }
    }
  }
})

/** What the sidebar's "Add project" does once the native folder picker returns. */
async function addRoot(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (path) => {
    try {
      const key = 'flow.onboarded'
      const seen: string[] = JSON.parse(localStorage.getItem(key) ?? '[]')
      if (!seen.includes(path)) seen.push(path)
      localStorage.setItem(key, JSON.stringify(seen))
    } catch {
      /* convenience only — keeps the per-project flow overlay from auto-opening */
    }
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path })
  }, dir)
}

/**
 * Throwaway git repo with a PRE-EXISTING `flow/` dir (so the FlowObserver watch
 * starts on it), added as a project root. Waits for BOTH halves of the state
 * (skill AND autopilot) so the watch has certainly attached before prompt writes.
 */
async function seedProject(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-reply-rec-'))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'flow'), { recursive: true })
  writeFileSync(
    join(dir, 'flow', 'STATE.md'),
    '# State\n\n- **Active Skill**: execute-plan\n- **Current Phase**: Phase 2\n',
    'utf-8',
  )
  writeFileSync(join(dir, 'flow', '.flowconfig'), 'autopilot: true\n', 'utf-8')
  seededDirs.push(dir)
  await addRoot(win, dir)
  // The FlowObserver has attached once main reports BOTH halves of the seeded
  // state (the status-bar readouts that used to show them were retired).
  await waitForFlowState(win, dir, (state) => state.activeSkill === 'execute-plan' && state.autopilot)
  return dir
}

/** Nudge the observer's direct-refresh path — the chokidar watch on a
 *  /var/folders temp dir is unreliable on macOS (fsevents), so a write may
 *  never be observed on its own. `setConfig` re-reads the whole snapshot. */
async function nudge(win: Page, dir: string): Promise<void> {
  await win.evaluate(async (path) => {
    await (
      window as unknown as {
        flow: {
          flow: {
            setConfig(r: { rootId: string; updates: Record<string, string> }): Promise<unknown>
          }
        }
      }
    ).flow.flow.setConfig({ rootId: path, updates: { autopilot: 'true' } })
  }, dir)
}

/** Write the prompt file and wait for the sticky reply card, retrying — a first
 *  write can land in the gap before the watch settles. */
async function raiseBlockedPrompt(win: Page, dir: string, markdown: string): Promise<void> {
  const promptPath = join(dir, 'flow', '.heartbeat-prompt.md')
  const reply = win.locator('.fl-flow-reply')
  for (let attempt = 0; attempt < 5; attempt += 1) {
    writeFileSync(promptPath, markdown, 'utf-8')
    if (attempt > 0) await nudge(win, dir)
    try {
      await reply.first().waitFor({ state: 'visible', timeout: 4000 })
      return
    } catch {
      /* retry */
    }
  }
  throw new Error('blocked-prompt card never appeared')
}

/** The unrelated per-project "Run a basic discovery?" ask shares the toast
 *  stack; clear it so toast assertions describe only the reply cards. */
async function clearDiscoveryAsk(win: Page): Promise<void> {
  const notNow = win.locator('fl-button', { hasText: 'Not now' })
  if (await notNow.count()) await notNow.first().click().catch(() => undefined)
  await win.evaluate(() => {
    for (const el of document.querySelectorAll('.fl-flow-toasts > *')) {
      if ((el as HTMLElement).innerText.includes('basic discovery')) el.remove()
    }
  })
}

/** Drag the mouse across an element's text the way a user selecting it would.
 *  Returns whatever ended up in the window selection. */
async function dragSelect(win: Page, target: Locator): Promise<string> {
  const box = await target.boundingBox()
  if (!box) throw new Error('drag target has no box')
  await win.mouse.move(box.x + 4, box.y + 6)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width - 6, box.y + box.height - 6, { steps: 12 })
  await win.mouse.up()
  return win.evaluate(() => window.getSelection()?.toString() ?? '')
}

const PROMPT_MD =
  '# Blocked\n\n**Task**: deploy-check\n\nShould I push the release branch to production?\n'

/** A considered, multi-line answer — the kind losing hurts. */
const DRAFT = [
  'No — hold the push.',
  'Reason: the migration in phase 4 has not been reviewed by the DBA yet,',
  'and rolling it back after a prod deploy needs a manual data repair.',
  'Re-run once ticket OPS-4471 is signed off.',
].join('\n')

/**
 * LIVE CONTROL — answering in-app really works end to end. Without this, the
 * "no false announcement" tripwire below could pass simply because the reply
 * never went anywhere.
 */
test('a reply sent from the card is really delivered, archived and unblocks the line', async ({
  window,
}) => {
  const pageErrors: string[] = []
  window.on('pageerror', (error) => pageErrors.push(String(error)))

  const dir = await seedProject(window)
  await raiseBlockedPrompt(window, dir, PROMPT_MD)
  await clearDiscoveryAsk(window)

  await window.locator('.fl-flow-reply').first().fill('Yes — push it, OPS-4471 is signed off.')
  await window
    .locator('.fl-flow-toast', { hasText: 'Task blocked' })
    .locator('fl-button', { hasText: 'Send reply' })
    .click()

  await expect(window.locator('.fl-flow-toast', { hasText: 'Reply sent' })).toBeVisible({
    timeout: 10_000,
  })

  // Ground truth on disk — removing the prompt file is what resumes the daemon.
  await expect
    .poll(() => existsSync(join(dir, 'flow', '.heartbeat-prompt.md')), { timeout: 10_000 })
    .toBe(false)
  const archiveDir = join(dir, 'flow', 'archive', 'heartbeat-prompts')
  expect(existsSync(archiveDir)).toBe(true)
  expect(readdirSync(archiveDir).some((f) => f.startsWith('prompt_deploy-check'))).toBe(true)

  // …and the status line stops claiming the project is blocked.
  await expect(window.locator('.fl-flow-line-blocked')).toBeHidden({ timeout: 10_000 })
  expect(pageErrors).toEqual([])
})

/**
 * LIVE CONTROL — #1165's real path. A prompt resolved by somebody else DOES get
 * announced, and the unsent draft is carried into the announcement. This is the
 * behaviour that must survive whatever fix the tripwire below drives.
 */
test('a prompt resolved out-of-band is announced and carries the unsent draft', async ({
  window,
}) => {
  const pageErrors: string[] = []
  window.on('pageerror', (error) => pageErrors.push(String(error)))

  const dir = await seedProject(window)
  await raiseBlockedPrompt(window, dir, PROMPT_MD)
  await window.locator('.fl-flow-reply').first().fill(DRAFT)

  // Somebody else answers it: the prompt file goes away without this window
  // ever calling flow:respondPrompt.
  unlinkSync(join(dir, 'flow', '.heartbeat-prompt.md'))
  await nudge(window, dir)

  const announcement = window.locator('.fl-flow-toast', {
    hasText: 'Question answered elsewhere',
  })
  await expect(announcement).toBeVisible({ timeout: 10_000 })
  await expect(announcement).toContainText('OPS-4471')
  expect(pageErrors).toEqual([])
})

/**
 * LIVE CONTROL — text in an inbox entry really is selectable with the mouse, so
 * the drag-select tripwire below cannot pass vacuously on a renderer where no
 * selection is possible at all. Uses a SINGLE-line body, which gets no expand
 * toggle (`notification-center.ts` only makes multi-line bodies expandable).
 */
test('inbox text is selectable with the mouse on a plain entry', async ({ window }) => {
  await window.evaluate(() => {
    document.dispatchEvent(
      new CustomEvent('flow:notify', {
        detail: {
          kind: 'state-change',
          rootId: '',
          title: 'Commit failed',
          body: 'fatal: could not read Username for https://github.com',
          timestamp: new Date().toISOString(),
          level: 'error',
        },
      }),
    )
  })

  await window.locator('.fl-flow-line-inbox').click()
  const entry = window
    .locator('.fl-flow-inbox .fl-flow-inbox-entry')
    .filter({ hasText: 'Commit failed' })
    .first()
  await expect(entry).toBeVisible()
  expect(await entry.getAttribute('class')).not.toContain('expandable')

  const selection = await dragSelect(window, entry.locator('.fl-flow-caption').first())
  expect(selection.length).toBeGreaterThan(0)
  expect(await entry.innerText()).toContain('could not read Username')
})

/**
 * #1165 residual — answering IN-APP takes the out-of-band announcement path.
 *
 * `flow:respondPrompt` unlinks the prompt file and refreshes, so the renderer
 * sees a state with no pendingPrompt and cannot tell the two apart. The user
 * gets a red error card telling them somebody ELSE answered their question and
 * that their reply is UNSENT — immediately above the blue "Reply sent" card
 * saying the opposite, and both land in the inbox permanently.
 *
 * The announcement is correct for the real out-of-band case (control above);
 * it must simply not fire for the reply this window just sent.
 */
test.fixme('answering in-app raises no "someone else answered it" card', async ({ window }) => {
  const dir = await seedProject(window)
  await raiseBlockedPrompt(window, dir, PROMPT_MD)
  await clearDiscoveryAsk(window)

  await window.locator('.fl-flow-reply').first().fill('Yes — push it, OPS-4471 is signed off.')
  await window
    .locator('.fl-flow-toast', { hasText: 'Task blocked' })
    .locator('fl-button', { hasText: 'Send reply' })
    .click()

  await expect(window.locator('.fl-flow-toast', { hasText: 'Reply sent' })).toBeVisible({
    timeout: 10_000,
  })

  const falseAlarm = window.locator('.fl-flow-toast', { hasText: 'Question answered elsewhere' })
  expect(
    await falseAlarm.count(),
    'the reply I just sent myself was announced as answered by someone else',
  ).toBe(0)

  await window.locator('.fl-flow-line-inbox').click()
  const falseEntry = window
    .locator('.fl-flow-inbox .fl-flow-inbox-entry')
    .filter({ hasText: 'Question answered elsewhere' })
  expect(
    await falseEntry.count(),
    'the durable inbox record contradicts itself about who answered',
  ).toBe(0)
})

/**
 * #1075 residual — the expand toggle is bound to a click on the whole entry, so
 * the drag a user makes to SELECT and copy the retained text fires it: the body
 * collapses back to its first line, the text leaves the DOM entirely, and the
 * selection is wiped. For the #1165 announcement that text is the only surviving
 * copy of the reply the user typed, and the toast holding it auto-dismissed at 6s.
 */
test.fixme('an expanded inbox entry survives selecting its text', async ({ window }) => {
  const dir = await seedProject(window)
  await raiseBlockedPrompt(window, dir, PROMPT_MD)
  await window.locator('.fl-flow-reply').first().fill(DRAFT)

  unlinkSync(join(dir, 'flow', '.heartbeat-prompt.md'))
  await nudge(window, dir)
  await expect(
    window.locator('.fl-flow-toast', { hasText: 'Question answered elsewhere' }),
  ).toBeVisible({ timeout: 10_000 })
  await clearDiscoveryAsk(window)

  await window.locator('.fl-flow-line-inbox').click()
  const entry = window
    .locator('.fl-flow-inbox .fl-flow-inbox-entry')
    .filter({ hasText: 'Question answered elsewhere' })
    .first()
  await expect(entry).toBeVisible()

  // Expand it — the #1075 affordance that makes the kept draft readable.
  await entry.click()
  await expect(entry).toContainText('OPS-4471')

  // Now select that text, which is the whole point of keeping it.
  const selection = await dragSelect(window, entry.locator('.fl-flow-caption').first())
  expect(await entry.innerText(), 'the kept draft left the screen when I selected it').toContain(
    'OPS-4471',
  )
  expect(selection.length, 'selecting the kept draft produced an empty selection').toBeGreaterThan(
    0,
  )
})

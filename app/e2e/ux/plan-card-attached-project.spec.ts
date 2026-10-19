/**
 * A PLAN WRITTEN INTO AN ATTACHED PROJECT IS ACTED ON THERE (2026-10-09).
 *
 * A thread started in one project attached a sibling and wrote its plan THERE.
 * The card appeared (artifact-card-attached-project.spec.ts), but every plan
 * action still aimed at the thread's own project: the note counts were read
 * from a project that has no such plan (so Review the change never showed),
 * the review asked the home project for the plan's code, and Execute named a
 * relative path the agent's working directory does not hold.
 *
 * Real everywhere it can be: two seeded git repos, the thread_roots API the
 * app uses to attach the sibling, a marker in the sink's shape
 * (`[artifact] plan <path> @<root>`), the bundled CLI reading the notes and
 * drawing the story (`blueprint storyline --plan`). Nothing reaches an agent —
 * `threads:sendMessage` is answered in MAIN and records what was sent.
 *
 * Always run hidden: FLOW_E2E=1 FLOW_E2E_BACKGROUND=1.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ElectronApplication, Page } from '@playwright/test'

import { expect, test } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds, seedProject } from './fixtures/seed'

const PLAN = 'flow/plans/plan_meter_gauge_v1.md'
const QUOTE = 'const reading = clamp(raw, 0, 100)'

const METER_FILE = `/** Turn a raw sensor value into a gauge reading. */
export function readMeter(raw: number): number {
  ${QUOTE}
  return Math.round(reading)
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
`

const PLAN_DOC = `# Plan: Meter gauge

## Overview

The gauge reads its meter with one decimal instead of rounding.

## Phases

### Phase 1: Reading
**Complexity**: 2/10

- [ ] Keep one decimal

#### Change notes

- note: 1 · change · file:src/meter.ts:readMeter
    where: \`${QUOTE}\`
    what: keep one decimal in the reading
    why: the gauge shows tenths

### Phase 2: Tests (Final)
**Complexity**: 1/10

- [ ] A tenth survives
`

test.afterAll(() => cleanupSeeds())

function git(dir: string, args: string[]): void {
  execFileSync('git', ['-c', 'user.name=Flow E2E', '-c', 'user.email=e2e@example.invalid', ...args], { cwd: dir })
}

function seedSibling(dir: string): void {
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'meter.ts'), METER_FILE)
  git(dir, ['add', 'src'])
  git(dir, ['commit', '-q', '-m', 'seed'])
  // The plan rides the Workspace import (`link --import`) into the project's knowledge.
  mkdirSync(join(dir, 'flow', 'plans'), { recursive: true })
  writeFileSync(join(dir, PLAN), PLAN_DOC)
}

async function waitForWorkspaceLink(dir: string): Promise<void> {
  await expect
    .poll(
      () => {
        try {
          return lstatSync(join(dir, 'flow')).isSymbolicLink() && existsSync(join(dir, PLAN))
        } catch {
          return false
        }
      },
      { timeout: 300_000 },
    )
    .toBe(true)
}

async function api<T>(win: Page, fn: string, arg: unknown): Promise<T> {
  return win.evaluate(
    async ({ fn, arg }) => {
      const flow = (window as unknown as { flow: Record<string, Record<string, (i: unknown) => Promise<unknown>>> }).flow
      const [ns, method] = fn.split('.')
      return (await flow[ns]![method]!(arg)) as unknown
    },
    { fn, arg },
  ) as Promise<T>
}

async function spySend(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { __cardSends?: unknown[] }
    g.__cardSends = []
    ipcMain.removeHandler('threads:sendMessage')
    ipcMain.handle('threads:sendMessage', (_event, request) => {
      g.__cardSends?.push(request)
      return { messageId: `card-stub-${g.__cardSends?.length ?? 0}` }
    })
  })
}

async function sent(app: ElectronApplication): Promise<Array<{ threadId: string; content: string }>> {
  return app.evaluate(() =>
    ((globalThis as unknown as { __cardSends?: Array<{ threadId: string; content: string }> }).__cardSends ?? []).map(
      (request) => ({ threadId: request.threadId, content: request.content }),
    ),
  )
}

test('a plan in a project attached to the thread: its description, Review the change on its own code, Execute by its absolute path', async ({
  app,
  window: page,
}) => {
  test.setTimeout(600_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

  const home = await seedProject(page, 'flow-ux-plan-attached-home-', (dir) => {
    writeFileSync(join(dir, 'README.md'), '# Home\n')
    git(dir, ['add', 'README.md'])
    git(dir, ['commit', '-q', '-m', 'seed'])
  })
  const sibling = await seedProject(page, 'flow-ux-plan-attached-sibling-', seedSibling)
  await waitForWorkspaceLink(sibling)
  await activateProject(page, home)
  await spySend(app)

  const thread = await api<{ id: string }>(page, 'threads.create', { projectRoot: home, title: 'Attached plan thread' })
  await api(page, 'threads.setRoots', { threadId: thread.id, roots: [sibling] })
  await api(page, 'messages.append', { threadId: thread.id, role: 'user', content: 'plan the meter gauge next door' })
  // What main's sink writes for a plan in an attached project.
  await api(page, 'messages.append', { threadId: thread.id, role: 'system', content: `[artifact] plan ${PLAN} @${sibling}` })
  await api(page, 'messages.append', { threadId: thread.id, role: 'user', content: 'looks right' })

  await page.getByText('Attached plan thread', { exact: true }).first().click()
  await expect(page.locator(sel.conversation)).toBeVisible()
  const card = page.locator(`.fl-artifact-card[data-doc-path="${PLAN}"]`)
  await expect(card).toHaveCount(1, { timeout: 30_000 })

  // ── THE DESCRIPTION, read from the sibling (the home project has no plan) ──
  await expect(card.locator('.fl-artifact-summary')).toHaveText('The gauge reads its meter with one decimal instead of rounding.', {
    timeout: 30_000,
  })

  // ── THE NOTES WERE READ THERE: the card offers the review ─────────────────
  const reviewButton = card.getByRole('button', { name: 'Review the change' })
  await expect(reviewButton).toBeVisible({ timeout: 60_000 })
  await reviewButton.click()

  // The code story of the SIBLING's code, the note on it — opened for a
  // project that is not the board's active one.
  const board = page.locator('.flow-board-root')
  await expect(board.locator('.fb-nr-modes [data-review-mode="proposal"]')).toHaveAttribute('aria-pressed', 'true', { timeout: 120_000 })
  const sheet = board.locator('.fb-story.fb-story-review')
  const box = sheet.locator('.fb-story-box[data-piece="src/meter.ts#readMeter"]')
  await expect(box).toHaveCount(1, { timeout: 60_000 })
  await expect(box.locator('pre.fb-story-code')).toBeVisible()
  await expect(box.locator('pre.fb-story-code')).toContainText(QUOTE)
  await expect(box.locator('pre.fb-story-code')).toContainText('return Math.round(reading)')
  await expect(box.locator('.fb-note[data-note="1"]')).toBeVisible()
  await expect(box.locator('.fb-note[data-note="1"]')).toContainText('keep one decimal in the reading')

  // ── EXECUTE names the plan by its absolute path ───────────────────────────
  await page.getByText('Attached plan thread', { exact: true }).first().click()
  await expect(card).toBeVisible({ timeout: 30_000 })
  const execute = card.getByRole('button', { name: 'Execute the plan' })
  await expect(execute).toBeVisible()
  await execute.click()
  // The note is not reviewed yet, so the card asks first — and it knows that
  // only because it read the sibling's notes.
  const confirm = card.locator('.fl-artifact-confirm')
  await expect(confirm).toContainText('1 note has not been reviewed')
  await confirm.getByRole('button', { name: 'Execute anyway' }).click()
  const command = `/execute-plan @${sibling}/${PLAN}`
  await expect.poll(() => sent(app), { timeout: 10_000 }).toEqual([{ threadId: thread.id, content: command }])
  await page.waitForTimeout(1_000)
  expect(await sent(app)).toHaveLength(1)
  expect(errors).toEqual([])
})

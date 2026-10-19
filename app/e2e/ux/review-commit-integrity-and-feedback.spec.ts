/**
 * UX sweep — flow 5 (Review), round 24: what the phase gate MEANS, and what the
 * panel tells you after its primary action.
 *
 * Why this was un-probed. Twenty-plus review specs drive the file list, the
 * approve toggle and its re-gate (#1052), approve↔stage sync (#857), commit
 * scope (#1051), the conflicted (#986) / deleted (#1181) / renamed (#1182) file
 * states, the message draft lifecycle (#282/#342/#1140/#1141), the ✨ wand
 * (#1285/#1379/#1380), the reject and discard prompts (#697/#1018/#951) and
 * every FAILURE toast (#73/#103/#1090/#1332/#1333). Two things nobody had ever
 * asked:
 *
 *  1. WHOSE approval satisfies a phase's gate. `ReviewService` supports a file
 *     claimed by several phases ("a file claimed by several phases appears
 *     under each") and `#renderGroup` derives each group's approved set from
 *     GIT STAGED-NESS (`approvedFilePaths`, #857) — a per-FILE fact used to
 *     gate a per-GROUP action. So one ✓ given inside Phase 1 arms a Phase 2 the
 *     user has never looked at. #1052 is the same root cause across TIME (a
 *     file rewritten after approval); this is the same root cause across PLACE.
 *
 *  2. WHAT SUCCESS LOOKS LIKE. `commitGroup`/`discardGroup`
 *     (renderer/review/index.ts) notify only on FAILURE. The sibling Changes
 *     box, one segmented-control click away, raises "Committed · <repo> ·
 *     <hash>" for the same git operation (#1144). In the Phases panel a
 *     landed commit and a destroyed changeset produce the identical and only
 *     signal: the group's rows vanish.
 *
 * Credential-free: throwaway git repos + the project/review/git IPC. No
 * Claude account, no agent turn, no native dialog.
 *
 * The LIVE tests below hold before AND after a fix, and are chosen so no
 * tripwire can pass vacuously: the notification bridge really does fire for the
 * sibling view, and the phase gate really does gate an untouched phase. The
 * remaining tests began as `test.fixme` tripwires and flipped to live guards
 * when their defects landed fixes — the gate pair with #1432, the feedback
 * pair with #1433.
 */
import { test, expect, type Page } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SHOTS = join(__dirname, '__screens')

/** git round-trip + review:list + render, with headroom. */
const SETTLE_MS = 3500

/**
 * A plan whose Phase 2 declares ONLY the file Phase 1 also declares — the
 * shared-file shape ReviewService documents ("a file claimed by several phases
 * appears under each"), reduced to its smallest form so the gate question has a
 * single unambiguous answer.
 */
const PLAN = [
  '# Plan: qa gate',
  '',
  '## Phase 1 — Alpha',
  '',
  '**Files**:',
  '- `shared.ts`',
  '- `a1.ts`',
  '',
  '## Phase 2 — Beta',
  '',
  '**Files**:',
  '- `shared.ts`',
  '',
].join('\n')

const TRACKED = ['shared.ts', 'a1.ts', 'loose.ts'] as const

/** A repo with one working-tree change per tracked file and the plan above, all
 *  built BEFORE the root is handed to the app so the seed's own git calls can't
 *  race the watcher for index.lock. */
async function seedPhaseRepo(win: Page, tag: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `flow-ux-revgate-${tag}-`))
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  // Keep the IDE's own scaffold out of git status (see fixtures/seed.ts).
  writeFileSync(join(dir, '.git', 'info', 'exclude'), '.claude/\nflow\n.gitignore\n')
  for (const file of TRACKED) writeFileSync(join(dir, file), 'export const v = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  mkdirSync(join(dir, 'flow', 'plans'), { recursive: true })
  writeFileSync(join(dir, 'flow', 'plans', 'plan_qa_gate_v1.md'), PLAN)
  for (const file of TRACKED) writeFileSync(join(dir, file), 'export const v = 2\n')
  seeded.push(dir)
  await win.evaluate(async (path) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path })
  }, dir)
  await activateProject(win, dir)
  return dir
}

const seeded: string[] = []

/** Open Source Control → Phases (the folded-in review surface, #335). */
async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await win.waitForTimeout(SETTLE_MS)
}

interface GroupState {
  label: string | null
  files: Array<{ name: string | null; approved: boolean }>
  button: string | null
}

/** Every rendered group's label, per-file approved state and commit-row button. */
function groups(win: Page): Promise<GroupState[]> {
  return win.evaluate(() =>
    [...document.querySelectorAll('.fl-review-group')].map((group) => ({
      label: group.querySelector('.fl-review-group-label')?.textContent ?? null,
      files: [...group.querySelectorAll('.fl-review-file')].map((row) => ({
        name: row.querySelector('.fl-review-file-name')?.textContent ?? null,
        approved: row.classList.contains('fl-review-file-approved'),
      })),
      button: group.querySelector('.fl-review-commit-btn')?.textContent ?? null,
    })),
  )
}

const groupNamed = (all: GroupState[], needle: string): GroupState | undefined =>
  all.find((group) => group.label?.includes(needle))

const oneline = (dir: string): string =>
  execFileSync('git', ['log', '--oneline'], { cwd: dir }).toString().trim()

/** The discovery prompt a freshly-seeded project raises is unrelated noise that
 *  would make any "did the app say anything" assertion pass vacuously — send it
 *  away before measuring the panel's own feedback. */
async function dismissDiscoveryPrompt(win: Page): Promise<void> {
  const notNow = win.locator('.fl-flow-toast button').filter({ hasText: 'Not now' })
  for (let i = 0; i < 3; i += 1) {
    if ((await notNow.count()) === 0) return
    await notNow.first().click().catch(() => undefined)
    await win.waitForTimeout(400)
  }
}

/** Approve the shared file from INSIDE Phase 1 — the only approval this fixture
 *  ever performs. Returns the panel state once it has settled. */
async function approveSharedInPhaseOne(win: Page): Promise<GroupState[]> {
  await win
    .locator('.fl-review-group')
    .filter({ hasText: 'Phase 1' })
    .locator('.fl-review-file')
    .filter({ hasText: 'shared.ts' })
    .locator('.fl-review-approve')
    .click()
  await win.waitForTimeout(SETTLE_MS)
  return groups(win)
}

test.afterAll(() => cleanupSeeds())

test.describe('Review (Phases): approval scope and post-action feedback', () => {
  // ---------------------------------------------------------------- LIVE ----

  test('LIVE: an untouched phase really is gated — its button approves, it does not commit', async ({
    window: win,
  }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(String(error)))
    const dir = await seedPhaseRepo(win, 'gated')
    await openReview(win)

    // Nothing approved anywhere: every group must offer "Approve all (0/N)".
    const initial = await groups(win)
    expect(initial.length).toBeGreaterThanOrEqual(3)
    for (const group of initial) {
      expect(group.button, `${group.label} must be gated before any approval`).toMatch(
        /^Approve all \(0\/\d+\)$/,
      )
    }

    // Clicking a gated group's button approves; it must NOT land a commit.
    const before = oneline(dir)
    const other = win.locator('.fl-review-group').filter({ hasText: 'Other changes' })
    await other.locator('.fl-review-commit-btn').last().click()
    await win.waitForTimeout(SETTLE_MS)
    expect(oneline(dir)).toBe(before)
    expect(groupNamed(await groups(win), 'Other changes')?.button).toBe('Commit phase')
    expect(errors).toEqual([])
  })

  test('LIVE: the sibling Changes view announces a successful commit (#1144)', async ({
    window: win,
  }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(String(error)))
    const dir = await seedPhaseRepo(win, 'sibling')
    await win.locator('[data-rail-item="source-control"]').click()
    await win.waitForTimeout(SETTLE_MS)
    await dismissDiscoveryPrompt(win)

    // Stage everything through the real IPC, then commit from the Changes box.
    await win.evaluate(async () => {
      const api = (window as unknown as { flow: Record<string, any> }).flow
      const context = await api.project.active()
      const status = await api.git.status({ rootId: context.rootPath })
      await api.git.stage({
        rootId: context.rootPath,
        filePaths: (status?.changes ?? []).map((change: { filePath: string }) => change.filePath),
      })
    })
    await win.waitForTimeout(SETTLE_MS)
    const box = win.locator('textarea[data-msg-key]').first()
    await box.click()
    await box.fill('changes-view commit')
    await win.locator('button').filter({ hasText: /^Commit/ }).first().click()

    // This is the contract the Phases panel is measured against below: the same
    // git operation, announced with the repo and the hash it produced.
    const toast = win.locator('.fl-flow-toast').filter({ hasText: 'Committed' })
    await expect(toast).toBeVisible({ timeout: 8000 })
    const hash = oneline(dir).split(/\s/)[0]
    await expect(toast).toContainText(hash)
    expect(errors).toEqual([])
  })

  test('LIVE: approving inside Phase 1 stages the file and arms Phase 1 itself', async ({
    window: win,
  }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(String(error)))
    await seedPhaseRepo(win, 'arms')
    await openReview(win)

    const after = await approveSharedInPhaseOne(win)
    const phase1 = groupNamed(after, 'Phase 1')
    expect(phase1?.files.find((file) => file.name === 'shared.ts')?.approved).toBe(true)
    // Phase 1 declares two files, so one ✓ leaves it partially approved.
    expect(phase1?.button).toBe('Approve all (1/2)')
    expect(errors).toEqual([])
  })

  // ------------------------------------------------------------ TRIPWIRES ----

  test(
    'a phase the user never touched must not arm itself off a sibling phase’s approval',
    async ({ window: win }) => {
      const errors: string[] = []
      win.on('pageerror', (error) => errors.push(String(error)))
      await seedPhaseRepo(win, 'bypass')
      await openReview(win)

      const after = await approveSharedInPhaseOne(win)
      await win.screenshot({ path: join(SHOTS, 'review-phase-gate-bypass.png') })
      const phase2 = groupNamed(after, 'Phase 2')

      expect(
        phase2?.button,
        'Phase 2 was never opened, never approved — one ✓ inside Phase 1 armed it for commit ' +
          `(showing: ${phase2?.button})`,
      ).not.toBe('Commit phase')
      expect(errors).toEqual([])
    },
  )

  test(
    'committing a phase must not also commit it under a phase the user never reviewed',
    async ({ window: win }) => {
      const errors: string[] = []
      win.on('pageerror', (error) => errors.push(String(error)))
      const dir = await seedPhaseRepo(win, 'wrongphase')
      await openReview(win)
      await approveSharedInPhaseOne(win)

      // The user's only review gesture happened in Phase 1. Firing Phase 2's
      // armed button lands the change under PHASE 2's suggested message.
      const before = oneline(dir)
      await win
        .locator('.fl-review-group')
        .filter({ hasText: 'Phase 2' })
        .locator('.fl-review-commit-btn')
        .last()
        .click()
      await win.waitForTimeout(SETTLE_MS)
      const landed = oneline(dir)

      expect(
        landed === before || !landed.includes('beta'),
        `a single ✓ given in Phase 1 committed under Phase 2's message (${landed.split('\n')[0]})`,
      ).toBe(true)
      expect(errors).toEqual([])
    },
  )

  test('a successful "Commit phase" must confirm itself to the user', async ({
    window: win,
  }) => {
    const errors: string[] = []
    win.on('pageerror', (error) => errors.push(String(error)))
    const dir = await seedPhaseRepo(win, 'silentcommit')
    await openReview(win)
    await dismissDiscoveryPrompt(win)

    const other = win.locator('.fl-review-group').filter({ hasText: 'Other changes' })
    const button = other.locator('.fl-review-commit-btn').last()
    await button.click() // approve all
    await win.waitForTimeout(SETTLE_MS)
    const before = oneline(dir)
    await button.click() // commit phase
    await win.waitForTimeout(SETTLE_MS)

    // The commit really landed …
    expect(oneline(dir)).not.toBe(before)
    await win.screenshot({ path: join(SHOTS, 'review-commit-no-confirmation.png') })
    // … so the user must be told, the way the sibling Changes box tells them.
    const toast = win.locator('.fl-flow-toast').filter({ hasText: /Committed/i })
    await expect(
      toast,
      'the phase commit landed in history with no confirmation of any kind',
    ).toBeVisible({ timeout: 6000 })
    expect(errors).toEqual([])
  })

  test(
    'a destructive "Discard all" must not be indistinguishable from a successful commit',
    async ({ window: win }) => {
      const errors: string[] = []
      win.on('pageerror', (error) => errors.push(String(error)))
      const dir = await seedPhaseRepo(win, 'silentdiscard')
      await openReview(win)
      await dismissDiscoveryPrompt(win)

      const other = win.locator('.fl-review-group').filter({ hasText: 'Other changes' })
      await other.locator('.fl-review-discard-btn').first().click()
      await win.waitForTimeout(600)
      await win.locator('.fl-review-discard-btn.confirm').click()
      await win.waitForTimeout(SETTLE_MS)

      // The work really was destroyed …
      expect(readFileSync(join(dir, 'loose.ts'), 'utf8')).toBe('export const v = 1\n')
      await win.screenshot({ path: join(SHOTS, 'review-discard-no-confirmation.png') })
      // … and the only signal was the rows vanishing — exactly what a COMMIT
      // shows. Two opposite outcomes, one indistinguishable result.
      const toast = win.locator('.fl-flow-toast').filter({ hasText: /Discard|revert/i })
      await expect(
        toast,
        'the discard destroyed uncommitted work with no confirmation distinguishing it from a commit',
      ).toBeVisible({ timeout: 6000 })
      expect(errors).toEqual([])
    },
  )
})

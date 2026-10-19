import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { activateProject, waitForStableNode, removeTempDir } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5: Review, phase commit vs an unrelated staged file.
 *
 * Committing a phase group is PATH-SCOPED (#1051): `git commit -- <phase
 * files>` (git:commit) commits exactly that group's files, whatever else sits
 * in the index. A file staged OUTSIDE the phase — via the git panel or the CLI
 * (the #335 Q-1 scenario) — is simply left alone: no dialog, no sweep, still
 * staged afterwards, still listed for its own commit.
 *
 * (History: the pre-#1051 flow ran `git:stage` → `git:commitIndex`, which
 * commits the WHOLE index, guarded by an "other staged changes" `window.confirm`
 * whose only outcomes were "commit everything" or abort. This spec asserted
 * that warn-then-sweep contract; it now asserts the scoped one that replaced
 * it.)
 *
 * To get TWO groups (a phase group + "Other changes") without a Claude account,
 * we attribute one file to `phase-1` via flow/.wave-context.jsonl (the durable
 * phase-map source ReviewService reads), leaving the stray file unattributed.
 */

const SCREENS = 'e2e/ux/__screens'

/** Locate a review group section by its header label. */
function group(win: Page, label: string) {
  return win
    .locator('.fl-review-group')
    .filter({ has: win.locator('.fl-review-group-label', { hasText: label }) })
}

/** Throwaway repos seeded this file — cleaned up in afterAll. */
const seededDirs: string[] = []

/**
 * Seed a repo with a committed baseline, then two working-tree edits: `app.ts`
 * (attributed to Phase 1 via wave-context) and `stray.ts` (unattributed →
 * "Other changes"). `stray.ts` is STAGED so it sits in the index outside Phase 1.
 *
 * The whole repo — including staging stray.ts — is built BEFORE the app is told
 * about the root. Adding a root starts the app's file watcher, whose `git status`
 * refreshes would otherwise race our seed's `git add` for index.lock (a pure
 * test-infra collision). Handing over a finished repo removes that race.
 */
async function seedTwoGroupRepo(win: Page): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'flow-ux-revstaged-'))
  seededDirs.push(dir)
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  writeFileSync(join(dir, 'stray.ts'), 'export const stray = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })

  // Two working-tree changes.
  writeFileSync(join(dir, 'app.ts'), 'export const version = 2\n')
  writeFileSync(join(dir, 'stray.ts'), 'export const stray = 2\n')

  // Attribute app.ts to phase-1 so it forms its own group; stray.ts stays in
  // "Other changes". This is exactly what a wave run writes.
  mkdirSync(join(dir, 'flow'), { recursive: true })
  writeFileSync(
    join(dir, 'flow', '.wave-context.jsonl'),
    JSON.stringify({ type: 'progress', agent: 'phase-1', data: { files_modified: ['app.ts'] } }) +
      '\n',
  )

  // Stage the stray file OUTSIDE the phase — it now sits in the index and a
  // whole-index commit of Phase 1 would sweep it in.
  execFileSync('git', ['add', 'stray.ts'], { cwd: dir })

  // Only now hand the finished repo to the app: add it as a project root, then
  // activate it (setActiveProject + dismiss the per-project flow overlay).
  await win.evaluate(async (p) => {
    await (
      window as unknown as {
        flow: { project: { add(r: { path: string }): Promise<unknown> } }
      }
    ).flow.project.add({ path: p })
  }, dir)
  await activateProject(win, dir)
  return dir
}

async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
  // Let the file-watcher's debounced review refresh (500ms) settle so no
  // background `git status` is still in flight when we stage/commit — otherwise
  // it races the commit's `git add` for index.lock (a test-timing artifact from
  // seeding writes, not a product bug: a real user reviews for seconds before
  // committing, and the app surfaces a "Commit failed" toast + preserves the
  // changes + a retry succeeds even if the narrow race is hit).
  await win.waitForTimeout(900)
  // The list rebuilds a couple of times as a fresh project settles; a click
  // landing on a replaced node is lost (#1093/#1094).
  await waitForStableNode(win, '.fl-review-file')
}

/**
 * Approve every file in a group, then click its (now "Commit phase") button.
 * The panel rebuilds its whole DOM on every background refresh (and approving
 * itself triggers a git:changed refresh), so a click can land on a detached
 * node and do nothing — a harness hazard, not the behavior under test. Retry
 * each click until its observable effect (button flips / HEAD moves) lands,
 * mirroring review-phase-commit-scope.spec.ts's clickUntil.
 */
async function approveAndCommit(win: Page, dir: string, label: string): Promise<void> {
  const commitBtn = group(win, label).locator('.fl-review-commit-btn')
  await expect(async () => {
    const text = (await commitBtn.innerText()).trim()
    if (text.startsWith('Approve all')) await commitBtn.click()
    expect(text).toContain('Commit phase')
  }).toPass({ timeout: 15000 })
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
  await expect(async () => {
    if (await commitBtn.count()) await commitBtn.click().catch(() => undefined)
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
    expect(head).not.toBe(before)
  }).toPass({ timeout: 15000 })
}

test.afterAll(() => {
  while (seededDirs.length) {
    const dir = seededDirs.pop()
    if (dir) removeTempDir(dir)
  }
})

test('committing a phase leaves an unrelated staged file alone — no warning, no sweep (#1051)', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))
  const dir = await seedTwoGroupRepo(window)
  await openReview(window)

  // Two groups: Phase 1 (app.ts) and Other changes (stray.ts).
  await expect(group(window, 'Phase 1')).toBeVisible()
  await expect(group(window, 'Other changes')).toBeVisible()

  // The scoped commit never needs a dialog — record any that fires.
  const dialogs: string[] = []
  window.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.accept()
  })

  await approveAndCommit(window, dir, 'Phase 1')

  // Wait on the APP's own post-commit refresh (the Phase 1 group's only file,
  // app.ts, is committed away so the group detaches) rather than polling git —
  // repeatedly spawning `git status` while the app's commit is writing races
  // the index and can make the commit fail, a test-only artifact.
  await expect(group(window, 'Phase 1')).toHaveCount(0, { timeout: 8000 })

  // The commit contains ONLY the phase's file — the stray staged file was not
  // swept in (#1051) …
  const committed = execFileSync('git', ['show', '--pretty=format:', '--name-only', 'HEAD'], {
    cwd: dir,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
  expect(committed).toEqual(['app.ts'])

  // … and it is STILL STAGED, pending its own commit, still listed in its own
  // group with its approval (staged-ness, #857) intact.
  const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
    cwd: dir,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
  expect(staged).toEqual(['stray.ts'])
  await expect(group(window, 'Other changes')).toBeVisible()
  // The group can also hold the auto-provisioner's own untracked files
  // (.claude/, .gitignore) — assert stray.ts is still listed, not sole tenancy.
  await expect(
    group(window, 'Other changes').locator('.fl-review-file-name').filter({ hasText: 'stray.ts' }),
  ).toHaveCount(1)

  // No "other staged changes" confirm (or any other dialog) fired: a scoped
  // commit has nothing to warn about.
  expect(dialogs, dialogs.join(' | ')).toHaveLength(0)

  await window.screenshot({ path: `${SCREENS}/review-other-staged-scoped.png` })
  expect(errors, errors.join(', ')).toHaveLength(0)
})

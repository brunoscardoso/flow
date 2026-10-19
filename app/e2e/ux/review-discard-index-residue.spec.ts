import { test, expect } from '../fixtures/electron'
import { sel } from '../selectors'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5 (Review): what "Discard all" leaves BEHIND in git.
 *
 * Sixteen prior review rounds drove the panel's UI contract — the file list,
 * the approve toggle's re-gate, the commit gate/failure (#73/#434), the reject
 * prompt (#697/#397), the two-step discard confirm and its completion (#124/#136),
 * the diff overlay (#659/#854), project switch (#951), conflicts (#986),
 * overlapping prompts (#1018), multi-phase groups (#1051/#1052). Every one asks
 * whether the PANEL is right afterwards. None asks what `git status` says.
 *
 * `GitManager.revertFile` is `git checkout HEAD -- <path>` with an
 * `fs.rm` fallback for paths unknown at HEAD (#93/#136). Two working-tree states
 * make that fallback wrong or dead:
 *
 *  1. (#1090) A file the user APPROVED (✓ stages it, #857) that is new at HEAD is
 *     `A ` in the index. checkout fails ("did not match any file"), fs.rm
 *     removes the worktree copy — and NOBODY unstages the index entry. git is
 *     left at `AD`: a staged addition of a file that no longer exists.
 *  2. (#1091) A repo with NO commits yet (`git init`, nothing committed). `git checkout
 *     HEAD --` fails with `fatal: invalid reference: HEAD`, which is not the
 *     "did not match any file" string #93's guard looks for, so EVERY revert
 *     rethrows and the discard reverts nothing at all.
 *
 * The live tests below guard the behavior that IS correct today (an unapproved
 * new file discards cleanly; approval really does stage; a failed discard is
 * surfaced rather than swallowed, #103). The `test.fixme` tripwires pin the two
 * defects and are fix-agnostic — any correct fix (unstage before rm, `git rm
 * --cached`, an empty-tree revert, or refusing with an actionable message that
 * ends in a clean tree) turns them green.
 */

const SCREENS = 'e2e/ux/__screens'

/** Ignore the assets the app provisions into a managed project so the review
 *  list contains only what the test seeded. */
const IGNORES = '.claude/\nflow/\nCLAUDE.md\ngraphify-out/\n'

const porcelain = (dir: string): string =>
  execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString().trim()

/** A repo with a baseline commit plus one brand-new untracked file to review.
 *  `newFile` is unique per test so a not-yet-rebound panel can never match a
 *  previous test's project row. */
async function seedCommittedRepo(win: Page, prefix: string, newFile: string): Promise<string> {
  const dir = await seedProject(win, prefix, (d) => {
    writeFileSync(join(d, '.gitignore'), IGNORES)
  })
  execFileSync('git', ['config', 'user.email', 'qa@flow.test'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Flow QA'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', '-A'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'baseline'], { cwd: dir })
  writeFileSync(join(dir, newFile), 'export const feature = true\n')
  await activateProject(win, dir)
  return dir
}

/** A repo with NO commits — `git init` + the agent's first output. */
async function seedFreshRepo(win: Page, prefix: string, newFile: string): Promise<string> {
  const dir = await seedProject(win, prefix, (d) => {
    writeFileSync(join(d, '.gitignore'), IGNORES)
    writeFileSync(join(d, newFile), 'export const written = "by the agent"\n')
  })
  await activateProject(win, dir)
  return dir
}

/** Click a row's ✓ until git actually reports it staged. The panel rebinds to a
 *  newly activated project asynchronously, so the first click can land on a row
 *  whose coordinator still points at the previous root. */
async function approveUntilStaged(win: Page, dir: string, name: string): Promise<void> {
  await expect
    .poll(
      async () => {
        if (porcelain(dir).includes(`A  ${name}`)) return true
        await row(win, name).locator('.fl-review-approve').click({ timeout: 5000 })
        await win.waitForTimeout(700)
        return porcelain(dir).includes(`A  ${name}`)
      },
      { timeout: 20000, intervals: [500, 1000, 1000, 1000, 1000] },
    )
    .toBe(true)
}

/** Open Source Control → Phases (the folded-in review, #335). */
async function openReview(win: Page): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: 'Phases' }).click()
  await expect(win.locator('.fl-review')).toBeAttached()
}

/** Wait for a named file's review row to mount (the provisioner adds rows of its
 *  own asynchronously, so an exact total count is racy). */
function row(win: Page, name: string) {
  return win.locator('.fl-review-file').filter({ hasText: name })
}

/** Click "Discard all" and confirm the two-step destructive prompt. */
async function discardAll(win: Page): Promise<void> {
  await win.locator('.fl-review-discard-btn').first().click()
  const confirm = win.locator('.fl-review-discard-confirm')
  await expect(confirm).toBeVisible()
  await confirm.locator('.fl-review-discard-btn.confirm').click()
}

test.afterAll(() => {
  // The app keeps provisioning into the temp root while it tears down, so an
  // rm can lose a race with a background writer — never fail a green run on it.
  try {
    cleanupSeeds()
  } catch {
    /* best effort */
  }
})

test('an UNAPPROVED new file discards cleanly — worktree and index both clear', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedCommittedRepo(window, 'flow-ux-rev-res-clean-', 'clean-me.ts')
  await openReview(window)
  await expect(row(window, 'clean-me.ts')).toHaveCount(1, { timeout: 15000 })
  expect(porcelain(dir)).toContain('?? clean-me.ts')

  await discardAll(window)

  await expect(row(window, 'clean-me.ts')).toHaveCount(0, { timeout: 15000 })
  expect(existsSync(join(dir, 'clean-me.ts'))).toBe(false)
  expect(porcelain(dir)).not.toContain('clean-me.ts')
  expect(errors, errors.join(', ')).toHaveLength(0)
})

test('approving a new file really stages it (#857 mirror)', async ({ window }) => {
  const dir = await seedCommittedRepo(window, 'flow-ux-rev-res-stage-', 'stage-me.ts')
  await openReview(window)
  await expect(row(window, 'stage-me.ts')).toHaveCount(1, { timeout: 15000 })

  await approveUntilStaged(window, dir, 'stage-me.ts')
})

test('a discard that cannot revert is SURFACED, never swallowed (#103)', async ({ window }) => {
  // The no-commit repo is the reproducible "revert refuses" case; whatever the
  // fix, the user must be told when files were left unchanged.
  const dir = await seedFreshRepo(window, 'flow-ux-rev-res-loud-', 'loud-output.ts')
  await openReview(window)
  await expect(row(window, 'loud-output.ts')).toHaveCount(1, { timeout: 15000 })

  await discardAll(window)

  // Either it reverts (fixed) or it says so (today) — silence is the failure.
  await expect
    .poll(
      async () => {
        const gone = !existsSync(join(dir, 'loud-output.ts'))
        const told = await window.evaluate(() =>
          /could not be reverted|Discard incomplete|Discard failed/i.test(document.body.innerText),
        )
        return gone || told
      },
      { timeout: 12000 },
    )
    .toBe(true)
  await window.screenshot({ path: `${SCREENS}/review-nohead-discard-incomplete.png` })
})

// ── Former tripwires — live guards since the #1090/#1091 fixes ──────────────

test(
  'discarding an APPROVED new file must not leave a staged phantom in the index',
  async ({ window }) => {
    const dir = await seedCommittedRepo(window, 'flow-ux-rev-res-ghost-', 'ghost-me.ts')
    await openReview(window)
    await expect(row(window, 'ghost-me.ts')).toHaveCount(1, { timeout: 15000 })

    // Approve → the new file becomes a staged addition (`A `).
    await approveUntilStaged(window, dir, 'ghost-me.ts')

    await discardAll(window)
    await window.waitForTimeout(2500)

    // The worktree copy is gone …
    expect(existsSync(join(dir, 'ghost-me.ts'))).toBe(false)
    await window.screenshot({ path: `${SCREENS}/review-index-residue-ghost.png` })
    // … but today the index still carries the addition (`AD feature.ts`), so the
    // panel grows a "D" row for a deletion the user never made, and a second
    // "Discard all" is a total no-op.
    expect(
      porcelain(dir),
      `"Discard all" promised "Files revert to HEAD" but git still reports: ${porcelain(dir)}`,
    ).not.toContain('ghost-me.ts')
    await expect(row(window, 'ghost-me.ts')).toHaveCount(0)
  },
)

test(
  'Discard all works in a repo with no initial commit',
  async ({ window }) => {
    const dir = await seedFreshRepo(window, 'flow-ux-rev-res-nohead-', 'nohead-output.ts')
    await openReview(window)
    await expect(row(window, 'nohead-output.ts')).toHaveCount(1, { timeout: 15000 })

    await discardAll(window)
    await window.waitForTimeout(2500)

    expect(
      existsSync(join(dir, 'nohead-output.ts')),
      'Discard all left the file on disk — `git checkout HEAD --` fails with ' +
        '"fatal: invalid reference: HEAD" in an unborn repo and #93\'s guard rethrows',
    ).toBe(false)
    await expect(row(window, 'nohead-output.ts')).toHaveCount(0)
  },
)

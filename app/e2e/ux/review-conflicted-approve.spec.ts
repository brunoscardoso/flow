import { test, expect } from '../fixtures/electron'
import { seedProject, activateProject, cleanupSeeds } from './fixtures/seed'
import { sel } from '../selectors'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'

/**
 * UX sweep — flow 5 (Review): a CONFLICTED file in the Phases (review) tab.
 *
 * The Source Control panel's two tabs disagree about conflicted files. The
 * Changes tab routes them into a dedicated "Merge Changes" section whose rows
 * deliberately offer NO stage action (source-control-actions.ts: merge →
 * use-ours / use-theirs / open-merge / open-diff), and its merge banner enables
 * "Complete merge" only once `unmergedCount === 0` — because staging a file that
 * still holds `<<<<<<<` markers tells git the conflict is resolved.
 *
 * The Phases tab used to render the very same file as an ordinary row with
 * ✓ Approve (→ `git add`) and "Commit phase" (→ `git commit`) — approving
 * marked the conflict resolved and the phase commit landed the merge commit
 * with the markers still in the file (#986).
 *
 * Fixed: GitManager.unresolvedConflictPaths is the ONE detection code path —
 * it gates stage()/commitIndex()/commit()/completeMerge() main-side, and the
 * panel mirrors the listing's `conflicted` state (blocked ✓ with a refusal
 * toast; the phase button becomes "Resolve N conflicts first"). The tests
 * below assert both tabs now enforce the same invariant.
 */

const SCREENS = 'e2e/ux/__screens'

/** Seed a repo parked in a real conflicted merge (built BEFORE addRoot, so the
 *  app's git watcher can never race the seed for `.git/index.lock`). */
async function seedConflictedRepo(win: Page): Promise<string> {
  const dir = await seedProject(win, 'flow-ux-conflict-', (d) => {
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: d })
    }
    git('config', 'user.email', 'qa@flow.test')
    git('config', 'user.name', 'Flow QA')
    writeFileSync(join(d, 'app.ts'), 'export const version = 1\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'baseline')
    git('checkout', '-q', '-b', 'feature')
    writeFileSync(join(d, 'app.ts'), 'export const version = 2 // feature\n')
    git('commit', '-qam', 'feature change')
    git('checkout', '-q', '-')
    writeFileSync(join(d, 'app.ts'), 'export const version = 3 // main\n')
    git('commit', '-qam', 'main change')
    try {
      git('merge', 'feature')
    } catch {
      // Expected — the merge conflicts and parks the repo in MERGE state.
    }
  })
  await activateProject(win, dir)
  return dir
}

function gitOut(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString().trim()
}

/** app.ts's porcelain status line, isolated from the auto-provisioner's own
 *  untracked files (.claude/, .gitignore, flow) that land mid-test. */
function appTsStatus(dir: string): string {
  return gitOut(dir, 'status', '--porcelain', '--', 'app.ts')
}

/** Whether the repo is still mid-merge ('' once a merge commit lands). */
function mergeHead(dir: string): string {
  try {
    return execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: dir })
      .toString()
      .trim()
  } catch {
    return ''
  }
}

async function openSourceControl(win: Page, view: 'Changes' | 'Phases'): Promise<void> {
  await win.locator('[data-rail-item="source-control"]').click()
  await win.locator(sel.scViewBtn).filter({ hasText: view }).click()
}

test.afterAll(() => cleanupSeeds())

/**
 * The stable sibling: the Changes tab keeps an unresolved conflict out of the
 * stage/commit path — it lives in "Merge Changes" with resolve-only actions.
 */
test('Changes tab routes a conflicted file into Merge Changes, not the stage path', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedConflictedRepo(window)
  expect(appTsStatus(dir)).toBe('UU app.ts')

  await openSourceControl(window, 'Changes')
  const panel = window.locator(sel.gitPanelRoot)
  await expect(panel).toBeAttached({ timeout: 10000 })
  // The conflicted file is listed under the merge section, and the panel says a
  // merge is in progress — the user is told the repo is in a special state.
  await expect(panel.getByText('Merge Changes', { exact: false }).first()).toBeVisible({
    timeout: 10000,
  })
  await expect(panel.locator('.gp-name').filter({ hasText: 'app.ts' }).first()).toBeAttached()

  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * The Phases tab shows the same conflicted file. It correctly reports the `U`
 * state letter — that part is stable and worth guarding.
 */
test('Phases tab lists the conflicted file with the U state letter', async ({ window }) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  await seedConflictedRepo(window)
  await openSourceControl(window, 'Phases')
  await expect(window.locator('.fl-review')).toBeAttached()

  const row = window.locator('.fl-review-file').filter({ hasText: 'app.ts' }).first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await expect(row.locator('.fl-review-state-conflicted')).toHaveText('U')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * #986 (fixed) — an unresolved conflict is not approvable/committable from the
 * review surface. The ✓ refuses (GitManager.unresolvedConflictPaths gates
 * `stage`, the panel blocks renderer-side from the listing's `conflicted`
 * state), and the phase button reads "Resolve N conflicts first" instead of
 * dispatching a commit — the merge stays in progress until the markers are gone.
 */
test(
  '#986 unresolved conflict must not be approvable/committable from the Phases tab',
  async ({ window }) => {
    const errors: string[] = []
    window.on('pageerror', (e) => errors.push(e.message))

    const dir = await seedConflictedRepo(window)
    await openSourceControl(window, 'Phases')
    const row = window.locator('.fl-review-file').filter({ hasText: 'app.ts' }).first()
    await expect(row).toBeVisible({ timeout: 10000 })

    await row.locator('.fl-review-approve').click()
    await window.waitForTimeout(1500)
    // ✓ must NOT resolve the conflict behind the user's back.
    expect(appTsStatus(dir)).toBe('UU app.ts')

    await window.locator('.fl-review-message').first().fill('feat: commit the phase')
    const commitBtn = window.locator('.fl-review-commit-btn').last()
    // The button may first offer "Approve all" for the provisioner's own files —
    // clicking through it must still never dispatch a commit while the conflict
    // stands, so drive it (at most a few states) and verify below.
    for (let clicks = 0; clicks < 3; clicks += 1) {
      await commitBtn.click()
      await window.waitForTimeout(1500)
    }

    // The merge must still be in progress and no marker-laden commit may exist.
    expect(mergeHead(dir)).not.toBe('')
    expect(appTsStatus(dir)).toBe('UU app.ts')
    expect(readFileSync(join(dir, 'app.ts'), 'utf8')).toContain('<<<<<<<')
    expect(gitOut(dir, 'log', '-1', '--pretty=%s')).not.toBe('feat: commit the phase')

    expect(errors, errors.join(', ')).toHaveLength(0)
  },
)

/**
 * The fixed affordances (#986): the phase button announces the block instead of
 * offering "Approve all (0/1)", the ✓ carries a resolve-first hint, and a click
 * raises the refusal toast pointing at the merge resolver. Captures the
 * screenshots documenting the fix.
 */
test('FIXED BEHAVIOR: the Phases tab demands resolution and refuses with a toast', async ({
  window,
}) => {
  const errors: string[] = []
  window.on('pageerror', (e) => errors.push(e.message))

  const dir = await seedConflictedRepo(window)
  await openSourceControl(window, 'Phases')
  const row = window.locator('.fl-review-file').filter({ hasText: 'app.ts' }).first()
  await expect(row).toBeVisible({ timeout: 10000 })

  // The conflicted row is visibly blocked and the ✓ explains itself.
  const approve = row.locator('.fl-review-approve')
  await expect(approve).toHaveClass(/fl-review-approve-blocked/)
  await expect(approve).toHaveAttribute('title', /resolve it before approving/i)

  // The phase button demands resolution instead of offering the conflict for
  // approval. The auto-provisioner's own files (.claude/, .gitignore) can share
  // the group, so approve those siblings until only the conflict blocks it.
  const commitBtn = window.locator('.fl-review-commit-btn').last()
  await expect(async () => {
    const text = (await commitBtn.innerText()).trim()
    if (text.startsWith('Approve all')) {
      await commitBtn.click()
      throw new Error(`still approving provisioned siblings: ${text}`)
    }
    expect(text).toBe('Resolve 1 conflict first')
  }).toPass({ timeout: 20000 })
  await window.screenshot({ path: `${SCREENS}/review-conflicted-blocked-row.png` })

  // ✓ refuses with an actionable toast; the conflict is NOT staged away.
  await approve.click()
  const toast = window.locator('.fl-flow-toast').filter({ hasText: 'Unresolved merge conflict' })
  await expect(toast.first()).toBeVisible({ timeout: 5000 })
  await window.screenshot({ path: `${SCREENS}/review-conflicted-refusal-toast.png` })
  expect(appTsStatus(dir)).toBe('UU app.ts')

  // The phase button never dispatches a commit while the conflict stands.
  await commitBtn.click()
  await window.waitForTimeout(1500)
  expect(mergeHead(dir)).not.toBe('')
  expect(appTsStatus(dir)).toBe('UU app.ts')

  expect(errors, errors.join(', ')).toHaveLength(0)
})

/**
 * Seed a thread that owns a real git worktree with uncommitted changes —
 * the fixture the change-review card (#1906) needs and this repo did not have.
 *
 * It drives the app's OWN seams end to end (no store backdoors):
 *   1. `seedProject` — a throwaway git repo, committed base, added as a root.
 *   2. `threads.create` — a real thread (the multi-project chooser's seam).
 *   3. `threads.prepareWorktree` — cuts the thread's own worktree
 *      (`thread_worktrees` defaults true), the same call the New-thread flow makes.
 *   4. writes two changes INTO that worktree — one tracked-file edit (counted vs
 *      HEAD) and one new untracked file (listed, no counts).
 *
 * Returns the ids/paths the card + the `threads:changeReview` IPC read from.
 */
import type { Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { activateProject, seedProject } from '../ux/fixtures/seed'

export interface SeededThreadWorktree {
  /** The project root (the added project root). */
  root: string
  /** The created thread's id. */
  threadId: string
  /** The thread's own worktree — where the changes live. */
  worktreePath: string
}

interface FlowThreadsBridge {
  threads: {
    create(request: { projectRoot: string; title: string }): Promise<{ id: string }>
    prepareWorktree(request: {
      threadId: string
    }): Promise<{ status: string; detail?: string }>
    get(request: { threadId: string }): Promise<{ worktreePath: string | null } | null>
  }
}

/**
 * The OTHER thread — the normal one, after the worktree gate made automatic
 * copies loops-only: no checkout of its own, working directly in the project.
 * Its review is the project's own uncommitted work, which is what the main-side
 * fallback (`reviewRootFor`) exists to return; before it, this thread's review
 * resolved to null and the surface reported nothing to review while Source
 * Control listed the same files.
 */
export async function seedThreadInProject(
  win: Page,
): Promise<{ root: string; threadId: string }> {
  const root = await seedProject(win, 'flow-change-review-shared-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', 'a.ts'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir })
  })
  await activateProject(win, root)

  const threadId = await win.evaluate(async (projectRoot) => {
    const flow = (window as unknown as { flow: FlowThreadsBridge }).flow
    const created = await flow.threads.create({ projectRoot, title: 'Project-files thread' })
    return created.id
  }, root)

  // Uncommitted work in the PROJECT itself — no worktree was ever cut.
  writeFileSync(join(root, 'a.ts'), 'export const a = 2\nexport const b = 3\n')

  return { root, threadId }
}

/**
 * A thread on a project with a CLEAN tree — nothing uncommitted, nothing
 * touched. The review's genuinely-empty case, which is the one the toolbar has
 * to disappear for.
 */
export async function seedThreadInCleanProject(
  win: Page,
): Promise<{ root: string; threadId: string }> {
  const root = await seedProject(win, 'flow-change-review-clean-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir })
  })
  await activateProject(win, root)

  const threadId = await win.evaluate(async (projectRoot) => {
    const flow = (window as unknown as { flow: FlowThreadsBridge }).flow
    const created = await flow.threads.create({ projectRoot, title: 'Clean project thread' })
    return created.id
  }, root)

  return { root, threadId }
}

/**
 * A thread on a project that HAS an upstream — a bare repo beside it, with the
 * branch pushed and tracking. The review's committed state needs one: "unpushed"
 * is not a fact that can be established without a base, and nothing guesses one.
 */
export async function seedThreadInPushedProject(
  win: Page,
): Promise<{ root: string; threadId: string; bare: string }> {
  const bare = mkdtempSync(join(tmpdir(), 'flow-change-review-remote-'))
  execFileSync('git', ['init', '--bare', '-q', bare])
  const root = await seedProject(win, 'flow-change-review-pushed-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir })
    execFileSync('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: dir })
  })
  await activateProject(win, root)

  const threadId = await win.evaluate(async (projectRoot) => {
    const flow = (window as unknown as { flow: FlowThreadsBridge }).flow
    const created = await flow.threads.create({ projectRoot, title: 'Pushed project thread' })
    return created.id
  }, root)

  // Uncommitted work to commit in the test.
  writeFileSync(join(root, 'a.ts'), 'export const a = 2\nexport const b = 3\n')

  // The bare repo is returned so a publish test can ask THE REMOTE what it
  // holds. A push asserted only through the toolbar's own sentence is the app
  // grading its own homework; the ref on disk is the fact.
  return { root, threadId, bare }
}

/**
 * A thread on a project whose branch NOBODY HAS AIMED — the plan's R1.
 *
 * A remote exists (so the ask has somewhere to offer) and the branch has never
 * been published to it, which is the one state where `ahead: 0` does not mean
 * "nothing to publish": there is no upstream for the branch to be ahead OF. The
 * uncommitted edit is what keeps the toolbar on screen — the review's chrome
 * disappears when there is nothing to review, Push included.
 */
export async function seedThreadOnUnboundBranch(
  win: Page,
): Promise<{ root: string; threadId: string; bare: string; branch: string }> {
  const bare = mkdtempSync(join(tmpdir(), 'flow-publish-unbound-remote-'))
  execFileSync('git', ['init', '--bare', '-q', bare])
  const branch = 'never-published'
  const root = await seedProject(win, 'flow-publish-unbound-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir })
    // A remote with NOTHING on it: the destination exists, the decision does not.
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir })
    execFileSync('git', ['checkout', '-q', '-b', branch], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2\n')
    execFileSync('git', ['commit', '-q', '-am', 'work on an unaimed branch'], { cwd: dir })
  })
  await activateProject(win, root)

  const threadId = await win.evaluate(async (projectRoot) => {
    const flow = (window as unknown as { flow: FlowThreadsBridge }).flow
    const created = await flow.threads.create({ projectRoot, title: 'Unbound branch thread' })
    return created.id
  }, root)

  writeFileSync(join(root, 'a.ts'), 'export const a = 2\nexport const b = 3\n')

  return { root, threadId, bare, branch }
}

/**
 * A thread whose branch is BOTH ahead of and behind its upstream.
 *
 * Built the only honest way: a second clone publishes a commit, this checkout
 * fetches it (so git really knows it is behind) and then commits its own. The
 * review lands in its committed state — no loose files, one unpushed commit —
 * which is exactly where the Push control lives.
 */
export async function seedThreadOnDivergedBranch(
  win: Page,
): Promise<{ root: string; threadId: string; bare: string; branch: string; clone: string }> {
  const bare = mkdtempSync(join(tmpdir(), 'flow-publish-diverged-remote-'))
  execFileSync('git', ['init', '--bare', '-q', bare])
  const clone = mkdtempSync(join(tmpdir(), 'flow-publish-diverged-clone-'))
  let branch = ''
  const root = await seedProject(win, 'flow-publish-diverged-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir })
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir })
    execFileSync('git', ['push', '-q', '-u', 'origin', 'HEAD'], { cwd: dir })
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir })
      .toString()
      .trim()

    // Somebody else's commit, made where this checkout cannot see it.
    execFileSync('git', ['clone', '-q', bare, clone])
    execFileSync('git', ['config', 'user.email', 'other@flow.test'], { cwd: clone })
    execFileSync('git', ['config', 'user.name', 'Other E2E'], { cwd: clone })
    writeFileSync(join(clone, 'b.ts'), 'export const b = 1\n')
    execFileSync('git', ['add', '-A'], { cwd: clone })
    execFileSync('git', ['commit', '-q', '-m', 'their work'], { cwd: clone })
    execFileSync('git', ['push', '-q', 'origin', 'HEAD'], { cwd: clone })

    // …which this one now KNOWS about (behind), and one of its own (ahead).
    execFileSync('git', ['fetch', '-q', 'origin'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 2\nexport const c = 3\n')
    execFileSync('git', ['commit', '-q', '-am', 'our work'], { cwd: dir })
  })
  await activateProject(win, root)

  const threadId = await win.evaluate(async (projectRoot) => {
    const flow = (window as unknown as { flow: FlowThreadsBridge }).flow
    const created = await flow.threads.create({ projectRoot, title: 'Diverged branch thread' })
    return created.id
  }, root)

  return { root, threadId, bare, branch, clone }
}

export async function seedThreadWithChanges(win: Page): Promise<SeededThreadWorktree> {
  // A committed base so `git worktree add` has a starting point, plus a git
  // identity so the commit does not prompt.
  const root = await seedProject(win, 'flow-change-review-', (dir) => {
    execFileSync('git', ['config', 'user.email', 'e2e@flow.test'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 'Flow E2E'], { cwd: dir })
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, 'keep.ts'), 'export const keep = 1\n')
    execFileSync('git', ['add', 'a.ts', 'keep.ts'], { cwd: dir })
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: dir })
  })
  await activateProject(win, root)

  // Create the thread and cut its own worktree — fail LOUDLY with the status if
  // the environment has thread worktrees disabled, rather than seeding an empty
  // review the test would then misread as a bug in the card.
  const threadId = await win.evaluate(async (projectRoot) => {
    const flow = (window as unknown as { flow: FlowThreadsBridge }).flow
    const created = await flow.threads.create({ projectRoot, title: 'Change review e2e' })
    const prepared = await flow.threads.prepareWorktree({ threadId: created.id })
    if (prepared.status !== 'created' && prepared.status !== 'ready') {
      throw new Error(`prepareWorktree returned '${prepared.status}': ${prepared.detail ?? ''}`)
    }
    return created.id
  }, root)

  const worktreePath = await win.evaluate(async (id) => {
    const flow = (window as unknown as { flow: FlowThreadsBridge }).flow
    const detail = await flow.threads.get({ threadId: id })
    return detail?.worktreePath ?? null
  }, threadId)
  if (worktreePath === null) {
    throw new Error('thread has no worktreePath after a successful prepareWorktree')
  }

  // Two changes in the worktree: a tracked-file edit (counts vs HEAD) and a new
  // untracked file (listed, no counts). Neither is a flow/ artifact.
  writeFileSync(join(worktreePath, 'a.ts'), 'export const a = 2\nexport const b = 3\n')
  writeFileSync(join(worktreePath, 'added.ts'), 'export const added = true\n')

  return { root, threadId, worktreePath }
}

/**
 * THE MIGRATION AGAINST REAL GIT — the test that had to exist before anybody
 * sets the flag.
 *
 * Everything else about this migration is tested with a faked runner, which
 * proves the decisions and nothing about the act. The act is `git worktree
 * move`: a verb with its own refusals, its own registry
 * (`.git/worktrees/<id>/gitdir`), and its own opinion about locked and missing
 * checkouts. A plan that is right and a move that does not land is still a
 * person's directory in the wrong place.
 *
 * So this one makes real repositories, real worktrees at real uuid-shaped
 * paths, and runs the real thing — then asks GIT what it thinks happened
 * rather than asking the code that just ran (forbidden-pattern #7).
 *
 * Nothing here touches anything outside its own temp directory.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyCheckoutRenames,
  planCheckoutRenames,
  type RecordedCheckout,
} from './checkout-rename'

const UUID_A = 'e2265b48-03e9-43e3-8f76-ff887a48615e'
const UUID_B = 'b3fe4467-2ffb-4b6a-9539-dfbc10bef52a'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
}

/** A repository with one commit, and a container for its checkouts. */
function seedRepo(): { dir: string; repo: string; threads: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flow-rename-live-'))
  const repo = join(dir, 'orbit-app')
  execFileSync('mkdir', ['-p', repo])
  git(repo, 'init', '-q')
  git(repo, 'config', 'user.email', 'live@flow.test')
  git(repo, 'config', 'user.name', 'Flow Live')
  git(repo, 'symbolic-ref', 'HEAD', 'refs/heads/main')
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'base')
  return { dir, repo, threads: join(dir, '.orbit-app-threads') }
}

/** A checkout at a uuid-shaped path, exactly as this app used to make them. */
function seedCheckout(repo: string, threads: string, id: string, branch: string): string {
  const path = join(threads, id)
  git(repo, 'worktree', 'add', '-q', '-b', branch, path)
  return path
}

/** The real dependencies — git, the filesystem, and a store stand-in. */
function liveDeps(moved: Array<[string, string]>) {
  return {
    runGit: async (cwd: string, args: readonly string[]) => {
      try {
        git(cwd, ...args)
        return { ok: true }
      } catch (error) {
        return { ok: false, stderr: String((error as { stderr?: Buffer }).stderr ?? error) }
      }
    },
    exists: (path: string) => existsSync(path),
    repoint: (from: string, to: string) => {
      moved.push([from, to])
    },
    // The real one: `git worktree move` will not create the folder it moves
    // into, and the nested shape means that folder is new the first time.
    ensureParent: (path: string) => {
      mkdirSync(path, { recursive: true })
    },
  }
}

describe('the rename, against real git', () => {
  let seeded: ReturnType<typeof seedRepo> | null = null

  afterEach(() => {
    if (seeded !== null) rmSync(seeded.dir, { recursive: true, force: true })
    seeded = null
  })

  it('moves the directory AND git’s own record of it', async () => {
    seeded = seedRepo()
    const { repo, threads } = seeded
    const from = seedCheckout(repo, threads, UUID_A, 'worktree/one')

    const checkouts: RecordedCheckout[] = [
      {
        threadId: UUID_A,
        title: 'Data Contract Guard',
        rootPath: repo,
        worktreePath: from,
        kind: 'primary',
      },
    ]
    const moved: Array<[string, string]> = []
    const plan = planCheckoutRenames(checkouts)
    const results = await applyCheckoutRenames(liveDeps(moved), plan, { dryRun: false })

    expect(results.map((result) => result.status)).toEqual(['renamed'])
    const to = join(threads, 'worktree', 'data-contract-guard')
    // The disk moved…
    expect(existsSync(from)).toBe(false)
    expect(existsSync(join(to, 'a.ts'))).toBe(true)
    // …GIT agrees it moved, which `mv` would not have achieved…
    expect(git(repo, 'worktree', 'list')).toContain(to)
    expect(git(repo, 'worktree', 'list')).not.toContain(from)
    // …the checkout still works as a checkout…
    expect(git(to, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('worktree/one')
    // …and the record was pointed at where it now is.
    expect(moved).toEqual([[from, to]])
  })

  it('moves NOTHING on a dry run, against the same real repository', async () => {
    seeded = seedRepo()
    const { repo, threads } = seeded
    const from = seedCheckout(repo, threads, UUID_A, 'worktree/one')
    const moved: Array<[string, string]> = []
    await applyCheckoutRenames(
      liveDeps(moved),
      planCheckoutRenames([
        { threadId: UUID_A, title: 'Data Contract Guard', rootPath: repo, worktreePath: from, kind: 'primary' },
      ]),
      { dryRun: true },
    )
    expect(existsSync(from)).toBe(true)
    expect(git(repo, 'worktree', 'list')).toContain(from)
    expect(moved).toEqual([])
  })

  it('leaves a LOCKED checkout exactly where it is, and says so', async () => {
    seeded = seedRepo()
    const { repo, threads } = seeded
    const from = seedCheckout(repo, threads, UUID_A, 'worktree/one')
    // The real refusal, from real git — a locked worktree is one somebody said
    // must not move.
    git(repo, 'worktree', 'lock', from)

    const moved: Array<[string, string]> = []
    const results = await applyCheckoutRenames(
      liveDeps(moved),
      planCheckoutRenames([
        { threadId: UUID_A, title: 'Data Contract Guard', rootPath: repo, worktreePath: from, kind: 'primary' },
      ]),
      { dryRun: false },
    )

    expect(results[0]?.status).toBe('refused')
    expect(existsSync(from)).toBe(true)
    // AND THE RECORD DID NOT MOVE WITH IT — a repointed record over a directory
    // that stayed put is the one outcome worse than not migrating at all.
    expect(moved).toEqual([])
  })

  it('renames the rest when one of them refuses — a partial migration works', async () => {
    seeded = seedRepo()
    const { repo, threads } = seeded
    const stuck = seedCheckout(repo, threads, UUID_A, 'worktree/one')
    const fine = seedCheckout(repo, threads, UUID_B, 'worktree/two')
    git(repo, 'worktree', 'lock', stuck)

    const moved: Array<[string, string]> = []
    const results = await applyCheckoutRenames(
      liveDeps(moved),
      planCheckoutRenames([
        { threadId: UUID_A, title: 'Stuck one', rootPath: repo, worktreePath: stuck, kind: 'primary' },
        { threadId: UUID_B, title: 'Fine one', rootPath: repo, worktreePath: fine, kind: 'primary' },
      ]),
      { dryRun: false },
    )

    expect(results.map((result) => result.status)).toEqual(['refused', 'renamed'])
    // The one that could move did…
    expect(existsSync(join(threads, 'worktree', 'fine-one'))).toBe(true)
    // …the one that could not is untouched and still a working checkout…
    expect(existsSync(stuck)).toBe(true)
    expect(git(stuck, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('worktree/one')
    // …and git holds both, one under each kind of name. THIS is the end state
    // most machines will actually be in, and it has to be a correct one.
    const listed = git(repo, 'worktree', 'list')
    expect(listed).toContain(stuck)
    expect(listed).toContain(join(threads, 'worktree', 'fine-one'))
  })

  it('nests a FLAT checkout, and git follows it', async () => {
    // The shape this feature shipped with for one afternoon. It is not a uuid,
    // so the original migration would never look at it again.
    seeded = seedRepo()
    const { repo, threads } = seeded
    const from = join(threads, 'worktree-export-pipeline')
    git(repo, 'worktree', 'add', '-q', '-b', 'export-pipeline', from)

    const moved: Array<[string, string]> = []
    const results = await applyCheckoutRenames(
      liveDeps(moved),
      planCheckoutRenames([
        { threadId: UUID_A, title: 'Unrelated title', rootPath: repo, worktreePath: from, kind: 'primary' },
      ]),
      { dryRun: false },
    )

    expect(results.map((result) => result.status)).toEqual(['renamed'])
    const to = join(threads, 'worktree', 'export-pipeline')
    expect(existsSync(join(to, 'a.ts'))).toBe(true)
    expect(existsSync(from)).toBe(false)
    // GIT AGREES, which `mv` would not have achieved…
    expect(git(repo, 'worktree', 'list')).toContain(to)
    // …the checkout still works, on the branch it was already on…
    expect(git(to, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('export-pipeline')
    // …and the BRANCH was not touched: this migration moves a directory.
    expect(moved).toEqual([[from, to]])
  })

  it('is a no-op the second time — there is nothing left named after an id', async () => {
    seeded = seedRepo()
    const { repo, threads } = seeded
    const from = seedCheckout(repo, threads, UUID_A, 'worktree/one')
    const moved: Array<[string, string]> = []
    const deps = liveDeps(moved)
    const checkouts: RecordedCheckout[] = [
      { threadId: UUID_A, title: 'Data Contract Guard', rootPath: repo, worktreePath: from, kind: 'primary' },
    ]
    await applyCheckoutRenames(deps, planCheckoutRenames(checkouts), { dryRun: false })

    // The store now holds the new path, which is what the second run reads.
    const after: RecordedCheckout[] = [{ ...checkouts[0]!, worktreePath: moved[0]![1] }]
    expect(planCheckoutRenames(after)).toEqual([])
  })
})

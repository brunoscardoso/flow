// Thread change-review read model tests (#1906). `buildThreadChangeReview` is
// PURE (path math only), so these run with no fs/git — the union of git status +
// touched paths, count joining, the flow/ filter, the touched-only rule, and git
// as the source of truth are all pinned here. `resolveThreadChangeReview` is
// driven through injected fakes (no GitManager, no ThreadStore, no Electron).

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import { join, resolve } from 'node:path'

import {
  buildThreadChangeReview,
  resolveThreadChangeReview,
  type ChangeCounts,
  type ChangeReviewGit,
  type ChangeReviewThreads,
} from './change-review'
import type { GitFileChange, GitStatus } from '../../shared/ipc-contract'

const ROOT = resolve('/repo')

function status(changes: GitFileChange[]): GitStatus {
  return {
    rootId: ROOT,
    branch: 'main',
    dirty: changes.length > 0,
    ahead: 0,
    behind: 0,
    changes,
  }
}

function change(overrides: Partial<GitFileChange> & { filePath: string }): GitFileChange {
  return { state: 'modified', staged: false, ...overrides }
}

describe('buildThreadChangeReview', () => {
  it('unions git changes with counts, status and staged flags', () => {
    const counts = new Map<string, ChangeCounts>([
      ['src/a.ts', { added: 12, deleted: 3, binary: false }],
    ])
    const review = buildThreadChangeReview({
      threadId: 't1',
      ownWorktree: true,
      rootId: ROOT,
      gitStatus: status([change({ filePath: 'src/a.ts', staged: true })]),
      touchedPaths: [],
      counts,
    })
    expect(review.files).toEqual([
      {
        filePath: 'src/a.ts',
        status: 'modified',
        staged: true,
        added: 12,
        deleted: 3,
        binary: false,
        touchedOnly: false,
      },
    ])
  })

  it('filters flow/ artifacts out of the git change set', () => {
    const review = buildThreadChangeReview({
      threadId: 't1',
      ownWorktree: true,
      rootId: ROOT,
      gitStatus: status([
        change({ filePath: 'flow/tasklist.md' }),
        change({ filePath: 'src/a.ts' }),
      ]),
      touchedPaths: [],
    })
    expect(review.files.map((f) => f.filePath)).toEqual(['src/a.ts'])
  })

  it('adds a touched-but-unchanged file as touchedOnly (never keep/rejectable)', () => {
    const review = buildThreadChangeReview({
      threadId: 't1',
      ownWorktree: true,
      rootId: ROOT,
      gitStatus: status([change({ filePath: 'src/a.ts' })]),
      touchedPaths: [
        { toolName: 'Edit', filePath: join(ROOT, 'src/b.ts') }, // no git change → touchedOnly
        { toolName: 'Edit', filePath: join(ROOT, 'src/a.ts') }, // already a real change → not duplicated
      ],
    })
    const b = review.files.find((f) => f.filePath === 'src/b.ts')
    expect(b?.touchedOnly).toBe(true)
    expect(b?.staged).toBe(false)
    // 'src/a.ts' appears once, as the real (non-touchedOnly) change.
    expect(review.files.filter((f) => f.filePath === 'src/a.ts')).toHaveLength(1)
    expect(review.files.find((f) => f.filePath === 'src/a.ts')?.touchedOnly).toBe(false)
  })

  it('ignores touched paths that are flow/ artifacts, non-edit tools, or outside the root', () => {
    const review = buildThreadChangeReview({
      threadId: 't1',
      ownWorktree: true,
      rootId: ROOT,
      gitStatus: null,
      touchedPaths: [
        { toolName: 'Edit', filePath: join(ROOT, 'flow/brain/x.md') }, // flow artifact
        { toolName: 'Read', filePath: join(ROOT, 'src/c.ts') }, // not a file-edit tool
        { toolName: 'Write', filePath: resolve('/elsewhere/d.ts') }, // outside the root
        { toolName: 'Write', filePath: null }, // no path
      ],
    })
    expect(review.files).toEqual([])
  })

  it('reports a binary file with null counts', () => {
    const counts = new Map<string, ChangeCounts>([
      ['assets/logo.png', { added: null, deleted: null, binary: true }],
    ])
    const review = buildThreadChangeReview({
      threadId: 't1',
      ownWorktree: true,
      rootId: ROOT,
      gitStatus: status([change({ filePath: 'assets/logo.png', state: 'added' })]),
      touchedPaths: [],
      counts,
    })
    expect(review.files[0]).toMatchObject({ binary: true, added: null, deleted: null })
  })

  it('carries renamedFrom through', () => {
    const review = buildThreadChangeReview({
      threadId: 't1',
      ownWorktree: true,
      rootId: ROOT,
      gitStatus: status([
        change({ filePath: 'src/new.ts', state: 'renamed', renamedFrom: 'src/old.ts' }),
      ]),
      touchedPaths: [],
    })
    expect(review.files[0].renamedFrom).toBe('src/old.ts')
  })
})

describe('resolveThreadChangeReview', () => {
  const threads = (
    worktree: string | null,
    touched: Array<{ toolName: string; filePath: string | null }> = [],
  ): ChangeReviewThreads => ({
    reviewRootFor: () => (worktree === null ? null : { rootPath: worktree, ownWorktree: true }),
    listToolCallPaths: () => touched,
  })

  it('returns null only when the thread names no root at all', async () => {
    const git: ChangeReviewGit = {
      listUntrackedInDir: async () => [],
      aheadFiles: async () => [],
      upstreamOf: async () => null,
      status: async () => null,
      changeCounts: async () => new Map(),
    }
    expect(await resolveThreadChangeReview(git, threads(null), 't1')).toBeNull()
  })

  it('REVIEWS THE PROJECT TREE for a thread with no copy of its own', async () => {
    // After the worktree gate (loops only) this is the normal thread, and the
    // old `worktreePathFor` returned null for it — so the review surface
    // reported nothing to review while Source Control listed the same files two
    // columns away. The list is the same; only `ownWorktree` differs, and it is
    // what stops the UI calling every uncommitted file in the repo "what this
    // conversation changed".
    const git: ChangeReviewGit = {
      listUntrackedInDir: async () => [],
      aheadFiles: async () => [],
      upstreamOf: async () => null,
      status: async () => status([change({ filePath: 'src/a.ts' })]),
      changeCounts: async () => new Map(),
    }
    const shared: ChangeReviewThreads = {
      reviewRootFor: () => ({ rootPath: ROOT, ownWorktree: false }),
      listToolCallPaths: () => [],
    }
    const review = await resolveThreadChangeReview(git, shared, 't1')
    expect(review?.rootId).toBe(ROOT)
    expect(review?.ownWorktree).toBe(false)
    expect(review?.files.map((f) => f.filePath)).toEqual(['src/a.ts'])
  })

  it('unions git status + counts + touched paths for a thread with a worktree', async () => {
    const git: ChangeReviewGit = {
      listUntrackedInDir: async () => [],
      aheadFiles: async () => [],
      upstreamOf: async () => null,
      status: async () => status([change({ filePath: 'src/a.ts' })]),
      changeCounts: async () => new Map([['src/a.ts', { added: 1, deleted: 0, binary: false }]]),
    }
    const review = await resolveThreadChangeReview(
      git,
      threads(ROOT, [{ toolName: 'Edit', filePath: join(ROOT, 'src/b.ts') }]),
      't1',
    )
    expect(review?.rootId).toBe(ROOT)
    expect(review?.ownWorktree).toBe(true)
    expect(review?.files.map((f) => f.filePath).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(review?.files.find((f) => f.filePath === 'src/a.ts')?.added).toBe(1)
  })

  it('degrades to touched-only when git status throws (fail-soft)', async () => {
    const git: ChangeReviewGit = {
      listUntrackedInDir: async () => [],
      aheadFiles: async () => [],
      upstreamOf: async () => null,
      status: async () => {
        throw new Error('not a repo')
      },
      changeCounts: async () => {
        throw new Error('boom')
      },
    }
    const review = await resolveThreadChangeReview(
      git,
      threads(ROOT, [{ toolName: 'Write', filePath: join(ROOT, 'src/b.ts') }]),
      't1',
    )
    expect(review?.files).toEqual([
      {
        filePath: 'src/b.ts',
        status: 'modified',
        staged: false,
        added: null,
        deleted: null,
        binary: false,
        touchedOnly: true,
      },
    ])
  })
})

describe('the committed state (#1906 follow-up)', () => {
  const cleanStatus = (ahead: number) => ({
    rootId: ROOT,
    branch: 'fix/x',
    dirty: false,
    ahead,
    behind: 0,
    changes: [],
  })

  it('reports what is committed and unpushed when the tree is clean', () => {
    // A commit does not make the work disappear. The review used to empty on
    // one, which reads as "nothing happened here" — reported as still saying
    // "Uncommitted" and then, once that was fixed, as losing the files.
    const built = buildThreadChangeReview({
      threadId: 't1',
      rootId: ROOT,
      ownWorktree: false,
      gitStatus: cleanStatus(2),
      touchedPaths: [],
      aheadFiles: [{ filePath: 'src/a.ts', added: 20, deleted: 2, binary: false }],
      aheadCommits: 2,
    })
    expect(built.state).toBe('committed')
    expect(built.aheadCommits).toBe(2)
    expect(built.files).toEqual([
      {
        filePath: 'src/a.ts',
        status: 'modified',
        staged: true,
        added: 20,
        deleted: 2,
        binary: false,
        touchedOnly: false,
      },
    ])
  })

  it('a dirty tree is UNCOMMITTED even with unpushed commits behind it', () => {
    // To the person looking at it, a repo with loose changes is a repo with
    // loose changes — and that is the state where keep and reject mean
    // something. The commits behind it are not the question being asked.
    const built = buildThreadChangeReview({
      threadId: 't1',
      rootId: ROOT,
      ownWorktree: false,
      gitStatus: status([change({ filePath: 'src/b.ts' })]),
      touchedPaths: [],
      aheadFiles: [{ filePath: 'src/a.ts', added: 20, deleted: 2, binary: false }],
      aheadCommits: 2,
    })
    expect(built.state).toBe('uncommitted')
    expect(built.files.map((f) => f.filePath)).toEqual(['src/b.ts'])
  })

  it('stays uncommitted with nothing ahead — an empty review is not a committed one', () => {
    const built = buildThreadChangeReview({
      threadId: 't1',
      rootId: ROOT,
      ownWorktree: false,
      gitStatus: cleanStatus(0),
      touchedPaths: [],
      aheadFiles: [],
      aheadCommits: 0,
    })
    expect(built.state).toBe('uncommitted')
    expect(built.files).toEqual([])
  })

  it('says nothing when there is no upstream to be ahead of (fail-soft)', () => {
    // `aheadFiles` returns [] for a branch with no upstream, a detached HEAD or
    // a non-repo — "unpushed" is not a fact that can be established without a
    // base, and this never guesses one.
    const built = buildThreadChangeReview({
      threadId: 't1',
      rootId: ROOT,
      ownWorktree: false,
      gitStatus: cleanStatus(0),
      touchedPaths: [],
    })
    expect(built.state).toBe('uncommitted')
  })
})

describe('bound — whether the branch is aimed anywhere (push-from-review Phase 1)', () => {
  const threadsFor = (rootPath: string): ChangeReviewThreads => ({
    reviewRootFor: () => ({ rootPath, ownWorktree: true }),
    listToolCallPaths: () => [],
  })

  const cleanStatus = {
    rootId: ROOT,
    branch: 'fix/x',
    dirty: false,
    ahead: 0,
    behind: 0,
    changes: [],
  }

  it('reports bound: true when git has an upstream for the checkout', () => {
    const built = buildThreadChangeReview({
      threadId: 't1',
      rootId: ROOT,
      ownWorktree: false,
      gitStatus: cleanStatus,
      touchedPaths: [],
      bound: true,
    })
    expect(built.bound).toBe(true)
  })

  it('reports bound: false for a branch nobody has ever aimed at a remote', () => {
    // This is the case the field exists for. `ahead` is 0 here and 0 for a
    // fully published branch too — with no upstream there is nothing to be
    // ahead OF — so the count alone cannot tell "nothing to push" from "never
    // pushed". `bound` is what separates them.
    const built = buildThreadChangeReview({
      threadId: 't1',
      rootId: ROOT,
      ownWorktree: false,
      gitStatus: cleanStatus,
      touchedPaths: [],
      bound: false,
    })
    expect(built.aheadCommits).toBe(0)
    expect(built.bound).toBe(false)
  })

  it('defaults to false when the input never says — not looking is not proof of a binding', () => {
    // The cautious answer, the same rule `aheadCommits` follows: a caller that
    // did not read git's configuration has established nothing, and claiming
    // "aimed" on that would let a surface skip an ask it owes the reader.
    const built = buildThreadChangeReview({
      threadId: 't1',
      rootId: ROOT,
      ownWorktree: false,
      gitStatus: cleanStatus,
      touchedPaths: [],
    })
    expect(built.bound).toBe(false)
  })

  it('carries bound into the committed state as well as the uncommitted one', () => {
    // The committed state is the one a Push control is rendered over, so the
    // field has to survive that branch of the builder — an early return is
    // exactly where a new field goes missing.
    const built = buildThreadChangeReview({
      threadId: 't1',
      rootId: ROOT,
      ownWorktree: false,
      gitStatus: { ...cleanStatus, ahead: 2 },
      touchedPaths: [],
      aheadFiles: [{ filePath: 'src/a.ts', added: 3, deleted: 0, binary: false }],
      aheadCommits: 2,
      bound: true,
    })
    expect(built.state).toBe('committed')
    expect(built.bound).toBe(true)
  })

  it('resolves bound from the upstream read — a ref means aimed, null means not', async () => {
    const aimed: ChangeReviewGit = {
      listUntrackedInDir: async () => [],
      aheadFiles: async () => [],
      upstreamOf: async () => 'origin/fix/x',
      status: async () => status([change({ filePath: 'src/a.ts' })]),
      changeCounts: async () => new Map(),
    }
    const unaimed: ChangeReviewGit = { ...aimed, upstreamOf: async () => null }
    expect((await resolveThreadChangeReview(aimed, threadsFor(ROOT), 't1'))?.bound).toBe(true)
    expect((await resolveThreadChangeReview(unaimed, threadsFor(ROOT), 't1'))?.bound).toBe(false)
  })

  it('degrades to bound: false when the upstream read throws (fail-soft)', async () => {
    // Same rule as every other read in the round: a git failure is a "cannot
    // say", and cannot-say never fails the review. False is also the safe way
    // to be wrong — it offers a person the ask rather than publishing to a
    // destination nobody confirmed.
    const git: ChangeReviewGit = {
      listUntrackedInDir: async () => [],
      aheadFiles: async () => [],
      upstreamOf: async () => {
        throw new Error('not a repo')
      },
      status: async () => status([change({ filePath: 'src/a.ts' })]),
      changeCounts: async () => new Map(),
    }
    const review = await resolveThreadChangeReview(git, threadsFor(ROOT), 't1')
    expect(review?.bound).toBe(false)
    expect(review?.files.map((f) => f.filePath)).toEqual(['src/a.ts'])
  })
})

describe('a rolled-up untracked directory is expanded (the list you audit is the list you commit)', () => {
  const rolled = (): GitStatus =>
    ({
      rootId: '/r',
      branch: 'thread/x',
      ahead: 0,
      changes: [
        { filePath: 'src/app.ts', state: 'modified', staged: false },
        { filePath: '.husky/', state: 'untracked', staged: false },
      ],
    }) as unknown as GitStatus

  const gitWith = (listed: Record<string, string[]>, fail = false): ChangeReviewGit => ({
    status: async () => rolled(),
    changeCounts: async () => new Map(),
    aheadFiles: async () => [],
    upstreamOf: async () => null,
    listUntrackedInDir: async (_root, dir) => {
      if (fail) throw new Error('git said no')
      return listed[dir] ?? []
    },
  })

  const threads: ChangeReviewThreads = {
    reviewRootFor: () => ({ rootPath: '/r', ownWorktree: true }),
    listToolCallPaths: () => [],
  }

  it('shows the files, not the directory they sit in', async () => {
    const git = gitWith({ '.husky/': ['.husky/pre-commit', '.husky/post-merge'] })
    const review = await resolveThreadChangeReview(git, threads, 't1')
    const paths = review!.files.map((f) => f.filePath)
    expect(paths).toContain('.husky/pre-commit')
    expect(paths).toContain('.husky/post-merge')
    // The row that hid them is gone — ticking it staged files nobody had seen.
    expect(paths).not.toContain('.husky/')
    // …and it did not eat the ordinary change beside it.
    expect(paths).toContain('src/app.ts')
  })

  it('each expanded file carries the directory row’s own state', async () => {
    const git = gitWith({ '.husky/': ['.husky/pre-commit'] })
    const review = await resolveThreadChangeReview(git, threads, 't1')
    const file = review!.files.find((f) => f.filePath === '.husky/pre-commit')
    expect(file).toMatchObject({ status: 'untracked', staged: false })
  })

  it('keeps the rolled-up row when the listing fails — over-stating beats vanishing', async () => {
    const review = await resolveThreadChangeReview(gitWith({}, true), threads, 't1')
    expect(review!.files.map((f) => f.filePath)).toContain('.husky/')
  })

  it('asks git nothing extra when there is nothing rolled up', async () => {
    let asked = 0
    const git: ChangeReviewGit = {
      status: async () =>
        ({ rootId: '/r', branch: 'b', ahead: 0, changes: [{ filePath: 'a.ts', state: 'modified', staged: false }] }) as unknown as GitStatus,
      changeCounts: async () => new Map(),
      aheadFiles: async () => [],
      upstreamOf: async () => null,
      listUntrackedInDir: async () => {
        asked += 1
        return []
      },
    }
    await resolveThreadChangeReview(git, threads, 't1')
    expect(asked).toBe(0)
  })
})

describe('the worktree link step is not the agent’s work (real git worktree)', () => {
  let base = ''
  let main = ''
  let tree = ''
  const gitIn = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8' })

  /** The structural slice, backed by real `git status --porcelain` on the tree. */
  const realGit: ChangeReviewGit = {
    status: async (root) => {
      const changes: GitFileChange[] = gitIn(root, 'status', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('??'))
        .map((line) => ({ filePath: line.slice(3), state: 'untracked', staged: false }))
      return { rootId: root, branch: 'thread/x', dirty: changes.length > 0, ahead: 0, behind: 0, changes }
    },
    changeCounts: async () => new Map(),
    aheadFiles: async () => [],
    upstreamOf: async () => null,
    listUntrackedInDir: async (root, dir) =>
      gitIn(root, 'ls-files', '--others', '--exclude-standard', '--', dir).split('\n').filter(Boolean),
  }
  const threadsAt = (rootPath: string, ownWorktree = true): ChangeReviewThreads => ({
    reviewRootFor: () => ({ rootPath, ownWorktree }),
    listToolCallPaths: () => [],
  })
  const paths = async (rootPath: string, ownWorktree = true): Promise<string[]> =>
    (await resolveThreadChangeReview(realGit, threadsAt(rootPath, ownWorktree), 't1'))!.files.map(
      (f) => f.filePath,
    )

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(join(os.tmpdir(), 'flow-change-review-')))
    main = join(base, 'main')
    tree = join(base, 'tree')
    fs.mkdirSync(main)
    gitIn(main, 'init', '-q', '-b', 'main')
    // `.claude/` with the trailing slash: matches directories only — a link to
    // one is NOT covered, which is the live report.
    fs.writeFileSync(join(main, '.gitignore'), '.claude/\n')
    fs.writeFileSync(join(main, 'README.md'), 'hi\n')
    gitIn(main, 'add', '.')
    gitIn(main, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init')
    gitIn(main, 'worktree', 'add', '-q', '-b', 'thread/x', tree)
    // The main checkout's untracked set, and the link step's work.
    fs.mkdirSync(join(main, '.claude', 'commands'), { recursive: true })
    fs.mkdirSync(join(main, 'node_modules', 'pkg'), { recursive: true })
    fs.symlinkSync(join(main, '.claude'), join(tree, '.claude'), 'dir')
    fs.symlinkSync(join(main, 'node_modules'), join(tree, 'node_modules'), 'dir')
  })

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true })
  })

  it('lists a file the agent created (positive first)', async () => {
    fs.writeFileSync(join(tree, 'new.ts'), 'export {}\n')
    expect(await paths(tree)).toContain('new.ts')
  })

  it('does not list the linked .claude / node_modules — git DOES report them', async () => {
    fs.writeFileSync(join(tree, 'new.ts'), 'export {}\n')
    // The premise: without the filter these are real `??` rows.
    const raw = (await realGit.status(tree))!.changes.map((c) => c.filePath)
    expect(raw).toEqual(expect.arrayContaining(['.claude', 'node_modules']))

    const listed = await paths(tree)
    expect(listed).toContain('new.ts')
    expect(listed).not.toContain('.claude')
    expect(listed).not.toContain('node_modules')
  })

  it('drops a nested link inside a rolled-up untracked directory', async () => {
    fs.mkdirSync(join(main, 'tools', 'hooks'), { recursive: true })
    fs.mkdirSync(join(tree, 'tools'))
    fs.symlinkSync(join(main, 'tools', 'hooks'), join(tree, 'tools', 'hooks'), 'dir')
    fs.writeFileSync(join(tree, 'tools', 'real.sh'), 'echo\n')
    const listed = await paths(tree)
    expect(listed).toContain('tools/real.sh')
    expect(listed).not.toContain('tools/hooks')
  })

  it('still lists a symlink the agent made inside the worktree', async () => {
    fs.mkdirSync(join(tree, 'src'))
    fs.writeFileSync(join(tree, 'bar.ts'), 'export {}\n')
    fs.symlinkSync('../bar.ts', join(tree, 'src', 'foo.ts'))
    const listed = await paths(tree)
    expect(listed).toContain('src/foo.ts')
    expect(listed).toContain('bar.ts')
    expect(listed).not.toContain('.claude')
  })

  it('filters nothing on the project tree itself (no link step there)', async () => {
    fs.symlinkSync(join(base, 'elsewhere'), join(main, 'loose-link'))
    expect(await paths(main, false)).toContain('loose-link')
  })
})

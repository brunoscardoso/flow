import {
  DEFAULT_WORKTREE_CAP,
  collectWorktreeCandidates,
  enforceWorktreeCap,
  planWorktreeCap,
  worktreeUsage,
  type CapRunResult,
  type WorktreeCandidate,
} from './worktree-cap'

function candidate(overrides: Partial<WorktreeCandidate> & { thread: string }): WorktreeCandidate {
  return {
    path: `/repo/.repo-threads/${overrides.thread}`,
    landed: true,
    lastActiveAt: 0,
    inUse: false,
    ...overrides,
  }
}

/** `count` checkouts, oldest first, all landed. */
function landedRun(count: number): WorktreeCandidate[] {
  return Array.from({ length: count }, (_unused, index) =>
    candidate({ thread: `t${index}`, lastActiveAt: index }),
  )
}

describe('the ceiling', () => {
  it('does nothing while the repository is under it', () => {
    const plan = planWorktreeCap({ candidates: landedRun(DEFAULT_WORKTREE_CAP) })
    expect(plan.over).toBe(0)
    expect(plan.release).toEqual([])
    expect(plan.stuck).toBe(false)
  })

  it('releases the oldest landed checkout, one per checkout above the line', () => {
    const plan = planWorktreeCap({ candidates: landedRun(DEFAULT_WORKTREE_CAP + 2) })
    expect(plan.over).toBe(2)
    expect(plan.release.map((entry) => entry.thread)).toEqual(['t0', 't1'])
  })

  it('orders by last activity, not by list order', () => {
    const plan = planWorktreeCap({
      cap: 1,
      candidates: [
        candidate({ thread: 'new', lastActiveAt: 900 }),
        candidate({ thread: 'old', lastActiveAt: 100 }),
        candidate({ thread: 'middle', lastActiveAt: 500 }),
      ],
    })
    expect(plan.release.map((entry) => entry.thread)).toEqual(['old', 'middle'])
  })

  it('breaks a tie the same way every run', () => {
    const same = [
      candidate({ thread: 'b', lastActiveAt: 5 }),
      candidate({ thread: 'a', lastActiveAt: 5 }),
    ]
    expect(planWorktreeCap({ cap: 1, candidates: same }).release[0]?.thread).toBe('a')
    expect(planWorktreeCap({ cap: 1, candidates: [...same].reverse() }).release[0]?.thread).toBe('a')
  })

  it('reads an unusable ceiling as the default', () => {
    expect(planWorktreeCap({ candidates: [], cap: Number.NaN }).cap).toBe(DEFAULT_WORKTREE_CAP)
    expect(planWorktreeCap({ candidates: [], cap: 0 }).cap).toBe(1)
  })
})

describe('unlanded work is never touched by the cap', () => {
  it('skips a checkout whose work has not landed, however old it is', () => {
    const plan = planWorktreeCap({
      cap: 1,
      candidates: [
        candidate({ thread: 'ancient', lastActiveAt: 1, landed: false }),
        candidate({ thread: 'recent-landed', lastActiveAt: 900 }),
        candidate({ thread: 'older-landed', lastActiveAt: 400 }),
      ],
    })
    expect(plan.release.map((entry) => entry.thread)).toEqual(['older-landed', 'recent-landed'])
    expect(plan.unlanded).toBe(1)
  })

  it('would rather stay over the line than delete unlanded work', () => {
    const plan = planWorktreeCap({
      cap: 1,
      candidates: [
        candidate({ thread: 'a', lastActiveAt: 1, landed: false }),
        candidate({ thread: 'b', lastActiveAt: 2, landed: false }),
        candidate({ thread: 'c', lastActiveAt: 3, landed: false }),
      ],
    })
    expect(plan.release).toEqual([])
    expect(plan.over).toBe(2)
    expect(plan.stuck).toBe(true)
  })

  it('treats a checkout nobody could read as unlanded', () => {
    // `landed` false is the safe answer, and it is the one an unreadable
    // checkout arrives with — the cap never removes what it could not ask about.
    const plan = planWorktreeCap({ cap: 1, candidates: [candidate({ thread: 'x', landed: false })] })
    expect(plan.release).toEqual([])
  })
})

describe('enforcement (forbidden-pattern #15)', () => {
  it('releases nothing when the caller handed over no way to release', async () => {
    const result = await enforceWorktreeCap({ candidates: landedRun(DEFAULT_WORKTREE_CAP + 3) })
    expect(result.refused).toBe(true)
    expect(result.released).toEqual([])
    expect(result.plan.over).toBe(3)
  })

  it('releases exactly the planned checkouts when it was given one', async () => {
    const seen: string[] = []
    const result = await enforceWorktreeCap({
      candidates: landedRun(DEFAULT_WORKTREE_CAP + 1),
      release: (entry) => {
        seen.push(entry.thread)
        return Promise.resolve(true)
      },
    })
    expect(seen).toEqual(['t0'])
    expect(result.released).toEqual(['t0'])
    expect(result.refused).toBe(false)
  })

  it('reports a checkout that would not go, and keeps reclaiming the rest', async () => {
    const result = await enforceWorktreeCap({
      cap: 1,
      candidates: [
        candidate({ thread: 'locked', lastActiveAt: 1 }),
        candidate({ thread: 'free', lastActiveAt: 2 }),
        candidate({ thread: 'kept', lastActiveAt: 3 }),
      ],
      release: (entry) => Promise.resolve(entry.thread !== 'locked'),
    })
    expect(result.failed).toEqual(['locked'])
    expect(result.released).toEqual(['free'])
  })

  it('never asks about a checkout holding unlanded work', async () => {
    const asked: string[] = []
    await enforceWorktreeCap({
      cap: 1,
      candidates: [
        candidate({ thread: 'unlanded', lastActiveAt: 1, landed: false }),
        candidate({ thread: 'landed', lastActiveAt: 2 }),
      ],
      release: (entry) => {
        asked.push(entry.thread)
        return Promise.resolve(true)
      },
    })
    expect(asked).toEqual(['landed'])
  })

  it('asks again, immediately before deleting, whether the checkout is still free', async () => {
    // THE INCIDENT, THROUGH THE LATER WINDOW. `inUseFor` runs while the plan is
    // being COLLECTED; the `--force` happens seconds later. A thread that was
    // idle at collect time and has an agent in it by delete time was still
    // being removed, because the "recompute" before release is a pure function
    // over the array already gathered — it re-runs no git and asks no session.
    const asked: string[] = []
    const result = await enforceWorktreeCap({
      cap: 1,
      candidates: [
        candidate({ thread: 'woke-up', lastActiveAt: 1 }),
        candidate({ thread: 'still-idle', lastActiveAt: 2 }),
        candidate({ thread: 'kept', lastActiveAt: 3 }),
      ],
      stillEligible: (entry) => entry.thread !== 'woke-up',
      release: (entry) => {
        asked.push(entry.thread)
        return Promise.resolve(true)
      },
    })
    expect(asked).not.toContain('woke-up')
    expect(result.skipped).toEqual(['woke-up'])
    expect(result.released).toEqual(['still-idle'])
    expect(result.failed).toEqual([])
  })

  it('accepts an async answer, because asking git is not free', async () => {
    const result = await enforceWorktreeCap({
      cap: 1,
      candidates: [candidate({ thread: 'busy', lastActiveAt: 1 }), candidate({ thread: 'kept', lastActiveAt: 2 })],
      stillEligible: () => Promise.resolve(false),
      release: () => Promise.resolve(true),
    })
    expect(result.skipped).toEqual(['busy'])
    expect(result.released).toEqual([])
  })

  it('releases everything planned when the caller supplies no second look', async () => {
    // Absent means "nothing changes between the two moments" — only true for a
    // caller with no live sessions at all, and the shape every existing test has.
    const result = await enforceWorktreeCap({
      cap: 1,
      candidates: [candidate({ thread: 'a', lastActiveAt: 1 }), candidate({ thread: 'b', lastActiveAt: 2 })],
      release: () => Promise.resolve(true),
    })
    expect(result.released).toEqual(['a'])
    expect(result.skipped).toEqual([])
  })
})

describe('the visible total', () => {
  it('counts everything, and says how much of it is unlanded', () => {
    const usage = worktreeUsage([
      candidate({ thread: 'a' }),
      candidate({ thread: 'b', landed: false }),
    ])
    expect(usage).toEqual({ total: 2, cap: DEFAULT_WORKTREE_CAP, unlanded: 1, atCap: false })
  })

  it('says it is at the ceiling before the ceiling bites', () => {
    expect(worktreeUsage(landedRun(3), 3).atCap).toBe(true)
    expect(worktreeUsage(landedRun(2), 3).atCap).toBe(false)
  })
})

describe('reading what is on disk', () => {
  const ROOT = '/repo'
  const listing = JSON.stringify({
    status: 'listed',
    root: '/repo/.repo-threads',
    worktrees: [
      { thread: 'a', path: '/repo/.repo-threads/a', branch: 'thread/a', prunable: false },
      { thread: 'b', path: '/repo/.repo-threads/b', branch: 'thread/b', prunable: false },
      { thread: 'dead', path: '/repo/.repo-threads/dead', branch: null, prunable: true },
    ],
  })

  function ok(stdout = ''): CapRunResult {
    return { ok: true, stdout }
  }

  function collect(
    git: (cwd: string, args: readonly string[]) => CapRunResult | undefined,
    cli: CapRunResult = ok(listing),
  ): Promise<WorktreeCandidate[]> {
    return collectWorktreeCandidates({
      rootPath: ROOT,
      runCli: () => Promise.resolve(cli),
      runGit: (cwd, args) =>
        Promise.resolve(
          git(cwd, args) ??
            (args[0] === 'status'
              ? ok('')
              : args[0] === 'rev-list'
                ? ok('0\n')
                : ok('1700000000\n')),
        ),
      baseFor: () => 'main',
      inUseFor: () => false,
      owners: [],
    })
  }

  it('reads every live checkout and skips the dead records', async () => {
    const candidates = await collect(() => undefined)
    expect(candidates.map((entry) => entry.thread)).toEqual(['a', 'b'])
    expect(candidates[0]).toMatchObject({ landed: true, lastActiveAt: 1700000000000 })
  })

  it('counts a checkout with uncommitted work as unlanded', async () => {
    const candidates = await collect((cwd, args) =>
      cwd.endsWith('/a') && args[0] === 'status' ? ok(' M src/app.ts\n') : undefined,
    )
    expect(candidates.find((entry) => entry.thread === 'a')?.landed).toBe(false)
  })

  it('counts a checkout ahead of its base as unlanded', async () => {
    const candidates = await collect((cwd, args) =>
      cwd.endsWith('/b') && args[0] === 'rev-list' ? ok('4\n') : undefined,
    )
    expect(candidates.find((entry) => entry.thread === 'b')?.landed).toBe(false)
  })

  it('keeps a checkout whose base nobody can name', async () => {
    const candidates = await collectWorktreeCandidates({
      rootPath: ROOT,
      runCli: () => Promise.resolve(ok(listing)),
      runGit: () => Promise.resolve(ok('')),
      baseFor: () => null,
      inUseFor: () => false,
      owners: [],
    })
    expect(candidates.every((entry) => !entry.landed)).toBe(true)
  })

  it('knows a checkout by its THREAD, joined on the path its record holds — not by its folder', async () => {
    // Checkouts are `worktree/<name>` folders now, so the CLI's key is no
    // longer the thread id. Keyed on it, the cap asked for the base and the
    // busy state of a thread that did not exist.
    const named = JSON.stringify({
      status: 'listed',
      worktrees: [
        { thread: 'worktree/tidy', path: '/repo/.repo-threads/worktree/tidy', branch: 'b1', prunable: false },
        { thread: 'worktree/stray', path: '/repo/.repo-threads/worktree/stray', branch: 'b2', prunable: false },
      ],
    })
    const asked: string[] = []
    const candidates = await collectWorktreeCandidates({
      rootPath: ROOT,
      runCli: () => Promise.resolve(ok(named)),
      runGit: () => Promise.resolve(ok('')),
      baseFor: (thread) => {
        asked.push(thread)
        return null
      },
      inUseFor: () => false,
      owners: [
        { id: 'uuid-1', worktreePath: '/repo/.repo-threads/worktree/tidy' },
        { id: 'uuid-2', worktreePath: null },
      ],
    })
    expect(candidates.map((entry) => entry.thread)).toEqual(['uuid-1', 'worktree/stray'])
    expect(asked).toEqual(['uuid-1', 'worktree/stray'])
  })

  it('never offers an ATTACHED project’s checkout for release — its prune would hit the owner’s primary copy', async () => {
    const named = JSON.stringify({
      status: 'listed',
      worktrees: [
        { thread: 'worktree/mine', path: '/repo/.repo-threads/worktree/mine', branch: 'b1', prunable: false },
        { thread: 'worktree/theirs', path: '/repo/.repo-threads/worktree/theirs', branch: 'b2', prunable: false },
      ],
    })
    const candidates = await collectWorktreeCandidates({
      rootPath: ROOT,
      runCli: () => Promise.resolve(ok(named)),
      runGit: (_cwd, args) => Promise.resolve(args[0] === 'rev-list' ? ok('0\n') : ok('')),
      baseFor: () => 'main',
      inUseFor: () => false,
      owners: [
        { id: 'mine', worktreePath: '/repo/.repo-threads/worktree/mine' },
        { id: 'other-project-thread', worktreePath: '/repo/.repo-threads/worktree/theirs', attached: true },
      ],
    })
    expect(candidates.map((entry) => [entry.thread, entry.inUse])).toEqual([
      ['mine', false],
      ['other-project-thread', true],
    ])
  })

  it('reports nothing rather than guessing when the listing cannot be read', async () => {
    const candidates = await collect(() => undefined, { ok: false, stdout: '' })
    expect(candidates).toEqual([])
  })
})

/**
 * THE 2026-09-08 INCIDENT, held as a plan.
 *
 * A project sitting exactly at the cap. A thread is given a worktree; the cut
 * kicks off this sweep, unawaited; the agent session is spawned into the new
 * checkout a moment later. The fresh checkout is spotlessly landed (clean
 * status, nothing ahead of base) and ranks OLDEST, because `lastActiveAt` is
 * its base commit's date. It was therefore the first thing evicted — while the
 * session that had just been pointed at it was still starting.
 *
 * The agent then recreated the path as an empty non-git directory, and every
 * future `git worktree add` for that thread refused it forever.
 */
describe('planWorktreeCap — never the checkout somebody is in', () => {
  it('leaves a fresh, in-use checkout alone and takes the next oldest instead', () => {
    const plan = planWorktreeCap({
      cap: 2,
      candidates: [
        // Cut seconds ago: perfectly landed, and ranked oldest by its base.
        candidate({ thread: 'just-cut', lastActiveAt: 1, inUse: true }),
        candidate({ thread: 'stale', lastActiveAt: 2 }),
        candidate({ thread: 'newer', lastActiveAt: 3 }),
      ],
    })
    expect(plan.release.map((entry) => entry.thread)).toEqual(['stale'])
    expect(plan.inUse).toBe(1)
  })

  it('releases nothing when every landed checkout is in use, and says so', () => {
    // Over the ceiling with nothing it may take is the honest state — the same
    // one unlanded work produces. Silently taking one anyway is the bug.
    const plan = planWorktreeCap({
      cap: 1,
      candidates: [
        candidate({ thread: 'a', lastActiveAt: 1, inUse: true }),
        candidate({ thread: 'b', lastActiveAt: 2, inUse: true }),
      ],
    })
    expect(plan.release).toEqual([])
    expect(plan.stuck).toBe(true)
    expect(plan.inUse).toBe(2)
  })

  it('counts in-use checkouts even when the ceiling is not reached', () => {
    const plan = planWorktreeCap({
      cap: 10,
      candidates: [candidate({ thread: 'a', inUse: true }), candidate({ thread: 'b' })],
    })
    expect(plan.over).toBe(0)
    expect(plan.inUse).toBe(1)
  })

  it('holds back an in-use checkout that is ALSO unlanded, without double-counting', () => {
    const plan = planWorktreeCap({
      cap: 0,
      candidates: [candidate({ thread: 'a', landed: false, inUse: true })],
    })
    expect(plan.release).toEqual([])
    expect(plan.unlanded).toBe(1)
    expect(plan.inUse).toBe(1)
  })
})

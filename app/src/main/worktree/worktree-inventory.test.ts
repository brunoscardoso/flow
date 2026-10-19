import { readWorktreeInventory, type InventoryDeps, type InventoryThread } from './worktree-inventory'

const ROOT = '/repo'

const thread = (over: Partial<InventoryThread> = {}): InventoryThread => ({
  id: 'thread-1',
  title: 'Fix the sidebar flicker',
  status: 'idle',
  worktreePath: '/repo-threads/thread-1',
  worktreeBranch: 'thread/fix-the-sidebar-flicker',
  worktreeBase: 'main',
  remote: null,
  remoteBranch: null,
  prBase: null,
  previouslyPushedAs: null,
  baseMayBeBehind: false,
  archived: false,
  ...over,
})

/** A CLI listing transcript, the way the real one arrives. */
const listing = (
  worktrees: Array<{ thread: string; path: string; branch?: string | null; prunable?: boolean }>,
): string =>
  `${JSON.stringify({
    status: 'listed',
    root: ROOT,
    worktrees: worktrees.map((entry) => ({
      thread: entry.thread,
      path: entry.path,
      branch: entry.branch ?? null,
      head: 'abc123',
      locked: false,
      prunable: entry.prunable ?? false,
    })),
  })}\n`

/** Git answers, keyed by the first argument. Everything unnamed is clean. */
const gitFake =
  (answers: Record<string, { ok?: boolean; stdout?: string }> = {}) =>
  async (_cwd: string, args: readonly string[]) => {
    const answer = answers[args[0] ?? ''] ?? {}
    return { ok: answer.ok ?? true, stdout: answer.stdout ?? '' }
  }

const deps = (over: Partial<InventoryDeps> = {}): InventoryDeps => ({
  threadsFor: () => [thread()],
  attachedCheckoutsFor: () => [],
  runCli: async () => ({ ok: true, stdout: listing([{ thread: 'thread-1', path: '/repo-threads/thread-1' }]) }),
  runGit: gitFake({ 'rev-list': { stdout: '0\n' }, log: { stdout: '1755000000\n' } }),
  ...over,
})

describe('readWorktreeInventory', () => {
  it('never lists a checkout an ATTACHED project’s thread holds as abandoned', async () => {
    // Thread "other" runs in another project and has this one attached, with
    // its own copy. It is live work — not "a conversation that no longer
    // exists", and not offered for deletion.
    const result = await readWorktreeInventory(
      ROOT,
      deps({
        threadsFor: () => [thread()],
        attachedCheckoutsFor: () => [{ threadId: 'other', worktreePath: '/repo-threads/worktree/attached' }],
        runCli: async () => ({
          ok: true,
          stdout: listing([
            { thread: 'thread-1', path: '/repo-threads/thread-1' },
            { thread: 'worktree/attached', path: '/repo-threads/worktree/attached' },
            { thread: 'worktree/stray', path: '/repo-threads/worktree/stray' },
          ]),
        }),
      }),
    )
    // Positive first: a truly unclaimed copy is still surfaced.
    expect(result.entries.find((entry) => entry.threadId === 'worktree/stray')?.drift).toBe('abandoned')
    expect(result.entries.map((entry) => entry.threadId).sort()).toEqual(['thread-1', 'worktree/stray'])
  })

  it('lists a named checkout ONCE, under the thread whose record holds its path', async () => {
    // `worktree/<name>` folders: the CLI's key is the folder, not the id. The
    // page used to show this one twice — the thread as "files already gone"
    // and the same directory as an abandoned copy.
    const result = await readWorktreeInventory(
      ROOT,
      deps({
        threadsFor: () => [thread({ worktreePath: '/repo-threads/worktree/fix-the-flicker' })],
        runCli: async () => ({
          ok: true,
          stdout: listing([{ thread: 'worktree/fix-the-flicker', path: '/repo-threads/worktree/fix-the-flicker' }]),
        }),
      }),
    )
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ threadId: 'thread-1', drift: 'none' })
  })

  it('reports a clean, landed worktree as landed', async () => {
    const result = await readWorktreeInventory(ROOT, deps())
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      threadId: 'thread-1',
      threadTitle: 'Fix the sidebar flicker',
      branch: 'thread/fix-the-sidebar-flicker',
      landed: true,
      changedFiles: 0,
      drift: 'none',
    })
  })

  it('counts what is uncommitted and refuses to call it landed', async () => {
    const result = await readWorktreeInventory(
      ROOT,
      deps({
        runGit: gitFake({
          status: { stdout: ' M a.ts\n?? b.ts\n' },
          'rev-list': { stdout: '0\n' },
          log: { stdout: '1755000000\n' },
        }),
      }),
    )
    expect(result.entries[0]).toMatchObject({ changedFiles: 2, landed: false })
  })

  it('never calls an unreadable checkout landed', async () => {
    // The cost of being wrong runs one way only — the same rule the cap has.
    const result = await readWorktreeInventory(ROOT, deps({ runGit: async () => ({ ok: false, stdout: '' }) }))
    expect(result.entries[0]?.landed).toBe(false)
  })

  it('never calls a worktree with no base landed', async () => {
    const result = await readWorktreeInventory(
      ROOT,
      deps({ threadsFor: () => [thread({ worktreeBase: null })] }),
    )
    expect(result.entries[0]).toMatchObject({ landed: false, aheadCommits: 0 })
  })

  it('shows a thread pointing at a copy git does not report as missing', async () => {
    const result = await readWorktreeInventory(
      ROOT,
      deps({ runCli: async () => ({ ok: true, stdout: listing([]) }) }),
    )
    expect(result.entries[0]).toMatchObject({ threadId: 'thread-1', drift: 'gone' })
  })

  it('shows a copy on disk that no thread claims', async () => {
    const result = await readWorktreeInventory(
      ROOT,
      deps({
        threadsFor: () => [],
        runCli: async () => ({
          ok: true,
          stdout: listing([{ thread: 'ghost', path: '/repo-threads/ghost', branch: 'thread/ghost' }]),
        }),
      }),
    )
    expect(result.entries[0]).toMatchObject({
      threadId: 'ghost',
      threadTitle: null,
      branch: 'thread/ghost',
      drift: 'abandoned',
      landed: false,
    })
  })

  it('shows a dead git record and asks git nothing about it', async () => {
    let gitCalls = 0
    const result = await readWorktreeInventory(
      ROOT,
      deps({
        threadsFor: () => [],
        runCli: async () => ({
          ok: true,
          stdout: listing([{ thread: 'dead', path: '/repo-threads/dead', prunable: true }]),
        }),
        runGit: async () => {
          gitCalls += 1
          return { ok: true, stdout: '' }
        },
      }),
    )
    expect(result.entries[0]?.drift).toBe('dead-record')
    // A directory that is not there costs a child process to be told what the
    // listing already said.
    expect(gitCalls).toBe(0)
  })

  it('does not count what occupies no disk toward the ceiling', async () => {
    const result = await readWorktreeInventory(
      ROOT,
      deps({
        threadsFor: () => [thread(), thread({ id: 'thread-2' })],
        runCli: async () => ({
          ok: true,
          stdout: listing([
            { thread: 'thread-1', path: '/repo-threads/thread-1' },
            { thread: 'dead', path: '/repo-threads/dead', prunable: true },
          ]),
        }),
      }),
    )
    // thread-1 is real; thread-2's copy is gone; the dead record is a note.
    expect(result.usage.total).toBe(1)
  })

  it('measures disk only for copies that are actually there', async () => {
    const measured: string[] = []
    await readWorktreeInventory(
      ROOT,
      deps({
        threadsFor: () => [thread(), thread({ id: 'thread-2' })],
        runDu: async (cwd) => {
          measured.push(cwd)
          return { ok: true, stdout: '40960\t.\n' }
        },
      }),
    )
    expect(measured).toEqual(['/repo-threads/thread-1'])
  })

  it('reports an unmeasurable copy as an unknown size, never as zero', async () => {
    const result = await readWorktreeInventory(
      ROOT,
      deps({ runDu: async () => ({ ok: false, stdout: '' }) }),
    )
    expect(result.entries[0]?.diskKb).toBeNull()
  })

  it('reports no size at all when nothing can measure one', async () => {
    const result = await readWorktreeInventory(ROOT, deps())
    expect(result.entries[0]?.diskKb).toBeNull()
  })

  it('sorts newest activity first, with the id as a stable tiebreak', async () => {
    const stamps: Record<string, string> = {
      '/repo-threads/thread-1': '1700000000\n',
      '/repo-threads/thread-2': '1755000000\n',
      '/repo-threads/thread-3': '1755000000\n',
    }
    const result = await readWorktreeInventory(
      ROOT,
      deps({
        threadsFor: () => [
          thread({ id: 'thread-1', worktreePath: '/repo-threads/thread-1' }),
          thread({ id: 'thread-3', worktreePath: '/repo-threads/thread-3' }),
          thread({ id: 'thread-2', worktreePath: '/repo-threads/thread-2' }),
        ],
        runCli: async () => ({
          ok: true,
          stdout: listing([
            { thread: 'thread-1', path: '/repo-threads/thread-1' },
            { thread: 'thread-2', path: '/repo-threads/thread-2' },
            { thread: 'thread-3', path: '/repo-threads/thread-3' },
          ]),
        }),
        runGit: async (cwd, args) => {
          if (args[0] === 'log') return { ok: true, stdout: stamps[cwd] ?? '0\n' }
          if (args[0] === 'rev-list') return { ok: true, stdout: '0\n' }
          return { ok: true, stdout: '' }
        },
      }),
    )
    expect(result.entries.map((entry) => entry.threadId)).toEqual([
      'thread-2',
      'thread-3',
      'thread-1',
    ])
  })

  it('never sends a path across the boundary (forbidden-pattern #12)', async () => {
    const result = await readWorktreeInventory(
      ROOT,
      deps({
        threadsFor: () => [thread()],
        runCli: async () => ({
          ok: true,
          stdout: listing([
            { thread: 'thread-1', path: '/repo-threads/thread-1' },
            { thread: 'ghost', path: '/repo-threads/ghost' },
          ]),
        }),
      }),
    )
    // The rootPath is the project the caller asked about and already knows;
    // no CHECKOUT path may appear anywhere in an entry.
    expect(JSON.stringify(result.entries)).not.toContain('/repo-threads/')
  })

  it('ignores a project whose checkouts cannot be listed rather than inventing rows', async () => {
    const result = await readWorktreeInventory(
      ROOT,
      deps({ threadsFor: () => [], runCli: async () => ({ ok: false, stdout: '' }) }),
    )
    expect(result.entries).toEqual([])
  })

  it('includes archived threads — archiving does not remove a copy from disk', async () => {
    const result = await readWorktreeInventory(
      ROOT,
      deps({ threadsFor: () => [thread({ archived: true })] }),
    )
    expect(result.entries[0]?.archived).toBe(true)
  })

  it('marks a worktree that took its base branch', async () => {
    const result = await readWorktreeInventory(
      ROOT,
      deps({ threadsFor: () => [thread({ worktreeBranch: 'main', worktreeBase: 'main' })] }),
    )
    expect(result.entries[0]?.onBase).toBe(true)
  })

  it('marks a thread mid-turn as busy', async () => {
    const result = await readWorktreeInventory(
      ROOT,
      deps({ threadsFor: () => [thread({ status: 'working' })] }),
    )
    expect(result.entries[0]?.busy).toBe(true)
  })

  it('reads nothing that writes', async () => {
    const gitArgs: string[][] = []
    await readWorktreeInventory(
      ROOT,
      deps({
        runGit: async (_cwd, args) => {
          gitArgs.push([...args])
          return { ok: true, stdout: args[0] === 'rev-list' ? '0\n' : '' }
        },
      }),
    )
    for (const args of gitArgs) {
      expect(['status', 'log', 'rev-list']).toContain(args[0])
    }
  })
})

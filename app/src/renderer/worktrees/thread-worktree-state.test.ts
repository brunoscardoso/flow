import type { ThreadSummary } from '../../shared/ipc-contract'
import { inProjectLine, threadWorktreeState, worksInOwnCopy } from './thread-worktree-state'

const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({ id: 't1', worktreePath: null, worktreeBranch: null, ...over }) as ThreadSummary

describe('whether a conversation works in a copy — the whole detection', () => {
  // THE BUG THIS PINS. The panel used to ask only "is worktreePath set?". On a
  // conversation working in the project itself that field IS set — to the
  // project's own root — so the panel announced "its own copy" over the main
  // checkout and then described the project's own commits as the copy's
  // unlanded work. Seen on orbit-app, whose main checkout sits on
  // feat/data-contract-guard-fe.
  it('is NOT a copy when the path is the project itself', () => {
    expect(worksInOwnCopy('/Users/me/orbit-app', '/Users/me/orbit-app')).toBe(false)
  })

  it('IS a copy when the path differs from the project', () => {
    expect(worksInOwnCopy('/Users/me/.flow/orbit-app/t1', '/Users/me/orbit-app')).toBe(true)
  })

  it('is not a copy when nothing is recorded', () => {
    expect(worksInOwnCopy(null, '/Users/me/orbit-app')).toBe(false)
    expect(worksInOwnCopy('   ', '/Users/me/orbit-app')).toBe(false)
  })

  it('ignores a trailing separator on either side', () => {
    expect(worksInOwnCopy('/Users/me/orbit-app/', '/Users/me/orbit-app')).toBe(false)
    expect(worksInOwnCopy('/Users/me/orbit-app', '/Users/me/orbit-app/')).toBe(false)
  })

  it('does not mistake a sibling whose name starts the same way', () => {
    // `orbit-app-loops` is a real directory beside `orbit-app` here.
    expect(worksInOwnCopy('/Users/me/orbit-app-loops/find', '/Users/me/orbit-app')).toBe(true)
  })

  it('needs a project to compare against', () => {
    expect(worksInOwnCopy('/Users/me/anything', null)).toBe(true)
  })
})

describe('what the panel is showing', () => {
  it('has nothing to address without a project', () => {
    expect(threadWorktreeState(null, thread(), 'main')).toEqual({ kind: 'no-project' })
  })

  it('has nothing to address without a conversation', () => {
    expect(threadWorktreeState('/p', null, 'main')).toEqual({ kind: 'no-thread' })
  })

  it('says the conversation works in the project when it has no worktree', () => {
    expect(threadWorktreeState('/p', thread(), 'main')).toEqual({
      kind: 'in-project',
      projectBranch: 'main',
    })
  })

  it('says in-project for a path that IS the project, however it was recorded', () => {
    const state = threadWorktreeState(
      '/Users/me/orbit-app',
      thread({ worktreePath: '/Users/me/orbit-app', worktreeBranch: 'feat/x' }),
      'feat/x',
    )
    expect(state).toEqual({ kind: 'in-project', projectBranch: 'feat/x' })
  })

  it('names the branch of a real worktree', () => {
    const state = threadWorktreeState(
      '/Users/me/orbit-app',
      thread({ worktreePath: '/Users/me/wt/t1', worktreeBranch: 'flow/work' }),
      'main',
    )
    expect(state).toEqual({ kind: 'own', folder: 't1', branch: 'flow/work', others: [] })
  })

  it('carries a null branch rather than a blank one', () => {
    const state = threadWorktreeState(
      '/Users/me/orbit-app',
      thread({ worktreePath: '/Users/me/wt/t1', worktreeBranch: '  ' }),
      'main',
    )
    expect(state).toEqual({ kind: 'own', folder: 't1', branch: null, others: [] })
  })

  // THE THIRTY SECONDS, PINNED. Describing what a worktree HOLDS meant reading
  // every worktree in the project. Nothing in this state does that any more —
  // there is no field for it to arrive in.
  it('says nothing about what is inside, and has nowhere to put it', () => {
    const state = threadWorktreeState(
      '/Users/me/orbit-app',
      thread({ worktreePath: '/Users/me/wt/t1', worktreeBranch: 'flow/work' }),
      'main',
    )
    expect(Object.keys(state).sort()).toEqual(['branch', 'folder', 'kind', 'others'])
  })

  // THE FOLDER IS NOT THE BRANCH, and the panel showed only the second of them.
  // A shell prompt that prints one path component reads the same word for both,
  // and the `worktree/` prefix is exactly what tells them apart (user,
  // 2026-09-18).
  it('names the FOLDER with its prefix, beside the branch', () => {
    const state = threadWorktreeState(
      '/Users/me/orbit-app',
      thread({
        worktreePath: '/Users/me/.orbit-app-threads/worktree/using-claude-sonnet-5',
        worktreeBranch: 'using-claude-sonnet-5',
      }),
      'main',
    )
    expect(state).toMatchObject({
      kind: 'own',
      folder: 'worktree/using-claude-sonnet-5',
      branch: 'using-claude-sonnet-5',
    })
  })

  it('has no folder name for a checkout still called after a thread id', () => {
    const state = threadWorktreeState(
      '/Users/me/orbit-app',
      thread({
        worktreePath: '/Users/me/.orbit-app-threads/e2265b48-03e9-43e3-8f76-ff887a48615e',
        worktreeBranch: 'flow/work',
      }),
      'main',
    )
    // The positive first: this IS a worktree, so a null folder is a decision
    // rather than a state that was never reached.
    expect(state.kind).toBe('own')
    expect(state.kind === 'own' && state.folder).toBeNull()
  })
})

describe('the sentence about working in the project', () => {
  it('names where the conversation is working when the branch is known', () => {
    expect(inProjectLine('main')).toContain('on main')
  })

  it('omits the branch rather than inventing one', () => {
    expect(inProjectLine(null)).toBe('This conversation changes the files you have open.')
  })

  it('names no path, command or config key', () => {
    for (const line of [inProjectLine('main'), inProjectLine(null)]) {
      expect(line).not.toMatch(/planflow-ai|`|\.flowconfig|\/|git /)
    }
  })
})


describe('a conversation carrying several projects', () => {
  // THE BUG. Only the project a thread started in got a copy, so the
  // conversation was isolated in one repository and writing straight into the
  // others — and the file tree said so without anyone noticing:
  // `orbit-app (thread/…)` above a plain `orbit-core` (user, 2026-09-17).
  const withProjects = (
    attached: Array<{ rootPath: string; path?: string | null; branch: string | null }>,
    roots: string[],
  ) =>
    threadWorktreeState(
      '/w/orbit-app',
      {
        id: 't1',
        worktreePath: '/w/wt/t1',
        worktreeBranch: 'thread/migration',
        additionalRoots: roots,
        attachedWorktrees: attached.map((entry) => ({
          rootPath: entry.rootPath,
          // Default: an attached entry EXISTS, so it has a copy. A test that
          // means "no copy" passes `path: null` on purpose.
          path: entry.path === undefined ? `/w/wt/${entry.rootPath.split('/').pop() ?? ''}` : entry.path,
          branch: entry.branch,
        })),
      } as ThreadSummary,
      'main',
    )

  it('lists every other project, with the branch its copy is on', () => {
    const state = withProjects(
      [{ rootPath: '/w/orbit-core', branch: 'thread/migration' }],
      ['/w/orbit-core'],
    )
    if (state.kind !== 'own') throw new Error('expected own')
    expect(state.others).toEqual([
      { rootPath: '/w/orbit-core', name: 'orbit-core', path: '/w/wt/orbit-core', branch: 'thread/migration' },
    ])
  })

  // THE ONE THAT MATTERS. A project with no copy is where the agent edits real
  // files; leaving it out of the list would hide exactly what went wrong.
  it('still lists a project that has NO copy, with no branch', () => {
    const state = withProjects([], ['/w/orbit-core'])
    if (state.kind !== 'own') throw new Error('expected own')
    expect(state.others).toEqual([
      { rootPath: '/w/orbit-core', name: 'orbit-core', path: null, branch: null },
    ])
  })

  it('keeps what worked beside what did not', () => {
    const state = withProjects(
      [{ rootPath: '/w/orbit-core', branch: 'thread/migration' }],
      ['/w/orbit-core', '/w/not-a-repo'],
    )
    if (state.kind !== 'own') throw new Error('expected own')
    expect(state.others.map((o) => [o.name, o.branch])).toEqual([
      ['orbit-core', 'thread/migration'],
      ['not-a-repo', null],
    ])
  })

  it('says nothing extra for a conversation carrying one project', () => {
    const state = withProjects([], [])
    if (state.kind !== 'own') throw new Error('expected own')
    expect(state.others).toEqual([])
  })

  /**
   * A DETACHED COPY IS STILL A COPY.
   *
   * `path` and `branch` answer different questions, and only `path` answers
   * "does this project have its own checkout?". The panel used to read a null
   * branch as "no copy" — which is true of nothing and false of every detached
   * attachment, and a detached primary cuts detached attachments by design. A
   * person saw "still your main folder" beside a copy that existed, under a
   * button that could not help because there was nothing left to cut.
   *
   * Measured on the real profile when this was found: three attached checkouts,
   * all with a recorded path, all with an empty branch.
   */
  it('reports a DETACHED attached copy as having one, not as missing', () => {
    const state = withProjects(
      [{ rootPath: '/w/orbit-core', path: '/w/wt/orbit-core', branch: null }],
      ['/w/orbit-core'],
    )
    if (state.kind !== 'own') throw new Error('expected own')
    // POSITIVE FIRST (#28): the project really is listed, so the path beside it
    // is evidence of the distinction rather than of an empty list.
    expect(state.others).toHaveLength(1)
    expect(state.others[0].path).toBe('/w/wt/orbit-core')
    expect(state.others[0].branch).toBe(null)
  })

  it('keeps path and branch independent in both directions', () => {
    const state = withProjects(
      [
        { rootPath: '/w/has-both', path: '/w/wt/a', branch: 'feat/x' },
        { rootPath: '/w/detached', path: '/w/wt/b', branch: null },
        { rootPath: '/w/no-copy', path: null, branch: null },
      ],
      ['/w/has-both', '/w/detached', '/w/no-copy'],
    )
    if (state.kind !== 'own') throw new Error('expected own')
    expect(state.others.map((o) => [o.path !== null, o.branch])).toEqual([
      [true, 'feat/x'],
      [true, null],
      [false, null],
    ])
  })
})

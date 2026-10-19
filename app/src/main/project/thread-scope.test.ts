// threadScopeFor — pure model tests (no DB, no Electron; plain `npx jest`).

import { threadCopyName, threadScopeFor, type ScopeProjectRoot } from './thread-scope'

const ROOT_A = '/Users/dev/project-a'
const ROOT_B = '/Users/dev/project-b'
const ROOT_C = '/Users/dev/nested/project-c'

const REGISTERED_PROJECTS: ScopeProjectRoot[] = [
  { id: 'id-a', rootPath: ROOT_A, available: true },
  { id: 'id-b', rootPath: ROOT_B, available: true },
  { id: 'id-c', rootPath: ROOT_C, available: false },
]

describe('threadScopeFor', () => {
  it('orders the primary first, then additional roots in given order', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: ROOT_B,
      additionalRoots: [ROOT_C, ROOT_A],
      projectRoots: REGISTERED_PROJECTS,
    })

    expect(scope.threadId).toBe('t1')
    expect(scope.roots.map((entry) => entry.rootPath)).toEqual([ROOT_B, ROOT_C, ROOT_A])
    expect(scope.roots[0].primary).toBe(true)
    expect(scope.roots.slice(1).every((entry) => !entry.primary)).toBe(true)
  })

  it('never duplicates the primary from an additional entry and collapses repeats', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: ROOT_A,
      additionalRoots: [ROOT_A, ROOT_B, ROOT_B, ROOT_A],
      projectRoots: REGISTERED_PROJECTS,
    })

    expect(scope.roots.map((entry) => entry.rootPath)).toEqual([ROOT_A, ROOT_B])
    expect(scope.roots.filter((entry) => entry.primary)).toHaveLength(1)
  })

  it('joins rootId + availability from the project record', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: ROOT_A,
      additionalRoots: [ROOT_C],
      projectRoots: REGISTERED_PROJECTS,
    })

    expect(scope.roots[0]).toEqual({
      rootId: 'id-a',
      rootPath: ROOT_A,
      name: 'project-a',
      primary: true,
      available: true,
    })
    // ROOT_C is a persisted-but-unreachable project root (#263).
    expect(scope.roots[1].rootId).toBe('id-c')
    expect(scope.roots[1].available).toBe(false)
  })

  it('treats an absent `available` flag on the record as available', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: ROOT_A,
      additionalRoots: [],
      projectRoots: [{ id: 'id-a', rootPath: ROOT_A }],
    })

    expect(scope.roots[0].available).toBe(true)
  })

  it('keeps a thread root with NO project record as rootId "" / unavailable', () => {
    const unknown = '/Users/dev/not-yet-opened'
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: ROOT_A,
      additionalRoots: [unknown],
      projectRoots: REGISTERED_PROJECTS,
    })

    expect(scope.roots[1]).toEqual({
      rootId: '',
      rootPath: unknown,
      name: 'not-yet-opened',
      primary: false,
      available: false,
    })
  })

  it('single-root degenerate case: one entry, primary, no extras', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: ROOT_A,
      additionalRoots: [],
      projectRoots: REGISTERED_PROJECTS,
    })

    expect(scope.roots).toHaveLength(1)
    expect(scope.roots[0].primary).toBe(true)
    expect(scope.roots[0].rootPath).toBe(ROOT_A)
  })

  it('null thread → the active project single root; additionalRoots ignored', () => {
    const scope = threadScopeFor({
      threadId: null,
      primaryRoot: ROOT_A,
      additionalRoots: [ROOT_B],
      projectRoots: REGISTERED_PROJECTS,
    })

    expect(scope.threadId).toBeNull()
    expect(scope.roots.map((entry) => entry.rootPath)).toEqual([ROOT_A])
  })

  it('null primary → empty scope', () => {
    const scope = threadScopeFor({
      threadId: null,
      primaryRoot: null,
      additionalRoots: [],
      projectRoots: REGISTERED_PROJECTS,
    })

    expect(scope).toEqual({ threadId: null, roots: [] })
  })

  it('names come from the last path segment (trailing slash + windows paths)', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: '/Users/dev/project-a/',
      additionalRoots: ['C:\\work\\repo-x'],
      projectRoots: [],
    })

    expect(scope.roots[0].name).toBe('project-a')
    expect(scope.roots[1].name).toBe('repo-x')
  })

  it('skips empty-string additional roots', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: ROOT_A,
      additionalRoots: ['', ROOT_B],
      projectRoots: REGISTERED_PROJECTS,
    })

    expect(scope.roots.map((entry) => entry.rootPath)).toEqual([ROOT_A, ROOT_B])
  })
})

describe('threadScopeFor — accent override pass-through', () => {
  it('carries a project record accentColor onto the entry as `accent`', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: ROOT_A,
      additionalRoots: [ROOT_B],
      projectRoots: [
        { id: 'id-a', rootPath: ROOT_A, available: true, accentColor: '#9d70db' },
        { id: 'id-b', rootPath: ROOT_B, available: true },
      ],
    })

    expect(scope.roots[0].accent).toBe('#9d70db')
  })

  it('omits the accent key entirely when there is no override (shape-stable)', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: ROOT_A,
      additionalRoots: [],
      projectRoots: REGISTERED_PROJECTS,
    })

    expect('accent' in scope.roots[0]).toBe(false)
  })

  it('a thread root with NO project record has no accent', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: ROOT_A,
      additionalRoots: ['/Users/dev/not-yet-opened'],
      projectRoots: REGISTERED_PROJECTS,
    })

    expect('accent' in scope.roots[1]).toBe(false)
  })
})

describe('display names', () => {
  const CHECKOUT = '/Users/dev/.project-a-threads/b966e62c-499f-4ffc-86f7-8c42d26'

  it('names a registered project by its folder, as it always has', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: ROOT_A,
      additionalRoots: [],
      projectRoots: REGISTERED_PROJECTS,
    })

    expect(scope.roots[0].name).toBe('project-a')
  })

  it('lets a LENT record state its own name — the checkout is not named by its folder', () => {
    const scope = threadScopeFor({
      threadId: 't1',
      primaryRoot: CHECKOUT,
      additionalRoots: [],
      projectRoots: [
        ...REGISTERED_PROJECTS,
        { id: 'id-a', rootPath: CHECKOUT, name: threadCopyName(ROOT_A) },
      ],
    })

    expect(scope.roots[0].name).toBe('project-a')
    // The regression: the user read a raw UUID as a repository name.
    expect(scope.roots[0].name).not.toContain('b966e62c')
  })

  it('threadCopyName names the PROJECT, and nothing else', () => {
    // It used to append "(this thread)", which existed only to tell two groups
    // of the same repository apart. The panel renders one group per repository
    // since 2026-08-26, so the distinction it drew is no longer on screen and
    // the label explaining it went with it.
    //
    // What the function still does is refuse the checkout's OWN folder name,
    // which is a thread id: no path, no command, no id (forbidden-pattern #12).
    expect(threadCopyName('/Users/dev/orbit-app')).toBe('orbit-app')
    expect(threadCopyName('/Users/dev/orbit-app/')).toBe('orbit-app')
    expect(threadCopyName('/Users/dev/orbit-app')).not.toContain('/')
    expect(threadCopyName('/Users/dev/orbit-app')).not.toContain('(')
  })
})

// primary-root tests — the renderer's single answer to "which working tree is
// on screen". Pure + DOM-free (fake bridge object, no window), so it runs under
// plain jest with no Electron.

import type { ProjectContext, ThreadScope } from '../shared/ipc-contract'
import { bindPrimaryRoot, primaryRootOf, readPrimaryRoot, type PrimaryRootApi } from './primary-root'

const PROJECT = '/repos/app'
const WORKTREE = '/repos/.app-threads/t-1'

function scopeOf(rootPaths: string[], threadId: string | null = 't-1'): ThreadScope {
  return {
    threadId,
    roots: rootPaths.map((rootPath, index) => ({
      rootId: `id-${index}`,
      rootPath,
      name: rootPath,
      primary: index === 0,
      available: true,
    })),
  }
}

function contextOf(rootPath: string): ProjectContext {
  return {
    rootPath,
    openFiles: [],
    activeFile: null,
    activeThreadId: null,
    dirtyBuffers: {},
  }
}

/** A controllable stand-in for `window.flow.project`. */
function fakeApi(options: { scope?: boolean } = {}): PrimaryRootApi & {
  emitProject(context: ProjectContext | null): void
  emitScope(scope: ThreadScope): void
  resolveProject(context: ProjectContext | null): void
  resolveScope(scope: ThreadScope | null): void
  projectUnbinds: number
  scopeUnbinds: number
} {
  const withScope = options.scope !== false
  let projectListener: ((context: ProjectContext | null) => void) | null = null
  let scopeListener: ((scope: ThreadScope) => void) | null = null
  let resolveProjectSnapshot: (context: ProjectContext | null) => void = () => undefined
  let resolveScopeSnapshot: (scope: ThreadScope | null) => void = () => undefined
  const projectSnapshot = new Promise<ProjectContext | null>((resolve) => {
    resolveProjectSnapshot = resolve
  })
  const scopeSnapshot = new Promise<ThreadScope | null>((resolve) => {
    resolveScopeSnapshot = resolve
  })

  const api = {
    projectUnbinds: 0,
    scopeUnbinds: 0,
    active: () => projectSnapshot,
    onActiveChanged: (listener: (context: ProjectContext | null) => void) => {
      projectListener = listener
      return () => {
        api.projectUnbinds += 1
      }
    },
    ...(withScope
      ? {
          getThreadScope: () => scopeSnapshot as Promise<ThreadScope>,
          onThreadScopeChanged: (listener: (scope: ThreadScope) => void) => {
            scopeListener = listener
            return () => {
              api.scopeUnbinds += 1
            }
          },
        }
      : {}),
    emitProject: (context: ProjectContext | null) => projectListener?.(context),
    emitScope: (scope: ThreadScope) => scopeListener?.(scope),
    resolveProject: (context: ProjectContext | null) => resolveProjectSnapshot(context),
    resolveScope: (scope: ThreadScope | null) => resolveScopeSnapshot(scope),
  }
  return api
}

/** Let the seeding Promise.all settle. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('primaryRootOf', () => {
  it("prefers the scope's primary root — the thread's own checkout", () => {
    expect(primaryRootOf(scopeOf([WORKTREE, '/repos/lib']), PROJECT)).toBe(WORKTREE)
  })

  it('falls back to the active project when there is no scope at all', () => {
    expect(primaryRootOf(null, PROJECT)).toBe(PROJECT)
  })

  it('falls back to the active project when the scope is empty', () => {
    expect(primaryRootOf({ threadId: null, roots: [] }, PROJECT)).toBe(PROJECT)
  })

  it('is null when nothing is open', () => {
    expect(primaryRootOf(null, null)).toBeNull()
  })

  it('takes the first root when no entry is flagged primary (defensive)', () => {
    const scope = scopeOf([WORKTREE])
    scope.roots[0].primary = false
    expect(primaryRootOf(scope, PROJECT)).toBe(WORKTREE)
  })
})

describe('readPrimaryRoot', () => {
  it("resolves the thread's worktree over the project root", async () => {
    const api = fakeApi()
    api.resolveProject(contextOf(PROJECT))
    api.resolveScope(scopeOf([WORKTREE]))
    await expect(readPrimaryRoot(api)).resolves.toBe(WORKTREE)
  })

  it('degrades to the active project when the scope channel is absent', async () => {
    const api = fakeApi({ scope: false })
    api.resolveProject(contextOf(PROJECT))
    await expect(readPrimaryRoot(api)).resolves.toBe(PROJECT)
  })
})

describe('bindPrimaryRoot', () => {
  it('reports once, with the thread root, after BOTH snapshots land', async () => {
    const api = fakeApi()
    const seen: (string | null)[] = []
    bindPrimaryRoot(api, (root) => seen.push(root))

    api.resolveProject(contextOf(PROJECT))
    await flush()
    // The project snapshot alone must not report — a surface that saw PROJECT
    // here would load the wrong tree and reload a frame later.
    expect(seen).toEqual([])

    api.resolveScope(scopeOf([WORKTREE]))
    await flush()
    expect(seen).toEqual([WORKTREE])
  })

  it('reports the seeded null so a surface enters its no-project state', async () => {
    const api = fakeApi()
    const seen: (string | null)[] = []
    bindPrimaryRoot(api, (root) => seen.push(root))
    api.resolveProject(null)
    api.resolveScope(null)
    await flush()
    expect(seen).toEqual([null])
  })

  it('does NOT re-report a scope change that leaves the root where it was', async () => {
    const api = fakeApi()
    const seen: (string | null)[] = []
    bindPrimaryRoot(api, (root) => seen.push(root))
    api.resolveProject(contextOf(PROJECT))
    api.resolveScope(scopeOf([WORKTREE]))
    await flush()

    // Same primary, an extra additional root — nothing this reports changed.
    api.emitScope(scopeOf([WORKTREE, '/repos/lib']))
    expect(seen).toEqual([WORKTREE])
  })

  it('follows the thread into and out of its worktree', async () => {
    const api = fakeApi()
    const seen: (string | null)[] = []
    bindPrimaryRoot(api, (root) => seen.push(root))
    api.resolveProject(contextOf(PROJECT))
    api.resolveScope(scopeOf([PROJECT], null))
    await flush()

    api.emitScope(scopeOf([WORKTREE]))
    api.emitScope(scopeOf([PROJECT], null))
    expect(seen).toEqual([PROJECT, WORKTREE, PROJECT])
  })

  it('lets a live event during seeding win over the snapshot it raced', async () => {
    const api = fakeApi()
    const seen: (string | null)[] = []
    bindPrimaryRoot(api, (root) => seen.push(root))

    api.emitScope(scopeOf([WORKTREE]))
    // Snapshots resolve LATE, carrying the pre-event world.
    api.resolveProject(contextOf(PROJECT))
    api.resolveScope(scopeOf([PROJECT], null))
    await flush()

    expect(seen).toEqual([WORKTREE])
  })

  it('degrades to the active project when the scope channel is absent', async () => {
    const api = fakeApi({ scope: false })
    const seen: (string | null)[] = []
    bindPrimaryRoot(api, (root) => seen.push(root))
    api.resolveProject(contextOf(PROJECT))
    await flush()
    expect(seen).toEqual([PROJECT])

    api.emitProject(contextOf('/repos/other'))
    expect(seen).toEqual([PROJECT, '/repos/other'])
  })

  it('drops both subscriptions and reports nothing after dispose', async () => {
    const api = fakeApi()
    const seen: (string | null)[] = []
    const unbind = bindPrimaryRoot(api, (root) => seen.push(root))
    unbind()
    api.resolveProject(contextOf(PROJECT))
    api.resolveScope(scopeOf([WORKTREE]))
    await flush()

    expect(seen).toEqual([])
    expect(api.projectUnbinds).toBe(1)
    expect(api.scopeUnbinds).toBe(1)
  })
})

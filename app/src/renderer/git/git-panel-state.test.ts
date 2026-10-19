import {
  deriveMergeBanner,
  panelRenderSignature,
  resolvePanelState,
  type RootLoadStatus,
} from './git-panel-state'
import type { GitRootView } from './git-panel'
import type { GitMergeState } from '../../shared/ipc-contract'

const view = (rootPath: string): GitRootView => ({ rootPath, status: null, commits: [] })

/** Build the input from plain maps for readability. */
function input(
  activeRoot: string | null,
  rootOrder: string[],
  views: Record<string, GitRootView>,
  statuses: Record<string, RootLoadStatus> = {},
) {
  return {
    activeRoot,
    rootOrder,
    viewFor: (r: string) => views[r],
    statusFor: (r: string) => statuses[r],
  }
}

describe('resolvePanelState (#289)', () => {
  it('shows the active root when its view has loaded', () => {
    const v = view('/a')
    expect(resolvePanelState(input('/a', ['/a'], { '/a': v }))).toEqual({ kind: 'roots', views: [v] })
  })

  it('shows LOADING (not "no roots") for an active root whose refresh is still in flight', () => {
    // The exact project-switch flash: active root known, no view yet.
    expect(resolvePanelState(input('/a', ['/a'], {}, { '/a': 'loading' }))).toEqual({ kind: 'loading' })
    // Even before any status is recorded, a known active root is loading, not empty.
    expect(resolvePanelState(input('/a', ['/a'], {}))).toEqual({ kind: 'loading' })
  })

  it('shows ERROR for an active root whose refresh rejected — never the misleading empty state', () => {
    expect(resolvePanelState(input('/a', ['/a'], {}, { '/a': 'error' }))).toEqual({ kind: 'error' })
  })

  it('keeps showing loaded data during a background refresh (view present, status loading)', () => {
    const v = view('/a')
    expect(resolvePanelState(input('/a', ['/a'], { '/a': v }, { '/a': 'loading' }))).toEqual({
      kind: 'roots',
      views: [v],
    })
  })

  it('falls back to all loaded roots when no project is active (early boot)', () => {
    const a = view('/a')
    const b = view('/b')
    expect(resolvePanelState(input(null, ['/a', '/b'], { '/a': a, '/b': b }))).toEqual({
      kind: 'roots',
      views: [a, b],
    })
  })

  it('shows loading (not empty) at boot while roots exist but none have data yet', () => {
    expect(resolvePanelState(input(null, ['/a'], {}))).toEqual({ kind: 'loading' })
  })

  it('shows the genuine empty state only when there are truly no roots', () => {
    expect(resolvePanelState(input(null, [], {}))).toEqual({ kind: 'empty' })
  })
})

describe('resolvePanelState — thread-spanning roots (#45)', () => {
  const withThreadRoots = (base: ReturnType<typeof input>, threadRoots: string[]) => ({
    ...base,
    threadRoots,
  })

  it('appends a loaded thread root after the active project section', () => {
    const a = view('/app')
    const core = view('/core')
    const state = resolvePanelState(
      withThreadRoots(input('/app', ['/app', '/core'], { '/app': a, '/core': core }), ['/core']),
    )
    expect(state).toEqual({ kind: 'roots', views: [a, core] })
  })

  it('never duplicates the active root when the thread also lists it', () => {
    const a = view('/app')
    const state = resolvePanelState(
      withThreadRoots(input('/app', ['/app'], { '/app': a }), ['/app']),
    )
    expect(state).toEqual({ kind: 'roots', views: [a] })
  })

  it('skips thread roots unknown to the project list', () => {
    const a = view('/app')
    const state = resolvePanelState(
      withThreadRoots(input('/app', ['/app'], { '/app': a }), ['/gone']),
    )
    expect(state).toEqual({ kind: 'roots', views: [a] })
  })

  it('skips a still-loading thread root without holding up the active section', () => {
    const a = view('/app')
    const state = resolvePanelState(
      withThreadRoots(
        input('/app', ['/app', '/core'], { '/app': a }, { '/core': 'loading' }),
        ['/core'],
      ),
    )
    expect(state).toEqual({ kind: 'roots', views: [a] })
  })

  it('active-root loading/error semantics are unchanged by thread roots', () => {
    const core = view('/core')
    expect(
      resolvePanelState(
        withThreadRoots(input('/app', ['/app', '/core'], { '/core': core }, { '/app': 'loading' }), ['/core']),
      ),
    ).toEqual({ kind: 'loading' })
    expect(
      resolvePanelState(
        withThreadRoots(input('/app', ['/app', '/core'], { '/core': core }, { '/app': 'error' }), ['/core']),
      ),
    ).toEqual({ kind: 'error' })
  })
})

describe('resolvePanelState — thread scope (multi-project threads Phase 4)', () => {
  function withScope(base: ReturnType<typeof input>, scopeRoots: string[]) {
    return { ...base, scopeRoots }
  }

  it('renders one view per scope root, in scope order (primary first)', () => {
    const app = view('/app')
    const core = view('/core')
    const state = resolvePanelState(
      withScope(input('/core', ['/app', '/core'], { '/app': app, '/core': core }), [
        '/app',
        '/core',
      ]),
    )
    // Scope order wins over the active root — the primary root's group leads.
    expect(state).toEqual({ kind: 'roots', views: [app, core] })
  })

  it('single-root scope resolves exactly like the legacy active-root binding', () => {
    const app = view('/app')
    expect(
      resolvePanelState(withScope(input('/app', ['/app'], { '/app': app }), ['/app'])),
    ).toEqual({ kind: 'roots', views: [app] })
  })

  it('best-effort skips scope roots that are unknown or still loading', () => {
    const app = view('/app')
    const state = resolvePanelState(
      withScope(
        input('/app', ['/app', '/core'], { '/app': app }, { '/core': 'loading' }),
        ['/app', '/core', '/missing'],
      ),
    )
    expect(state).toEqual({ kind: 'roots', views: [app] })
  })

  it('no scope view loaded: loading while any scope root is known, error when the primary failed', () => {
    expect(
      resolvePanelState(withScope(input('/app', ['/app'], {}, { '/app': 'loading' }), ['/app'])),
    ).toEqual({ kind: 'loading' })
    expect(
      resolvePanelState(withScope(input('/app', ['/app'], {}, { '/app': 'error' }), ['/app'])),
    ).toEqual({ kind: 'error' })
    expect(resolvePanelState(withScope(input(null, [], {}), ['/gone']))).toEqual({
      kind: 'empty',
    })
  })

  it('an empty scope falls back to the legacy binding (fail-soft)', () => {
    const app = view('/app')
    expect(
      resolvePanelState(withScope(input('/app', ['/app'], { '/app': app }), [])),
    ).toEqual({ kind: 'roots', views: [app] })
  })
})

describe('deriveMergeBanner (#335)', () => {
  it('is not visible for null/undefined state', () => {
    expect(deriveMergeBanner(null).visible).toBe(false)
    expect(deriveMergeBanner(undefined).visible).toBe(false)
  })

  it('is not visible when no operation is in progress (op: none)', () => {
    const state: GitMergeState = { op: 'none', unmergedPaths: [] }
    expect(deriveMergeBanner(state)).toEqual({
      visible: false,
      op: 'none',
      opLabel: '',
      unmergedCount: 0,
      canComplete: false,
      message: '',
    })
  })

  it('is visible with canComplete=false while a merge has unresolved conflicts', () => {
    const state: GitMergeState = { op: 'merge', unmergedPaths: ['a.ts', 'b.ts'], mergeMsg: 'Merge x' }
    const banner = deriveMergeBanner(state)
    expect(banner.visible).toBe(true)
    expect(banner.opLabel).toBe('Merge in progress')
    expect(banner.unmergedCount).toBe(2)
    expect(banner.canComplete).toBe(false)
  })

  it('enables canComplete and surfaces the merge message when no conflicts remain', () => {
    const state: GitMergeState = { op: 'merge', unmergedPaths: [], mergeMsg: 'Merge branch feat' }
    const banner = deriveMergeBanner(state)
    expect(banner.visible).toBe(true)
    expect(banner.canComplete).toBe(true)
    expect(banner.message).toBe('Merge branch feat')
  })

  it('labels a rebase distinctly and defaults an absent message to empty', () => {
    const state: GitMergeState = { op: 'rebase', unmergedPaths: ['a.ts'] }
    const banner = deriveMergeBanner(state)
    expect(banner.opLabel).toBe('Rebase in progress')
    expect(banner.message).toBe('')
  })

  it('stays hidden for cherry-pick (banner has no wired continue/abort for it yet)', () => {
    // getMergeState classifies cherry-pick for the identity pipeline, but the
    // banner's buttons only speak merge/rebase — so it must not surface here.
    const state: GitMergeState = { op: 'cherry-pick', cherryPickHead: 'abc', unmergedPaths: ['a.ts'] }
    const banner = deriveMergeBanner(state)
    expect(banner.visible).toBe(false)
    expect(banner.op).toBe('cherry-pick')
  })

  it('surfaces the raw op so controls run the merge vs rebase path (#571)', () => {
    expect(deriveMergeBanner({ op: 'merge', unmergedPaths: [] }).op).toBe('merge')
    expect(deriveMergeBanner({ op: 'rebase', unmergedPaths: [] }).op).toBe('rebase')
    expect(deriveMergeBanner(null).op).toBe('none')
  })
})

describe('panelRenderSignature (#1094)', () => {
  const richView = (rootPath: string, dirty: boolean): GitRootView => ({
    rootPath,
    status: {
      rootId: rootPath,
      branch: 'main',
      dirty,
      ahead: 0,
      behind: 0,
      changes: dirty ? [{ filePath: 'a.ts', state: 'modified', staged: false }] : [],
    },
    commits: [{ hash: 'abc1234', subject: 'feat: x', author: 'qa', date: '2026-07-29' }],
    mergeState: { op: 'none', unmergedPaths: [] },
  })

  it('is identical for two independently-built but equal states (a no-op refresh)', () => {
    const a = panelRenderSignature({ kind: 'roots', views: [richView('/r', true)] }, null)
    const b = panelRenderSignature({ kind: 'roots', views: [richView('/r', true)] }, null)
    expect(a).toBe(b)
  })

  it('changes when any rendered fact changes (change set, commits, scope, kind)', () => {
    const base = panelRenderSignature({ kind: 'roots', views: [richView('/r', true)] }, null)
    expect(panelRenderSignature({ kind: 'roots', views: [richView('/r', false)] }, null)).not.toBe(
      base,
    )
    expect(panelRenderSignature({ kind: 'loading' }, null)).not.toBe(base)
    expect(
      panelRenderSignature({ kind: 'roots', views: [richView('/r', true)] }, [
        {
          rootId: 'id',
          rootPath: '/r',
          name: 'r',
          primary: true,
          available: true,
        },
      ]),
    ).not.toBe(base)
  })

  it('distinguishes the empty/loading/error placeholders from each other', () => {
    const kinds = ['empty', 'loading', 'error'] as const
    const signatures = kinds.map((kind) => panelRenderSignature({ kind }, null))
    expect(new Set(signatures).size).toBe(3)
  })
})

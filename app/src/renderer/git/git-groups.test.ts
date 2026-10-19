// git-groups — the Source Control repo-group view model (Phase 4).
import type { GitStatus, ThreadScopeEntry } from '../../shared/ipc-contract'
import type { GitRootView } from './git-panel'
import {
  aheadBehindLabel,
  deriveGitGroups,
  diffRootStillVisible,
  groupByRoot,
  groupCollapseKey,
  groupHeaderTitle,
  lastPathSegment,
  mayFireGroupAction,
  repoConfirmName,
} from './git-groups'

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    rootId: '/w/app',
    branch: 'main',
    dirty: false,
    ahead: 0,
    behind: 0,
    changes: [],
    ...overrides,
  }
}

function view(rootPath: string, overrides: Partial<GitRootView> = {}): GitRootView {
  return { rootPath, status: status({ rootId: rootPath }), commits: [], ...overrides }
}

function entry(rootPath: string, overrides: Partial<ThreadScopeEntry> = {}): ThreadScopeEntry {
  return {
    rootId: `id-${rootPath}`,
    rootPath,
    name: lastPathSegment(rootPath),
    primary: false,
    available: true,
    ...overrides,
  }
}

describe('deriveGitGroups', () => {
  it('single-root scope renders ZERO group chrome (the no-chrome rule)', () => {
    const groups = deriveGitGroups([view('/w/app')], [entry('/w/app', { primary: true })])
    expect(groups).toHaveLength(1)
    expect(groups[0].header).toBeNull()
    expect(groups[0].view.rootPath).toBe('/w/app')
  })

  it('multi-root scope gets one header per group, in view order', () => {
    const groups = deriveGitGroups(
      [view('/w/app'), view('/w/core')],
      [entry('/w/app', { primary: true }), entry('/w/core')],
    )
    expect(groups.map((group) => group.header?.name)).toEqual(['app', 'core'])
    expect(groups[0].header).toMatchObject({
      rootPath: '/w/app',
      branch: 'main',
      primary: true,
      available: true,
    })
    expect(groups[1].header).toMatchObject({ rootPath: '/w/core', primary: false })
  })

  it('carries branch + ahead/behind from the view and availability from the scope', () => {
    const groups = deriveGitGroups(
      [
        view('/w/app', { status: status({ branch: 'feat/x', ahead: 2, behind: 1 }) }),
        view('/w/core', { status: null }), // not a git repository
      ],
      [entry('/w/app', { primary: true }), entry('/w/core', { available: false })],
    )
    expect(groups[0].header).toMatchObject({ branch: 'feat/x', aheadBehind: '↑2 ↓1' })
    expect(groups[1].header).toMatchObject({ branch: '', aheadBehind: '', available: false })
  })

  it('falls back to path-segment names and first-view-primary without a scope (legacy)', () => {
    const groups = deriveGitGroups([view('/w/app'), view('/w/core')], null)
    expect(groups[0].header).toMatchObject({ name: 'app', primary: true, available: true })
    expect(groups[1].header).toMatchObject({ name: 'core', primary: false })
  })
})

describe('aheadBehindLabel', () => {
  it.each([
    [status({ ahead: 1, behind: 2 }), '↑1 ↓2'],
    [status({ ahead: 3 }), '↑3'],
    [status({ behind: 4 }), '↓4'],
    [status(), ''],
    [null, ''],
  ])('formats %#', (input, expected) => {
    expect(aheadBehindLabel(input)).toBe(expected)
  })
})

describe('groupCollapseKey', () => {
  it('namespaces group keys away from the section keys', () => {
    expect(groupCollapseKey('/w/app')).toBe('root:/w/app')
    expect(['merge', 'staged', 'changes', 'commits']).not.toContain(groupCollapseKey('/w/app'))
  })
})

describe('mayFireGroupAction (#951 generalized)', () => {
  it('fires only while the armed root is still visible', () => {
    expect(mayFireGroupAction('/w/app', ['/w/app', '/w/core'])).toBe(true)
    expect(mayFireGroupAction('/w/core', ['/w/app', '/w/core'])).toBe(true)
    expect(mayFireGroupAction('/w/gone', ['/w/app', '/w/core'])).toBe(false)
    expect(mayFireGroupAction(null, ['/w/app'])).toBe(false)
    expect(mayFireGroupAction('/w/app', [])).toBe(false)
  })
})

describe('diffRootStillVisible', () => {
  const alive = new Set(['/w/app', '/w/core'])

  it('keeps a diff on any visible, alive root (multi-root generalization of #191)', () => {
    expect(diffRootStillVisible('/w/core', ['/w/app', '/w/core'], alive)).toBe(true)
  })

  it('closes when the root left the scope, died, or nothing is open', () => {
    expect(diffRootStillVisible('/w/core', ['/w/app'], alive)).toBe(false)
    expect(diffRootStillVisible('/w/gone', ['/w/gone'], alive)).toBe(false)
    expect(diffRootStillVisible(null, ['/w/app'], alive)).toBe(false)
  })

  it('single-root visibility reproduces the active-project rule exactly', () => {
    expect(diffRootStillVisible('/w/app', ['/w/app'], alive)).toBe(true)
    expect(diffRootStillVisible('/w/core', ['/w/app'], alive)).toBe(false)
  })
})

describe('groupByRoot', () => {
  it('single-root listings stay chrome-free (multiRoot false), order preserved', () => {
    const items = [
      { rootId: '/w/app', filePath: 'a.ts' },
      { rootId: '/w/app', filePath: 'b.ts' },
    ]
    const result = groupByRoot(items)
    expect(result.multiRoot).toBe(false)
    expect(result.groups).toEqual([{ rootId: '/w/app', items }])
  })

  it('groups by root in first-seen order across interleaved items', () => {
    const a1 = { rootId: '/w/app', filePath: 'a.ts' }
    const c1 = { rootId: '/w/core', filePath: 'c.ts' }
    const a2 = { rootId: '/w/app', filePath: 'b.ts' }
    const result = groupByRoot([a1, c1, a2])
    expect(result.multiRoot).toBe(true)
    expect(result.groups).toEqual([
      { rootId: '/w/app', items: [a1, a2] },
      { rootId: '/w/core', items: [c1] },
    ])
  })
})

describe('repoConfirmName (#1144)', () => {
  const scope: ThreadScopeEntry[] = [
    { rootId: 'a', rootPath: '/repos/app', name: 'app', primary: true, available: true },
    { rootId: 'c', rootPath: '/repos/core', name: 'core', primary: false, available: true },
  ]

  it('names the repo the way its group header does', () => {
    expect(repoConfirmName('/repos/core', scope, 2)).toBe('core')
  })

  it('falls back to the path segment when the scope has no entry', () => {
    expect(repoConfirmName('/repos/vendored', scope, 2)).toBe('vendored')
    expect(repoConfirmName('/repos/vendored', null, 2)).toBe('vendored')
  })

  it('names nothing with a single repo on screen — the copy stays as it was', () => {
    expect(repoConfirmName('/repos/app', scope, 1)).toBeNull()
    expect(repoConfirmName('/repos/app', scope, 0)).toBeNull()
  })
})

describe('groupHeaderTitle', () => {
  const header = (over: Partial<Parameters<typeof groupHeaderTitle>[0]> = {}) => ({
    rootPath: '/Users/someone/repos/core',
    name: 'core',
    branch: 'main',
    aheadBehind: '',
    primary: false,
    available: true,
    ...over,
  })

  it('never puts a filesystem path on screen (forbidden-pattern #12)', () => {
    const shown = [
      groupHeaderTitle(header()),
      groupHeaderTitle(header({ primary: true })),
      groupHeaderTitle(header({ available: false })),
      groupHeaderTitle(header({ rootPath: '/private/var/folders/x/.app-threads/9f3c-uuid' })),
    ]
    for (const text of shown) {
      expect(text).not.toMatch(/\/Users\/|\/private\/|\/repos\/|-threads\/|planflow-ai|`/)
      expect(text).not.toContain('/')
    }
  })

  it('keeps the primary sentence exactly as it was', () => {
    expect(groupHeaderTitle(header({ primary: true }))).toBe(
      'Primary project — owns plans and flow state',
    )
    // The role wins over availability: a primary that is unreachable is still
    // the primary, and its one sentence is asserted verbatim elsewhere.
    expect(groupHeaderTitle(header({ primary: true, available: false }))).toBe(
      'Primary project — owns plans and flow state',
    )
  })

  it('says what a non-primary group IS, in the terms of the thing on screen', () => {
    expect(groupHeaderTitle(header())).toBe(
      'Another project this thread works in — it has its own branch and its own changes.',
    )
  })

  it('says why an unreachable group is not to be trusted', () => {
    const text = groupHeaderTitle(header({ available: false }))
    expect(text).toContain('can’t reach it right now')
    expect(text).toContain('the last it saw')
  })
})

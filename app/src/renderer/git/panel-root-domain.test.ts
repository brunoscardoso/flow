// The Source Control panel's root domain (thread-worktrees Phase 9).
//
// THE REGRESSION THESE GUARD. A thread's checkout is deliberately never a
// registered project root, and the panel gated everything — rendering, git
// refresh, diff validity, armed destructive actions — on the registered list.
// So Source Control showed "No project open" to a thread that had a whole
// working tree of its own. Phase 8's E2E specs did not catch it (the panel's
// empty state is still a visible box); this is where it gets caught cheaply.

import type { ThreadScopeEntry } from '../../shared/ipc-contract'
import { displacedProjectRoot, panelRootDomain, panelVisibleRoots } from './panel-root-domain'
import { resolvePanelState } from './git-panel-state'
import { deriveGitGroups } from './git-groups'
import type { GitRootView } from './git-panel'

const PROJECT = '/repos/app'
const OTHER = '/repos/core'
/** Where the CLI puts a thread's checkout: a hidden sibling of the repo. */
const CHECKOUT = '/repos/.app-threads/thread-1'

function entry(rootPath: string, over: Partial<ThreadScopeEntry> = {}): ThreadScopeEntry {
  return {
    rootId: 'id-app',
    rootPath,
    name: rootPath.split('/').pop() ?? rootPath,
    primary: rootPath === CHECKOUT,
    available: true,
    ...over,
  }
}

describe('panelRootDomain', () => {
  it('is exactly the registered order when nothing is scope-driven', () => {
    expect(panelRootDomain([PROJECT, OTHER], null)).toEqual([PROJECT, OTHER])
    expect(panelRootDomain([PROJECT, OTHER], [])).toEqual([PROJECT, OTHER])
  })

  it('admits a thread’s checkout, which is never a registered root', () => {
    expect(panelRootDomain([PROJECT], [entry(CHECKOUT)])).toEqual([PROJECT, CHECKOUT])
  })

  it('keeps the registered roots first and in their own order', () => {
    expect(panelRootDomain([PROJECT, OTHER], [entry(CHECKOUT), entry(OTHER)])).toEqual([
      PROJECT,
      OTHER,
      CHECKOUT,
    ])
  })

  it('never repeats a root the project list already registered', () => {
    expect(panelRootDomain([PROJECT], [entry(PROJECT)])).toEqual([PROJECT])
  })

  // THE NARROW HALF. This set is also the fire-time domain for armed
  // destructive actions, so an entry main could not vouch for must not join it.
  it('drops a scope root main flagged unavailable', () => {
    expect(panelRootDomain([PROJECT], [entry('/gone/project', { available: false })])).toEqual([
      PROJECT,
    ])
  })

  it('drops a blank scope root', () => {
    expect(panelRootDomain([PROJECT], [entry('', { rootId: '' })])).toEqual([PROJECT])
  })
})

describe('the panel rendered from that domain', () => {
  const view = (rootPath: string): GitRootView =>
    ({ rootPath, status: null, commits: [], mergeState: null }) as unknown as GitRootView

  it('renders the thread’s checkout instead of "No project open"', () => {
    const domain = panelRootDomain([PROJECT], [entry(CHECKOUT)])
    const state = resolvePanelState({
      activeRoot: PROJECT,
      rootOrder: domain,
      scopeRoots: [CHECKOUT],
      viewFor: (rootPath) => (rootPath === CHECKOUT ? view(CHECKOUT) : undefined),
      statusFor: () => 'loaded',
    })
    expect(state).toEqual({ kind: 'roots', views: [view(CHECKOUT)] })
  })

  it('shows loading — never the empty state — while the checkout’s first refresh is in flight', () => {
    const domain = panelRootDomain([PROJECT], [entry(CHECKOUT)])
    const state = resolvePanelState({
      activeRoot: PROJECT,
      rootOrder: domain,
      scopeRoots: [CHECKOUT],
      viewFor: () => undefined,
      statusFor: () => undefined,
    })
    expect(state).toEqual({ kind: 'loading' })
  })

  // The pre-fix behaviour, pinned so the cause is legible: hand the resolver the
  // REGISTERED list and the same scope, and it answers "no project open".
  it('answers empty when the checkout is filtered out of the domain (the defect)', () => {
    const state = resolvePanelState({
      activeRoot: PROJECT,
      rootOrder: [PROJECT],
      scopeRoots: [CHECKOUT],
      viewFor: (rootPath) => (rootPath === CHECKOUT ? view(CHECKOUT) : undefined),
      statusFor: () => 'loaded',
    })
    expect(state).toEqual({ kind: 'empty' })
  })
})

// ── The project's own tree, which the checkout pushed off the panel ────────
//
// THE BUG A USER FOUND ON FIRST REAL USE. A thread spanning three repos showed
// its checkout and the two siblings — and `orbit-app`, the project whose tree
// held their own uncommitted work, was nowhere. "im not seeing more the files
// changed on the source control." Nothing had been lost; the only surface that
// shows changes had stopped listing the tree they were in.

const ARGO = '/repos/argo'

describe('displacedProjectRoot', () => {
  it('is null for every state that existed before thread worktrees', () => {
    expect(displacedProjectRoot(null, PROJECT)).toBeNull()
    expect(displacedProjectRoot([], PROJECT)).toBeNull()
    // A thread WITHOUT a checkout has the project itself as its root — nothing
    // is displaced, so the panel is byte-identical to what it always was.
    expect(displacedProjectRoot([entry(PROJECT, { primary: true })], PROJECT)).toBeNull()
    expect(
      displacedProjectRoot([entry(PROJECT, { primary: true }), entry(OTHER)], PROJECT),
    ).toBeNull()
  })

  it('names the project when a checkout took its place in the scope', () => {
    expect(displacedProjectRoot([entry(CHECKOUT), entry(OTHER)], PROJECT)).toBe(PROJECT)
  })

  it('is null when no project is active', () => {
    expect(displacedProjectRoot([entry(CHECKOUT)], null)).toBeNull()
  })
})

describe('panelVisibleRoots', () => {
  it('is exactly the addressable scope when nothing is displaced (unchanged)', () => {
    const scope = [entry(PROJECT, { primary: true }), entry(OTHER)]
    expect(panelVisibleRoots(scope, [PROJECT, OTHER], PROJECT)).toEqual([PROJECT, OTHER])
  })

  // THE FIX. The user's own tree is back on screen, and it is next to the copy
  // of itself rather than below two unrelated repositories.
  it('shows a repository ONCE — the thread’s checkout, not it and the project too', () => {
    // Until 2026-08-26 this asserted the opposite: CHECKOUT then PROJECT, the
    // same repository twice under two names a parenthesis apart. The user read
    // that panel and rejected it ("lets show just one of each of them"). The
    // cost is stated where the rule lives: while a thread has a checkout, the
    // project tree's own uncommitted work is not on this panel.
    const scope = [entry(CHECKOUT, { primary: true }), entry(ARGO), entry(OTHER)]
    expect(panelVisibleRoots(scope, [PROJECT, ARGO, OTHER, CHECKOUT], PROJECT)).toEqual([
      CHECKOUT,
      ARGO,
      OTHER,
    ])
  })

  it('still drops a scope root the domain does not vouch for', () => {
    const scope = [entry(CHECKOUT, { primary: true }), entry('/gone', { available: false })]
    expect(panelVisibleRoots(scope, [PROJECT, CHECKOUT], PROJECT)).toEqual([CHECKOUT])
  })

  it('never repeats the project when it is already a scope root', () => {
    const scope = [entry(PROJECT, { primary: true }), entry(OTHER)]
    expect(panelVisibleRoots(scope, [PROJECT, OTHER], PROJECT)).toEqual([PROJECT, OTHER])
  })

  it('leads with the project’s tree when the checkout itself is not addressable', () => {
    const scope = [entry(CHECKOUT, { primary: true }), entry(OTHER)]
    expect(panelVisibleRoots(scope, [PROJECT, OTHER], PROJECT)).toEqual([PROJECT, OTHER])
  })

  it('renders one group per repository, end to end through the panel state', () => {
    const view = (rootPath: string): GitRootView =>
      ({ rootPath, status: null, commits: [], mergeState: null }) as unknown as GitRootView
    const scope = [entry(CHECKOUT, { primary: true }), entry(OTHER)]
    const domain = panelRootDomain([PROJECT, OTHER], scope)
    const visible = panelVisibleRoots(scope, domain, PROJECT)
    const state = resolvePanelState({
      activeRoot: PROJECT,
      rootOrder: domain,
      scopeRoots: visible,
      viewFor: (rootPath) => view(rootPath),
      statusFor: () => 'loaded',
    })
    expect(state).toEqual({
      kind: 'roots',
      views: [view(CHECKOUT), view(OTHER)],
    })
  })

  it('falls back to the project’s tree rather than showing that repository not at all', () => {
    // "One of each" is the rule; "none" never was. With the thread's own
    // checkout unaddressable, dropping the project tree too would leave the
    // repository the thread is working in off the panel entirely.
    const scope = [entry(CHECKOUT, { primary: true }), entry(OTHER)]
    expect(panelVisibleRoots(scope, [PROJECT, OTHER], PROJECT)).toEqual([PROJECT, OTHER])
  })
})

describe('telling the two trees apart on screen', () => {
  const view = (rootPath: string): GitRootView =>
    ({ rootPath, status: null, commits: [], mergeState: null }) as unknown as GitRootView

  it('gives each group a name a person can act on — no id, no path', () => {
    // The scope entry for a checkout carries the name main derived for it
    // (`threadCopyName`); the project's own tree has no scope entry at all and
    // falls back to its folder, exactly as it always did.
    const scope = [
      entry(CHECKOUT, { primary: true, name: 'app (this thread)' }),
      entry(OTHER, { name: 'core' }),
    ]
    const groups = deriveGitGroups([view(CHECKOUT), view(PROJECT), view(OTHER)], scope)
    expect(groups.map((group) => group.header?.name)).toEqual([
      'app (this thread)',
      'app',
      'core',
    ])
    // Two trees of the same repository, and neither header reads as the other.
    expect(groups[0].header?.name).not.toBe(groups[1].header?.name)
    for (const group of groups) {
      expect(group.header?.name).not.toContain('/')
      expect(group.header?.name).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/)
    }
  })
})

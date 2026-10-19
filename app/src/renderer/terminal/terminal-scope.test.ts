// Thread-scope decisions for the terminal panel (multi-project threads
// Phase 5). Pins the degenerate regression guard — single-root scope and the
// legacy binding behave byte-identically to the pre-scope panel — plus the
// multi-root visibility/accent/menu semantics.
import type { ThreadScopeEntry } from '../../shared/ipc-contract'
import {
  defaultNewTerminalRoot,
  displacedProjectRoot,
  hasLiveTabInScope,
  hasLiveTabInThreadTree,
  isTerminalInThreadTree,
  isTerminalInScope,
  newTerminalMenu,
  tabProjectName,
  terminalCwdLabel,
  unscopedTabAction,
  type TerminalScopeState,
} from './terminal-scope'

function entry(overrides: Partial<ThreadScopeEntry> & { rootPath: string }): ThreadScopeEntry {
  return {
    rootId: `id-${overrides.rootPath}`,
    name: overrides.rootPath.split('/').filter(Boolean).pop() ?? overrides.rootPath,
    primary: false,
    available: true,
    ...overrides,
  }
}

const APP = '/work/app'
const LIB = '/work/lib'
const OTHER = '/work/other'

const legacyUnscoped: TerminalScopeState = { scopeRoots: null, activeProjectRoot: null }
const legacyScoped: TerminalScopeState = { scopeRoots: null, activeProjectRoot: APP }
const singleRootScope: TerminalScopeState = {
  scopeRoots: [entry({ rootPath: APP, primary: true })],
  activeProjectRoot: APP,
}
const multiRootScope: TerminalScopeState = {
  scopeRoots: [entry({ rootPath: APP, primary: true }), entry({ rootPath: LIB })],
  activeProjectRoot: APP,
}

describe('isTerminalInScope', () => {
  it('legacy unscoped shows every terminal, including unowned ones', () => {
    expect(isTerminalInScope(APP, legacyUnscoped)).toBe(true)
    expect(isTerminalInScope(undefined, legacyUnscoped)).toBe(true)
  })

  it('legacy scoped shows only the active project (today exactly)', () => {
    expect(isTerminalInScope(APP, legacyScoped)).toBe(true)
    expect(isTerminalInScope(LIB, legacyScoped)).toBe(false)
    expect(isTerminalInScope(undefined, legacyScoped)).toBe(false)
  })

  it('single-root scope is byte-identical to the legacy scoped decision', () => {
    for (const root of [APP, LIB, OTHER, undefined]) {
      expect(isTerminalInScope(root, singleRootScope)).toBe(isTerminalInScope(root, legacyScoped))
    }
  })

  it('multi-root scope shows terminals from every scope root', () => {
    expect(isTerminalInScope(APP, multiRootScope)).toBe(true)
    expect(isTerminalInScope(LIB, multiRootScope)).toBe(true)
    expect(isTerminalInScope(OTHER, multiRootScope)).toBe(false)
    expect(isTerminalInScope(undefined, multiRootScope)).toBe(false)
  })

  it('an EMPTY scope falls back to the legacy binding (boot-time empty scope must not hide every tab)', () => {
    const emptyUnscoped: TerminalScopeState = { scopeRoots: [], activeProjectRoot: null }
    const emptyScoped: TerminalScopeState = { scopeRoots: [], activeProjectRoot: APP }
    expect(isTerminalInScope(APP, emptyUnscoped)).toBe(true)
    expect(isTerminalInScope(LIB, emptyScoped)).toBe(false)
    expect(isTerminalInScope(APP, emptyScoped)).toBe(true)
  })

  it('scope roots that left the set hide their tabs (visibility only — never a PTY decision)', () => {
    const shrunk: TerminalScopeState = {
      scopeRoots: [entry({ rootPath: APP, primary: true })],
      activeProjectRoot: APP,
    }
    expect(isTerminalInScope(LIB, multiRootScope)).toBe(true)
    expect(isTerminalInScope(LIB, shrunk)).toBe(false)
  })
})

describe('hasLiveTabInScope', () => {
  it('exited tabs never count as live (#439)', () => {
    expect(hasLiveTabInScope([{ projectRoot: APP, exited: true }], multiRootScope)).toBe(false)
    expect(hasLiveTabInScope([{ projectRoot: APP, exited: false }], multiRootScope)).toBe(true)
  })

  it('a live tab out of scope does not satisfy the reveal guard', () => {
    expect(hasLiveTabInScope([{ projectRoot: OTHER, exited: false }], multiRootScope)).toBe(false)
    expect(hasLiveTabInScope([{ projectRoot: LIB, exited: false }], multiRootScope)).toBe(true)
  })

  it('legacy unscoped matches the pre-scope hasLiveVisibleTab semantics', () => {
    expect(hasLiveTabInScope([{ projectRoot: undefined, exited: false }], legacyUnscoped)).toBe(
      true,
    )
    expect(hasLiveTabInScope([], legacyUnscoped)).toBe(false)
  })
})

describe('unscopedTabAction (#1024 — the boot shell vs. the first project)', () => {
  const userTab = { kind: 'user' as const, projectRoot: undefined, interacted: false, exited: false }

  it('adopts an unscoped USER shell the user typed into (their work stays reachable)', () => {
    expect(unscopedTabAction({ ...userTab, interacted: true }, APP)).toBe('adopt')
  })

  it('disposes a pristine unscoped shell (nothing worth keeping; no silent PTY leak)', () => {
    expect(unscopedTabAction(userTab, APP)).toBe('dispose')
  })

  it('disposes an unscoped shell that already exited, even if it was used', () => {
    expect(unscopedTabAction({ ...userTab, interacted: true, exited: true }, APP)).toBe('dispose')
  })

  it('keeps already-scoped tabs untouched (ADR-002 scoping is not adoption)', () => {
    expect(unscopedTabAction({ ...userTab, projectRoot: LIB, interacted: true }, APP)).toBe('keep')
    expect(unscopedTabAction({ ...userTab, projectRoot: APP }, APP)).toBe('keep')
  })

  it('keeps agent tabs untouched (their scoping belongs to the thread layer)', () => {
    expect(unscopedTabAction({ ...userTab, kind: 'agent', interacted: true }, APP)).toBe('keep')
  })

  it('no project activating → nothing to settle', () => {
    expect(unscopedTabAction({ ...userTab, interacted: true }, null)).toBe('keep')
  })
})

describe('tabProjectName', () => {
  it('multi-root scope: every visible tab carries its project name', () => {
    expect(tabProjectName(APP, multiRootScope)).toBe('app')
    expect(tabProjectName(LIB, multiRootScope)).toBe('lib')
  })

  it('single-root scope and legacy: no dots, ever (NFR1)', () => {
    expect(tabProjectName(APP, singleRootScope)).toBeNull()
    expect(tabProjectName(APP, legacyScoped)).toBeNull()
    expect(tabProjectName(APP, legacyUnscoped)).toBeNull()
  })

  it('unowned or out-of-scope roots get no accent', () => {
    expect(tabProjectName(undefined, multiRootScope)).toBeNull()
    expect(tabProjectName(OTHER, multiRootScope)).toBeNull()
  })
})

describe('newTerminalMenu', () => {
  it('multi-root scope: one row per available root, primary first', () => {
    expect(newTerminalMenu(multiRootScope)).toEqual([
      { rootPath: APP, name: 'app' },
      { rootPath: LIB, name: 'lib' },
    ])
  })

  it('omits unavailable roots', () => {
    const state: TerminalScopeState = {
      scopeRoots: [
        entry({ rootPath: APP, primary: true }),
        entry({ rootPath: LIB, available: false }),
        entry({ rootPath: OTHER }),
      ],
      activeProjectRoot: APP,
    }
    expect(newTerminalMenu(state)).toEqual([
      { rootPath: APP, name: 'app' },
      { rootPath: OTHER, name: 'other' },
    ])
  })

  it('no menu when fewer than two roots are available (single-root + keeps today\'s behavior)', () => {
    expect(newTerminalMenu(singleRootScope)).toBeNull()
    expect(newTerminalMenu(legacyScoped)).toBeNull()
    const oneAvailable: TerminalScopeState = {
      scopeRoots: [entry({ rootPath: APP, primary: true }), entry({ rootPath: LIB, available: false })],
      activeProjectRoot: APP,
    }
    expect(newTerminalMenu(oneAvailable)).toBeNull()
  })
})

describe('defaultNewTerminalRoot', () => {
  it('undefined when the scope layer is not in charge (legacy path takes over)', () => {
    expect(defaultNewTerminalRoot(legacyScoped)).toBeUndefined()
    expect(defaultNewTerminalRoot({ scopeRoots: [], activeProjectRoot: APP })).toBeUndefined()
  })

  it('primary root when available', () => {
    expect(defaultNewTerminalRoot(multiRootScope)).toBe(APP)
  })

  it('falls to the first available root when the primary is unavailable', () => {
    const state: TerminalScopeState = {
      scopeRoots: [
        entry({ rootPath: APP, primary: true, available: false }),
        entry({ rootPath: LIB }),
      ],
      activeProjectRoot: APP,
    }
    expect(defaultNewTerminalRoot(state)).toBe(LIB)
  })

  it('primary anyway when nothing is available (main owns the cwd fallback)', () => {
    const state: TerminalScopeState = {
      scopeRoots: [
        entry({ rootPath: APP, primary: true, available: false }),
        entry({ rootPath: LIB, available: false }),
      ],
      activeProjectRoot: APP,
    }
    expect(defaultNewTerminalRoot(state)).toBe(APP)
  })
})

describe("a thread's checkout does not hide the project's own shells (phase 5.7)", () => {
  const CHECKOUT = '/work/.app-threads/t1'
  /** The scope of a thread that owns a checkout: its worktree is the primary
   *  root and the project's own tree is NOT in the set. */
  const worktreeScope: TerminalScopeState = {
    scopeRoots: [entry({ rootPath: CHECKOUT, primary: true })],
    activeProjectRoot: APP,
  }

  it('keeps a shell opened in the project visible beside the thread’s own', () => {
    // Phase 6 decided running terminals never move — they get tagged with the
    // tree they are in. A tag on a tab the strip has hidden is no tag at all.
    expect(isTerminalInScope(CHECKOUT, worktreeScope)).toBe(true)
    expect(isTerminalInScope(APP, worktreeScope)).toBe(true)
  })

  it('does not make every other tree visible', () => {
    expect(isTerminalInScope(OTHER, worktreeScope)).toBe(false)
    expect(isTerminalInScope(undefined, worktreeScope)).toBe(false)
  })

  it('names the displaced tree only when a checkout displaced it', () => {
    expect(displacedProjectRoot(worktreeScope)).toBe(APP)
    // Every state that existed before thread worktrees: nothing displaced.
    expect(displacedProjectRoot(singleRootScope)).toBeNull()
    expect(displacedProjectRoot(multiRootScope)).toBeNull()
    expect(displacedProjectRoot(legacyScoped)).toBeNull()
    expect(displacedProjectRoot(legacyUnscoped)).toBeNull()
  })

  it('changes nothing for a thread without a checkout (the degenerate guard)', () => {
    for (const root of [APP, LIB, OTHER, undefined]) {
      expect(isTerminalInScope(root, singleRootScope)).toBe(isTerminalInScope(root, legacyScoped))
    }
  })

  // A REVERSAL, FOUND IN USE. This block used to assert that a live shell in
  // the PROJECT's tree keeps the panel from auto-starting one — and it does
  // keep it visible, which is right. But reveal was asking the visibility
  // question, so opening the panel on a thread whose branch was `ACME-2778-…`
  // started nothing and left the person at a prompt in the project's tree, on
  // the project's branch, in a tab named the same way in both trees.
  it('shows the project’s shell but does not let it answer for the thread’s tree', () => {
    const projectShell = [{ projectRoot: APP, exited: false }]
    expect(hasLiveTabInScope(projectShell, worktreeScope)).toBe(true) // still visible
    expect(hasLiveTabInThreadTree(projectShell, worktreeScope)).toBe(false) // still needs one
  })

  it('is satisfied by a shell in the thread’s own checkout', () => {
    expect(
      hasLiveTabInThreadTree([{ projectRoot: CHECKOUT, exited: false }], worktreeScope),
    ).toBe(true)
    expect(
      hasLiveTabInThreadTree([{ projectRoot: CHECKOUT, exited: true }], worktreeScope),
    ).toBe(false)
  })

  it('separates “mine” from “merely visible”, and only where a checkout exists', () => {
    // The whole distinction, in one place: the project's tree is VISIBLE under
    // a worktree scope and is not the thread's. Everywhere else the two tests
    // are the same test.
    expect(isTerminalInScope(APP, worktreeScope)).toBe(true)
    expect(isTerminalInThreadTree(APP, worktreeScope)).toBe(false)
    expect(isTerminalInThreadTree(CHECKOUT, worktreeScope)).toBe(true)
    for (const scope of [singleRootScope, multiRootScope, legacyScoped, legacyUnscoped]) {
      for (const root of [APP, LIB, OTHER, undefined]) {
        expect(isTerminalInThreadTree(root, scope)).toBe(isTerminalInScope(root, scope))
      }
    }
  })

  it('asks exactly the old question wherever nothing is displaced', () => {
    // The degenerate guard: with no thread checkout there is no displaced tree,
    // so the two predicates cannot disagree and nothing changes for anybody.
    for (const scope of [singleRootScope, multiRootScope, legacyScoped, legacyUnscoped]) {
      for (const root of [APP, LIB, OTHER, undefined]) {
        const tabs = [{ projectRoot: root, exited: false }]
        expect(hasLiveTabInThreadTree(tabs, scope)).toBe(hasLiveTabInScope(tabs, scope))
      }
    }
  })
})

// ── What the tab calls the folder ────────────────────────────────────────────
describe('terminalCwdLabel', () => {
  const CHECKOUT = '/Users/me/Projects/.orbit-app-threads/b3fe4467-2ffb-4b6a-9539-dfbc10bef52a'
  const scope = (): TerminalScopeState => ({
    activeProjectRoot: '/Users/me/Projects/orbit-app',
    scopeRoots: [entry({ rootPath: CHECKOUT, name: 'orbit-app', primary: true })],
  })

  it('names a thread checkout by its project, never by the thread id', () => {
    // The tab followed the shell's cwd and printed its last path segment, which
    // for a worktree is a UUID (user, 2026-09-17).
    expect(terminalCwdLabel(CHECKOUT, scope())).toBe('orbit-app')
    expect(terminalCwdLabel(CHECKOUT, scope())).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i)
  })

  it('shows the folder itself once the shell has moved deeper', () => {
    // Renaming every path under the checkout would hide where somebody just
    // navigated to, which is the one thing this label is for.
    expect(terminalCwdLabel(`${CHECKOUT}/src/main`, scope())).toBe('main')
  })

  it('falls back to the last segment for anything the scope does not know', () => {
    expect(terminalCwdLabel('/Users/me/elsewhere/thing', scope())).toBe('thing')
    expect(terminalCwdLabel('/', scope())).toBe('/')
  })
})

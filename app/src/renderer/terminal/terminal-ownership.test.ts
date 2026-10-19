// Each conversation is its own context: a user shell belongs to the
// conversation (or project view) it was opened in, and is shown only while
// that scope is on screen. Pure decisions from terminal-scope.ts.
import type { TerminalOwner, ThreadScopeEntry } from '../../shared/ipc-contract'
import {
  claimOwnerFor,
  closeActiveTerminalAction,
  hasLiveShellHere,
  isTerminalMine,
  isTerminalShown,
  ownerSpawnOverride,
  restoreSpawnRoot,
  restoredCustomTitle,
  sameOwner,
  type TerminalIdentity,
  type TerminalScopeState,
} from './terminal-scope'

const APP = '/work/app'
const CHECKOUT_A = '/work/.app-threads/a'

function entry(rootPath: string, extra: Partial<ThreadScopeEntry> = {}): ThreadScopeEntry {
  return { rootId: rootPath, rootPath, name: 'app', primary: true, available: true, ...extra }
}

const A: TerminalOwner = { rootPath: APP, threadId: 'a' }
const B: TerminalOwner = { rootPath: APP, threadId: 'b' }
const PROJECT: TerminalOwner = { rootPath: APP, threadId: null }

function user(owner: TerminalOwner | undefined, projectRoot: string = APP): TerminalIdentity {
  return { kind: 'user', projectRoot, ...(owner === undefined ? {} : { owner }) }
}

function onScreen(owner: TerminalOwner | null, roots: ThreadScopeEntry[] = [entry(APP)]): TerminalScopeState {
  return {
    scopeRoots: roots,
    activeProjectRoot: APP,
    ownerScope: owner,
    scopeThreadId: owner?.threadId ?? null,
  }
}

describe('isTerminalShown — user shells follow their conversation', () => {
  it('shows a shell only while the scope it was opened in is on screen', () => {
    expect(isTerminalShown(user(A), onScreen(A))).toBe(true)
    expect(isTerminalShown(user(A), onScreen(B))).toBe(false)
    expect(isTerminalShown(user(A), onScreen(PROJECT))).toBe(false)
    expect(isTerminalShown(user(PROJECT), onScreen(PROJECT))).toBe(true)
    expect(isTerminalShown(user(PROJECT), onScreen(A))).toBe(false)
  })

  it('hides every owned shell while no project is active', () => {
    expect(isTerminalShown(user(A), onScreen(null, []))).toBe(false)
  })

  it('a same-named thread in another project is another scope', () => {
    expect(isTerminalShown(user({ rootPath: '/work/lib', threadId: 'a' }), onScreen(A))).toBe(false)
  })

  it('ignores the root for an owned shell — a worktree thread’s shell is still the thread’s', () => {
    const roots = [entry(CHECKOUT_A)]
    expect(isTerminalShown(user(A, CHECKOUT_A), onScreen(A, roots))).toBe(true)
    // …and the project's own shell is NOT shown in the thread any more, even
    // though its tree is the thread's displaced project root.
    expect(isTerminalShown(user(PROJECT, APP), onScreen(A, roots))).toBe(false)
  })

  it('before the scope on screen is known, falls back to the root rule', () => {
    const unknown: TerminalScopeState = { scopeRoots: [entry(APP)], activeProjectRoot: APP }
    expect(isTerminalShown(user(A), unknown)).toBe(true)
    expect(isTerminalShown(user(A, '/work/lib'), unknown)).toBe(false)
  })

  it('agent terminals and unowned shells keep the root rule', () => {
    const agent: TerminalIdentity = { kind: 'agent', projectRoot: APP }
    expect(isTerminalShown(agent, onScreen(A))).toBe(true)
    expect(isTerminalShown(agent, onScreen(B))).toBe(true)
    expect(isTerminalShown(user(undefined), onScreen(B))).toBe(true)
    expect(isTerminalShown({ kind: 'user', projectRoot: undefined }, onScreen(B))).toBe(false)
  })
})

describe('isTerminalMine / hasLiveShellHere — what auto-start counts', () => {
  it('another conversation’s live shell does not stop this one getting its own', () => {
    const tabs = [{ ...user(A), exited: false }]
    expect(hasLiveShellHere(tabs, onScreen(A))).toBe(true)
    expect(hasLiveShellHere(tabs, onScreen(B))).toBe(false)
    expect(isTerminalMine(user(A), onScreen(B))).toBe(false)
  })

  it('an exited shell is not live', () => {
    expect(hasLiveShellHere([{ ...user(A), exited: true }], onScreen(A))).toBe(false)
  })

  it('an agent tab in the same tree is not this conversation’s shell — it must not block the restore', () => {
    const agent = { kind: 'agent' as const, projectRoot: APP, exited: false }
    // Positive first (allowed-pattern #28): the agent tab IS on screen and in
    // the thread's tree, which is exactly why counting it used to answer yes.
    expect(isTerminalShown(agent, onScreen(A))).toBe(true)
    expect(isTerminalMine(agent, onScreen(A))).toBe(true)
    expect(hasLiveShellHere([agent], onScreen(A))).toBe(false)
    expect(hasLiveShellHere([agent, { ...user(A), exited: false }], onScreen(A))).toBe(true)
  })
})

describe('ownerSpawnOverride / restoreSpawnRoot — where a shell for this conversation starts', () => {
  it('the project view starts in the project’s own tree, whatever thread the roots are for', () => {
    const stale: TerminalScopeState = { ...onScreen(PROJECT, [entry(CHECKOUT_A)]), scopeThreadId: 'a' }
    expect(ownerSpawnOverride(stale)).toEqual({ rootPath: APP })
    expect(restoreSpawnRoot(CHECKOUT_A, stale)).toBe(APP)
  })

  it('the project view waits while a selection is in flight — the roots moved to a thread after it came on screen', () => {
    // Settled: main keeps the project's last thread active in the project
    // view, so the scope's thread is 'a', not null — and that must NOT wait.
    const settled: TerminalScopeState = { ...onScreen(PROJECT), scopeThreadId: 'a', projectViewScopeThreadId: 'a' }
    expect(ownerSpawnOverride(settled)).toEqual({ rootPath: APP })
    // Thread B selected: its roots landed before the editor's answer.
    const inFlight: TerminalScopeState = { ...settled, scopeRoots: [entry(CHECKOUT_A)], scopeThreadId: 'b' }
    expect(ownerSpawnOverride(inFlight)).toEqual({ wait: true })
    // A project with no thread at all never waits.
    expect(ownerSpawnOverride({ ...onScreen(PROJECT), projectViewScopeThreadId: null })).toEqual({ rootPath: APP })
    // No baseline yet (boot) → the existing rule.
    expect(ownerSpawnOverride({ ...onScreen(PROJECT), scopeThreadId: 'b' })).toEqual({ rootPath: APP })
  })

  it('a thread waits for its own roots rather than using the previous thread’s', () => {
    const behind: TerminalScopeState = { ...onScreen(B, [entry(CHECKOUT_A)]), scopeThreadId: 'a' }
    expect(ownerSpawnOverride(behind)).toEqual({ wait: true })
    expect(ownerSpawnOverride(onScreen(B))).toBeNull()
    // No scope layer at all → no waiting (the legacy path decides).
    expect(ownerSpawnOverride({ scopeRoots: null, activeProjectRoot: APP, ownerScope: B })).toBeNull()
  })

  it('restores into the saved directory while it is still an available root, else the thread’s default', () => {
    const roots = [entry(CHECKOUT_A)]
    expect(restoreSpawnRoot(CHECKOUT_A, onScreen(A, roots))).toBe(CHECKOUT_A)
    expect(restoreSpawnRoot('/work/.app-threads/renamed-away', onScreen(A, roots))).toBe(CHECKOUT_A)
    expect(restoreSpawnRoot(CHECKOUT_A, onScreen(A, [entry(CHECKOUT_A, { available: false })]))).toBe(CHECKOUT_A)
  })

  it('sameOwner compares both halves', () => {
    expect(sameOwner(A, { rootPath: APP, threadId: 'a' })).toBe(true)
    expect(sameOwner(A, PROJECT)).toBe(false)
  })
})

describe('claimOwnerFor — which conversation adopts a flagged boot shell', () => {
  it('the scope on screen, when it is in the shell’s own project', () => {
    expect(claimOwnerFor({ projectRoot: APP }, A)).toBe(A)
    expect(claimOwnerFor({ projectRoot: APP }, PROJECT)).toBe(PROJECT)
  })

  it('nobody yet — no scope known, no project, or a scope in another project', () => {
    expect(claimOwnerFor({ projectRoot: APP }, undefined)).toBeNull()
    expect(claimOwnerFor({ projectRoot: APP }, null)).toBeNull()
    expect(claimOwnerFor({ projectRoot: APP }, { rootPath: '/work/lib', threadId: 'a' })).toBeNull()
    expect(claimOwnerFor({ projectRoot: undefined }, A)).toBeNull()
  })
})

describe('closeActiveTerminalAction — what ⌘W does', () => {
  it('closes a person’s shell, PTY and all', () => {
    expect(closeActiveTerminalAction('user')).toBe('dispose')
  })

  it('only takes an agent tab off the strip — it never kills the agent’s command', () => {
    expect(closeActiveTerminalAction('agent')).toBe('hide')
  })
})

describe('restoredCustomTitle — a renamed shell comes back under its name', () => {
  it('is the saved title when a person gave it one', () => {
    expect(restoredCustomTitle({ title: 'server', cwd: CHECKOUT_A })).toBe('server')
  })

  it('is nothing when the saved title is just the folder’s name', () => {
    expect(restoredCustomTitle({ title: 'a', cwd: CHECKOUT_A })).toBeUndefined()
    expect(restoredCustomTitle({ title: 'a', cwd: `${CHECKOUT_A}/` })).toBeUndefined()
    expect(restoredCustomTitle({ title: '/', cwd: '/' })).toBeUndefined()
    expect(restoredCustomTitle({ title: '', cwd: APP })).toBeUndefined()
  })
})

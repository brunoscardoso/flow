/**
 * Thread-scope decisions for the terminal panel (multi-project threads
 * Phase 5) — DOM-free and unit-testable.
 *
 * The panel consumes the thread-scope layer (allowed-pattern #14: one scope
 * source of truth): a tab is visible when its terminal's projectRoot is in
 * the active thread scope's root set. Until the first scope lands — and
 * forever if the scope API is unavailable — the legacy activeProjectRoot
 * binding (ADR-002) stays in charge, and a single-root scope reproduces it
 * byte-identically (the degenerate regression guard). Scope changes NEVER
 * touch PTYs — visibility only; background shells keep running.
 */
import type {
  SavedTerminalRef,
  TerminalKind,
  TerminalOwner,
  ThreadScopeEntry,
} from '../../shared/ipc-contract'

/** The panel's current scoping inputs, in fallback order. */
export interface TerminalScopeState {
  /** The active thread scope's roots, primary first — null until the scope
   *  layer delivers one (legacy binding in charge). An EMPTY root set also
   *  falls back to the legacy binding, mirroring the git panel's
   *  resolvePanelState — a boot-time empty scope must not hide every tab. */
  scopeRoots: readonly ThreadScopeEntry[] | null
  /** Legacy active project (ADR-002) — the fail-soft fallback.
   *  null → unscoped: every terminal is visible. */
  activeProjectRoot: string | null
  /**
   * The conversation on screen — the editor's tab scope (`flow:tab-scope`):
   * a thread in a project, or `threadId: null` for the project view. null
   * when no project is active; undefined until the first one is known (the
   * root-based rules above stay in charge until then).
   */
  ownerScope?: TerminalOwner | null
  /** The thread the scope layer's `scopeRoots` were derived for (undefined
   *  until a scope lands). Lets a spawn wait for the roots of the thread it
   *  is for, rather than use the roots of the one being left. */
  scopeThreadId?: string | null
  /**
   * The thread the scope layer was on when the PROJECT VIEW came on screen
   * (undefined until both are known). Main keeps a project's last thread
   * active when the person goes back to the project view, so the scope's
   * threadId is that thread, not null — what signals a selection in flight is
   * the scope MOVING away from this baseline.
   */
  projectViewScopeThreadId?: string | null
}

/** What the ownership rules need to know about one terminal. */
export interface TerminalIdentity {
  kind: TerminalKind
  projectRoot: string | undefined
  /** The scope a user shell was opened in (absent: agent tabs, boot shells). */
  owner?: TerminalOwner
}

export function sameOwner(a: TerminalOwner, b: TerminalOwner): boolean {
  return a.rootPath === b.rootPath && a.threadId === b.threadId
}

/** True when this terminal is decided by OWNERSHIP rather than by its root:
 *  a user shell that knows its owner, once the scope on screen is known. */
function ownershipDecides(
  tab: TerminalIdentity,
  state: TerminalScopeState,
): tab is TerminalIdentity & { owner: TerminalOwner } {
  return tab.kind === 'user' && tab.owner !== undefined && state.ownerScope !== undefined
}

/**
 * Is this terminal on the strip right now?
 *
 * EACH CONVERSATION IS ITS OWN CONTEXT (user, 2026-10-01: "your terminals
 * too"). A shell a person opened belongs to the conversation — or the project
 * view — it was opened in, and is shown only while that scope is on screen.
 * Switching away hides it; nothing is killed, so a command running in thread
 * A keeps running and is there with its scrollback when A is selected again.
 *
 * Agent terminals, and shells that predate ownership (the boot shell), keep
 * the root-based rule (`isTerminalInScope`) exactly as before.
 */
export function isTerminalShown(tab: TerminalIdentity, state: TerminalScopeState): boolean {
  if (ownershipDecides(tab, state)) {
    return state.ownerScope !== null && state.ownerScope !== undefined && sameOwner(tab.owner, state.ownerScope)
  }
  return isTerminalInScope(tab.projectRoot, state)
}

/**
 * Is this terminal the current conversation's OWN — the question auto-start
 * and switch arrival ask? For an owned shell, shown and mine are the same
 * thing; everything else keeps `isTerminalInThreadTree`.
 */
export function isTerminalMine(tab: TerminalIdentity, state: TerminalScopeState): boolean {
  if (ownershipDecides(tab, state)) return isTerminalShown(tab, state)
  return isTerminalInThreadTree(tab.projectRoot, state)
}

/** Whether the conversation on screen already has a live SHELL of its own —
 *  the guard before restoring or auto-starting one. Agent tabs never count:
 *  another thread's agent tab in the same tree is not this conversation's
 *  shell, and counting it skipped the restore of the shells it had saved. */
export function hasLiveShellHere(
  tabs: readonly (TerminalIdentity & { exited: boolean })[],
  state: TerminalScopeState,
): boolean {
  return tabs.some(
    (tab) => tab.kind === 'user' && !tab.exited && isTerminalShown(tab, state) && isTerminalMine(tab, state),
  )
}

/**
 * Where a shell opened for the conversation on screen should start, before the
 * usual scope rules (`defaultNewTerminalRoot`) are asked:
 *
 *  - `{ wait: true }` — the scope on screen and the scope roots disagree (the
 *    two signals arrive in no fixed order). For a THREAD: the roots still
 *    belong to another one, and spawning now would put this thread's shell in
 *    the previous thread's checkout. For the PROJECT VIEW: the roots have
 *    moved to a thread since it came on screen — a selection is in flight,
 *    and the editor's answer is about to replace the project view. Either
 *    way the next arrival asks again.
 *  - `{ rootPath }` — the PROJECT VIEW, settled: its shells live in the
 *    project's own tree, whatever thread the scope layer last derived.
 *  - null — no override; the scope / legacy rules decide.
 */
export function ownerSpawnOverride(
  state: TerminalScopeState,
): { wait: true } | { rootPath: string } | null {
  const owner = state.ownerScope
  if (owner === undefined || owner === null) return null
  if (owner.threadId === null) {
    return projectViewSelectionInFlight(state) ? { wait: true } : { rootPath: owner.rootPath }
  }
  if (scopeDriven(state) && state.scopeThreadId !== undefined && state.scopeThreadId !== owner.threadId) {
    return { wait: true }
  }
  return null
}

/**
 * True when the project view is on screen but the scope layer has since moved
 * to a different thread — the thread-scope half of a selection whose editor
 * half has not landed yet. NOT "the scope's thread is not null": main keeps a
 * project's last thread active in the project view, so that test would make
 * the project view wait for ever.
 */
function projectViewSelectionInFlight(state: TerminalScopeState): boolean {
  const baseline = state.projectViewScopeThreadId
  const current = state.scopeThreadId
  if (baseline === undefined || current === undefined || current === null) return false
  return current !== baseline
}

/** True when the scope layer is in charge (a non-empty scope has landed). */
function scopeDriven(state: TerminalScopeState): state is TerminalScopeState & {
  scopeRoots: readonly ThreadScopeEntry[]
} {
  return state.scopeRoots !== null && state.scopeRoots.length > 0
}

/**
 * The project's OWN tree, when a thread's checkout has displaced it from the
 * scope (thread-worktrees Phase 5, task 5.7). Null when there is nothing
 * displaced — which is every state that existed before thread worktrees.
 *
 * A thread with a checkout reports THAT as its primary root, so the project's
 * own tree is no longer a scope root. For most surfaces that is exactly right:
 * the editor shows the thread's copy, the git panel commits to it, and the
 * agent may not address anything else (Phase 3.5's gate is deliberately
 * narrower still, and this does NOT widen it — nothing here decides what may
 * be written to).
 *
 * For the terminal strip it is wrong, and it makes the plan's own decision
 * unkeepable. Phase 6 settled that running terminals never move; they get
 * TAGGED with the tree they are in (discovery OQ 4). A shell opened from the
 * project before the thread existed is still running in the project's tree —
 * and plain scope visibility hides its tab, so the tag Phase 6 wrote for it is
 * a tag on something nobody can see. A shell that is alive, reachable a moment
 * ago, and now absent from the strip is worse than an untagged one.
 *
 * So the strip keeps the project's own tree visible. It is a VISIBILITY answer
 * only: nothing else in the app reads this, and it grants no access to anything
 * — the tab was already there and its shell was already running.
 */
export function displacedProjectRoot(state: TerminalScopeState): string | null {
  if (!scopeDriven(state)) return null
  const project = state.activeProjectRoot
  if (project === null) return null
  // Not displaced at all when the project IS a scope root — which is the case
  // for every thread without a checkout, so this returns null and the answer
  // below is byte-identical to what it was before worktrees existed.
  return state.scopeRoots.some((root) => root.rootPath === project) ? null : project
}

/**
 * Visibility decision: scope-driven → the terminal's root must be IN the
 * scope's root set (a single-root scope therefore behaves exactly like
 * today's `projectRoot === activeProjectRoot`), or be the project's own tree
 * that a thread's checkout displaced from it (see `displacedProjectRoot`);
 * legacy → unscoped shows all, scoped shows the active project's terminals
 * only.
 */
export function isTerminalInScope(
  projectRoot: string | undefined,
  state: TerminalScopeState,
): boolean {
  if (scopeDriven(state)) {
    if (projectRoot === undefined) return false
    return (
      state.scopeRoots.some((root) => root.rootPath === projectRoot) ||
      displacedProjectRoot(state) === projectRoot
    )
  }
  return state.activeProjectRoot === null || projectRoot === state.activeProjectRoot
}

/** Whether any tab is a LIVE (visible, not exited) shell under the current
 *  scope — visibility only. NOT the auto-start question: see
 *  `hasLiveTabInThreadTree`. */
export function hasLiveTabInScope(
  tabs: readonly { projectRoot: string | undefined; exited: boolean }[],
  state: TerminalScopeState,
): boolean {
  return tabs.some((tab) => !tab.exited && isTerminalInScope(tab.projectRoot, state))
}

/**
 * Whether this thread's OWN trees already have a live shell — the question
 * panel reveal actually has to answer before auto-starting one (#439).
 *
 * VISIBLE IS NOT THE SAME AS MINE, and conflating them is a wrong-branch bug
 * rather than a cosmetic one. A shell left running in the project's own tree
 * stays visible after a thread's checkout displaces that tree from the scope
 * (`displacedProjectRoot`) — deliberately, so the person can still reach it.
 * Reveal used to count it as "this thread has a terminal", start nothing, and
 * leave that shell active: someone opening the panel on a thread whose branch
 * is `ACME-2778-…` landed at a prompt sitting on the project's own branch, with
 * a tab labelled the same way in both trees.
 *
 * So auto-start asks about SCOPE ROOTS only. The displaced tab is still shown
 * and still reachable; it just no longer answers for a tree it is not in.
 */
export function hasLiveTabInThreadTree(
  tabs: readonly { projectRoot: string | undefined; exited: boolean }[],
  state: TerminalScopeState,
): boolean {
  return tabs.some((tab) => !tab.exited && isTerminalInThreadTree(tab.projectRoot, state))
}

/**
 * Is this shell in one of the thread's OWN trees — as opposed to merely
 * visible, which also covers the project tree its checkout displaced?
 *
 * The two questions differ only while a thread has a checkout, and everywhere
 * else this is `isTerminalInScope` exactly.
 */
export function isTerminalInThreadTree(
  projectRoot: string | undefined,
  state: TerminalScopeState,
): boolean {
  if (!scopeDriven(state)) return isTerminalInScope(projectRoot, state)
  if (projectRoot === undefined) return false
  return state.scopeRoots.some((root) => root.rootPath === projectRoot)
}

/**
 * The project name a visible tab's accent dot/tooltip should carry — only in
 * a MULTI-root scope (two or more scope roots). Single-root scope and the
 * legacy binding return null for every tab: no dots, byte-identical to today
 * (NFR1). A tab whose root is not a scope root (impossible for a visible tab,
 * but total anyway) also gets none.
 */
export function tabProjectName(
  projectRoot: string | undefined,
  state: TerminalScopeState,
): string | null {
  if (!scopeDriven(state) || state.scopeRoots.length < 2 || projectRoot === undefined) {
    return null
  }
  const entry = state.scopeRoots.find((root) => root.rootPath === projectRoot)
  return entry ? entry.name : null
}

/**
 * What a tab should call the folder its shell is sitting in.
 *
 * A THREAD'S CHECKOUT IS A UUID ON DISK. The tab follows the shell's cwd (OSC
 * 7) and printed its last path segment, which for a worktree is the thread's
 * id — `b3fe4467-2ffb-4b6a-9539-dfbc10bef52a` on a tab two inches wide (user,
 * 2026-09-17: "on the terminal, we should show the name of the worktree, not
 * that UUID"). The scope already carries the name for exactly this reason: the
 * checkout is lent its project's record, and that record states a name the path
 * cannot.
 *
 * Only the root itself is renamed. A shell that has `cd`-ed somewhere deeper
 * shows that folder, which is what a person navigating wants to see.
 */
export function terminalCwdLabel(path: string, state: TerminalScopeState): string | null {
  const trimmed = path.replace(/\/+$/, '')
  if (trimmed === '') return '/'
  const named = state.scopeRoots?.find((root) => root.rootPath === trimmed)
  if (named !== undefined && named.name.trim() !== '') return named.name
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return base.length > 0 ? base : null
}

/**
 * The conversation an unowned shell flagged for adoption should be claimed by
 * NOW — or null to keep the flag until one arrives. Only a scope in the shell's
 * own project qualifies: a flag set by one project's activation must never be
 * answered by a conversation in another (a quick switch), and a flag left
 * standing because the scope was ALREADY on screen must not wait for the next
 * conversation, which is a different one.
 */
export function claimOwnerFor(
  tab: { projectRoot?: string | undefined },
  ownerScope: TerminalOwner | null | undefined,
): TerminalOwner | null {
  if (ownerScope === undefined || ownerScope === null) return null
  return tab.projectRoot === ownerScope.rootPath ? ownerScope : null
}

/**
 * What ⌘W does to the focused terminal. A person's shell is closed the way the
 * tab's ✕ closes it — the PTY goes too, or it would run unreachable and come
 * back with its conversation after a restart. An agent tab is only taken off
 * the strip: its PTY is running the agent's command, and a keystroke meant to
 * close a tab must not SIGKILL that.
 */
export function closeActiveTerminalAction(kind: TerminalKind): 'dispose' | 'hide' {
  return kind === 'user' ? 'dispose' : 'hide'
}

/**
 * The automatic title main gives a shell opened in `cwd` — the folder name.
 * Mirrors `createUserTerminal`'s `basename(cwd) || cwd`.
 */
function automaticShellTitle(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '')
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return base.length > 0 ? base : cwd
}

/**
 * The name a person gave a saved shell, or undefined when it carries only the
 * automatic one. Main saves `customTitle ?? title`; a saved title that is not
 * the folder's own name can only be a rename.
 */
export function restoredCustomTitle(ref: SavedTerminalRef): string | undefined {
  return ref.title.length > 0 && ref.title !== automaticShellTitle(ref.cwd) ? ref.title : undefined
}

/**
 * What to do with an UNSCOPED tab when a project becomes active (#1024). The
 * boot shell auto-starts before any project exists (`projectRoot: undefined`);
 * plain ADR-002 scoping would hide it forever — unscoped tabs are only visible
 * while no project is active, a state the UI never returns to — leaving its
 * PTY (and anything the user started in it) alive but unreachable.
 *
 *  - 'adopt'   — a live shell the user actually typed into: re-home it to the
 *                activating project so their work stays reachable.
 *  - 'dispose' — a pristine (never-touched) or exited unscoped shell carries
 *                nothing worth keeping; dispose the PTY so it can't leak
 *                alive-but-unreachable in the main process.
 *  - 'keep'    — scoped tabs, agent tabs, or no project activating: untouched.
 */
export type UnscopedTabAction = 'adopt' | 'dispose' | 'keep'

export function unscopedTabAction(
  tab: {
    kind: 'user' | 'agent'
    projectRoot: string | undefined
    interacted: boolean
    exited: boolean
  },
  activatingRoot: string | null,
): UnscopedTabAction {
  if (activatingRoot === null || tab.projectRoot !== undefined || tab.kind !== 'user') {
    return 'keep'
  }
  return tab.interacted && !tab.exited ? 'adopt' : 'dispose'
}

/** One row of the + button's "New terminal in:" menu. */
export interface NewTerminalMenuItem {
  rootPath: string
  name: string
}

/**
 * Menu model for the + button under a thread scope: one row per AVAILABLE
 * attached root, primary first (scope order is already primary-first —
 * preserved). null → no menu: fewer than two available roots means + spawns
 * directly (single-root scope keeps today's exact behavior).
 */
export function newTerminalMenu(
  state: TerminalScopeState,
): NewTerminalMenuItem[] | null {
  if (!scopeDriven(state)) {
    return null
  }
  const available = state.scopeRoots.filter((root) => root.available)
  if (available.length < 2) {
    return null
  }
  return available.map(({ rootPath, name }) => ({ rootPath, name }))
}

/**
 * Where a direct (menu-less) new terminal spawns under a thread scope: the
 * primary root when available, else the first available root, else the
 * primary root anyway (main owns the cwd-missing fallback). undefined only
 * when not scope-driven — the caller then uses the legacy path.
 */
export function defaultNewTerminalRoot(state: TerminalScopeState): string | undefined {
  if (!scopeDriven(state)) {
    return undefined
  }
  const primary = state.scopeRoots.find((root) => root.primary)
  if (primary?.available) {
    return primary.rootPath
  }
  return state.scopeRoots.find((root) => root.available)?.rootPath ?? state.scopeRoots[0].rootPath
}

/**
 * Where a saved shell is re-spawned after a restart: the directory it was
 * opened in when that is still one of the conversation's available roots (or,
 * for the project view, the project itself) — else wherever a new shell for
 * this conversation would go. A checkout that was renamed or removed must not
 * turn a restore into a failed spawn.
 */
export function restoreSpawnRoot(cwd: string, state: TerminalScopeState): string | undefined {
  const override = ownerSpawnOverride(state)
  if (override !== null && 'rootPath' in override) return override.rootPath
  if (scopeDriven(state) && state.scopeRoots.some((root) => root.rootPath === cwd && root.available)) {
    return cwd
  }
  return defaultNewTerminalRoot(state) ?? state.ownerScope?.rootPath ?? state.activeProjectRoot ?? undefined
}

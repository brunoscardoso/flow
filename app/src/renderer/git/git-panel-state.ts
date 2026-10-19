// What the Git panel should show, resolved from the coordinator's state (#289).
//
// The panel is scoped to the ACTIVE project (ADR-002). Previously render() only
// distinguished "has a view" from "no view", so an active root with no view yet —
// whether its status/log refresh was still in flight OR had just failed — fell
// through to setRoots([]) → the misleading "No project roots" empty state. That
// was both wrong (a root IS active) and, on a failed refresh, permanent and silent
// (forbidden pattern #2). It also flashed on every project switch during the IPC
// round-trip. This pure resolver separates the three real states — loading, error,
// and genuinely-empty — so the panel can render each distinctly. DOM-free so it's
// unit-testable under the node jest env; git-panel.ts renders the returned state.
import type { GitMergeState, ThreadScopeEntry } from '../../shared/ipc-contract'
import type { GitRootView } from './git-panel'

/** Per-root refresh lifecycle tracked by the coordinator. */
export type RootLoadStatus = 'loading' | 'error' | 'loaded'

/**
 * The merge/rebase in-progress banner's rendered shape, derived purely from a
 * root's `GitMergeState` (#335, Phase 6). DOM-free so the derivation — visibility,
 * label, and whether "Complete merge" is enabled — is unit-testable.
 */
export interface MergeBannerState {
  /** Show the banner at all — only while a merge/rebase is in progress. */
  visible: boolean
  /** The in-progress operation — drives whether the controls run the merge or
   *  rebase code paths (#571). 'none' only appears on the hidden state. */
  op: GitMergeState['op']
  /** Human label for the operation ('Merge in progress' / 'Rebase in progress'). */
  opLabel: string
  /** Count of still-unresolved conflicted paths. */
  unmergedCount: number
  /** "Complete merge" is enabled only when NO conflicts remain. */
  canComplete: boolean
  /** The prepared commit message handed to `completeMerge` ('' when none). */
  message: string
}

const MERGE_OP_LABELS: Record<GitMergeState['op'], string> = {
  merge: 'Merge in progress',
  rebase: 'Rebase in progress',
  'cherry-pick': 'Cherry-pick in progress',
  stash: 'Stash apply in progress',
  none: '',
}

/**
 * Ops whose complete/abort actions the banner has wired (#571). `getMergeState`
 * now also classifies `cherry-pick` (and reserves `stash`) so the identity
 * pipeline can map conflict sides — but the banner's buttons only speak merge
 * and rebase, so it stays hidden for the others until a later phase wires their
 * `--continue`/`--abort`. Surfacing them here would offer a `git merge --abort`
 * button that errors mid-cherry-pick.
 */
const BANNER_WIRED_OPS: ReadonlySet<GitMergeState['op']> = new Set(['merge', 'rebase'])

/** Derive the merge banner's render state from a root's merge state (null → hidden). */
export function deriveMergeBanner(state: GitMergeState | null | undefined): MergeBannerState {
  if (!state || !BANNER_WIRED_OPS.has(state.op)) {
    return {
      visible: false,
      op: state?.op ?? 'none',
      opLabel: '',
      unmergedCount: 0,
      canComplete: false,
      message: '',
    }
  }
  const unmergedCount = state.unmergedPaths.length
  return {
    visible: true,
    op: state.op,
    opLabel: MERGE_OP_LABELS[state.op],
    unmergedCount,
    canComplete: unmergedCount === 0,
    message: state.mergeMsg ?? '',
  }
}

export type GitPanelState =
  | { kind: 'roots'; views: GitRootView[] }
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'empty' }

/**
 * Stable content signature for a resolved panel render (#1094). The panel
 * rebuilds its whole DOM on every refresh, and refreshes fire on ANY file write
 * — including ones that leave `git status` byte-identical. Comparing this
 * signature lets the panel SKIP the rebuild entirely when nothing it renders
 * from (views + scope) changed, so a no-op background refresh can't yank the
 * user's scroll, keyboard selection, or focus. Every rendered fact lives inside
 * `state`/`scope` (both plain IPC data), so JSON over them is exhaustive by
 * construction; purely-local UI toggles (fold state, branch picker, expanded
 * dirs) re-render through #rerender, which bypasses the signature check.
 */
export function panelRenderSignature(
  state: GitPanelState,
  scope: ThreadScopeEntry[] | null,
): string {
  return JSON.stringify({ state, scope })
}

export interface PanelStateInput {
  activeRoot: string | null
  /**
   * Every root the panel may address, in order — NOT the project
   * list. The two were the same until a thread could own a git worktree: a
   * checkout is never a registered project, so filtering scope roots through
   * the project list rendered "No project open" for a thread that had a whole
   * working tree of its own. The coordinator passes `panelRootDomain(...)`,
   * which is the project list PLUS whatever the scope layer vouched for.
   */
  rootOrder: string[]
  /** ADDITIONAL roots the active thread spans (#45) — a thread working across
   *  two repos (e.g. app + core) surfaces BOTH in source control, not just the
   *  active project. [] when no thread is active or it's single-project. */
  threadRoots?: string[]
  /** The thread-scope layer's ordered root set (multi-project threads Phase 4)
   *  — primary first. When present, it REPLACES the activeRoot+threadRoots
   *  derivation: one view per scope root in scope order. Undefined → the
   *  legacy binding (fail-soft, e.g. when the scope API is unavailable). */
  scopeRoots?: string[]
  viewFor: (rootPath: string) => GitRootView | undefined
  statusFor: (rootPath: string) => RootLoadStatus | undefined
}

export function resolvePanelState(input: PanelStateInput): GitPanelState {
  const { activeRoot, rootOrder, threadRoots = [], scopeRoots, viewFor, statusFor } = input

  // Scope-driven (Phase 4): one section per scope root, in scope order. Roots
  // unknown to the project list (unavailable/missing) or still loading are
  // best-effort skipped — they appear once their refresh lands, and the roots
  // that HAVE data must never wait on them (same contract as the #45 widening).
  if (scopeRoots !== undefined && scopeRoots.length > 0) {
    const views: GitRootView[] = []
    for (const rootPath of scopeRoots) {
      if (!rootOrder.includes(rootPath)) continue
      const view = viewFor(rootPath)
      if (view && !views.includes(view)) views.push(view)
    }
    if (views.length > 0) return { kind: 'roots', views }
    const primary = scopeRoots[0]
    if (statusFor(primary) === 'error') return { kind: 'error' }
    // Any scope root the project list knows (or is refreshing) → loading, never
    // the misleading "No project roots" (#289's rule, scope edition).
    if (
      scopeRoots.some(
        (rootPath) => rootOrder.includes(rootPath) || statusFor(rootPath) === 'loading',
      )
    ) {
      return { kind: 'loading' }
    }
    return { kind: 'empty' }
  }

  // Scoped to the active project (ADR-002), WIDENED by the active thread's
  // additional roots: the active project's section always leads, and each
  // thread root known to the project list renders its own section below.
  if (activeRoot !== null) {
    const view = viewFor(activeRoot)
    if (view) {
      const views: GitRootView[] = [view]
      for (const rootPath of threadRoots) {
        if (rootPath === activeRoot) continue
        if (!rootOrder.includes(rootPath)) continue
        const threadView = viewFor(rootPath)
        // Best-effort: a still-loading/errored thread root is skipped — it
        // appears on the next render once its refresh lands, and the active
        // project's section must never wait on it.
        if (threadView && !views.includes(threadView)) views.push(threadView)
      }
      return { kind: 'roots', views }
    }
    if (statusFor(activeRoot) === 'error') return { kind: 'error' }
    // A known/refreshing root with no data yet is LOADING — never "no roots".
    if (rootOrder.includes(activeRoot) || statusFor(activeRoot) === 'loading') {
      return { kind: 'loading' }
    }
    return { kind: 'empty' }
  }

  // No active project yet (early boot) — fall back to whatever roots have data.
  const views: GitRootView[] = []
  for (const rootPath of rootOrder) {
    const view = viewFor(rootPath)
    if (view) views.push(view)
  }
  if (views.length > 0) return { kind: 'roots', views }
  // Roots exist but none have loaded yet → loading (kills the boot flash);
  // genuinely no roots → the real empty state.
  return rootOrder.length > 0 ? { kind: 'loading' } : { kind: 'empty' }
}

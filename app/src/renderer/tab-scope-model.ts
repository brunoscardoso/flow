/**
 * WHOSE TABS ARE ON SCREEN — the pure half of per-conversation tab sets.
 *
 * Each thread separates the work: the files, unsaved buffers and views opened
 * while one conversation is selected belong to it, and the project keeps its
 * own set while no conversation is selected. The coordinator
 * (`project-context.ts`) owns the DOM and the IPC; every decision about WHICH
 * set a signal means, and what a switch has to save and load, lives here so a
 * test can hold it without a window (allowed-pattern #14).
 */
import type { TabSet } from '../shared/ipc-contract'

/**
 * Broadcast (detail: `TabScopeKey | null`) after the editor settles on a tab
 * set — the surfaces whose views belong to a set (the feature view host)
 * follow it rather than guessing from the thread and project signals, which
 * arrive in no fixed order.
 */
export const TAB_SCOPE_EVENT = 'flow:tab-scope'

/** One tab set's key: a conversation in a project, or (null) the project. */
export interface TabScopeKey {
  rootPath: string
  threadId: string | null
}

export function sameScope(a: TabScopeKey | null, b: TabScopeKey | null): boolean {
  if (a === null || b === null) return a === b
  return a.rootPath === b.rootPath && a.threadId === b.threadId
}

/**
 * The scope a project activation asks for: that project, on the conversation
 * main recorded as its last-active one. Null when no project is active.
 */
export function scopeForProject(
  context: { rootPath: string; activeThreadId: string | null } | null,
): TabScopeKey | null {
  if (context === null) return null
  return { rootPath: context.rootPath, threadId: context.activeThreadId }
}

/**
 * The scope a `flow:active-thread` signal asks for, or null when it asks for
 * nothing the coordinator should act on.
 *
 * A conversation in ANOTHER project is not acted on here: selecting it also
 * activates its project, and that activation arrives carrying the very same
 * conversation — acting twice would rebuild the strip twice, the first time
 * against the wrong project. A clear (`threadId: null`) carries no project and
 * means the project-level set of whatever project is current.
 */
export function scopeForThreadSignal(
  signal: { threadId: string | null; projectRoot?: string | null },
  currentRoot: string | null,
): TabScopeKey | null {
  if (currentRoot === null) return null
  const projectRoot = signal.projectRoot ?? null
  if (projectRoot !== null && projectRoot !== currentRoot) return null
  return { rootPath: currentRoot, threadId: signal.threadId }
}

/** What one switch has to do, in order. */
export type TabSwitchPlan =
  | { kind: 'none' }
  | {
      kind: 'switch'
      /** The outgoing set to save first — null when nothing was on screen. */
      save: { scope: TabScopeKey; set: TabSet } | null
      /** The set to load and show — null for "no project at all". */
      load: TabScopeKey | null
      /** True when the project changes too (the tree, terminals rebind). */
      projectChanges: boolean
    }

/**
 * Plan the move from what is on screen (`shown`, captured as `outgoing`) to
 * what was asked for. Nothing to do when they are the same set. The outgoing
 * set is ALWAYS saved before anything closes — that is what keeps an unsaved
 * buffer from being lost on a switch.
 */
export function planTabSwitch(
  shown: TabScopeKey | null,
  wanted: TabScopeKey | null,
  outgoing: TabSet,
): TabSwitchPlan {
  if (sameScope(shown, wanted)) return { kind: 'none' }
  return {
    kind: 'switch',
    save: shown === null ? null : { scope: shown, set: outgoing },
    load: wanted,
    projectChanges: (shown?.rootPath ?? null) !== (wanted?.rootPath ?? null),
  }
}

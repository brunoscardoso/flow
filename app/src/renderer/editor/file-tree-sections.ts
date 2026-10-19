/**
 * Pure section model for the multi-root files sidebar (multi-project threads
 * Phase 3). Maps the active thread's scope to the list of tree sections the
 * FileTree renders — DOM-free so the single-root no-chrome rule (NFR1: a
 * one-root scope renders EXACTLY today's tree, no section headers, no accent
 * dots) and the fold rules are unit-tested.
 *
 * FOLDING (user, 2026-10-06). A thread with MORE THAN ONE project opens with
 * every project folded — "keep collapsed so the user understands there is
 * more than one folder to open". What the person unfolds or folds afterwards
 * is remembered for as long as that thread stays open (`SectionFoldMemory`),
 * and forgotten when another thread is opened: the next visit starts folded
 * again. It used to be a per-root fold persisted in localStorage, which meant
 * a project unfolded once was unfolded in every thread forever after — and a
 * second project could sit below an open tree of the first, unnoticed.
 */
import type { ThreadScope } from '../../shared/ipc-contract'

/** One collapsible section of the files sidebar — a scope root's view model. */
export interface FileTreeSectionModel {
  /** Project root id (may be '' for a not-yet-materialized thread root). */
  rootId: string
  /** Absolute path — the identity every tree operation keys off. */
  rootPath: string
  /** Display name (the path's last segment, per the scope contract). */
  name: string
  /** True for the thread's primary root — rendered non-textually: a FILLED
   *  accent dot (secondaries render rings) + a "primary project" tooltip. A
   *  text tag here read as branch information and was removed. */
  primary: boolean
  /** User accent override from the scope entry (`#rrggbb`). Absent = no
   *  override — the deterministic hash accent applies. */
  accent?: string
  /** Availability from the project record (#263). Unavailable sections
   *  render the existing dimmed + "unavailable" tag treatment and are inert. */
  available: boolean
  /** Whether the section renders header chrome (chevron + accent dot + name).
   *  False exactly when the scope has one root — the degenerate case that
   *  must stay byte-identical to today's single-root tree. */
  header: boolean
  /** Whether the section starts folded. Only meaningful with `header`;
   *  unavailable roots are always collapsed (nothing to list). */
  collapsed: boolean
  /** True when this root is the thread's own checkout rather than the project. */
  threadCopy?: boolean
}

/**
 * What the person has unfolded in the thread that is open now. Belongs to ONE
 * thread: `foldMemoryFor` hands back a fresh, empty memory as soon as the scope
 * names a different thread, so every visit to a multi-project thread starts
 * folded.
 */
export interface SectionFoldMemory {
  /** The thread the memory belongs to (null = no thread selected). */
  threadId: string | null
  /** Roots the person unfolded while this thread was open. */
  expanded: ReadonlySet<string>
}

export function emptyFoldMemory(threadId: string | null = null): SectionFoldMemory {
  return { threadId, expanded: new Set() }
}

/** The memory to fold `threadId`'s sections with: kept for the same thread,
 *  started afresh for any other. */
export function foldMemoryFor(memory: SectionFoldMemory, threadId: string | null): SectionFoldMemory {
  return memory.threadId === threadId ? memory : emptyFoldMemory(threadId)
}

/** Record that the person folded or unfolded one root — a NEW memory. */
export function setRootExpanded(
  memory: SectionFoldMemory,
  rootPath: string,
  expanded: boolean,
): SectionFoldMemory {
  const next = new Set(memory.expanded)
  if (expanded) next.add(rootPath)
  else next.delete(rootPath)
  return { threadId: memory.threadId, expanded: next }
}

/**
 * Scope → ordered section view models (scope order preserved: primary first,
 * per the thread-scope contract).
 *
 * Rules:
 * - No scope / empty scope → no sections (the tree shows its empty hint).
 * - Exactly one root → one section WITHOUT header chrome and never collapsed
 *   — today's tree, byte for byte (NFR1). The root row's own expand/collapse
 *   behavior is untouched by this model.
 * - N > 1 roots → one headered section per root, in scope order, each FOLDED
 *   unless the person unfolded it while this thread has been open
 *   (`expandedRoots`), and always folded when the root is unavailable.
 */
export function sectionsForScope(
  scope: ThreadScope | null,
  expandedRoots: ReadonlySet<string>,
): FileTreeSectionModel[] {
  if (!scope || scope.roots.length === 0) return []
  const multiRoot = scope.roots.length > 1
  return scope.roots.map((root) => {
    const header = multiRoot
    const collapsed = header && (!root.available || !expandedRoots.has(root.rootPath))
    return {
      rootId: root.rootId,
      rootPath: root.rootPath,
      name: root.name,
      primary: root.primary,
      available: root.available,
      header,
      collapsed,
      // A thread's own checkout, lent into the scope. Carried as a FACT because
      // the name deliberately cannot say it: the checkout's folder is a UUID, so
      // it is displayed under the project's name — which left a reader inside a
      // copy looking at a tree headed `orbit-app`, identical to the project's
      // own (user, 2026-09-16).
      ...(root.threadCopy === true ? { threadCopy: true } : {}),
      // Omitted entirely (not set to undefined) when there is no override, so
      // section models stay shape-stable for existing consumers/tests.
      ...(root.accent !== undefined ? { accent: root.accent } : {}),
    }
  })
}

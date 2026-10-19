// Pure thread-scope model (multi-project threads, phase 1).
//
// A thread's attached projects — the primary `threads.workspace_root` plus the
// `thread_roots` extras — become ONE ordered, deduped, availability-flagged
// root set: the thread's scope. This module is the single derivation (one
// scope source of truth, allowed-pattern #14); the ThreadScopeManager feeds it
// live inputs and every consumer reads its output.
//
// Deliberately dependency-free and DOM-free (type-only import from the shared
// contract) so it runs under plain `npx jest` with no DB or Electron.

import type { ThreadScope, ThreadScopeEntry } from '../../shared/ipc-contract'

/** The slice of a project root record the scope derivation needs. Both
 *  main's RegisteredProject and the contract's satisfy it structurally. */
export interface ScopeProjectRoot {
  id: string
  /** Absolute path — the project domain's addressing key. */
  rootPath: string
  /**
   * What a person should see this root called. Absent for every REGISTERED
   * project — a project is named by its folder, and deriving that here keeps
   * the project record free of a display field it never had.
   *
   * Present only for a root that is LENT a record it does not own: a thread's
   * checkout borrows its project's record (`withWorktreeRoot`), and the
   * checkout's own folder is named after the thread id — a UUID, which is
   * exactly the internal spelling forbidden-pattern #12 keeps off the screen.
   */
  name?: string
  /** Absent = available (mirrors RegisteredProject, #263). */
  available?: boolean
  /** User accent override (mirrors RegisteredProject.accentColor). Absent = no
   *  override — the deterministic hash accent applies. */
  accentColor?: string
  /** True when this record is a thread's own checkout, lent into the list. */
  threadCopy?: boolean
}

export interface ThreadScopeInput {
  /** The active thread, or null when no thread is active. */
  threadId: string | null
  /** The thread's primary root (threads.workspace_root) — or, with a null
   *  thread, the active project's root. Null = no project active. */
  primaryRoot: string | null
  /** The thread's additional roots (thread_roots extras), in stored order. */
  additionalRoots: readonly string[]
  /** The project root list — identity (rootId) + availability source. */
  projectRoots: readonly ScopeProjectRoot[]
}

/**
 * Derive a thread's scope: ordered primary-first, deduped (the primary is
 * never duplicated by an additional entry, and repeated additionals collapse),
 * each entry joined against the project root list for rootId + availability.
 *
 * Degenerate cases (exactly today's single-root semantics):
 * - `primaryRoot` null → empty scope (no project active).
 * - `threadId` null → the scope is just the active project's root;
 *   `additionalRoots` are ignored (extras belong to a thread, not a project).
 *
 * A thread root with NO project record yet resolves to an entry with
 * `rootId: ''` and `available: false` — it is kept (never dropped) so the
 * auto-open phase can materialize its project record later.
 */
export function threadScopeFor(input: ThreadScopeInput): ThreadScope {
  const { threadId, primaryRoot, additionalRoots, projectRoots } = input
  if (primaryRoot === null) {
    return { threadId, roots: [] }
  }

  const byPath = new Map<string, ScopeProjectRoot>()
  for (const root of projectRoots) {
    if (!byPath.has(root.rootPath)) byPath.set(root.rootPath, root)
  }

  const roots: ThreadScopeEntry[] = [entryFor(primaryRoot, true, byPath)]
  if (threadId !== null) {
    const seen = new Set<string>([primaryRoot])
    for (const rootPath of additionalRoots) {
      if (rootPath === '' || seen.has(rootPath)) continue
      seen.add(rootPath)
      roots.push(entryFor(rootPath, false, byPath))
    }
  }
  return { threadId, roots }
}

function entryFor(
  rootPath: string,
  primary: boolean,
  byPath: ReadonlyMap<string, ScopeProjectRoot>,
): ThreadScopeEntry {
  const record = byPath.get(rootPath)
  return {
    rootId: record?.id ?? '',
    rootPath,
    // A lent record may carry its own display name (a thread's checkout); a
    // real project never does, and falls back to its folder as it always has.
    name: record?.name ?? lastPathSegment(rootPath),
    primary,
    // Carried through so a renderer can SAY which root it is looking at; the
    // name cannot, by design.
    ...(record?.threadCopy === true ? { threadCopy: true } : {}),
    // Absent `available` on a record = available (#263); NO record = not yet
    // materialized as a project root → unavailable until auto-open does so.
    available: record !== undefined && record.available !== false,
    // User accent override rides along so every scope consumer resolves the
    // same color (key omitted entirely when there is no override — existing
    // entry shapes, and the scope-change JSON compare, stay byte-stable).
    ...(record?.accentColor !== undefined ? { accent: record.accentColor } : {}),
  }
}

/** Last path segment of a POSIX or Windows path (trailing separators
 *  ignored); the path itself when there is no separator. */
function lastPathSegment(path: string): string {
  const segments = path.split(/[/\\]/).filter((segment) => segment !== '')
  return segments.length > 0 ? segments[segments.length - 1] : path
}

/**
 * What a thread's checkout of `projectRoot` is CALLED (thread-worktrees, the
 * Source Control naming fix).
 *
 * IT IS THE PROJECT'S NAME PLUS THE WORKTREE'S OWN.
 *
 * Three wrong answers came before this one. The path's last segment is the
 * thread id, so the header read a raw UUID. The project's name alone made a
 * copy indistinguishable from the project, and a reader inside one concluded
 * the explorer was showing the wrong files. Shortening the UUID to
 * `orbit-app (b3fe4467)` only made the meaningless part smaller.
 *
 * A worktree's name is its BRANCH — it is what `git worktree list` identifies
 * one by, and the only string about a checkout that means anything to a person.
 * When there is no branch there is no name, and the project's own name stands
 * alone rather than carrying a parenthesis full of nothing.
 *
 * IT USED TO CARRY "(this thread)". That suffix existed for exactly one
 * reason: the panel showed a thread's checkout ALONGSIDE the project's own
 * tree, so two groups would have read `orbit-app` and `orbit-app`, and
 * "Discard all changes in orbit-app" would have named both. On 2026-08-26
 * the panel stopped rendering the second group ("lets show just one of each of
 * them"), which removed the ambiguity and with it the suffix's whole subject.
 *
 * A label that explains a distinction the screen no longer draws is a label
 * asking the reader about something they cannot see, so it goes with the thing
 * it explained rather than staying on as decoration.
 */
export function threadCopyName(projectRoot: string): string {
  // JUST THE PROJECT. It carried the branch in parentheses — `orbit-app
  // (thread/migration-check-feature-flag-based-on-this-ticke)` — back when the
  // only way to know a conversation was isolated was to read it off this row.
  // The worktree panel now sits directly above the tree and says so, including
  // the branch, so the row was answering a question that is already answered
  // two lines up while eating the width the project's own name needs (user,
  // 2026-09-17: "the project is showing orbit-app(name of worktree), we don't
  // need it anymore because the worktree is here on the same screen").
  //
  // Same lesson as the `(b3fe4467)` it replaced: a label explaining a
  // distinction the screen already draws is decoration.
  return lastPathSegment(projectRoot)
}

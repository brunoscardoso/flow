// The address gate — ONE answer to "is this a root the renderer may address?"
//
// Every main-side channel that takes a `rootPath`/`rootId` straight from the
// renderer has to decide whether to trust it as a working directory. Until a
// thread owned a checkout the answer was simply "is it a registered project
// root", restated in four places (project file IO, the flat file list, the
// file tree, the git write channels).
//
// A thread's worktree broke that. `thread-scope-manager` reports the worktree as
// the thread's primary root, so the editor, the file tree, the terminal and the
// git panel all address it — and a worktree is deliberately NEVER registered as
// a project root, because putting checkouts in the user's project list would
// be worse than the bug. Four independent restatements of a widened rule is four
// chances to drift, so the rule lives here and only here (allowed-pattern #14).
//
// The answer: a registered project root, OR a path some thread recorded as its
// worktree. Nothing else.
//
// Safety shape (forbidden-pattern #15 — this gate widens what the app will
// WRITE to): the widening exists only when a caller passes a thread-worktree
// source. Construct it without one and the gate is exactly what it was before
// thread worktrees existed. An empty store, a null `worktree_path`, or a source
// that throws all widen nothing.

import { resolve } from 'path'

/** One thread's checkout, exactly as the thread store recorded it. */
export interface ThreadWorktree {
  /** Absolute path of the worktree — the path `planflow-ai worktree` returned,
   *  never one recomputed from the project root (see ThreadRecord.worktreePath). */
  worktreePath: string
  /** The registered project root this worktree was cut from. */
  projectRoot: string
}

export interface AddressableRoots {
  /**
   * May the renderer address `rootPath` — as a file-IO root, a listing root, or
   * a git working directory? True for a registered project root and for any
   * thread's recorded worktree; false for everything else.
   */
  isAddressable(rootPath: string): boolean
  /**
   * The main checkout that owns `rootPath` when it is a thread's worktree, else
   * null. A registered project root answers null — it owns itself and is not
   * a checkout of anything.
   *
   * Callers use this to widen symlink containment: a worktree's linked-in
   * entries (`node_modules`, `.env*`, `flow/`) point at the main checkout by
   * design, and they are the same project's files.
   */
  ownerCheckoutFor(rootPath: string): string | null
  /**
   * Every root a renderer may address, registered and recorded alike.
   *
   * THE SAME QUESTION `isAddressable` ANSWERS, ASKED THE OTHER WAY ROUND, and
   * it exists because a surface that has an absolute path and needs the root
   * containing it was otherwise forced to guess from the project list alone.
   * Reveal-in-Finder did exactly that and silently did nothing for every file
   * in a thread's checkout: the renderer mapped against a narrower list than
   * this gate accepts, found no root, and skipped (#1063 follow-up).
   *
   * Longest-first, so a caller matching by prefix finds the innermost root — a
   * worktree nested under a registered project must win over the project.
   */
  addressablePaths(): readonly string[]
}

export interface AddressableRootsDeps {
  /** The registered project roots — the user's project list. */
  registeredRoots(): readonly { rootPath: string }[]
  /**
   * Every thread that owns a checkout. OMIT IT and no path is addressable
   * beyond the registered roots — the pre-worktree gate, which is the safe
   * default a forgetful caller gets.
   */
  threadWorktrees?: () => readonly ThreadWorktree[]
}

/** Build the gate. See the module header for what it does and does not widen. */
export function createAddressableRoots(deps: AddressableRootsDeps): AddressableRoots {
  /** Registered first, always: it needs no store read, so a thread-store hiccup
   *  can never refuse a legitimate project root. */
  function isRegistered(absolute: string): boolean {
    return deps.registeredRoots().some((root) => resolve(root.rootPath) === absolute)
  }

  /**
   * The thread worktree recorded at `absolute`, or null. Fails CLOSED and loud:
   * a store that cannot be read refuses the widening (never grants it) and says
   * why — a silent `false` here would surface as an unexplained "unknown root".
   */
  function recordedWorktree(absolute: string): ThreadWorktree | null {
    if (deps.threadWorktrees === undefined) return null
    let recorded: readonly ThreadWorktree[]
    try {
      recorded = deps.threadWorktrees()
    } catch (error) {
      console.warn('[Project] Thread worktrees unreadable; refusing to widen', {
        rootPath: absolute,
        error,
      })
      return null
    }
    for (const worktree of recorded) {
      // A null/blank `worktree_path` is "this thread has no checkout" — it must
      // never widen anything, and neither may a worktree with no owning root.
      if (typeof worktree.worktreePath !== 'string' || worktree.worktreePath === '') continue
      if (typeof worktree.projectRoot !== 'string' || worktree.projectRoot === '') continue
      if (resolve(worktree.worktreePath) === absolute) return worktree
    }
    return null
  }

  return {
    isAddressable(rootPath: string): boolean {
      const absolute = resolve(rootPath)
      return isRegistered(absolute) || recordedWorktree(absolute) !== null
    },
    addressablePaths(): readonly string[] {
      const paths = deps.registeredRoots().map((root) => resolve(root.rootPath))
      // Same fail-closed read as `recordedWorktree`: an unreadable store yields
      // the registered roots alone rather than an exception, which is the
      // pre-worktree answer and never a wider one.
      if (deps.threadWorktrees !== undefined) {
        try {
          for (const worktree of deps.threadWorktrees()) {
            if (typeof worktree.worktreePath !== 'string' || worktree.worktreePath === '') continue
            if (typeof worktree.projectRoot !== 'string' || worktree.projectRoot === '') continue
            paths.push(resolve(worktree.worktreePath))
          }
        } catch (error) {
          console.warn('[Project] Thread worktrees unreadable; listing registered roots only', {
            error,
          })
        }
      }
      return [...new Set(paths)].sort((a, b) => b.length - a.length)
    },
    ownerCheckoutFor(rootPath: string): string | null {
      const absolute = resolve(rootPath)
      // A real record always wins: a path that is BOTH registered and recorded
      // as a worktree is treated as the project it is, with no widening.
      if (isRegistered(absolute)) return null
      const worktree = recordedWorktree(absolute)
      if (worktree === null) return null
      const owner = resolve(worktree.projectRoot)
      // A worktree recorded as its own owner would widen nothing and hide a
      // bookkeeping bug behind a no-op; report "no owner" instead.
      return owner === absolute ? null : owner
    },
  }
}

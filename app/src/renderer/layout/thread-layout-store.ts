/**
 * Per-THREAD layout persistence — the keying and storage half, DOM-free.
 *
 * Each chat thread is its own context, and its panel layout follows it: switch
 * threads and you see that thread's arrangement, switch back and yours comes
 * back. A project with NO thread selected (the project view) keeps a layout of
 * its own. This module owns only WHERE those layouts live and which one a scope
 * gets; what a layout IS stays with its owner (the shell's ShellLayoutState, the
 * terminal's split arrangement), passed in as a `normalize` function.
 *
 * Scopes are `(projectRoot, threadId | null)`; null is the project view. The
 * resolution order for a scope with no saved entry is the whole design:
 *
 *   1. its own saved entry
 *   2. a THREAD with none inherits what is on screen — but only when the screen
 *      belongs to the same project, so opening a new thread never makes the
 *      window jump, and a thread never inherits another project's arrangement
 *   3. otherwise the project view's entry for that root
 *   4. otherwise the caller's fallback (the pre-thread per-project layout — the
 *      migration path — then the built-in default)
 *
 * One localStorage key per namespace holds every scope, each entry stamped with
 * when it was last written; past `maxEntries` the least recently used go. That
 * bound is what keeps deleted threads from accumulating — there is no thread
 * list to consult here, and needing one would make a layout read wait on IPC.
 *
 * Every storage access is wrapped: localStorage can be absent, throw on access
 * (blocked site data), or throw on write (quota). A failure reads as "nothing
 * saved" and never as an exception the shell has to survive.
 */

/** The slice of the Web Storage API this module uses (injectable for tests). */
export interface LayoutStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** A layout scope: a project root plus the thread on screen (null = project view). */
export interface LayoutScope {
  root: string
  threadId: string | null
}

/** Default bound on stored scopes per namespace — generous for real use, small
 *  enough that the one JSON value stays a few hundred KB at worst. */
export const DEFAULT_MAX_LAYOUT_ENTRIES = 200

const STORE_VERSION = 1 as const
const PROJECT_VIEW_SEGMENT = 'project'
const THREAD_SEGMENT_PREFIX = 'thread:'
const SCOPE_SEPARATOR = '\n'

interface StoredEntry {
  at: number
  value: unknown
}

interface StoredShape {
  version: typeof STORE_VERSION
  entries: Record<string, StoredEntry>
}

/**
 * The storage key segment for a scope. The thread segment is prefixed so a
 * thread whose id happened to be the word "project" can never collide with the
 * project view, and the separator is a newline, which no path or id contains.
 */
export function layoutScopeKey(scope: LayoutScope): string {
  const segment =
    scope.threadId === null ? PROJECT_VIEW_SEGMENT : `${THREAD_SEGMENT_PREFIX}${scope.threadId}`
  return `${scope.root}${SCOPE_SEPARATOR}${segment}`
}

/** Same scope — the cheap check that lets a repeated signal apply nothing. */
export function sameLayoutScope(a: LayoutScope | null, b: LayoutScope | null): boolean {
  if (a === null || b === null) return a === b
  return a.root === b.root && a.threadId === b.threadId
}

export interface ThreadLayoutStoreOptions<T> {
  /** The localStorage key holding every scope of this namespace. */
  namespace: string
  /** Resolves the storage lazily — a getter, because touching `window.localStorage`
   *  itself can throw. Return null when there is none. */
  storage: () => LayoutStorage | null
  /** Validate a stored value; null discards it as corrupt. */
  normalize: (raw: unknown) => T | null
  maxEntries?: number
  now?: () => number
  warn?: (message: string, error: unknown) => void
}

export interface ThreadLayoutStore<T> {
  /** The scope's own saved layout, or null when it has none. */
  read(scope: LayoutScope): T | null
  /** Save a layout for a scope (stamped now, pruned to the bound). */
  write(scope: LayoutScope, value: T): void
  /**
   * The layout a scope should show. `onScreen` is what is displayed now and the
   * scope it belongs to (null before anything has been shown); `fallback` is
   * consulted last. `inherited` is true when the answer came from the screen
   * or a fallback rather than the scope's own entry — the caller snapshots it
   * so the scope diverges from here on.
   */
  resolve(
    scope: LayoutScope,
    onScreen: { scope: LayoutScope; value: T } | null,
    fallback: () => T,
  ): { value: T; inherited: boolean }
}

function isStoredShape(value: unknown): value is StoredShape {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<StoredShape>
  return (
    candidate.version === STORE_VERSION &&
    typeof candidate.entries === 'object' &&
    candidate.entries !== null
  )
}

function isStoredEntry(value: unknown): value is StoredEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<StoredEntry>).at === 'number' &&
    'value' in value
  )
}

/** Keep the `max` most recently written entries (ties keep insertion order). */
export function pruneLayoutEntries(
  entries: Record<string, StoredEntry>,
  max: number,
): Record<string, StoredEntry> {
  const keys = Object.keys(entries)
  if (keys.length <= max) return entries
  const kept = keys
    .map((key, index) => ({ key, index, at: entries[key].at }))
    .sort((a, b) => b.at - a.at || b.index - a.index)
    .slice(0, Math.max(0, max))
  const next: Record<string, StoredEntry> = {}
  for (const { key } of kept.sort((a, b) => a.index - b.index)) next[key] = entries[key]
  return next
}

export function createThreadLayoutStore<T>(
  options: ThreadLayoutStoreOptions<T>,
): ThreadLayoutStore<T> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_LAYOUT_ENTRIES
  const now = options.now ?? (() => Date.now())
  const warn =
    options.warn ?? ((message: string, error: unknown) => console.warn(message, error))

  function storage(): LayoutStorage | null {
    try {
      return options.storage()
    } catch (error) {
      warn('flow: layout storage unavailable', error)
      return null
    }
  }

  function load(): Record<string, StoredEntry> {
    const store = storage()
    if (!store) return {}
    try {
      const raw = store.getItem(options.namespace)
      if (!raw) return {}
      const parsed: unknown = JSON.parse(raw)
      if (!isStoredShape(parsed)) return {}
      const entries: Record<string, StoredEntry> = {}
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (isStoredEntry(entry)) entries[key] = entry
      }
      return entries
    } catch (error) {
      warn('flow: failed to read thread layouts', error)
      return {}
    }
  }

  function read(scope: LayoutScope): T | null {
    const entry = load()[layoutScopeKey(scope)]
    if (!entry) return null
    return options.normalize(entry.value)
  }

  function write(scope: LayoutScope, value: T): void {
    const store = storage()
    if (!store) return
    const entries = { ...load() }
    const key = layoutScopeKey(scope)
    // Re-insert so the freshest write is also last in insertion order.
    delete entries[key]
    entries[key] = { at: now(), value }
    const shape: StoredShape = {
      version: STORE_VERSION,
      entries: pruneLayoutEntries(entries, maxEntries),
    }
    try {
      store.setItem(options.namespace, JSON.stringify(shape))
    } catch (error) {
      warn('flow: failed to persist thread layout', error)
    }
  }

  function resolve(
    scope: LayoutScope,
    onScreen: { scope: LayoutScope; value: T } | null,
    fallback: () => T,
  ): { value: T; inherited: boolean } {
    const own = read(scope)
    if (own !== null) return { value: own, inherited: false }
    if (scope.threadId !== null && onScreen !== null && onScreen.scope.root === scope.root) {
      return { value: onScreen.value, inherited: true }
    }
    if (scope.threadId !== null) {
      const projectView = read({ root: scope.root, threadId: null })
      if (projectView !== null) return { value: projectView, inherited: true }
    }
    return { value: fallback(), inherited: true }
  }

  return { read, write, resolve }
}

/**
 * MOVING A PROJECT'S PERSISTED TABS ONTO A CHECKOUT'S NEW PATH.
 *
 * `workspace_state` stores a project's open editor tabs as `{ rootPath, relPath }`
 * pairs, and the unsaved contents of those tabs keyed by ABSOLUTE path. Both
 * address a thread's checkout by where it sits on disk, so renaming the
 * directory strands them: the row survives, the folder does not, and every
 * activation of that project rehydrates tabs whose root no longer exists.
 *
 * PURE, so it can be tested without a database — and so the two shapes it has
 * to understand (an array of refs, a map keyed by path) are worked out in one
 * place rather than inline in a SQL loop.
 *
 * NOTHING IS REWRITTEN THAT DOES NOT HAVE TO BE. `null` means "this row does not
 * mention that checkout", and the caller leaves it completely untouched —
 * including `last_active_at`, which decides which project boots (#1080).
 */

interface StoredTab {
  rootPath?: unknown
  [key: string]: unknown
}

/** A path and its trailing-slash-free form compared as one. */
function sameRoot(value: unknown, root: string): boolean {
  return typeof value === 'string' && value.replace(/\/+$/, '') === root
}

/** `<root>/<rest>` → the same `<rest>` under `next`, or null when unrelated. */
function movedAbsolute(key: string, root: string, next: string): string | null {
  if (key === root) return next
  return key.startsWith(`${root}/`) ? `${next}${key.slice(root.length)}` : null
}

/**
 * The row's two JSON columns with `from` swapped for `to`, or null when neither
 * mentions it.
 *
 * MALFORMED JSON IS LEFT ALONE rather than repaired or dropped: a column this
 * cannot parse is one it does not understand, and rewriting it would turn a
 * puzzling row into a destroyed one.
 */
export function repointedTabs(
  openFilesJson: string,
  dirtyBuffersJson: string,
  from: string,
  to: string,
): { openFiles: string; dirtyBuffers: string } | null {
  const root = from.replace(/\/+$/, '')
  const next = to.replace(/\/+$/, '')
  if (root === '' || next === '' || root === next) return null

  let tabs: unknown
  let buffers: unknown
  try {
    tabs = JSON.parse(openFilesJson)
    buffers = JSON.parse(dirtyBuffersJson)
  } catch {
    return null
  }

  let touched = false

  const movedTabs = Array.isArray(tabs)
    ? tabs.map((tab) => {
        if (tab === null || typeof tab !== 'object') return tab
        const ref = tab as StoredTab
        if (!sameRoot(ref.rootPath, root)) return tab
        touched = true
        return { ...ref, rootPath: next }
      })
    : tabs

  const movedBuffers: Record<string, unknown> = {}
  if (buffers !== null && typeof buffers === 'object' && !Array.isArray(buffers)) {
    for (const [key, value] of Object.entries(buffers as Record<string, unknown>)) {
      const moved = movedAbsolute(key, root, next)
      if (moved === null) {
        movedBuffers[key] = value
      } else {
        movedBuffers[moved] = value
        touched = true
      }
    }
  }

  if (!touched) return null
  return {
    openFiles: JSON.stringify(movedTabs),
    dirtyBuffers:
      buffers !== null && typeof buffers === 'object' && !Array.isArray(buffers)
        ? JSON.stringify(movedBuffers)
        : dirtyBuffersJson,
  }
}

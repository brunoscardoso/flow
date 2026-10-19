/**
 * Brief scoping (feature-blueprint) — PURE, no DOM.
 *
 * WHY THIS EXISTS
 * ===============
 * Opening a feature's brief used to force the CODE MAP open, because the map
 * was the only renderer on the board that drew nodes at all — the brief then
 * decorated whatever cards happened to be there. So clicking a feature dropped
 * the reader into a 330-directory import graph they never asked for, and the
 * brief's own subject was somewhere inside it.
 *
 * The brief is not a view of the repository. It is a view of ONE FEATURE: the
 * handful of components that feature actually touches, and the wires between
 * them. That is a SUBGRAPH, and this module cuts it — so the board can render a
 * brief with the machinery it already has (layout, cards, wires) without ever
 * showing the full map.
 *
 * The cut is deliberately strict: an edge survives only when BOTH ends do. A
 * wire to a component that is not on screen is a line to nowhere, and the whole
 * point of the scoped view is that everything drawn is part of the story.
 */

/** The subset of a graph node this module needs — structurally compatible. */
export interface ScopableNode {
  id: string
}

/** The subset of a graph edge this module needs. */
export interface ScopableEdge {
  source: string
  target: string
}

export interface ScopedGraph<N extends ScopableNode, E extends ScopableEdge> {
  nodes: N[]
  edges: E[]
  /**
   * Brief node ids that the derived graph does not contain. Never silently
   * dropped: these are the components a feature claims but the map cannot
   * show, which is exactly what the verification ledger reports.
   */
  missing: string[]
}

/**
 * Cut `graph` down to the components a brief covers.
 *
 * Node order is preserved from the source graph so layout stays deterministic
 * across re-renders. `missing` is reported rather than swallowed.
 */
export function scopeGraphToBrief<N extends ScopableNode, E extends ScopableEdge>(
  graph: { nodes: N[]; edges: E[] },
  briefNodeIds: readonly string[],
): ScopedGraph<N, E> {
  const wanted = new Set(briefNodeIds)
  const nodes = graph.nodes.filter((node) => wanted.has(node.id))
  const present = new Set(nodes.map((node) => node.id))
  const edges = graph.edges.filter((edge) => present.has(edge.source) && present.has(edge.target))
  const missing = [...wanted].filter((id) => !present.has(id)).sort()
  return { nodes, edges, missing }
}

/**
 * Whether a scoped brief has anything to draw. An empty scope must NOT render
 * as an empty stage that looks like a broken board — the caller shows the
 * brief's own text instead and says why there is no diagram.
 */
export function hasDrawableScope(scoped: { nodes: readonly unknown[] }): boolean {
  return scoped.nodes.length > 0
}

/** One anchor as the verification ledger reports it. */
export interface LedgerAnchor {
  ref: string
  resolved: boolean
}

/**
 * The module paths a feature's Learn should read — deduped and sorted.
 *
 * Learning is module-keyed in the app's orchestrator, so learning a FEATURE
 * means learning the modules it claims. Anchors reach those modules two ways:
 *
 *  - `module:<dir>` — the directory itself.
 *  - `file:<path>`  — its PARENT DIRECTORY. The orchestrator reads a directory,
 *    and the directory containing a claimed file is the module that file lives
 *    in. Excluding these was wrong in a way only real data showed: a change
 *    record like "Chat Session Cache Rework" carries 14 anchors and every one is a
 *    `file:`, so the feature with the most known about it offered no Learn at
 *    all. A file at the repo root yields no directory and is skipped.
 *
 * UNRESOLVED anchors are still skipped: learning a path the map does not
 * contain would queue work that cannot succeed and report it as progress.
 *
 * Sorted so a feature's learn order is deterministic run to run.
 */
export function learnableModulePaths(anchors: readonly LedgerAnchor[]): string[] {
  const paths = new Set<string>()
  for (const anchor of anchors) {
    if (!anchor.resolved) continue
    if (anchor.ref.startsWith('module:')) {
      const path = anchor.ref.slice('module:'.length).trim()
      if (path.length > 0) paths.add(path)
      continue
    }
    if (anchor.ref.startsWith('file:')) {
      const path = anchor.ref.slice('file:'.length).trim()
      const slash = path.lastIndexOf('/')
      if (slash > 0) paths.add(path.slice(0, slash))
    }
  }
  return [...paths].sort()
}

/**
 * Labels that tell scoped components APART.
 *
 * A card shows a node's basename, which is fine on the code map where siblings
 * differ. Inside a FEATURE brief it collapses: a feature's anchors are usually
 * directories named after the feature, so opening "Chats" drew five cards
 * labelled `chat`, `chat`, `chats`, `chats`, `chats` — every one of them
 * truthful and none of them useful.
 *
 * The distinguishing part is the path. This walks each id leftward, one segment
 * at a time, until its label is unique within the scoped set — so the Chats
 * brief reads `api/chat`, `sdk/chat`, `tests/chats`, `spaces/chats`,
 * `(protected)/chats`. Shortest label that still distinguishes; the full path
 * only when nothing shorter does.
 */
export function distinguishingLabels(input: readonly string[]): Map<string, string> {
  // Dedupe first: the same id twice is one component, not a collision to grow
  // labels against (a graph cannot hold it twice; a careless caller can).
  const ids = [...new Set(input)]
  const pathOf = (id: string): string => {
    const colon = id.indexOf(':')
    return colon < 0 ? id : id.slice(colon + 1)
  }
  const segmentsOf = (id: string): string[] => pathOf(id).split('/').filter((part) => part.length > 0)

  const labels = new Map<string, string>()
  const depth = new Map<string, number>()
  for (const id of ids) depth.set(id, 1)

  // Grow only the labels that still collide, so a unique node keeps its short
  // name even when a sibling needs three segments to be told apart.
  const maxSegments = Math.max(1, ...ids.map((id) => segmentsOf(id).length))
  for (let round = 0; round < maxSegments; round += 1) {
    for (const id of ids) {
      const segments = segmentsOf(id)
      const take = Math.min(depth.get(id) ?? 1, segments.length)
      labels.set(id, segments.slice(segments.length - take).join('/') || pathOf(id))
    }
    const counts = new Map<string, number>()
    for (const id of ids) {
      const label = labels.get(id) as string
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    const collided = ids.filter((id) => (counts.get(labels.get(id) as string) ?? 0) > 1)
    if (collided.length === 0) break
    let grew = false
    for (const id of collided) {
      const current = depth.get(id) ?? 1
      if (current < segmentsOf(id).length) {
        depth.set(id, current + 1)
        grew = true
      }
    }
    if (!grew) break // identical paths — nothing left to distinguish with
  }
  return labels
}

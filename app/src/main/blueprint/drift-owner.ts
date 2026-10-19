/**
 * Drift → graph-node attribution (#1155).
 *
 * Drift used to be attributed by an EXACT `node.sourceFile === path` match. But
 * module nodes' `sourceFile` is a DIRECTORY (`src/core`), so an ordinary source
 * file inside it (`src/core/engine.ts`) matched nothing and was dropped
 * silently: no drift row, no card mark, no Drift tab at all. Only a file that
 * IS some node's exact sourceFile — an integration/endpoint/datastore file —
 * could ever surface. On plan-flow's own graph that is 14 of 65 file-bearing
 * nodes against ~1,300 tracked files: ~99% of source drift was invisible by
 * construction, contradicting file-stamps.ts's stated purpose ("a change to a
 * never-learned module still produces a signal").
 *
 * Attribution is therefore a ROLL-UP, which is what the assembler's own doc
 * always claimed ("SOURCE-file drift rolled up to its owning graph node"):
 *
 *   1. exact path match wins — an integration file still attributes to its own
 *      node, so nothing that worked before changes
 *   2. otherwise the DEEPEST directory-owning node that is a path prefix —
 *      `src/core/engine.ts` → `module:src/core`, never the shallower
 *      `module:src`, so the mark lands on the card a user navigates by.
 *
 * Mirrored, deliberately, from src/cli/blueprint/drift-owner.ts: the CLI and
 * the Electron main process are separate builds with no shared module, and the
 * two attribution sites must agree exactly. Keep the two in sync.
 */

/** Only what attribution needs from a graph node. */
export interface OwnerCandidate {
  id: string
  sourceFile?: string | undefined
}

export interface DriftOwnerIndex {
  /** sourceFile (exact, file or directory) → first node id in graph order. */
  exact: Map<string, string>
  /** Directory sourceFiles, longest first, for the prefix walk. */
  directories: Array<{ prefix: string; nodeId: string }>
}

/** Normalize to forward slashes with no trailing separator. */
function normalize(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  return slashed.endsWith('/') ? slashed.slice(0, -1) : slashed
}

/**
 * Index the graph's nodes for attribution. Every non-empty sourceFile is an
 * exact candidate; each is ALSO recorded as a potential directory prefix,
 * because the graph does not say which sourceFiles are directories — a path
 * that turns out to be a file simply never prefix-matches anything (no real
 * path starts with `file.ts/`).
 */
export function buildDriftOwnerIndex(nodes: readonly OwnerCandidate[]): DriftOwnerIndex {
  const exact = new Map<string, string>()
  const directories: Array<{ prefix: string; nodeId: string }> = []
  for (const node of nodes) {
    const raw = node.sourceFile
    if (typeof raw !== 'string' || raw.length === 0) {
      continue
    }
    const path = normalize(raw)
    if (path.length === 0) {
      continue; // a repo-root sourceFile would own everything — not attribution
    }
    if (!exact.has(path)) {
      exact.set(path, node.id)
    }
    directories.push({ prefix: `${path}/`, nodeId: node.id })
  }
  // Deepest first, so `src/core` wins over `src` for `src/core/engine.ts`.
  directories.sort((a, b) => b.prefix.length - a.prefix.length)
  return { exact, directories }
}

/**
 * The node that owns `path`: exact sourceFile match, else the deepest
 * directory-owning node containing it. `undefined` when nothing owns it.
 */
export function driftOwnerNodeId(path: string, index: DriftOwnerIndex): string | undefined {
  const normalized = normalize(path)
  const direct = index.exact.get(normalized)
  if (direct !== undefined) {
    return direct
  }
  for (const { prefix, nodeId } of index.directories) {
    if (normalized.startsWith(prefix)) {
      return nodeId
    }
  }
  return undefined
}

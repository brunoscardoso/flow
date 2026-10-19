// File → owning-module rollup, shared between the renderer board and the
// main-process invariant checker (#898). ONE code path (allowed-pattern #14):
// both surfaces must agree on which module a changed file belongs to, so the
// mapping lives here in shared/ and neither side re-implements it.

import type { BlueprintGraph } from './ipc-contract'

/**
 * The module node whose directory owns a given repo-relative path (#UX,
 * "Reveal in Blueprint"). A module node's `sourceFile` is its directory; the
 * owner is the DEEPEST module dir that equals the path or is an ancestor of it
 * (so `src/api/routes.ts` prefers `module:src/api` over `module:src`). Paths are
 * separator-normalized and trailing-slash-trimmed. Returns null when nothing
 * matches (e.g. a file under no module, or an empty graph). Pure/DOM-free.
 */
export function moduleNodeIdForPath(graph: BlueprintGraph | null, relPath: string): string | null {
  if (graph === null) return null
  const target = relPath.replace(/\\/g, '/').replace(/\/+$/, '')
  let best: { id: string; depth: number } | null = null
  for (const node of graph.nodes) {
    if (node.kind !== 'module') continue
    const dir = node.sourceFile.replace(/\\/g, '/').replace(/\/+$/, '')
    const owns = dir === '' || dir === target || target.startsWith(`${dir}/`)
    if (!owns) continue
    const depth = dir === '' ? 0 : dir.split('/').length
    if (best === null || depth > best.depth) best = { id: node.id, depth }
  }
  return best?.id ?? null
}

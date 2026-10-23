/**
 * Which features the one-time classify pass would classify (plan
 * `feature-type-icons`, FR-10) — pure, DOM-free, and shared.
 *
 * ONE SELECTION, TWO READERS (allowed-pattern #14). Main uses it to pick the
 * pass's work; the board uses it on the nodes it already has on screen to decide
 * whether to offer the pass at all. Deriving the offer flag in the renderer is
 * deliberate (allowed-pattern #17): the board already holds every node with its
 * `role` and `roleSource`, so a separate IPC read would pay a CLI spawn to answer
 * a question the screen can answer for free.
 *
 * A candidate is a LEARNED feature whose role is still only a guess — neither a
 * person's `role` nor a learn pass's `learnedRole` exists (`roleSource` is
 * resolved once, in the CLI graph build, so this never re-derives it). A part
 * qualifies when its feature is learned and its own role is a guess. A feature
 * nobody has learned is never sent: the pass reads summaries, and an unlearned
 * feature has nothing worth reading.
 */
import type { BlueprintFeatureNode } from './ipc-contract'

/** The fields the selection reads — a structural subset of the graph node. */
export type RoleClassifyNode = Pick<
  BlueprintFeatureNode,
  'id' | 'name' | 'kind' | 'parent' | 'understanding' | 'summary' | 'roleSource'
>

/** One thing the pass will classify. */
export interface RoleClassifyCandidate {
  /** The graph id — a feature id, or a part's address. What the verb takes. */
  id: string
  kind: 'core' | 'part'
  name: string
  summary: string
  /** A feature's part names (never a part's own). */
  partNames: string[]
  /** A part's feature name, so the model reads it in context. */
  featureName?: string
}

function isLearned(node: Pick<RoleClassifyNode, 'understanding'>): boolean {
  return node.understanding === 'learned' || node.understanding === 'stale'
}

/** The pass's work, in graph order: each feature, then its parts. */
export function selectRoleClassifyCandidates(nodes: readonly RoleClassifyNode[]): RoleClassifyCandidate[] {
  const cores = new Map<string, RoleClassifyNode>()
  const partsOf = new Map<string, RoleClassifyNode[]>()
  for (const node of nodes) {
    if (node.kind === 'core') cores.set(node.id, node)
    else if (node.kind === 'part' && node.parent !== undefined) {
      const list = partsOf.get(node.parent) ?? []
      list.push(node)
      partsOf.set(node.parent, list)
    }
  }
  const out: RoleClassifyCandidate[] = []
  for (const core of cores.values()) {
    if (!isLearned(core)) continue
    const parts = partsOf.get(core.id) ?? []
    if (core.roleSource === 'guess') {
      out.push({
        id: core.id,
        kind: 'core',
        name: core.name,
        summary: (core.summary ?? '').trim(),
        partNames: parts.map((part) => part.name),
      })
    }
    for (const part of parts) {
      if (part.roleSource !== 'guess') continue
      out.push({
        id: part.id,
        kind: 'part',
        name: part.name,
        summary: (part.summary ?? '').trim(),
        partNames: [],
        featureName: core.name,
      })
    }
  }
  return out
}

/** How many the pass would classify — the board's "offer it?" flag. */
export function countUnclassifiedRoles(nodes: readonly RoleClassifyNode[]): number {
  return selectRoleClassifyCandidates(nodes).length
}

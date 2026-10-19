// Pure Connections-panel model (blueprint-connections). DOM-free so it's
// testable under the node-env jest that can't import the board view.
//
// Turns a computed usage neighborhood into the two ranked lists the popover
// renders — "Used by (N)" and "Uses (M)" — enriching each display id with a
// human label and its jump-to-code source file.

import type { UsageNeighborhood } from './neighborhood'

/** Where a connection came from — native structural fact vs graphify enrichment. */
export type ConnectionProvenance = 'native' | 'graphify'

/** One connection row in the popover's Used-by / Uses lists. */
export interface ConnectionRow {
  /** Display node id of the connected card. */
  nodeId: string
  /** Human label (module basename, integration host, …). */
  label: string
  /** How many underlying edges rolled up into this connection (usage strength). */
  count: number
  /** The connected node's source file/dir for jump-to-code, or null. */
  sourceFile: string | null
  /** Trust of the connection: `native` (imports/uses/exposes — solid) vs
   *  `graphify` (calls only — enrichment, rendered secondary). */
  provenance: ConnectionProvenance
  /** Optional semantic label — "powers the invite flow", "learned", … — folded
   *  in from the board's feature/learning knowledge. Absent when there's none. */
  detail?: string
}

/** The popover's grouped, counted connection lists. */
export interface Connections {
  /** Nodes that use the focus (dependents), strongest first. */
  usedBy: ConnectionRow[]
  /** Nodes the focus uses (dependencies), strongest first. */
  uses: ConnectionRow[]
}

/** What the board can tell the model about a display node. */
export interface NodeIndexEntry {
  label: string
  sourceFile: string | null
  /** Optional semantic label folded onto the row (feature membership, learning). */
  detail?: string
}

/** Relations the native extractors emit (fact); anything else (graphify `calls`)
 *  reads as enrichment. */
const NATIVE_RELATIONS = new Set(['imports', 'uses', 'exposes'])

/** Native if ANY underlying relation is a native fact; else graphify enrichment. */
function provenanceOf(relations: readonly string[] | undefined): ConnectionProvenance {
  return relations?.some((relation) => NATIVE_RELATIONS.has(relation)) ? 'native' : 'graphify'
}

/** Fallback label for an id with no index entry: the last id segment. */
function labelFromId(nodeId: string): string {
  const afterKind = nodeId.includes(':') ? nodeId.slice(nodeId.indexOf(':') + 1) : nodeId
  const lastSlash = afterKind.lastIndexOf('/')
  return lastSlash === -1 ? afterKind : afterKind.slice(lastSlash + 1)
}

/**
 * Build the popover's Connections lists from a neighborhood.
 *
 * `nodeIndex` resolves a display id to its label + source file (the board maps
 * the rolled nodes). Rows are sorted by usage count descending, then label —
 * deterministic. A missing index entry falls back to a label derived from the
 * id and a null source file (the row still renders and highlights, just without
 * jump-to-code).
 */
export function buildConnections(
  neighborhood: UsageNeighborhood,
  nodeIndex: (displayId: string) => NodeIndexEntry | null,
): Connections {
  const toRows = (
    ids: readonly string[],
    counts: Record<string, number>,
    relations: Record<string, string[]>,
  ): ConnectionRow[] =>
    ids
      .map((nodeId): ConnectionRow => {
        const entry = nodeIndex(nodeId)
        const row: ConnectionRow = {
          nodeId,
          label: entry?.label ?? labelFromId(nodeId),
          count: counts[nodeId] ?? 1,
          sourceFile: entry?.sourceFile ?? null,
          provenance: provenanceOf(relations[nodeId]),
        }
        if (entry?.detail !== undefined && entry.detail !== '') row.detail = entry.detail
        return row
      })
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))

  return {
    usedBy: toRows(neighborhood.dependents, neighborhood.dependentCounts, neighborhood.dependentRelations),
    uses: toRows(neighborhood.dependencies, neighborhood.dependencyCounts, neighborhood.dependencyRelations),
  }
}

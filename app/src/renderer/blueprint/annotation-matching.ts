/**
 * Blueprint annotation ↔ node matching — pure logic (no DOM) mirroring the
 * CLI's `anchorReferencesNode` in `src/cli/commands/blueprint.ts` (the CLI
 * workspace is the source of truth for the matching rules; keep in sync).
 *
 * Also home to the CLI-endpoint rollup used by the node board: all
 * `endpoint` nodes detected from the commander CLI surface collapse into a
 * single "CLI surface" card instead of one card per subcommand.
 */
import type {
  BlueprintAnchor,
  BlueprintAnnotation,
  BlueprintNode,
} from '../../shared/ipc-contract'

/**
 * Whether a repo-relative file path matches a graph node.
 *
 * Containment semantics: a path matches when it equals the node's
 * `sourceFile` exactly, OR the node is a module and the path lives under the
 * module's directory (`path.startsWith(sourceFile + '/')`). Module nodes are
 * directory-granularity (e.g. `sourceFile: 'src/cli'`) while anchors carry
 * file-level paths, so exact equality alone would show 0 annotations for
 * module nodes. Non-module nodes still require exact equality.
 *
 * Mirrors the CLI's `fileMatchesNode` in `src/cli/blueprint/anchors.ts` —
 * the two copies MUST stay in sync.
 */
export function fileMatchesNode(path: string, node: BlueprintNode): boolean {
  if (node.sourceFile === path) {
    return true
  }
  return node.kind === 'module' && path.startsWith(`${node.sourceFile}/`)
}

/**
 * Whether an anchor references a graph node. An anchor matches when its ref
 * equals the node id (raw or kind-prefixed, e.g. `module:<ref>`), the node
 * symbol, the node source file, or one of the node's datastore tables.
 * Module anchors additionally match on the node's label (directory
 * basename) — the legacy-id bridge for anchors written against the old
 * basename module ids (`module:cli` → ref `cli`; ids are now path-based,
 * `module:src/cli`).
 * File refs and symbol-anchor `file` scopes use `fileMatchesNode` containment
 * (exact `sourceFile`, or under a module node's directory).
 */
export function anchorReferencesNode(anchor: BlueprintAnchor, node: BlueprintNode): boolean {
  if (anchor.ref === node.id || `${anchor.kind}:${anchor.ref}` === node.id) {
    return true
  }
  // Legacy module-id bridge (mirrors the CLI's `resolveAnchor`): module ids
  // are path-based (`module:src/cli`) but old anchors carry the basename
  // (`cli`) — the basename is now the node's label. The sourceFile form
  // (directory path) is covered by the `anchor.ref === node.sourceFile`
  // check below.
  if (anchor.kind === 'module' && node.kind === 'module' && anchor.ref === node.label) {
    return true
  }
  if (node.symbol !== undefined && anchor.ref === node.symbol) {
    return true
  }
  if (anchor.kind === 'file' && fileMatchesNode(anchor.ref, node)) {
    return true
  }
  if (anchor.file !== undefined && fileMatchesNode(anchor.file, node)) {
    return true
  }
  if (anchor.ref === node.sourceFile) {
    return true
  }
  const tables = node.meta?.tables
  return Array.isArray(tables) && tables.includes(anchor.ref)
}

/** All annotations with at least one anchor referencing `node`. */
export function annotationsForNode(
  annotations: BlueprintAnnotation[],
  node: BlueprintNode,
): BlueprintAnnotation[] {
  return annotations.filter((entry) =>
    entry.anchors.some((anchor) => anchorReferencesNode(anchor, node)),
  )
}

/**
 * All annotations referencing ANY of `nodes`, deduplicated (one annotation
 * may anchor several member nodes of a rollup) — used by the CLI-surface
 * card's aggregated drawer.
 */
export function annotationsForNodes(
  annotations: BlueprintAnnotation[],
  nodes: BlueprintNode[],
): BlueprintAnnotation[] {
  return annotations.filter((entry) =>
    entry.anchors.some((anchor) => nodes.some((node) => anchorReferencesNode(anchor, node))),
  )
}

/** Whether an endpoint node is part of the commander CLI surface. */
export function isCliEndpoint(node: BlueprintNode): boolean {
  if (node.kind !== 'endpoint') {
    return false
  }
  return node.meta?.detectedVia === 'commander' || node.id.startsWith('endpoint:cli ')
}

/** Display name for a CLI endpoint (its subcommand), e.g. `derive`. */
export function cliCommandName(node: BlueprintNode): string {
  const route = node.meta?.route
  if (typeof route === 'string' && route.length > 0) {
    return route
  }
  return node.label.replace(/^cli\s+/, '')
}

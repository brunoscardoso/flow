/**
 * Blueprint flow-board model — pure assembly + geometry (no DOM, no sqlite).
 * The CODE MAP collapses the full derived graph (~90 nodes, 271 edges) into a
 * legible stage: displayable depth-1 module nodes over the ground, a left band
 * of integrations, a bottom band of datastores + a single rolled-up CLI
 * surface, inline dashed proposal "ghosts", and aggregated cross-module wires.
 *
 * Two pure stages, both deterministic (stable sorts, no wall-clock, no random):
 *
 *   1. rollupGraph(graph, proposals, focusPath?) → RolledGraph
 *      Rolls the graph up to the displayed nodes: aggregates cross-module
 *      imports/calls/uses edges into weighted wires, attaches always-visible
 *      periphery (integrations / datastores / CLI surface), folds proposals
 *      into capped ghost nodes, and rolls mustReview items onto their
 *      displayed ancestor. Layout-agnostic — WHAT is on the board.
 *
 *   2. layoutRollupAsTerritory(rolled, stage) → TerritoryStageLayout
 *      Pure geometry over a RolledGraph: a treemap of module cells whose area
 *      is their subtree's file count, plus the two fixed periphery bands and
 *      the wire endpoints between them. WHERE it sits.
 *
 * The folder spine (contains edges) is the ONLY hierarchy source, walked with
 * first-parent-wins dedup and module→module edges only.
 */
import type {
  BlueprintEffectiveProposal,
  BlueprintGraph,
  BlueprintMustReviewSeverity,
  BlueprintNode,
  BlueprintNodeKind,
  BlueprintProposalState,
} from '../../shared/ipc-contract'
import { isCliEndpoint } from './annotation-matching'
import { moduleNodeIdForPath as moduleOwnerForPath } from '../../shared/module-owner'
import { inset, strips, type Rect } from './territory-layout'
import { CELL_INSET, CELL_INSET_IN_GROUP } from './territory-view'

// ── Caps ───────────────────────────────────────────────────────────────
/** Max displayable module nodes per stage; beyond → keep highest-degree. */
export const MAX_MODULE_NODES = 18
/**
 * Direct child modules a Territory cell nests inside itself, at most.
 *
 * Nine districts inside one province is a pattern; twenty is a texture. The cap
 * keeps the nested strip legible on the smallest cell that draws one, and
 * `childCount` — the honest total — is untouched by it.
 */
export const MAX_NESTED_CHILDREN = 8
/** Max inline proposal ghosts; beyond → overflow record. */
export const MAX_GHOST_NODES = 6

// ── Model constants ──────────────────────────────────────────────────────
/** Pseudo-node id/label for the single rolled-up CLI command surface. */
export const CLI_SURFACE_ID = 'cli-surface'

/** Display id prefix for rolled-up endpoint path groups (#901). */
export const ENDPOINT_GROUP_PREFIX = 'endpoint-group:'

/** Cap on rendered endpoint-group cards; beyond it, groups aggregate into
 *  per-top-segment SURFACE cards (#904) — never a silent drop. */
const MAX_ENDPOINT_GROUP_CARDS = 12

/** The display group id for an endpoint carrying meta.pathGroup, or null. */
export function endpointGroupIdOf(node: BlueprintNode): string | null {
  if (node.kind !== 'endpoint') return null
  const pathGroup = node.meta?.pathGroup
  return typeof pathGroup === 'string' && pathGroup.length > 0
    ? `${ENDPOINT_GROUP_PREFIX}${pathGroup}`
    : null
}

/** The surface key of a pathGroup: its FIRST segment (`/api/coworkers` → `/api`),
 *  `graphql` staying itself (#904 second-level aggregation). */
export function surfaceKeyOf(pathGroup: string): string {
  if (!pathGroup.startsWith('/')) return pathGroup
  const first = pathGroup.split('/').filter((segment) => segment.length > 0)[0]
  return first === undefined ? pathGroup : `/${first}`
}

/** Display id of the overflow card holding every surface beyond the cap. */
export const ENDPOINT_OVERFLOW_ID = `${ENDPOINT_GROUP_PREFIX}(other)`

/**
 * Deterministic surface ranking for a graph's grouped endpoints: surface key →
 * member count, sorted biggest-first (ties by key). ONE ranking shared by the
 * rollup's cap and the overflow card's Routes resolution (#14) so both always
 * agree on which surfaces folded into "(other)".
 */
export function rankedSurfaceKeys(graph: BlueprintGraph | null): string[] {
  if (graph === null) return []
  const counts = new Map<string, number>()
  for (const node of graph.nodes) {
    const pathGroup = node.kind === 'endpoint' ? node.meta?.pathGroup : undefined
    if (typeof pathGroup !== 'string' || pathGroup.length === 0) continue
    const key = surfaceKeyOf(pathGroup)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.keys()].sort(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b),
  )
}

/** Displayed card id for a grouped endpoint: its group card if displayed, else
 *  its surface card if displayed, else null. ONE resolution chain (#14). */
function groupedDisplayIdOf(
  node: BlueprintNode,
  isDisplayed: (id: string) => boolean,
): string | null {
  const groupId = endpointGroupIdOf(node)
  if (groupId === null) return null
  if (isDisplayed(groupId)) return groupId
  const surfaceId = `${ENDPOINT_GROUP_PREFIX}${surfaceKeyOf(groupId.slice(ENDPOINT_GROUP_PREFIX.length))}`
  if (isDisplayed(surfaceId)) return surfaceId
  // Below-the-cap surfaces fold into the "(other)" card — wires follow.
  return isDisplayed(ENDPOINT_OVERFLOW_ID) ? ENDPOINT_OVERFLOW_ID : null
}

/**
 * The concrete routes behind one endpoint-group card, for the popover's
 * Routes list (#901). Sorted: queries before mutations before REST methods,
 * then label. Pure/DOM-free.
 */
export interface EndpointGroupRoute {
  label: string
  sourceFile: string
}

export function endpointGroupRoutes(
  graph: BlueprintGraph | null,
  groupId: string,
): EndpointGroupRoute[] {
  if (graph === null || !groupId.startsWith(ENDPOINT_GROUP_PREFIX)) return []
  const key = groupId.slice(ENDPOINT_GROUP_PREFIX.length)
  // The overflow card owns every surface ranked below the rendered cap —
  // recomputed from the SAME ranking the rollup used, so they always agree.
  const overflowKeys =
    key === '(other)' ? new Set(rankedSurfaceKeys(graph).slice(MAX_ENDPOINT_GROUP_CARDS - 1)) : null
  const routes: EndpointGroupRoute[] = []
  for (const node of graph.nodes) {
    const pathGroup = node.kind === 'endpoint' ? node.meta?.pathGroup : undefined
    if (typeof pathGroup !== 'string' || pathGroup.length === 0) continue
    // A card id matches its exact group OR, for surface cards, every group
    // sharing its first segment (#904) — the overflow card matches every
    // surface that folded into it.
    const matches =
      overflowKeys !== null
        ? overflowKeys.has(surfaceKeyOf(pathGroup))
        : pathGroup === key || surfaceKeyOf(pathGroup) === key
    if (matches) {
      routes.push({ label: node.label, sourceFile: node.sourceFile })
    }
  }
  return routes.sort((a, b) => a.label.localeCompare(b.label))
}

/** Group-card label/sublabel from its members (graphql counts operations). */
function endpointGroupCard(groupId: string, members: BlueprintNode[]): FlowNode {
  const pathGroup = groupId.slice(ENDPOINT_GROUP_PREFIX.length)
  if (pathGroup === 'graphql') {
    let queries = 0
    let mutations = 0
    for (const member of members) {
      if (member.meta?.operation === 'mutation') mutations += 1
      else queries += 1
    }
    return {
      id: groupId,
      kind: 'endpoint',
      label: 'graphql',
      sublabel: `${queries} ${queries === 1 ? 'query' : 'queries'} · ${mutations} ${mutations === 1 ? 'mutation' : 'mutations'}`,
    }
  }
  if (pathGroup === '(partial)') {
    // Unmounted-router routes (fastapi pack): honest umbrella, one card.
    return {
      id: groupId,
      kind: 'endpoint',
      label: 'partial paths',
      sublabel: `${members.length} route${members.length === 1 ? '' : 's'} · mount unknown`,
    }
  }
  return {
    id: groupId,
    kind: 'endpoint',
    label: `${pathGroup}/*`,
    sublabel: `${members.length} route${members.length === 1 ? '' : 's'}`,
  }
}
const CLI_SURFACE_LABEL = 'CLI surface'
/** Relations that aggregate into module↔module wires (never contains/exposes). */
const MODULE_WIRE_RELATIONS = new Set(['imports', 'calls', 'uses'])
/** Relations that attach a periphery node to a displayed module. */
const PERIPHERY_WIRE_RELATIONS = new Set(['uses', 'exposes'])
const PERIPHERY_KINDS = new Set<BlueprintNodeKind>(['integration', 'endpoint', 'datastore'])
/** Proposal states that render as dashed ghost nodes. */
const GHOST_STATES = new Set<BlueprintProposalState>(['proposed', 'accepted', 'rejected'])
const MODULE_ID_PREFIX = 'module:'
/** Higher = louder; drives which mustReview item badges a rolled-up node. */
const SEVERITY_RANK: Record<BlueprintMustReviewSeverity, number> = {
  crit: 3,
  high: 2,
  ask: 1,
  info: 0,
}

/**
 * God-node "must review" rows were removed from the CLI (the Drift feature
 * supersedes them — node degree is now a ranker, not a review row). Projects
 * derived BEFORE that change still carry the rows in a persisted `graph.json`,
 * so filter them out in the renderer — old projects read clean without waiting
 * for a re-derive. Matches the CLI's exact god-node title.
 */
export function isSunsetMustReviewItem(item: { title: string }): boolean {
  return item.title.startsWith('God node touched:')
}
/** Deterministic node ordering: modules, then periphery, then endpoints. */
const KIND_ORDER: Record<BlueprintNodeKind, number> = {
  module: 0,
  integration: 1,
  datastore: 2,
  endpoint: 3,
  project: 4,
}

// ── Rollup output types ──────────────────────────────────────────────────
export interface FlowMustReview {
  severity: BlueprintMustReviewSeverity
  title: string
  count: number
}

export interface FlowNode {
  /** Displayed-node id (a real node id, `cli-surface`, or a ghost's predicted id). */
  id: string
  kind: BlueprintNodeKind
  label: string
  /** Secondary line (CLI command count, ghost plan name); omitted when empty. */
  sublabel?: string
  /** True for proposal ghosts (dashed render, no wires). */
  ghost?: boolean
  /** Ghost lifecycle state (proposed | accepted | rejected). */
  ghostState?: BlueprintProposalState
  /** Rolled-up mustReview badge (loudest severity, its title, total count). */
  mustReview?: FlowMustReview
  /** Direct child modules in the spine — a drill-down affordance. */
  childCount?: number
  /** Degree used for column ranking (meta.degree, else incident-wire count). */
  weight?: number
  /**
   * SOURCE FILES UNDER THIS MODULE, its whole subtree included — the measure
   * Territory gives the rollup its AREA from (Phase 7).
   *
   * The subtree sum rather than `meta.fileCount` alone, so a parent is never
   * drawn smaller than the children nested inside it. Absent for every kind but
   * `module`: a datastore or an integration has no file count, and a BAND cell's
   * area means nothing anyway (it is a fixed strip, not a measure).
   */
  fileCount?: number
  /**
   * The direct child modules Territory nests inside this cell, biggest first
   * and capped at `MAX_NESTED_CHILDREN`.
   *
   * A drawn subset, never the whole spine: `childCount` stays the honest total
   * and the sublabel still reads from it, so the card cannot claim a module has
   * eight children because eight is all that fit.
   */
  children?: FlowChild[]
}

/** One nested child cell's data — the id it drills to and the area it is owed. */
export interface FlowChild {
  id: string
  label: string
  /** Source files under the child's own subtree — its layout value. */
  fileCount: number
  /** Its OWN direct child modules — what makes a district drillable in turn. */
  childCount: number
}

export interface FlowWire {
  /** Displayed source node id. */
  from: string
  /** Displayed target node id. */
  to: string
  /** Merged count of underlying edges (duplicates collapse into one wire). */
  weight: number
  /** Sorted unique relations that contributed to this wire. */
  relations: string[]
}

export interface FlowOverflow {
  modules: { droppedCount: number; keptCount: number }
  ghosts: { droppedCount: number; plans: string[] }
}

export interface RolledGraph {
  nodes: FlowNode[]
  wires: FlowWire[]
  overflow: FlowOverflow
}

function emptyRolled(): RolledGraph {
  return {
    nodes: [],
    wires: [],
    overflow: { modules: { droppedCount: 0, keptCount: 0 }, ghosts: { droppedCount: 0, plans: [] } },
  }
}

function compareFlowNodes(a: FlowNode, b: FlowNode): number {
  const byGhost = (a.ghost ? 1 : 0) - (b.ghost ? 1 : 0)
  if (byGhost !== 0) return byGhost
  const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  if (byKind !== 0) return byKind
  const byLabel = a.label.localeCompare(b.label)
  return byLabel !== 0 ? byLabel : a.id.localeCompare(b.id)
}

/**
 * THE ONE SHAPE A PROPOSAL TAKES WHEN IT IS DRAWN — exported because two
 * surfaces build it now.
 *
 * `rollupGraph` builds a ghost for the code map; the territory sheet builds one
 * for a ghost CELL the reader pressed, so the popover can show the same
 * lifecycle row and plan badge from the same fields. Two copies of "what a
 * proposal looks like as a node" is how the two surfaces would start disagreeing
 * about a prediction's kind (allowed-pattern #14).
 */
export function ghostFlowNode(proposal: BlueprintEffectiveProposal): FlowNode {
  return {
    id: proposal.predictedNodeId,
    kind: ghostKind(proposal),
    label: proposal.label,
    sublabel: proposal.plan,
    ghost: true,
    ghostState: proposal.state,
  }
}

/** Ghost kind from the predicted id prefix, falling back to the proposal kind. */
function ghostKind(proposal: BlueprintEffectiveProposal): BlueprintNodeKind {
  const prefix = proposal.predictedNodeId.split(':', 1)[0]
  if (prefix === 'module' || prefix === 'integration' || prefix === 'endpoint' || prefix === 'datastore') {
    return prefix
  }
  return proposal.kind
}

/**
 * Roll the derived graph up to the board's displayed surface. Pure and
 * deterministic. Fail-soft: a null/empty graph returns an empty rolled graph.
 *
 * @param graph      derived system graph (or null/undefined when unavailable)
 * @param proposals  effective proposals (ghosts) — defaults to none
 * @param focusPath  optional drill-down: show the direct child modules of this
 *                   path instead of the depth-1 modules (`app/src/main` or the
 *                   `module:app/src/main` id form)
 */
export interface FederationInput {
  crossLinks: ReadonlyArray<{
    provider: string
    endpoint: string
    status: 'proposed' | 'confirmed' | 'rejected' | 'stale'
    files: string[]
  }>
  siblings: ReadonlyArray<{ name: string; surfaceDerivedAt: string; endpointCount: number }>
}

/** Peer-card age label: `6d ago` / `3h ago` / `just now` / `never derived`. */
export function surfaceAgeLabel(derivedAt: string, now: Date): string {
  if (derivedAt === '') return 'never derived'
  const ms = now.getTime() - new Date(derivedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return 'just now'
  const hours = ms / 3_600_000
  if (hours < 1) return 'just now'
  if (hours < 48) return `${Math.round(hours)}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export function rollupGraph(
  graph: BlueprintGraph | null | undefined,
  proposals: readonly BlueprintEffectiveProposal[] = [],
  focusPath?: string,
  federation?: FederationInput,
  now?: Date,
): RolledGraph {
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    return emptyRolled()
  }

  const nodesById = new Map<string, BlueprintNode>()
  for (const node of graph.nodes) nodesById.set(node.id, node)

  // ── Folder spine: module→module contains edges (first parent wins) ───────
  const parentMap = new Map<string, string>()
  const childCountMap = new Map<string, number>()
  const childrenMap = new Map<string, string[]>()
  for (const edge of graph.edges) {
    if (edge.relation !== 'contains') continue
    const parent = nodesById.get(edge.source)
    const child = nodesById.get(edge.target)
    if (!parent || !child || parent.kind !== 'module' || child.kind !== 'module' || parent === child) continue
    if (parentMap.has(child.id)) continue
    parentMap.set(child.id, parent.id)
    childCountMap.set(parent.id, (childCountMap.get(parent.id) ?? 0) + 1)
    const siblings = childrenMap.get(parent.id)
    if (siblings === undefined) childrenMap.set(parent.id, [child.id])
    else siblings.push(child.id)
  }

  // ── Area: source files under a module, its whole subtree included (Phase 7) ─
  // Memoized over the spine that was just built, so the walk is linear however
  // deep the tree is and a node visited twice costs nothing the second time.
  const subtreeFiles = new Map<string, number>()
  const filesUnder = (id: string, guard: Set<string> = new Set()): number => {
    const cached = subtreeFiles.get(id)
    if (cached !== undefined) return cached
    if (guard.has(id)) return 0 // a cyclic `contains` pair can never be a tree
    guard.add(id)
    const meta = nodesById.get(id)?.meta
    const direct = typeof meta?.fileCount === 'number' ? meta.fileCount : 0
    const rolled = typeof meta?.rolledUpFiles === 'number' ? meta.rolledUpFiles : 0
    let total = direct + rolled
    for (const childId of childrenMap.get(id) ?? []) total += filesUnder(childId, guard)
    guard.delete(id)
    subtreeFiles.set(id, total)
    return total
  }

  // ── Displayed module candidates ──────────────────────────────────────────
  // Default: depth-1 modules (fallback: spine roots when depth is absent).
  // Focus: the direct child modules of the focused path.
  const displayed = new Set<string>()
  const focusId = normalizeFocusId(focusPath)
  if (focusId !== null) {
    for (const [childId, parentId] of parentMap) {
      if (parentId === focusId && nodesById.get(childId)?.kind === 'module') displayed.add(childId)
    }
  } else {
    for (const node of graph.nodes) {
      if (node.kind === 'module' && node.meta?.depth === 1) displayed.add(node.id)
    }
    if (displayed.size === 0) {
      for (const node of graph.nodes) {
        if (node.kind === 'module' && !parentMap.has(node.id)) displayed.add(node.id)
      }
    }
  }

  // ── Ancestor resolution: any node id → its displayed ancestor (or null) ──
  const resolveCache = new Map<string, string | null>()
  const resolveModuleAncestor = (id: string): string | null => {
    const cached = resolveCache.get(id)
    if (cached !== undefined) return cached
    const seen = new Set<string>()
    let cur: string | undefined = id
    let result: string | null = null
    while (cur !== undefined && !seen.has(cur)) {
      if (displayed.has(cur)) {
        result = cur
        break
      }
      seen.add(cur)
      cur = parentMap.get(cur)
    }
    resolveCache.set(id, result)
    return result
  }

  // ── Degree ranking (meta.degree, else incident non-contains edges) ────────
  const rankDegree = new Map<string, number>()
  for (const id of displayed) rankDegree.set(id, 0)
  for (const edge of graph.edges) {
    if (edge.relation === 'contains') continue
    const sourceNode = nodesById.get(edge.source)
    const targetNode = nodesById.get(edge.target)
    const sourceDisplay = sourceNode?.kind === 'module' ? resolveModuleAncestor(edge.source) : null
    const targetDisplay = targetNode?.kind === 'module' ? resolveModuleAncestor(edge.target) : null
    if (sourceDisplay) rankDegree.set(sourceDisplay, (rankDegree.get(sourceDisplay) ?? 0) + 1)
    if (targetDisplay && targetDisplay !== sourceDisplay) {
      rankDegree.set(targetDisplay, (rankDegree.get(targetDisplay) ?? 0) + 1)
    }
  }
  for (const id of displayed) {
    const metaDegree = nodesById.get(id)?.meta?.degree
    if (typeof metaDegree === 'number') rankDegree.set(id, metaDegree)
  }

  // ── Module cap: keep highest-degree, stable id tiebreak ──────────────────
  const candidateCount = displayed.size
  let moduleOverflow = { droppedCount: 0, keptCount: candidateCount }
  if (candidateCount > MAX_MODULE_NODES) {
    const kept = [...displayed]
      .sort((a, b) => (rankDegree.get(b) ?? 0) - (rankDegree.get(a) ?? 0) || a.localeCompare(b))
      .slice(0, MAX_MODULE_NODES)
    displayed.clear()
    for (const id of kept) displayed.add(id)
    moduleOverflow = { droppedCount: candidateCount - kept.length, keptCount: kept.length }
    resolveCache.clear() // displayed set changed — invalidate memo
  }

  // ── Periphery: always-displayable integrations / datastores / CLI surface ─
  const peripheryNodes = new Map<string, FlowNode>()
  const groupedEndpoints = new Map<string, BlueprintNode[]>()
  let cliCommandCount = 0
  for (const node of graph.nodes) {
    if (node.kind === 'integration' || node.kind === 'datastore') {
      peripheryNodes.set(node.id, { id: node.id, kind: node.kind, label: node.label })
    } else if (node.kind === 'endpoint') {
      const groupId = endpointGroupIdOf(node)
      if (groupId !== null) {
        const members = groupedEndpoints.get(groupId)
        if (members === undefined) groupedEndpoints.set(groupId, [node])
        else members.push(node)
      } else if (isCliEndpoint(node)) {
        cliCommandCount += 1
      } else {
        peripheryNodes.set(node.id, { id: node.id, kind: 'endpoint', label: node.label })
      }
    }
  }
  // Path-group rollup (#901): one card per group, biggest groups first. When
  // even the GROUPS overflow the band (#904 — orbit's 40+ /api/* groups),
  // aggregate one level higher: ONE surface card per top path segment
  // (`/api/*` · 346 routes · 41 groups). graphql always keeps its own card.
  {
    const groupIds = [...groupedEndpoints.keys()].sort((a, b) => {
      const sizeDelta = (groupedEndpoints.get(b)?.length ?? 0) - (groupedEndpoints.get(a)?.length ?? 0)
      return sizeDelta !== 0 ? sizeDelta : a.localeCompare(b)
    })
    if (groupIds.length > MAX_ENDPOINT_GROUP_CARDS) {
      const surfaces = new Map<string, { members: BlueprintNode[]; groupCount: number }>()
      for (const groupId of groupIds) {
        const pathGroup = groupId.slice(ENDPOINT_GROUP_PREFIX.length)
        const surfaceKey = surfaceKeyOf(pathGroup)
        const surface = surfaces.get(surfaceKey) ?? { members: [], groupCount: 0 }
        surface.members.push(...(groupedEndpoints.get(groupId) ?? []))
        surface.groupCount += 1
        surfaces.set(surfaceKey, surface)
      }
      const surfaceKeys = [...surfaces.keys()].sort(
        (a, b) =>
          (surfaces.get(b)?.members.length ?? 0) - (surfaces.get(a)?.members.length ?? 0) ||
          a.localeCompare(b),
      )
      // HARD cap (#endpoint-band-overflow): a repo whose partial/one-off
      // surfaces all have distinct first segments (orbit-core's 30+) would
      // still flood the band. Render the top surfaces; everything below the
      // cap folds into ONE "(other)" card whose Routes popover lists it all —
      // never a silent drop, never an unreadable band.
      const rendered = surfaceKeys.slice(0, MAX_ENDPOINT_GROUP_CARDS - 1)
      const folded = surfaceKeys.slice(MAX_ENDPOINT_GROUP_CARDS - 1)
      for (const surfaceKey of rendered) {
        const surface = surfaces.get(surfaceKey)
        if (surface === undefined) continue
        const surfaceId = `${ENDPOINT_GROUP_PREFIX}${surfaceKey}`
        if (surfaceKey === 'graphql' || surfaceKey === '(partial)') {
          peripheryNodes.set(surfaceId, endpointGroupCard(surfaceId, surface.members))
        } else {
          peripheryNodes.set(surfaceId, {
            id: surfaceId,
            kind: 'endpoint',
            label: `${surfaceKey}/*`,
            sublabel: `${surface.members.length} route${surface.members.length === 1 ? '' : 's'} · ${surface.groupCount} group${surface.groupCount === 1 ? '' : 's'}`,
          })
        }
      }
      if (folded.length > 0) {
        let foldedRoutes = 0
        let foldedGroups = 0
        for (const surfaceKey of folded) {
          foldedRoutes += surfaces.get(surfaceKey)?.members.length ?? 0
          foldedGroups += surfaces.get(surfaceKey)?.groupCount ?? 0
        }
        peripheryNodes.set(ENDPOINT_OVERFLOW_ID, {
          id: ENDPOINT_OVERFLOW_ID,
          kind: 'endpoint',
          label: `+${folded.length} more surfaces`,
          sublabel: `${foldedRoutes} route${foldedRoutes === 1 ? '' : 's'} · ${foldedGroups} group${foldedGroups === 1 ? '' : 's'}`,
        })
      }
    } else {
      for (const groupId of groupIds) {
        peripheryNodes.set(groupId, endpointGroupCard(groupId, groupedEndpoints.get(groupId) ?? []))
      }
    }
  }
  // Cross-project peer cards (federation): one card per sibling with any
  // non-rejected link — confirmed/stale links make a solid card, proposed-only
  // renders as a ghost (never alarms). Wires come from the consuming modules.
  const peerWireSources = new Map<string, Map<string, number>>()
  if (federation !== undefined) {
    const byProvider = new Map<string, { proposed: number; confirmed: number; files: string[] }>()
    for (const link of federation.crossLinks) {
      if (link.status === 'rejected') continue
      const entry = byProvider.get(link.provider) ?? { proposed: 0, confirmed: 0, files: [] }
      if (link.status === 'proposed') entry.proposed += 1
      else entry.confirmed += 1
      entry.files.push(...link.files)
      byProvider.set(link.provider, entry)
    }
    const siblingByName = new Map(federation.siblings.map((sibling) => [sibling.name, sibling]))
    for (const [provider, tally] of [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const sibling = siblingByName.get(provider)
      const consumed = tally.confirmed + tally.proposed
      const age = surfaceAgeLabel(sibling?.surfaceDerivedAt ?? '', now ?? new Date(0))
      peripheryNodes.set(`project:${provider}`, {
        id: `project:${provider}`,
        kind: 'project',
        label: provider,
        sublabel: `${consumed} consumed · surface ${age}`,
        ...(tally.confirmed === 0 ? { ghost: true } : {}),
      })
      // Wires: consuming file → deepest module → weight per file occurrence.
      const weights = new Map<string, number>()
      for (const file of tally.files) {
        const moduleId = moduleOwnerForPath(graph, file)
        if (moduleId === null) continue
        weights.set(moduleId, (weights.get(moduleId) ?? 0) + 1)
      }
      peerWireSources.set(`project:${provider}`, weights)
    }
  }

  if (cliCommandCount > 0) {
    peripheryNodes.set(CLI_SURFACE_ID, {
      id: CLI_SURFACE_ID,
      kind: 'endpoint',
      label: CLI_SURFACE_LABEL,
      sublabel: `${cliCommandCount} command${cliCommandCount === 1 ? '' : 's'}`,
    })
  }

  // Resolve an edge endpoint to its displayed id (module ancestor or periphery).
  const resolveEndpoint = (id: string): { displayId: string; isModule: boolean } | null => {
    const node = nodesById.get(id)
    if (!node) return null
    if (node.kind === 'module') {
      const ancestor = resolveModuleAncestor(id)
      return ancestor ? { displayId: ancestor, isModule: true } : null
    }
    if (PERIPHERY_KINDS.has(node.kind)) {
      const grouped = node.kind === 'endpoint' ? groupedDisplayIdOf(node, (id) => peripheryNodes.has(id)) : null
      const displayId =
        grouped !== null
          ? grouped
          : node.kind === 'endpoint' && isCliEndpoint(node)
            ? CLI_SURFACE_ID
            : node.id
      return { displayId, isModule: false }
    }
    return null
  }

  // ── Wire aggregation (module↔module + module↔periphery, merged + weighted) ─
  const wireMap = new Map<string, { from: string; to: string; weight: number; relations: Set<string> }>()
  for (const edge of graph.edges) {
    if (edge.relation === 'contains') continue
    const source = resolveEndpoint(edge.source)
    const target = resolveEndpoint(edge.target)
    if (!source || !target || source.displayId === target.displayId) continue

    const bothModules = source.isModule && target.isModule
    const moduleToPeriphery = source.isModule !== target.isModule
    let allowed: boolean
    if (bothModules) {
      allowed = MODULE_WIRE_RELATIONS.has(edge.relation)
    } else if (moduleToPeriphery) {
      allowed = PERIPHERY_WIRE_RELATIONS.has(edge.relation)
    } else {
      allowed = false // periphery↔periphery never wires
    }
    if (!allowed) continue

    // Periphery wires always orient module → periphery.
    let from: string
    let to: string
    if (moduleToPeriphery) {
      from = source.isModule ? source.displayId : target.displayId
      to = source.isModule ? target.displayId : source.displayId
    } else {
      from = source.displayId
      to = target.displayId
    }
    const key = `${from}\x00${to}`
    const existing = wireMap.get(key)
    if (existing) {
      existing.weight += 1
      existing.relations.add(edge.relation)
    } else {
      wireMap.set(key, { from, to, weight: 1, relations: new Set([edge.relation]) })
    }
  }

  // ── mustReview rollup onto displayed ancestors ───────────────────────────
  const reviewAgg = new Map<string, { severity: BlueprintMustReviewSeverity; rank: number; title: string; count: number }>()
  for (const item of graph.mustReview ?? []) {
    if (isSunsetMustReviewItem(item)) continue
    if (!item.nodeId) continue
    const node = nodesById.get(item.nodeId)
    if (!node) continue
    let displayId: string | null = null
    if (node.kind === 'module') {
      displayId = resolveModuleAncestor(item.nodeId)
    } else if (PERIPHERY_KINDS.has(node.kind)) {
      const grouped = node.kind === 'endpoint' ? groupedDisplayIdOf(node, (id) => peripheryNodes.has(id)) : null
      displayId =
        grouped !== null
          ? grouped
          : node.kind === 'endpoint' && isCliEndpoint(node)
            ? CLI_SURFACE_ID
            : node.id
    }
    if (!displayId) continue
    if (!displayed.has(displayId) && !peripheryNodes.has(displayId)) continue
    const rank = SEVERITY_RANK[item.severity] ?? 0
    const existing = reviewAgg.get(displayId)
    if (!existing) {
      reviewAgg.set(displayId, { severity: item.severity, rank, title: item.title, count: 1 })
    } else {
      existing.count += 1
      if (rank > existing.rank) {
        existing.rank = rank
        existing.severity = item.severity
        existing.title = item.title
      }
    }
  }

  // ── Ghosts: proposals in proposed|accepted|rejected, capped at MAX_GHOST_NODES ─
  const ghostCandidates = proposals
    .filter((p) => GHOST_STATES.has(p.state) && !nodesById.has(p.predictedNodeId))
    .slice()
    .sort((a, b) => a.plan.localeCompare(b.plan) || a.predictedNodeId.localeCompare(b.predictedNodeId))
  const keptGhosts = ghostCandidates.slice(0, MAX_GHOST_NODES)
  const droppedGhosts = ghostCandidates.slice(MAX_GHOST_NODES)
  const ghostOverflow = {
    droppedCount: droppedGhosts.length,
    plans: [...new Set(droppedGhosts.map((g) => g.plan))].sort(),
  }
  const ghostNodes: FlowNode[] = keptGhosts.map(ghostFlowNode)

  // ── Assemble displayed nodes (modules + periphery + ghosts) ──────────────
  const attachReview = (base: FlowNode): FlowNode => {
    const review = reviewAgg.get(base.id)
    return review
      ? { ...base, mustReview: { severity: review.severity, title: review.title, count: review.count } }
      : base
  }
  const nodes: FlowNode[] = []
  for (const id of displayed) {
    const node = nodesById.get(id)
    if (!node) continue
    const nested = (childrenMap.get(id) ?? [])
      .map((childId) => ({
        id: childId,
        label: nodesById.get(childId)?.label ?? childId,
        fileCount: filesUnder(childId),
        childCount: childCountMap.get(childId) ?? 0,
      }))
      .sort((a, b) => b.fileCount - a.fileCount || a.id.localeCompare(b.id))
      .slice(0, MAX_NESTED_CHILDREN)
    nodes.push(
      attachReview({
        id,
        kind: 'module',
        label: node.label,
        childCount: childCountMap.get(id) ?? 0,
        weight: rankDegree.get(id) ?? 0,
        fileCount: filesUnder(id),
        ...(nested.length > 0 ? { children: nested } : {}),
      }),
    )
  }
  for (const peripheryNode of peripheryNodes.values()) {
    nodes.push(attachReview(peripheryNode))
  }
  nodes.push(...ghostNodes)
  nodes.sort(compareFlowNodes)

  // Every displayed wire renders (#911 — value-first): the volume of edges
  // between two points IS the signal. Density reads through stroke weight,
  // not through dropping wires.
  // Peer-card wires (federation): consuming module → project card, weight =
  // matched-call count. Modules hidden by the current view resolve up.
  for (const [peerId, weights] of peerWireSources) {
    for (const [moduleId, weight] of weights) {
      const resolvedModule = resolveModuleAncestor(moduleId)
      if (resolvedModule === null || !displayed.has(resolvedModule)) continue
      const key = `${resolvedModule}\u0000${peerId}`
      const existing = wireMap.get(key)
      if (existing === undefined) {
        wireMap.set(key, { from: resolvedModule, to: peerId, weight, relations: new Set(['uses']) })
      } else {
        existing.weight += weight
      }
    }
  }

  const wires: FlowWire[] = [...wireMap.values()]
    .map((w) => ({ from: w.from, to: w.to, weight: w.weight, relations: [...w.relations].sort() }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  return { nodes, wires, overflow: { modules: moduleOverflow, ghosts: ghostOverflow } }
}

/** Normalize a focus path to a `module:` id, or null when no focus is set. */
function normalizeFocusId(focusPath: string | undefined): string | null {
  if (focusPath === undefined || focusPath === '') return null
  return focusPath.startsWith(MODULE_ID_PREFIX) ? focusPath : `${MODULE_ID_PREFIX}${focusPath}`
}

// ── Drill breadcrumb + live-reload pruning (blueprint-v2 Phase 3) ────────────

/** One breadcrumb rail crumb: a displayed module ancestor of the drill focus. */
export interface FocusCrumb {
  /** The module node id (`module:<dir>`). */
  id: string
  /** Basename label (the node's own label), for the rail. */
  label: string
}

/** Build the module `contains` spine (first-parent-wins) from a graph. */
function buildParentSpine(graph: BlueprintGraph | null | undefined): Map<string, string> {
  const parentMap = new Map<string, string>()
  if (!graph || !Array.isArray(graph.nodes)) return parentMap
  const nodesById = new Map<string, BlueprintNode>()
  for (const node of graph.nodes) nodesById.set(node.id, node)
  for (const edge of graph.edges) {
    if (edge.relation !== 'contains') continue
    const parent = nodesById.get(edge.source)
    const child = nodesById.get(edge.target)
    if (!parent || !child || parent.kind !== 'module' || child.kind !== 'module' || parent === child) continue
    if (!parentMap.has(child.id)) parentMap.set(child.id, parent.id)
  }
  return parentMap
}

/**
 * Ancestor chain of module crumbs for the current drill focus, ordered
 * OUTERMOST → focused (inclusive), derived from the `contains` spine so it
 * matches the drill rollup exactly. Empty when focus is null or the focused id
 * is absent from the graph. Excludes the implicit ROOT level (focus = null) —
 * the board renders that crumb itself. Pure — no DOM.
 */
export function focusAncestry(
  graph: BlueprintGraph | null | undefined,
  focusPath: string | null | undefined,
): FocusCrumb[] {
  const focusId = normalizeFocusId(focusPath ?? undefined)
  if (focusId === null || !graph || !Array.isArray(graph.nodes)) return []
  const nodesById = new Map<string, BlueprintNode>()
  for (const node of graph.nodes) nodesById.set(node.id, node)
  if (nodesById.get(focusId)?.kind !== 'module') return []

  const parentMap = buildParentSpine(graph)
  const chain: FocusCrumb[] = []
  const seen = new Set<string>()
  let cur: string | undefined = focusId
  while (cur !== undefined && !seen.has(cur)) {
    const node = nodesById.get(cur)
    if (!node || node.kind !== 'module') break
    chain.push({ id: cur, label: node.label })
    seen.add(cur)
    cur = parentMap.get(cur)
  }
  return chain.reverse()
}

/**
 * Collapse a drill focus to the deepest ancestor still present as a module node
 * after a snapshot refresh (live-reload pruning). If the focused module still
 * exists it is kept (normalized id); otherwise its path ancestors are probed
 * from deepest to shallowest and the first surviving module id is returned.
 * Returns null when the focus and all its ancestors are gone — the board drops
 * to the depth-1 spine. Pure — no DOM.
 */
export function pruneFocusPath(
  graph: BlueprintGraph | null | undefined,
  focusPath: string | null | undefined,
): string | null {
  const focusId = normalizeFocusId(focusPath ?? undefined)
  if (focusId === null) return null
  if (!graph || !Array.isArray(graph.nodes)) return null
  const moduleIds = new Set<string>()
  for (const node of graph.nodes) {
    if (node.kind === 'module') moduleIds.add(node.id)
  }
  // Candidate chain: the focus id, then each shorter path prefix, deepest first.
  const dir = focusId.slice(MODULE_ID_PREFIX.length)
  const segments = dir.split('/')
  for (let end = segments.length; end >= 1; end -= 1) {
    const candidate = `${MODULE_ID_PREFIX}${segments.slice(0, end).join('/')}`
    if (moduleIds.has(candidate)) return candidate
  }
  return null
}

/**
 * Additive helper (blueprint-v2): resolve ANY graph node id to the id of the
 * displayed FlowNode it rolls up to on a given `rolled` board — or null when it
 * isn't represented. Mirrors rollupGraph's endpoint resolution (module-ancestor
 * walk over the `contains` spine; CLI endpoints fold to `cli-surface`; other
 * periphery matches only directly) so the board's story/flow DECORATION lights
 * the same card the rollup drew. Pure — no DOM. Returns a closure so callers
 * resolve many ids against one prepared index.
 *
 * @param graph   the graph the `rolled` board was built from (null → resolves
 *                only direct matches present in `rolled`)
 * @param rolled  the rolled board whose displayed node ids are the resolution
 *                targets
 */
export function buildDisplayResolver(
  graph: BlueprintGraph | null | undefined,
  rolled: RolledGraph,
): (nodeId: string) => string | null {
  const displayed = new Set(rolled.nodes.map((n) => n.id))
  const nodesById = new Map<string, BlueprintNode>()
  const parentMap = new Map<string, string>()
  if (graph && Array.isArray(graph.nodes)) {
    for (const node of graph.nodes) nodesById.set(node.id, node)
    for (const edge of graph.edges) {
      if (edge.relation !== 'contains') continue
      const parent = nodesById.get(edge.source)
      const child = nodesById.get(edge.target)
      if (!parent || !child || parent.kind !== 'module' || child.kind !== 'module' || parent === child) continue
      if (!parentMap.has(child.id)) parentMap.set(child.id, parent.id)
    }
  }
  return (nodeId: string): string | null => {
    if (displayed.has(nodeId)) return nodeId
    const node = nodesById.get(nodeId)
    if (!node) return null
    if (node.kind === 'module') {
      const seen = new Set<string>()
      let cur: string | undefined = nodeId
      while (cur !== undefined && !seen.has(cur)) {
        if (displayed.has(cur)) return cur
        seen.add(cur)
        cur = parentMap.get(cur)
      }
      return null
    }
    if (node.kind === 'endpoint') {
      const grouped = groupedDisplayIdOf(node, (id) => displayed.has(id))
      if (grouped !== null) return grouped
      if (isCliEndpoint(node)) return displayed.has(CLI_SURFACE_ID) ? CLI_SURFACE_ID : null
    }
    return null
  }
}

/**
 * Which story anchors should light a BREADCRUMB CRUMB instead of a card (#612).
 * On an auto-descended single-root board the focus root (e.g. `module:src`) is
 * not a rendered card — it's the breadcrumb — so `buildDisplayResolver` returns
 * null for it and `decorate` would silently light nothing. An anchor that (a)
 * resolves to no displayed card AND (b) is one of the current focus ancestry
 * ids (the descended root or an ancestor crumb) is surfaced on its crumb, so
 * the story→board coupling always gives visible feedback. Pure + deterministic.
 */
export function crumbHighlightsForAnchors(
  anchors: readonly string[],
  resolve: (nodeId: string) => string | null,
  ancestryIds: ReadonlySet<string>,
): Set<string> {
  const lit = new Set<string>()
  for (const anchor of anchors) {
    if (resolve(anchor) === null && ancestryIds.has(anchor)) lit.add(anchor)
  }
  return lit
}

/** A depth-1 root must own at least this share of files to auto-descend (#901). */
export const DOMINANT_ROOT_FILE_SHARE = 0.8

/**
 * Initial drill focus for a fresh board (#537, #901). Two triggers:
 *
 * 1. DEGENERATE spine — ≤2 displayable module roots (e.g. a single-root
 *    `src/` repo whose one card hides 17 child modules).
 * 2. DOMINANT root — more roots exist, but ONE owns ≥80% of the scanned
 *    source files (orbit-class repos: `src` beside `prisma`/`office-addin`).
 *    The first screen should show the domain, not one giant card.
 *
 * Either way the board descends into that root's children as the default
 * view. Returns the root's module id, or null to keep depth-1 (balanced
 * multi-root repos, or nothing worth descending into). Pure + deterministic.
 */
export function selectInitialFocus(graph: BlueprintGraph): string | null {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]))
  const depthOne = graph.nodes.filter((node) => node.kind === 'module' && node.meta?.depth === 1)
  if (depthOne.length > 2 && !hasDominantRoot(graph, depthOne)) {
    return null // balanced top-level structure — keep depth-1
  }
  // Direct child counts per module (first-parent-wins, mirroring rollupGraph).
  const childCount = new Map<string, number>()
  const seenChild = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.relation !== 'contains') continue
    const parent = nodesById.get(edge.source)
    const child = nodesById.get(edge.target)
    if (!parent || !child || parent.kind !== 'module' || child.kind !== 'module' || parent === child) {
      continue
    }
    if (seenChild.has(child.id)) continue
    seenChild.add(child.id)
    childCount.set(parent.id, (childCount.get(parent.id) ?? 0) + 1)
  }
  let best: { id: string; count: number } | null = null
  for (const node of depthOne) {
    const count = childCount.get(node.id) ?? 0
    // Descend only into a root that actually has children; deterministic id tiebreak.
    if (count > 0 && (best === null || count > best.count || (count === best.count && node.id < best.id))) {
      best = { id: node.id, count }
    }
  }
  return best?.id ?? null
}

/** Subtree file counts per depth-1 root: sum of every contained module's
 *  meta.fileCount (direct + rolled-up files both live there). */
function subtreeFileCounts(graph: BlueprintGraph, depthOne: BlueprintNode[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const root of depthOne) {
    const rootDir = root.sourceFile
    let files = 0
    for (const node of graph.nodes) {
      if (node.kind !== 'module') continue
      const dir = node.sourceFile
      if (dir === rootDir || dir.startsWith(`${rootDir}/`)) {
        const fileCount = node.meta?.fileCount
        if (typeof fileCount === 'number') files += fileCount
        const rolledUp = node.meta?.rolledUpFiles
        if (typeof rolledUp === 'number') files += rolledUp
      }
    }
    counts.set(root.id, files)
  }
  return counts
}

/** True when one depth-1 root owns ≥ DOMINANT_ROOT_FILE_SHARE of all files (#901). */
function hasDominantRoot(graph: BlueprintGraph, depthOne: BlueprintNode[]): boolean {
  const counts = subtreeFileCounts(graph, depthOne)
  let total = 0
  let max = 0
  for (const files of counts.values()) {
    total += files
    if (files > max) max = files
  }
  return total > 0 && max / total >= DOMINANT_ROOT_FILE_SHARE
}

// moduleNodeIdForPath moved to src/shared/module-owner.ts (#898 — shared with
// the main-process invariant checker); re-exported so board imports stay put.
export { moduleNodeIdForPath } from '../../shared/module-owner'

/** Floors so a degenerate viewport never divides by zero / yields NaN. */
const MIN_VIEWPORT_W = 320
const MIN_VIEWPORT_H = 240

export interface FlowPosition {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export interface FlowWireEndpoint {
  from: string
  to: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface StageLayout {
  positions: FlowPosition[]
  wireEndpoints: FlowWireEndpoint[]
}

// ── Territory layout (plan_blueprint_territory_v1, Phase 7) ──────────────────
//
// THE FULL MAP ALREADY *IS* A ROLLUP BY DIRECTORY. The retired degree-ranked
// grid gave that rollup constant-size cards, so the one thing the map could not
// say was HOW BIG anything is: `src/cli` (180 files) and `scripts` (14) drew
// the same 150 × 82 rectangle. Territory gives the rollup its area —
// a module's cell is its subtree's file count, its direct children nest inside
// it, and a level is a zoom of the level above.
//
// THE BANDS ARE NOT PART OF THE MEASURE. Integrations keep a fixed left strip
// and datastores, the rolled CLI surface and proposal ghosts keep a fixed
// bottom one, because an integration's AREA would mean nothing: `GitHub · gh`
// is not 3× `Telegram`. Only the module ground is a treemap; the periphery is
// a border, and it is drawn as one.
//
// Pure and deterministic: same rolled graph and
// same stage → identical rectangles, which is what lets the board re-render on
// every resize without the map reshuffling under the reader.

/** Fixed width of the integration band down the left edge (0 when empty). */
export const TERRITORY_LEFT_BAND_W = 150
/** Fixed height of the datastore + CLI + proposal band across the foot. */
export const TERRITORY_BOTTOM_BAND_H = 92
/** Breathing room between the map and the stage's edges. */
export const TERRITORY_MARGIN = 6
/** The strip above the map, where the meta line and the banners sit. */
export const TERRITORY_TOP_INSET = 30
/** The gutter under the bottom band, so its cells clear the stage's foot. */
export const TERRITORY_BOTTOM_GUTTER = 8
/**
 * The label row a nested module reserves before its children start.
 *
 * Deep enough for the `.fb-node` grammar's three rows (kicker 12 + name 16 +
 * id 13, plus the card's own 8px top padding and the gaps between them), so a
 * nested parent's own text is never drawn underneath its districts.
 */
export const TERRITORY_LABEL_ROW_H = 54
/** A nested parent's padding around its children. */
export const TERRITORY_NEST_PAD = 8
/** Smallest inner rectangle worth nesting children into. */
export const TERRITORY_NEST_MIN: { w: number; h: number } = { w: 64, h: 30 }

/** One nested child cell — a real module id, so it drills and peeks like any other. */
export interface FlowNestedCell extends FlowPosition {
  /** The module whose inner rect this cell was packed into. */
  parentId: string
  label: string
}

/** `StageLayout` plus what only a treemap has: nested cells and its three bands. */
export interface TerritoryStageLayout extends StageLayout {
  /** The module ground — the stage less the two bands. */
  main: Rect
  /** The integration strip. Zero-width when nothing stands in it. */
  leftBand: Rect
  /** The datastore + CLI + ghost strip. Zero-height when nothing stands in it. */
  bottomBand: Rect
  /** Nested child cells, ordered by parent then id. */
  children: FlowNestedCell[]
}

/** A module's layout value: its subtree file count, floored so a cell always draws. */
function territoryValueOf(node: FlowNode): number {
  return Math.max(1, node.fileCount ?? node.weight ?? 1)
}

/**
 * Lay a rolled graph out as TERRITORY.
 *
 * Three regions, decided by kind and never by degree:
 *  - **module ground** — ordered strips over the main rectangle, each cell's
 *    area its subtree's file count, its direct children packed into its inner
 *    rect below a reserved label row;
 *  - **left band** — integrations and external project peers, stacked;
 *  - **bottom band** — datastores, the rolled CLI surface and every proposal
 *    ghost, whatever kind the ghost predicts (a prediction is not yet part of
 *    the ground it claims, so it never takes area away from a real module).
 *
 * Wire endpoints sit at cell centres, with ONE exception that exists because
 * nesting created it: a module with drawn children anchors on its LABEL ROW's
 * centre, so a wire leaves the cell over its own name instead of crossing the
 * districts inside it.
 */
export function layoutRollupAsTerritory(
  rolled: RolledGraph,
  stage: { w: number; h: number },
): TerritoryStageLayout {
  const width = Math.max(MIN_VIEWPORT_W, stage?.w ?? MIN_VIEWPORT_W)
  const height = Math.max(MIN_VIEWPORT_H, stage?.h ?? MIN_VIEWPORT_H)

  const modules: FlowNode[] = []
  const leftNodes: FlowNode[] = []
  const bottomNodes: FlowNode[] = []
  for (const node of rolled.nodes) {
    if (node.ghost === true) bottomNodes.push(node)
    else if (node.kind === 'module') modules.push(node)
    else if (node.kind === 'integration' || node.kind === 'project') leftNodes.push(node)
    else bottomNodes.push(node)
  }
  // ONE ID, ONE RECTANGLE. A displayed module is never nested as somebody's
  // district — the rollup's spine makes that impossible today, and a node
  // placed twice would take whichever rectangle happened to be written last,
  // which is a layout that depends on iteration order.
  const displayed = new Set(rolled.nodes.map((node) => node.id))

  // An EMPTY BAND TAKES NO ROOM. A fixed strip is what keeps an integration's
  // area from reading as a measure; a fixed strip with nothing in it is just
  // 150px of the map the modules were refused for no reason.
  const leftBandW = leftNodes.length === 0 ? 0 : TERRITORY_LEFT_BAND_W
  const bottomBandH = bottomNodes.length === 0 ? 0 : TERRITORY_BOTTOM_BAND_H

  const leftBand: Rect = {
    x: TERRITORY_MARGIN,
    y: TERRITORY_TOP_INSET,
    w: Math.max(0, leftBandW - TERRITORY_MARGIN),
    h: Math.max(0, height - TERRITORY_TOP_INSET - bottomBandH),
  }
  const bottomBand: Rect = {
    x: TERRITORY_MARGIN,
    y: height - bottomBandH + TERRITORY_MARGIN,
    w: Math.max(0, width - TERRITORY_MARGIN * 2),
    h: Math.max(0, bottomBandH - TERRITORY_MARGIN - TERRITORY_BOTTOM_GUTTER),
  }
  const main: Rect = {
    x: leftBandW + TERRITORY_MARGIN,
    y: TERRITORY_TOP_INSET,
    w: Math.max(0, width - leftBandW - TERRITORY_MARGIN * 2),
    h: Math.max(0, height - TERRITORY_TOP_INSET - bottomBandH),
  }

  const positions = new Map<string, FlowPosition>()
  const nested: FlowNestedCell[] = []
  /** Modules that actually DREW children — the label-row anchor rule's subjects. */
  const parents = new Set<string>()

  const put = (id: string, rect: Rect, gap: number): Rect => {
    const drawn = inset(rect, gap)
    positions.set(id, { id, x: drawn.x, y: drawn.y, w: drawn.w, h: drawn.h })
    return drawn
  }

  // ── Module ground ─────────────────────────────────────────────────────────
  for (const placed of strips(
    modules.map((node) => ({ node, value: territoryValueOf(node) })),
    main,
  )) {
    const cell = put(placed.node.id, placed, CELL_INSET)
    const kids = (placed.node.children ?? []).filter((child) => !displayed.has(child.id))
    if (kids.length === 0) continue
    const inner: Rect = {
      x: cell.x + TERRITORY_NEST_PAD,
      y: cell.y + TERRITORY_LABEL_ROW_H,
      w: cell.w - TERRITORY_NEST_PAD * 2,
      h: cell.h - TERRITORY_LABEL_ROW_H - TERRITORY_NEST_PAD,
    }
    // A CELL TOO SMALL TO HOLD ITS DISTRICTS DRAWS NONE. Nesting into a rect
    // narrower than a name is how a treemap turns into a hatch pattern, and
    // the parent's own `childCount` sublabel still says how many there are.
    if (inner.w < TERRITORY_NEST_MIN.w || inner.h < TERRITORY_NEST_MIN.h) continue
    parents.add(placed.node.id)
    for (const kid of strips(
      kids.map((child) => ({ child, value: Math.max(1, child.fileCount) })),
      inner,
    )) {
      const drawn = put(kid.child.id, kid, CELL_INSET_IN_GROUP)
      nested.push({ ...drawn, id: kid.child.id, parentId: placed.node.id, label: kid.child.label })
    }
  }

  // ── Left band: integrations + external peers, stacked ─────────────────────
  // Every band cell carries the SAME value: the band is a fixed strip, and an
  // area that varied there would be a measure the reader cannot use.
  for (const placed of strips(
    leftNodes.map((node) => ({ node, value: 1 })),
    leftBand,
  )) {
    put(placed.node.id, placed, CELL_INSET)
  }

  // ── Bottom band: datastores, the rolled CLI surface, and the ghosts ───────
  for (const placed of strips(
    bottomNodes.map((node) => ({ node, value: 1 })),
    bottomBand,
  )) {
    put(placed.node.id, placed, CELL_INSET)
  }

  // ── Wires ─────────────────────────────────────────────────────────────────
  const anchorOf = (position: FlowPosition): { x: number; y: number } => ({
    x: position.x + position.w / 2,
    y: parents.has(position.id)
      ? position.y + Math.min(TERRITORY_LABEL_ROW_H / 2, position.h / 2)
      : position.y + position.h / 2,
  })
  const wireEndpoints: FlowWireEndpoint[] = []
  for (const wire of rolled.wires) {
    const a = positions.get(wire.from)
    const b = positions.get(wire.to)
    if (!a || !b) continue
    const from = anchorOf(a)
    const to = anchorOf(b)
    wireEndpoints.push({ from: wire.from, to: wire.to, x1: from.x, y1: from.y, x2: to.x, y2: to.y })
  }
  wireEndpoints.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))

  const positionList = [...positions.values()].sort((a, b) => a.id.localeCompare(b.id))
  nested.sort((a, b) => a.parentId.localeCompare(b.parentId) || a.id.localeCompare(b.id))
  return { positions: positionList, wireEndpoints, main, leftBand, bottomBand, children: nested }
}

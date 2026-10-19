// Drift assembler (drift feature, Phase 4) — a PURE, I/O-free reducer that turns
// a raw `blueprint drift-check` report plus injected git/run/ack facts into the
// renderer-facing `BlueprintDrift` the board's drift panel shows. It is the
// integration seam that assembles P1's drift entries, P2's origin/file-class
// classifiers, and P5's ack store into ONE deterministic projection.
//
// Every effect (spawning the CLI, reading git authorship, dirtiness, the run's
// in-play set, the ack store) is resolved by the OBSERVER and INJECTED here as
// plain data, so this module stays unit-testable under plain `npx jest` — no
// fs, no git, no spawn, no Electron. It only decides.
//
// Two buckets:
//   • nodes  — SOURCE-file drift rolled up to its owning graph node (blast
//              radius, origin, author, ack) and ranked by dependents desc.
//   • system — dependency/schema/config churn a user rarely reasons about
//              line-by-line, ranked by file-class then path.
//
// Fail-soft: any structurally-bad input yields empty buckets rather than a
// throw — drift must never break the snapshot read (allowed-pattern: invariants
// in one code path).

import type { BlueprintGraph, BlueprintNode } from '../../shared/ipc-contract'
import type {
  BlueprintDrift,
  BlueprintDriftNode,
  BlueprintSystemChange,
} from '../../shared/ipc-contract'
import { classifyOrigin, type DriftOrigin } from './drift-classify'
import {
  buildDriftOwnerIndex,
  driftOwnerNodeId,
  type DriftOwnerIndex,
} from './drift-owner'
import { classifyFileClass, type FileClass } from './file-class'
import { isAcked, type DriftAck } from './drift-acks'

/** The kinds P1's `drift-check` emits for one drifted path. */
export type DriftKind = 'changed' | 'missing' | 'added' | 'renamed'

/** One drifted path from `blueprint drift-check --json` (mirror of the CLI's
 *  DriftEntry — the app defines its own copy to avoid a cross-package import). */
export interface DriftEntryLike {
  /** Repo-relative path that drifted (for `renamed`, the NEW path). */
  path: string
  kind: DriftKind
  /** `id` of the graph node whose `sourceFile` is `path`, when one exists. */
  nodeId?: string
  /** For `renamed`: the baseline path the content moved from. */
  renamedFrom?: string
}

/** Per-file git authorship the assembler needs — a slice of git-manager's
 *  FileAuthor (all fields optional so a missing lookup degrades gracefully). */
export interface DriftAuthorInfo {
  /** Author email of the last commit that touched the file (origin split). */
  email?: string
  /** Author display name (falls back to email for the node's `author` label). */
  author?: string
  /** Commit hash of the last commit that touched the file (ack key). */
  hash?: string
  /** Author date (ISO/any comparable string) — the "most recent" tiebreak. */
  date?: string
}

/** Everything `assembleDrift` needs — all resolved and injected by the observer. */
export interface AssembleDriftInput {
  /** Raw drift entries from `blueprint drift-check`. */
  driftEntries: readonly DriftEntryLike[]
  /** The derived system graph (null when absent — nodes then carry 0 dependents). */
  graph: BlueprintGraph | null
  /** Last-commit authorship per drifted path (missing paths omitted). */
  authorsByPath: ReadonlyMap<string, DriftAuthorInfo>
  /** Repo-relative paths with uncommitted working-tree changes. */
  dirtyPaths: ReadonlySet<string>
  /** The repo's configured `user.email` (external-vs-yours split). */
  currentUserEmail?: string
  /** Node ids whose owning module is in play for an active run (→ 'agent'). */
  inPlayNodeIds: ReadonlySet<string>
  /** Human drift acknowledgements (from readDriftAcks). */
  acks: readonly DriftAck[]
  /** Max nodes shown; the rest count toward `overflow`. Default DEFAULT_DRIFT_CAP. */
  cap?: number
}

/** Default node cap — keeps the panel focused; overflow is reported as a count. */
export const DEFAULT_DRIFT_CAP = 20

/** The three file classes that route to the "system changes" bucket. */
const SYSTEM_CLASSES = new Set<FileClass>(['dependency', 'schema', 'config'])

/** Deterministic system-bucket ordering: most-impactful class first, then path. */
const SYSTEM_CLASS_ORDER: Record<'dependency' | 'schema' | 'config', number> = {
  dependency: 0,
  schema: 1,
  config: 2,
}

/** Precedence for picking a node's single origin across its files: agent wins. */
const ORIGIN_RANK: Record<DriftOrigin, number> = {
  agent: 3,
  yours: 2,
  external: 1,
}

const EMPTY_DRIFT: BlueprintDrift = { nodes: [], system: [], shown: 0, overflow: 0 }

/**
 * Build the attribution index for resolving entries without a nodeId (#1155):
 * exact sourceFile match first, then the deepest DIRECTORY-owning node
 * containing the path. Module nodes own a directory, so the old exact-only
 * index dropped every ordinary module-file change on the floor. Mirrors the
 * CLI's src/cli/blueprint/drift-owner.ts — both sites must agree.
 */
function buildSourceFileIndex(graph: BlueprintGraph | null): DriftOwnerIndex {
  if (graph === null || !Array.isArray(graph.nodes)) {
    return buildDriftOwnerIndex([])
  }
  return buildDriftOwnerIndex(graph.nodes)
}

/**
 * The owning node id of a drift entry: the CLI-supplied `nodeId` when present,
 * else the node whose `sourceFile` equals the path. `undefined` when the path
 * maps to no node (unattributable — dropped from the node bucket). Exported so
 * the observer can pre-compute the in-play node set without re-deriving rollup.
 */
export function ownerNodeId(
  entry: DriftEntryLike,
  sourceFileIndex: DriftOwnerIndex,
): string | undefined {
  if (typeof entry.nodeId === 'string' && entry.nodeId.length > 0) {
    return entry.nodeId
  }
  return driftOwnerNodeId(entry.path, sourceFileIndex)
}

/** Blast radius: graphify's precomputed `meta.degree`, else incident-edge count. */
function nodeDependents(nodeId: string, node: BlueprintNode | undefined, graph: BlueprintGraph | null): number {
  const degree = node?.meta?.degree
  if (typeof degree === 'number' && Number.isFinite(degree) && degree >= 0) {
    return degree
  }
  if (graph === null || !Array.isArray(graph.edges)) {
    return 0
  }
  let count = 0
  for (const edge of graph.edges) {
    if (edge.source === nodeId || edge.target === nodeId) {
      count += 1
    }
  }
  return count
}

/** Pick the highest-precedence origin across a node's files (agent > yours > external). */
function pickOrigin(origins: readonly DriftOrigin[]): DriftOrigin {
  let best: DriftOrigin = 'external'
  for (const origin of origins) {
    if (ORIGIN_RANK[origin] > ORIGIN_RANK[best]) {
      best = origin
    }
  }
  return best
}

/**
 * A drift is acked when EVERY one of its files has a committed hash AND all of
 * those commits are acknowledged under `key` (nodeId for nodes, path for system
 * files). An uncommitted (dirty/added, no hash) file can never be acked, so a
 * node with any such file reads as un-acked — you have not "seen" that change.
 */
function isDriftAcked(
  acks: readonly DriftAck[],
  key: string,
  paths: readonly string[],
  authorsByPath: ReadonlyMap<string, DriftAuthorInfo>,
): boolean {
  if (paths.length === 0) {
    return false
  }
  // Every file must carry a commit; a missing hash means "uncommitted" → not acked.
  const commits: string[] = []
  for (const path of paths) {
    const hash = authorsByPath.get(path)?.hash
    if (typeof hash !== 'string' || hash.length === 0) {
      return false
    }
    commits.push(hash)
  }
  return commits.every((commit) => isAcked(acks, key, commit))
}

/** The most-recent author info across a node's files (max `date`), if any. */
function mostRecentAuthor(
  paths: readonly string[],
  authorsByPath: ReadonlyMap<string, DriftAuthorInfo>,
): DriftAuthorInfo | undefined {
  let best: DriftAuthorInfo | undefined
  for (const path of paths) {
    const info = authorsByPath.get(path)
    if (info === undefined) {
      continue
    }
    if (best === undefined) {
      best = info
      continue
    }
    const a = info.date ?? ''
    const b = best.date ?? ''
    if (a > b) {
      best = info
    }
  }
  return best
}

/**
 * Assemble the renderer-facing drift projection. PURE and deterministic:
 *   1. route each entry — dependency/schema/config → `system`; source/other →
 *      its owning node (dropped when no node owns it),
 *   2. per node: origin (agent>yours>external across its files), most-recent
 *      author + commit, changed files, dependents (blast radius), acked flag,
 *   3. rank nodes by dependents desc then nodeId, cap to `cap`, report
 *      `shown` + `overflow`,
 *   4. rank system by file-class then path.
 * Fail-soft: any structurally-bad input yields empty buckets, never a throw.
 */
export function assembleDrift(input: AssembleDriftInput): BlueprintDrift {
  try {
    const {
      driftEntries,
      graph,
      authorsByPath,
      dirtyPaths,
      currentUserEmail,
      inPlayNodeIds,
      acks,
      cap = DEFAULT_DRIFT_CAP,
    } = input
    if (!Array.isArray(driftEntries)) {
      return { ...EMPTY_DRIFT }
    }

    const sourceFileIndex = buildSourceFileIndex(graph)
    const nodeById = new Map<string, BlueprintNode>()
    if (graph !== null && Array.isArray(graph.nodes)) {
      for (const node of graph.nodes) {
        nodeById.set(node.id, node)
      }
    }

    // Route entries into the two buckets.
    const systemRaw: Array<{ entry: DriftEntryLike; fileClass: 'dependency' | 'schema' | 'config' }> = []
    /** nodeId → its drifted paths (dedup, insertion order). */
    const nodePaths = new Map<string, string[]>()
    for (const entry of driftEntries) {
      if (entry === null || typeof entry !== 'object' || typeof entry.path !== 'string') {
        continue
      }
      const fileClass = classifyFileClass(entry.path)
      if (SYSTEM_CLASSES.has(fileClass)) {
        systemRaw.push({ entry, fileClass: fileClass as 'dependency' | 'schema' | 'config' })
        continue
      }
      const nodeId = ownerNodeId(entry, sourceFileIndex)
      if (nodeId === undefined) {
        continue // unattributable source/other file — dropped
      }
      const paths = nodePaths.get(nodeId) ?? []
      if (!paths.includes(entry.path)) {
        paths.push(entry.path)
      }
      nodePaths.set(nodeId, paths)
    }

    // Build node projections.
    const nodes: BlueprintDriftNode[] = []
    for (const [nodeId, rawPaths] of nodePaths) {
      const node = nodeById.get(nodeId)
      const changedFiles = [...rawPaths].sort((a, b) => a.localeCompare(b))
      const origins = changedFiles.map((path) =>
        classifyOrigin({
          path,
          committedAuthorEmail: authorsByPath.get(path)?.email,
          currentUserEmail,
          isDirty: dirtyPaths.has(path),
          inPlay: inPlayNodeIds.has(nodeId),
        }),
      )
      const origin = pickOrigin(origins)
      const recent = mostRecentAuthor(changedFiles, authorsByPath)
      const driftNode: BlueprintDriftNode = {
        nodeId,
        label: node?.label ?? nodeId,
        origin,
        changedFiles,
        dependents: nodeDependents(nodeId, node, graph),
        acked: isDriftAcked(acks, nodeId, changedFiles, authorsByPath),
      }
      const authorLabel = recent?.author ?? recent?.email
      if (authorLabel !== undefined && authorLabel.length > 0) {
        driftNode.author = authorLabel
      }
      if (recent?.hash !== undefined && recent.hash.length > 0) {
        driftNode.commit = recent.hash
      }
      nodes.push(driftNode)
    }

    // Rank by blast radius desc, then nodeId for determinism.
    nodes.sort((a, b) => b.dependents - a.dependents || a.nodeId.localeCompare(b.nodeId))
    const effectiveCap = typeof cap === 'number' && cap >= 0 ? Math.trunc(cap) : DEFAULT_DRIFT_CAP
    const shownNodes = nodes.slice(0, effectiveCap)
    const overflow = nodes.length - shownNodes.length

    // System bucket — deduped by path (first class wins), ranked by class then path.
    const seenSystem = new Set<string>()
    const system: BlueprintSystemChange[] = []
    for (const { entry, fileClass } of systemRaw) {
      if (seenSystem.has(entry.path)) {
        continue
      }
      seenSystem.add(entry.path)
      const origin = classifyOrigin({
        path: entry.path,
        committedAuthorEmail: authorsByPath.get(entry.path)?.email,
        currentUserEmail,
        isDirty: dirtyPaths.has(entry.path),
        inPlay: false, // system files have no owning module → never 'agent'
      })
      const change: BlueprintSystemChange = {
        path: entry.path,
        fileClass,
        origin,
        acked: isDriftAcked(acks, entry.path, [entry.path], authorsByPath),
      }
      const authorLabel = authorsByPath.get(entry.path)?.author ?? authorsByPath.get(entry.path)?.email
      if (authorLabel !== undefined && authorLabel.length > 0) {
        change.author = authorLabel
      }
      system.push(change)
    }
    system.sort(
      (a, b) => SYSTEM_CLASS_ORDER[a.fileClass] - SYSTEM_CLASS_ORDER[b.fileClass] || a.path.localeCompare(b.path),
    )

    return { nodes: shownNodes, system, shown: shownNodes.length, overflow }
  } catch {
    // Any unexpected shape → empty buckets; drift must never break the read.
    return { ...EMPTY_DRIFT }
  }
}

// BlueprintObserver — READ-ONLY lens over each project root's blueprint
// data at `<root>/flow/.blueprint/` (written by `planflow-ai blueprint
// derive`; `flow/` may be a symlink into the central vault — plain fs calls
// follow it transparently). It reads three fixed files:
//
//   graph.json          → the derived system graph (null when missing/corrupt)
//   annotations.jsonl   → append-only anchored annotations
//   status-events.jsonl → append-only status transitions, folded into each
//                         annotation's EFFECTIVE status (last event per
//                         fingerprint wins — mirrors the CLI store's
//                         readAnnotations in src/cli/blueprint/store.ts)
//   proposals.jsonl     → append-only proposal lifecycle events, folded into
//                         EFFECTIVE proposals (mirrors the CLI store's
//                         foldProposalEvents in
//                         src/cli/blueprint/proposal-store.ts)
//   story.json          → the compiled narrated story, written whole by
//                         `planflow-ai blueprint narrate` (mirrors the CLI's
//                         CompiledStory in src/cli/blueprint/types.ts);
//                         parsed fail-soft — undefined when missing/corrupt
//
// SECURITY: the renderer only ever supplies a rootId (an absolute project
// rootPath). File paths are constructed HERE, in main, from that root and
// the fixed `flow/.blueprint/<file>` suffixes — and the rootId itself is
// validated against the current project roots, so this channel cannot be
// steered to read arbitrary files.
//
// Watching: one chokidar watcher per root on the `.blueprint` directory
// (depth 0 — all three files sit directly inside it; chokidar tolerates the
// directory not existing yet and starts emitting once it appears). Change
// bursts are debounced, then a `blueprint:changed` event is pushed so the
// view re-reads after every derive/annotation append.
//
// Electron is only touched inside `registerBlueprintChannels` (lazy
// require), so the observer stays loadable from plain Node (test harnesses)
// — same pattern as src/main/flow/flow-observer.ts.

import { EventEmitter } from 'events'
import { recordSlow, timed } from '../ipc/slow-handler'
import { promises as fsPromises } from 'fs'
import { basename, join } from 'path'
import { spawn } from 'node:child_process'
import { watch, type FSWatcher } from 'chokidar'

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { realPathThroughLinksSync } from '../project/paths'
import { homedir } from 'node:os'
import type {
  BlueprintAnchor,
  BlueprintAnchorKind,
  BlueprintAnnotation,
  BlueprintAnnotationStatus,
  BlueprintDrift,
  BlueprintEffectiveProposal,
  BlueprintGraph,
  BlueprintInvestigation,
  BlueprintNode,
  BlueprintNodeKind,
  BlueprintProposalState,
  BlueprintSnapshot,
  BlueprintStory,
  BlueprintStoryStep,
  BlueprintCorpusIndexResult,
  BlueprintCrossLink,
  BlueprintSibling,
  BlueprintTierSummary,
  IpcEventChannel,
  IpcEventPayload,
  IpcInvokeChannel,
  IpcRequest,
  IpcResponse,
} from '../../shared/ipc-contract'
import type { RootsProvider } from '../flow/flow-observer'
import { LEARNING_STATE_FILE, parseLearningStateContent } from '../project/learning-state'
import { deriveBasicGraph } from './basic-derive'
import { BlueprintDeriveRunner, ensureProjectInitialized, type BundledCli } from './derive-runner'
import { runBrief } from './brief-runner'
import { runFeatureIndexing, runFeatureDiscovery, runFeatures } from './feature-runner'
import { alignLocalPaths, runWorkspaceGraph } from './workspace-graph-runner'
import { runFeatureMap } from './feature-map-runner'
import { runFeatureRelations } from './feature-relations-runner'
import { runReconcile } from './reconcile-runner'
import { readPlanFeatures } from './plan-features'
import { runBundledCliCapturing } from '../agent/learn-session'
import { resolveTreeSitterPath, resolveTypeScriptPath, runStoryline, shareStorylineRuns } from './storyline-runner'
import type { ImportIndexWarmer } from './import-index-warmer'
import { readPlanNotes, serializePlanNoteWrites, setPlanNote } from './plan-notes-runner'
import { createFeaturePortsCache, runFeaturePorts } from './feature-ports-runner'
import { runFeatureHome } from './feature-home-runner'
import { appendReviewVerdict, buildVerdictFingerprint } from './review-verdict-writer'
import { appendDriftAck, readDriftAcks, type DriftAck } from './drift-acks'
import {
  assembleDrift,
  ownerNodeId,
  DEFAULT_DRIFT_CAP,
  type DriftAuthorInfo,
  type DriftEntryLike,
  type DriftKind,
} from './drift-assemble'
import { buildDriftOwnerIndex } from './drift-owner'
import { isClaimImagePath } from '../../shared/claim-files'

// #52: the derived structure graph now lives under flow/brain/.structure (the
// blueprint stores were consolidated into brain). The board is structure-only.
const BLUEPRINT_DIR = join('flow', 'brain', '.structure')
// #69: the CLI is embedded in the app as a build artifact that can lag the
// source. A stale bundled CLI still writes the graph to the OLD location, so the
// board reads BOTH — new first, then legacy — to survive that skew.
const LEGACY_BLUEPRINT_DIR = join('flow', '.blueprint')
/** Both directories the derived graph might live in (new preferred). */
const GRAPH_DIRS = [BLUEPRINT_DIR, LEGACY_BLUEPRINT_DIR] as const
/**
 * #1306: the feature store. The board's DEFAULT view is the feature board, and
 * editing or deleting a `flow/brain/features/*.md` IS the documented
 * correction mechanism — but nothing watched this directory, so the board
 * never noticed. Not even a full `blueprint derive` moved it; only relaunching
 * the app did.
 */
const FEATURES_DIR = join('flow', 'brain', 'features')
/** The feature store's path BELOW `flow/` — what an event path carries once
 *  the watch is aimed through `flow`'s link at the real directory. */
const FEATURES_SUBPATH = join('brain', 'features')
// #1532 (changes-discovery-view): the persisted corpus index — one entry per
// change/discovery doc, written by the CLI's `features discover` pass. Fixed
// path in main (mirrors CORPUS_INDEX_RELPATH in src/cli/blueprint/
// corpus-index.ts; separate runtimes, no shared import).
const CORPUS_INDEX_FILE = join('flow', 'brain', '.derived', 'corpus-index.json')
const GRAPH_FILE = 'graph.json'

// #535: graphify writes its code graph here (repo root). A large repo's first
// build lands minutes after the derive that kicked it off (in the background);
// we watch for that FIRST appearance and re-derive so the board's structure
// fills in automatically — no manual Refresh.
const GRAPHIFY_OUT_DIR = 'graphify-out'
const GRAPHIFY_GRAPH_FILE = 'graph.json'
/** Emitted (rootId) when graphify's graph.json first appears — triggers a re-derive. */
export const GRAPHIFY_LANDED_EVENT = 'graphify-landed'
const ANNOTATIONS_FILE = 'annotations.jsonl'
const STATUS_EVENTS_FILE = 'status-events.jsonl'
const PROPOSALS_FILE = 'proposals.jsonl'
// The compiled story (`planflow-ai blueprint narrate`) — unlike graph.json,
// it has no legacy location; it only ever lives under flow/brain/.structure/.
const STORY_FILE = 'story.json'
// The investigation store — active notes are folded and projected into the
// snapshot; the CLI's investigation-store is the fold authority. Like story
// and learning-state, it only ever lives under flow/brain/.structure/.
const INVESTIGATIONS_FILE = 'investigations.jsonl'
// The trust-tier sidecar (trust-tiers) — recomputed whole on every derive and
// updated in place by verdict writes (`src/cli/blueprint/file-tiers.ts`). Only
// its TALLIES are projected into the snapshot; new-location only.
const FILE_TIERS_FILE = 'file-tiers.json'

/**
 * The files whose changes should trigger a `blueprint:changed` push.
 * Exported so tests can assert new stores (e.g. story.json, learning-state,
 * investigations) are wired into the watcher's filename filter without
 * spinning up a real chokidar watcher.
 */
export const WATCHED_FILES = new Set([
  GRAPH_FILE,
  ANNOTATIONS_FILE,
  STATUS_EVENTS_FILE,
  PROPOSALS_FILE,
  STORY_FILE,
  LEARNING_STATE_FILE,
  INVESTIGATIONS_FILE,
  FILE_TIERS_FILE,
])

/** Quiet window before a burst of blueprint file events notifies. */
/**
 * How long a burst of structure writes is collapsed before the board is told.
 *
 * 200 ms was tuned for a human editing files. A learn run is not that: it
 * rewrites learning-state.jsonl on every module transition, hundreds of times,
 * and each push made every surface re-read the whole snapshot — 2.7 MB of graph
 * in a real project, alongside the pass that was already saturating the
 * machine. A second is still live enough for a board nobody is typing into, and
 * it turns hundreds of re-reads into a handful.
 */
const CHANGE_DEBOUNCE_MS = 1_000

export const BLUEPRINT_CHANGED_EVENT = 'changed'

/** A drift assembly and whether it has landed. The board reads the value only
 *  when `ready` — waiting for it is what this type exists to prevent. */
interface DriftWork {
  promise: Promise<BlueprintDrift | undefined>
  ready: boolean
  value?: BlueprintDrift | undefined
}

const EMPTY_SNAPSHOT: BlueprintSnapshot = {
  graph: null,
  annotations: [],
  proposals: [],
  mtime: null,
}

// ── Pure parsing / folding (exported for tests) ──────────────────────────

/**
 * Parse graph.json content. Missing/empty/corrupt content yields null —
 * absence of a graph must never throw (mirrors the CLI's readGraph).
 */
export function parseGraphContent(content: string): BlueprintGraph | null {
  const trimmed = content.trim()
  if (trimmed.length === 0) {
    return null
  }
  try {
    const parsed = JSON.parse(trimmed) as BlueprintGraph
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

// ── Drift-check parsing (drift feature, Phase 4) ────────────────────────────
//
// The board reads P1's `blueprint drift-check --json` report and assembles the
// snapshot's `drift` field from it. Parsing is fail-soft (mirrors
// parseStaleCheckJson): unparseable JSON, a non-object, or a missing/mis-typed
// `entries` array all yield null, and the assembler then produces no drift.

const DRIFT_KINDS = new Set<DriftKind>(['changed', 'missing', 'added', 'renamed'])

/** P1's `drift-check --json` report shape (mirror of the CLI's DriftReport). */
export interface DriftReport {
  baselineAt: string | null
  entries: DriftEntryLike[]
}

/**
 * Parse `blueprint drift-check --json` stdout into a `DriftReport`. Fail-soft:
 * a cold index / stale CLI ("unknown action") / any unparseable or shape-invalid
 * output yields null (the caller then omits drift). Only the fields the
 * assembler consumes are validated; malformed entries drop individually.
 */
export function parseDriftReport(raw: string): DriftReport | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.entries)) {
    return null
  }
  const entries: DriftEntryLike[] = []
  for (const item of record.entries) {
    if (typeof item !== 'object' || item === null) {
      continue
    }
    const entry = item as Record<string, unknown>
    if (typeof entry.path !== 'string' || entry.path.length === 0) {
      continue
    }
    if (!DRIFT_KINDS.has(entry.kind as DriftKind)) {
      continue
    }
    const parsedEntry: DriftEntryLike = { path: entry.path, kind: entry.kind as DriftKind }
    if (typeof entry.nodeId === 'string' && entry.nodeId.length > 0) {
      parsedEntry.nodeId = entry.nodeId
    }
    if (typeof entry.renamedFrom === 'string' && entry.renamedFrom.length > 0) {
      parsedEntry.renamedFrom = entry.renamedFrom
    }
    entries.push(parsedEntry)
  }
  return {
    baselineAt: typeof record.baselineAt === 'string' ? record.baselineAt : null,
    entries,
  }
}

const ANCHOR_KINDS: readonly BlueprintAnchorKind[] = [
  'symbol',
  'file',
  'table',
  'endpoint',
  'module',
]

const ANNOTATION_TYPES = new Set(['decision', 'rule', 'claim', 'pin'])

/**
 * Stable annotation fingerprint: `<type>+<text>+<JSON array of sorted anchor
 * refs>` — must match the CLI's annotationFingerprint exactly, since status
 * events written by the CLI target annotations by this string.
 */
export function annotationFingerprint(
  entry: Pick<BlueprintAnnotation, 'type' | 'text' | 'anchors'>,
): string {
  const sortedRefs = entry.anchors.map((anchor) => anchor.ref).sort()
  return `${entry.type}+${entry.text}+${JSON.stringify(sortedRefs)}`
}

function isValidAnchor(value: unknown): value is BlueprintAnchor {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as { kind?: unknown; ref?: unknown; file?: unknown }
  if (
    typeof candidate.kind !== 'string' ||
    !ANCHOR_KINDS.includes(candidate.kind as BlueprintAnchorKind)
  ) {
    return false
  }
  if (typeof candidate.ref !== 'string' || candidate.ref.length === 0) {
    return false
  }
  return candidate.file === undefined || typeof candidate.file === 'string'
}

/**
 * Parse one annotation line. Records without anchors/status parse unchanged
 * (anchors default empty, status defaults active); malformed anchor elements
 * drop individually. Returns null for corrupt or shape-invalid lines.
 */
function parseAnnotationLine(line: string): BlueprintAnnotation | null {
  try {
    const parsed = JSON.parse(line) as Partial<BlueprintAnnotation>
    if (typeof parsed.text !== 'string' || typeof parsed.type !== 'string') {
      return null
    }
    if (!ANNOTATION_TYPES.has(parsed.type)) {
      return null
    }
    const anchors = Array.isArray(parsed.anchors) ? parsed.anchors.filter(isValidAnchor) : []
    return {
      ts: typeof parsed.ts === 'string' ? parsed.ts : '',
      runId: typeof parsed.runId === 'string' ? parsed.runId : null,
      type: parsed.type,
      text: parsed.text,
      anchors,
      provenance: typeof parsed.provenance === 'string' ? parsed.provenance : '',
      status: parsed.status === 'stale' ? 'stale' : 'active',
    }
  } catch {
    // Corrupt line — skip it rather than failing the whole read.
    return null
  }
}

function nonEmptyLines(content: string): string[] {
  return content.split('\n').filter((line) => line.trim().length > 0)
}

/**
 * Fold the annotation stream with its status events: the last event per
 * fingerprint (in file/append order) wins over the entry's as-written
 * status. Mirrors the CLI store's readAnnotations.
 */
export function foldAnnotationStream(
  annotationsContent: string,
  statusEventsContent: string,
): BlueprintAnnotation[] {
  const effectiveStatus = new Map<string, BlueprintAnnotationStatus>()
  for (const line of nonEmptyLines(statusEventsContent)) {
    try {
      const event = JSON.parse(line) as { targetFingerprint?: unknown; status?: unknown }
      if (typeof event.targetFingerprint !== 'string') {
        continue
      }
      if (event.status !== 'active' && event.status !== 'stale') {
        continue
      }
      effectiveStatus.set(event.targetFingerprint, event.status)
    } catch {
      // Corrupt event line — skip it.
    }
  }

  const entries: BlueprintAnnotation[] = []
  for (const line of nonEmptyLines(annotationsContent)) {
    const entry = parseAnnotationLine(line)
    if (entry === null) {
      continue
    }
    const overridden = effectiveStatus.get(annotationFingerprint(entry))
    entries.push(overridden === undefined ? entry : { ...entry, status: overridden })
  }
  return entries
}

// ── Proposal folding ──────────────────────────────────────────────────────
//
// Mirrors the CLI's fold rules EXACTLY — source of truth is
// `src/cli/blueprint/proposal-store.ts` (parseProposalRecord +
// foldProposalEvents); keep the two in sync:
//   - fail-soft per-line parse (corrupt/shape-invalid lines are skipped)
//   - group by fingerprint `<plan>+<predictedNodeId>`
//   - sort each group ascending by ts, ties broken by file order
//   - the LAST event's name is the state
//   - the payload (kind/label/detail/anchors/phase/provenance) comes from
//     the FIRST `proposed` event; groups without one are dropped
//   - decidedAt = latest accepted/rejected ts; confirmedAt = latest
//     confirmed ts (historical — never erased by a re-`proposed`)
//   - result sorted by proposedAt, then fingerprint

const PROPOSAL_STATES: readonly BlueprintProposalState[] = [
  'proposed',
  'accepted',
  'rejected',
  'confirmed',
  'stale',
  'cleared',
]

const PROPOSAL_KINDS: readonly BlueprintNodeKind[] = [
  'integration',
  'endpoint',
  'datastore',
  'module',
]

/** One parsed line of proposals.jsonl (the CLI's ProposalEvent shape). */
interface ProposalEventLine {
  ts: string
  plan: string
  phase?: number
  predictedNodeId: string
  kind: BlueprintNodeKind
  label: string
  detail?: string
  anchors?: BlueprintAnchor[]
  event: BlueprintProposalState
  provenance: string
}

/**
 * Parse one proposal line. Returns null when any REQUIRED field (plan,
 * predictedNodeId, kind, label, event) is missing or invalid; optional
 * fields default rather than invalidating the line. Mirrors the CLI's
 * parseProposalRecord.
 */
function parseProposalLine(line: string): ProposalEventLine | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // Corrupt line — skip it rather than failing the whole read.
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  if (typeof record.plan !== 'string' || record.plan.length === 0) {
    return null
  }
  if (typeof record.predictedNodeId !== 'string' || record.predictedNodeId.length === 0) {
    return null
  }
  if (!PROPOSAL_KINDS.includes(record.kind as BlueprintNodeKind)) {
    return null
  }
  if (typeof record.label !== 'string') {
    return null
  }
  if (!PROPOSAL_STATES.includes(record.event as BlueprintProposalState)) {
    return null
  }
  const event: ProposalEventLine = {
    ts: typeof record.ts === 'string' ? record.ts : '',
    plan: record.plan,
    predictedNodeId: record.predictedNodeId,
    kind: record.kind as BlueprintNodeKind,
    label: record.label,
    event: record.event as BlueprintProposalState,
    provenance: typeof record.provenance === 'string' ? record.provenance : '',
  }
  if (typeof record.phase === 'number' && Number.isInteger(record.phase)) {
    event.phase = record.phase
  }
  if (typeof record.detail === 'string') {
    event.detail = record.detail
  }
  if (Array.isArray(record.anchors)) {
    event.anchors = record.anchors.filter(isValidAnchor)
  }
  return event
}

const STORY_MODES = new Set(['draft', 'strict'])

/**
 * Validate one story step's shape. Mirrors the CLI's StoryStep field-by-field
 * (see `src/cli/blueprint/types.ts`) — every array field must be an array of
 * the expected element type; `kicker`/`source` are optional strings.
 */
function isValidStoryStep(value: unknown): value is BlueprintStoryStep {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Partial<BlueprintStoryStep>
  const isStringArray = (arr: unknown): arr is string[] =>
    Array.isArray(arr) && arr.every((entry) => typeof entry === 'string')

  if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') {
    return false
  }
  if (typeof candidate.body !== 'string') {
    return false
  }
  if (!Array.isArray(candidate.anchors) || !candidate.anchors.every(isValidAnchor)) {
    return false
  }
  if (!isStringArray(candidate.flow)) {
    return false
  }
  if (!Array.isArray(candidate.phases) || !candidate.phases.every((phase) => typeof phase === 'number')) {
    return false
  }
  if (!isStringArray(candidate.decisions) || !isStringArray(candidate.rejected) || !isStringArray(candidate.questions)) {
    return false
  }
  if (candidate.kicker !== undefined && typeof candidate.kicker !== 'string') {
    return false
  }
  if (candidate.source !== undefined && typeof candidate.source !== 'string') {
    return false
  }
  if (!isStringArray(candidate.unresolvedAnchors)) {
    return false
  }
  if (typeof candidate.draft !== 'boolean') {
    return false
  }
  return true
}

/**
 * Parse `story.json` content into a `BlueprintStory` (exported for tests).
 * Fail-soft: a missing file (`raw === null`), empty content, corrupt JSON,
 * non-object content, or a shape-invalid document (a `steps` field that
 * isn't an array, or any element that doesn't match the CLI's StoryStep
 * shape) all yield `undefined` — this must never throw. Unlike the
 * annotation stream's per-line fail-soft, a malformed step invalidates the
 * WHOLE story: story.json is one compiled artifact (atomically written by
 * `blueprint narrate`), not an append-only stream of independent records, so
 * there is no meaningful way to keep "the good half" of a corrupt compile.
 */
export function parseStoryContent(raw: string | null): BlueprintStory | undefined {
  if (raw === null) {
    return undefined
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const candidate = parsed as Partial<BlueprintStory>
  if (typeof candidate.plan !== 'string' || typeof candidate.sourcePath !== 'string') {
    return undefined
  }
  if (typeof candidate.mode !== 'string' || !STORY_MODES.has(candidate.mode)) {
    return undefined
  }
  if (!Array.isArray(candidate.steps) || !candidate.steps.every(isValidStoryStep)) {
    return undefined
  }
  if (!Array.isArray(candidate.warnings) || !candidate.warnings.every((entry) => typeof entry === 'string')) {
    return undefined
  }
  return {
    plan: candidate.plan,
    sourcePath: candidate.sourcePath,
    mode: candidate.mode as 'draft' | 'strict',
    steps: candidate.steps,
    warnings: candidate.warnings,
  }
}

// ── Trust-tier tallies (trust-tiers, Phase 4) ───────────────────────────────

/** Verdict kinds accepted when tallying (mirror of the CLI's TIER_VERDICT_KINDS). */
const TIER_VERDICT_KINDS = new Set<keyof Pick<BlueprintTierSummary, 'corroborated' | 'contradicted' | 'unverifiable'>>([
  'corroborated',
  'contradicted',
  'unverifiable',
])

/** File tiers accepted when tallying (mirror of the CLI's FILE_TIERS). */
const FILE_TIERS = new Set(['code', 'own', 'claim', 'other'])

/**
 * Parse `file-tiers.json` content into a `BlueprintTierSummary` — COUNTS only
 * (the board needs the adjudication picture, not thousands of file entries).
 * Fail-soft, mirroring `parseStoryContent`: a missing file (`raw === null`),
 * empty content, corrupt JSON, or a shape-invalid store (no `entries` array)
 * all yield `undefined` — this must never throw. Per-entry lenience mirrors
 * the CLI's `readFileTiers`: shape-invalid entries drop individually, and a
 * claim entry whose verdict is malformed keeps its classification and counts
 * as unadjudicated (a bad verdict must not sink the file's tier).
 */
/** Caps on the per-file detail carried into the snapshot (#1131) — enough to
 *  explain a verdict, bounded so a pathological file can't bloat the payload. */
const TIER_CLAIM_CAP = 20
const TIER_WITNESS_CAP = 10

/** Claim files + verdicts from file-tiers.json (capped, sorted) — the per-file
 *  trust column. Same tolerant parse as parseTierSummary. */
export function parseTierFiles(
  raw: string | null,
): BlueprintSnapshot['tierFiles'] | undefined {
  if (raw === null) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const entries = (parsed as { entries?: unknown })?.entries
  if (!Array.isArray(entries)) return undefined
  type TierFileView = NonNullable<BlueprintSnapshot['tierFiles']>[number]
  const files: TierFileView[] = []
  for (const candidate of entries) {
    if (typeof candidate !== 'object' || candidate === null) continue
    const entry = candidate as { path?: unknown; tier?: unknown; verdict?: unknown }
    if (typeof entry.path !== 'string' || entry.tier !== 'claim') continue
    // #1130: images are never listed as docs. They keep their claim TIER in
    // file-tiers.json (an image beside the code IS an unverified statement
    // about it), but nothing text-only can adjudicate one — so listing them
    // here produced permanently-"unverified" rows whose Verify button did
    // nothing. Filtering on READ means existing projects clean up on the next
    // board read, with no re-learn.
    if (isClaimImagePath(entry.path)) continue
    const rawVerdict =
      typeof entry.verdict === 'object' && entry.verdict !== null
        ? (entry.verdict as { verdict?: unknown; provenance?: unknown; claims?: unknown })
        : undefined
    const verdict = rawVerdict?.verdict
    const view: TierFileView = {
      path: entry.path,
      verdict:
        verdict === 'corroborated' || verdict === 'contradicted' || verdict === 'unverifiable'
          ? verdict
          : 'unadjudicated',
    }
    if (typeof rawVerdict?.provenance === 'string') view.provenance = rawVerdict.provenance
    // #1131: carry the WHY, not just the counts. Every verdict already records
    // when it was decided, what produced it, which code files it was checked
    // against, and each claim with its own outcome and note — the snapshot kept
    // only the counts, so a doc marked `contradicted` literally could not say
    // what it was contradicting. Capped and tolerantly parsed: a malformed
    // claim drops alone, never sinking the file's row.
    const detailed = rawVerdict as
      | { ts?: unknown; evidence?: unknown; verifiedAgainst?: unknown }
      | undefined
    if (typeof detailed?.ts === 'string') view.verifiedAt = detailed.ts
    if (typeof detailed?.evidence === 'string' && detailed.evidence.trim() !== '') {
      view.evidence = detailed.evidence.trim().slice(0, 400)
    }
    // The witnesses ARE `verifiedAgainst` — the hash-stamped code files the
    // doc was checked against. Their paths are what makes "contradicted by
    // what?" answerable; the hashes stay in the sidecar.
    if (Array.isArray(detailed?.verifiedAgainst)) {
      const witnesses = (detailed.verifiedAgainst as Array<{ path?: unknown }>)
        .map((stamp) => (typeof stamp?.path === 'string' ? stamp.path.trim() : ''))
        .filter((path) => path !== '')
        .slice(0, TIER_WITNESS_CAP)
      if (witnesses.length > 0) view.witnesses = witnesses
    }
    if (Array.isArray(rawVerdict?.claims)) {
      const counts = { corroborated: 0, contradicted: 0, unverifiable: 0 }
      const details: NonNullable<TierFileView['claimDetails']> = []
      for (const claim of rawVerdict.claims as Array<{
        outcome?: unknown
        claim?: unknown
        note?: unknown
      }>) {
        if (claim?.outcome === 'corroborated') counts.corroborated += 1
        else if (claim?.outcome === 'contradicted') counts.contradicted += 1
        else if (claim?.outcome === 'unverifiable') counts.unverifiable += 1
        else continue // unknown outcome — drop this claim alone
        if (details.length >= TIER_CLAIM_CAP) continue
        // `claim` is the assertion text and `note` its one-line evidence
        // (VerdictClaim in the CLI's file-tiers.ts — the single writer).
        if (typeof claim.claim !== 'string' || claim.claim.trim() === '') continue
        const detail: NonNullable<TierFileView['claimDetails']>[number] = {
          text: claim.claim.trim().slice(0, 300),
          outcome: claim.outcome,
        }
        if (typeof claim.note === 'string' && claim.note.trim() !== '') {
          detail.evidence = claim.note.trim().slice(0, 300)
        }
        details.push(detail)
      }
      view.claims = counts
      if (details.length > 0) view.claimDetails = details
    }
    files.push(view)
  }
  if (files.length === 0) return undefined
  return files.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 200)
}

/** Fold cross-links.jsonl (mirror of the CLI reader — last event per
 *  provider+endpoint wins; tolerant per line). */
export function parseCrossLinks(raw: string | null): BlueprintCrossLink[] | undefined {
  if (raw === null) return undefined
  const byFingerprint = new Map<string, BlueprintCrossLink>()
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      const event = JSON.parse(line) as BlueprintCrossLink & { ts?: string }
      if (typeof event.provider !== 'string' || typeof event.endpoint !== 'string') continue
      if (!['proposed', 'confirmed', 'rejected', 'stale'].includes(event.status)) continue
      byFingerprint.set(`${event.provider} ${event.endpoint}`, {
        provider: event.provider,
        endpoint: event.endpoint,
        status: event.status,
        confidence: event.confidence ?? 'medium',
        files: Array.isArray(event.files) ? event.files : [],
        surfaceDerivedAt: typeof event.surfaceDerivedAt === 'string' ? event.surfaceDerivedAt : '',
      })
    } catch {
      // corrupt line — skip
    }
  }
  if (byFingerprint.size === 0) return undefined
  return [...byFingerprint.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.endpoint.localeCompare(b.endpoint),
  )
}

/**
 * Join each cross-link with its EVIDENCE (pure; exported for tests):
 *  - consumer side: the outbound.json call sites whose path backs the link
 *    (same suffix rule as the CLI matcher), so the popover can show WHICH file
 *    calls WHAT via WHICH env base — the context a confirm decision needs;
 *  - provider side: the sourceFile of the matching endpoint node in the
 *    provider's own graph, so the user can jump to the exposing code.
 * Fail-soft: absent/corrupt inputs enrich nothing, links pass through.
 */
export function enrichCrossLinks(
  links: BlueprintCrossLink[],
  outboundRaw: string | null,
  providerGraphsRaw: Map<string, string | null>,
): BlueprintCrossLink[] {
  interface OutboundShape {
    calls?: Array<{ base?: string; baseIsEnv?: boolean; path?: string; file?: string }>
    graphqlOperations?: Array<{ operation?: string; name?: string; file?: string }>
  }
  let outbound: OutboundShape = {}
  if (outboundRaw !== null) {
    try {
      outbound = JSON.parse(outboundRaw) as OutboundShape
    } catch {
      outbound = {}
    }
  }
  /** Path → its segments, for the whole join. Every path here is compared
   *  against many others, so splitting it more than once is pure waste. */
  const segmentCache = new Map<string, string[]>()
  const providerEndpointFiles = new Map<string, Map<string, string>>()
  for (const [provider, raw] of providerGraphsRaw) {
    if (raw === null) continue
    try {
      const graph = JSON.parse(raw) as { nodes?: Array<{ id?: string; kind?: string; label?: string; sourceFile?: string }> }
      const byLabel = new Map<string, string>()
      for (const node of graph.nodes ?? []) {
        if (node.kind === 'endpoint' && typeof node.label === 'string' && typeof node.sourceFile === 'string') {
          byLabel.set(node.label, node.sourceFile)
        }
      }
      providerEndpointFiles.set(provider, byLabel)
    } catch {
      // corrupt sibling graph — no provider-side evidence for it
    }
  }
  // Same rules as the CLI matcher: param segments ({param}/{id}/[id]/:id)
  // match any concrete segment, and one-segment tails (/stream) never
  // suffix-match — evidence must not list callers the matcher itself would
  // have rejected.
  const isParam = (segment: string): boolean =>
    (segment.startsWith('{') && segment.endsWith('}')) ||
    (segment.startsWith('[') && segment.endsWith(']')) ||
    segment.startsWith(':')
  // SPLIT ONCE, NOT PER COMPARISON. This is links × calls string splitting, and
  // a CPU profile of the main process found `pathBacks` at 139ms plus this
  // function's own 50ms — on a read the board makes every time it opens.
  const segmentsOf = (path: string): string[] => {
    const cached = segmentCache.get(path)
    if (cached !== undefined) return cached
    const segments = path.split('/').filter((segment) => segment.length > 0)
    segmentCache.set(path, segments)
    return segments
  }
  const pathBacks = (callPath: string, linkPath: string): boolean => {
    const consumer = segmentsOf(callPath)
    const provider = segmentsOf(linkPath)
    const tailMatches = (): boolean => {
      const offset = provider.length - consumer.length
      return consumer.every(
        (segment, index) =>
          segment === provider[offset + index] || isParam(segment) || isParam(provider[offset + index]),
      )
    }
    if (consumer.length === provider.length && tailMatches()) return true
    if (consumer.length < 2) return false
    return provider.length > consumer.length && tailMatches()
  }
  return links.map((link) => {
    const enriched: BlueprintCrossLink = { ...link }
    const gql = /^(query|mutation) (.+)$/.exec(link.endpoint)
    if (gql !== null) {
      const calls = (outbound.graphqlOperations ?? [])
        .filter((op) => op.operation === gql[1] && op.name === gql[2] && typeof op.file === 'string')
        .map((op) => ({ file: op.file as string, base: `${gql[1]} document`, baseIsEnv: false, path: gql[2] }))
      if (calls.length > 0) enriched.calls = calls
    } else {
      const spaceIndex = link.endpoint.indexOf(' ')
      const linkPath = spaceIndex === -1 ? link.endpoint : link.endpoint.slice(spaceIndex + 1)
      const calls = (outbound.calls ?? [])
        .filter(
          (call) =>
            typeof call.path === 'string' && typeof call.file === 'string' && pathBacks(call.path, linkPath),
        )
        .map((call) => ({
          file: call.file as string,
          base: typeof call.base === 'string' ? call.base : '?',
          baseIsEnv: call.baseIsEnv === true,
          path: call.path as string,
        }))
      if (calls.length > 0) enriched.calls = calls
    }
    const providerFile = providerEndpointFiles.get(link.provider)?.get(link.endpoint)
    if (providerFile !== undefined) enriched.providerFile = providerFile
    return enriched
  })
}

/**
 * Paths whose recorded verdict is STALE against the current tree: the doc's
 * own hash or any verified-against witness hash no longer matches. Pure fs +
 * crypto — mirrors the CLI's verdictIsStale (the CLI stays authoritative for
 * writes; this is the read-time surface).
 */
export function computeStaleTierPaths(rootPath: string, tiersRaw: string): Set<string> {
  const stale = new Set<string>()
  let parsed: unknown
  try {
    parsed = JSON.parse(tiersRaw)
  } catch {
    return stale
  }
  const entries = (parsed as { entries?: unknown })?.entries
  if (!Array.isArray(entries)) return stale
  // Per-call memo: the same witness file is commonly stamped by many docs and
  // must hash at most once per sweep (#1653).
  const memo = new Map<string, string | null>()
  const hashOf = (relPath: string): string | null => {
    const cached = memo.get(relPath)
    if (cached !== undefined) return cached
    let hash: string | null
    try {
      hash = createHash('sha256').update(readFileSync(join(rootPath, relPath))).digest('hex')
    } catch {
      hash = null
    }
    memo.set(relPath, hash)
    return hash
  }
  for (const candidate of entries) {
    const entry = candidate as { path?: unknown; verdict?: unknown }
    if (typeof entry.path !== 'string' || typeof entry.verdict !== 'object' || entry.verdict === null) continue
    const verdict = entry.verdict as { docHash?: unknown; verifiedAgainst?: unknown }
    if (typeof verdict.docHash !== 'string') continue
    const docHash = hashOf(entry.path)
    if (docHash === null || docHash !== verdict.docHash) {
      stale.add(entry.path)
      continue
    }
    if (Array.isArray(verdict.verifiedAgainst)) {
      for (const stamp of verdict.verifiedAgainst as Array<{ path?: unknown; contentHash?: unknown }>) {
        if (typeof stamp?.path !== 'string' || typeof stamp.contentHash !== 'string') continue
        const witnessHash = hashOf(stamp.path)
        if (witnessHash === null || witnessHash !== stamp.contentHash) {
          stale.add(entry.path)
          break
        }
      }
    }
  }
  return stale
}

/** Sibling surfaces from the vault — name, vintage, repoPath, endpoint count. */
/** How long a sibling sweep stays good — see `siblingsSnapshot`. */
const SIBLINGS_TTL_MS = 60_000

export async function readSiblings(selfRepoPath: string): Promise<BlueprintSibling[] | undefined> {
  const projectsDir = join(homedir(), 'plan-flow', 'brain', 'projects')
  let entries: string[]
  try {
    entries = await fsPromises.readdir(projectsDir)
  } catch {
    return undefined
  }
  const siblings: BlueprintSibling[] = []
  for (const name of entries.sort()) {
    const raw = await readFileOrNull(join(projectsDir, name, 'flow', 'brain', '.structure', 'surface.json'))
    if (raw === null) continue
    try {
      const surface = JSON.parse(raw) as {
        version?: number
        project?: string
        repoPath?: string
        derivedAt?: string
        endpoints?: unknown[]
        graphqlOperations?: unknown[]
      }
      if (surface.version !== 1 || typeof surface.project !== 'string') continue
      if (surface.repoPath === selfRepoPath) continue
      siblings.push({
        name: surface.project,
        repoPath: typeof surface.repoPath === 'string' ? surface.repoPath : '',
        surfaceDerivedAt: typeof surface.derivedAt === 'string' ? surface.derivedAt : '',
        endpointCount:
          (Array.isArray(surface.endpoints) ? surface.endpoints.length : 0) +
          (Array.isArray(surface.graphqlOperations) ? surface.graphqlOperations.length : 0),
      })
    } catch {
      // corrupt sibling surface — skip
    }
  }
  return siblings.length > 0 ? siblings : undefined
}

export function parseTierSummary(raw: string | null): BlueprintTierSummary | undefined {
  if (raw === null) {
    return undefined
  }
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const entries = (parsed as { entries?: unknown }).entries
  if (!Array.isArray(entries)) {
    return undefined
  }
  const summary: BlueprintTierSummary = {
    claimTotal: 0,
    corroborated: 0,
    contradicted: 0,
    unverifiable: 0,
    unadjudicated: 0,
  }
  for (const candidate of entries) {
    if (typeof candidate !== 'object' || candidate === null) {
      continue
    }
    const entry = candidate as { path?: unknown; tier?: unknown; verdict?: unknown }
    if (typeof entry.path !== 'string' || typeof entry.tier !== 'string' || !FILE_TIERS.has(entry.tier)) {
      continue
    }
    if (entry.tier !== 'claim') {
      continue
    }
    // #1130: exclude images here too, so the tab's COUNT matches the rows
    // under it — a count that included unlistable images was the visible half
    // of the same bug.
    if (isClaimImagePath(entry.path)) {
      continue
    }
    summary.claimTotal += 1
    const verdict =
      typeof entry.verdict === 'object' && entry.verdict !== null
        ? (entry.verdict as { verdict?: unknown }).verdict
        : undefined
    if (
      typeof verdict === 'string' &&
      TIER_VERDICT_KINDS.has(verdict as 'corroborated' | 'contradicted' | 'unverifiable')
    ) {
      summary[verdict as 'corroborated' | 'contradicted' | 'unverifiable'] += 1
    } else {
      summary.unadjudicated += 1
    }
  }
  return summary
}

/**
 * Fold the raw proposals.jsonl content into effective proposals (exported
 * for tests). See the fold-rules comment above — this must stay in lockstep
 * with the CLI's foldProposalEvents.
 */
export function foldProposalStream(content: string): BlueprintEffectiveProposal[] {
  const events: ProposalEventLine[] = []
  for (const line of nonEmptyLines(content)) {
    const event = parseProposalLine(line)
    if (event !== null) {
      events.push(event)
    }
  }

  /** fingerprint → its events with file positions, in file order. */
  const groups = new Map<string, Array<{ event: ProposalEventLine; fileIndex: number }>>()
  for (let fileIndex = 0; fileIndex < events.length; fileIndex += 1) {
    const event = events[fileIndex]
    const fingerprint = `${event.plan}+${event.predictedNodeId}`
    const group = groups.get(fingerprint) ?? []
    group.push({ event, fileIndex })
    groups.set(fingerprint, group)
  }

  const effective: BlueprintEffectiveProposal[] = []
  for (const [fingerprint, group] of groups) {
    const ordered = [...group].sort((a, b) => {
      if (a.event.ts !== b.event.ts) {
        return a.event.ts.localeCompare(b.event.ts)
      }
      return a.fileIndex - b.fileIndex
    })

    const first = ordered.find((entry) => entry.event.event === 'proposed')
    if (first === undefined) {
      // No `proposed` event — nothing to carry; drop the fingerprint.
      continue
    }

    const proposal: BlueprintEffectiveProposal = {
      fingerprint,
      plan: first.event.plan,
      predictedNodeId: first.event.predictedNodeId,
      kind: first.event.kind,
      label: first.event.label,
      anchors: first.event.anchors ?? [],
      state: ordered[ordered.length - 1].event.event,
      provenance: first.event.provenance,
      proposedAt: first.event.ts,
    }
    if (first.event.phase !== undefined) {
      proposal.phase = first.event.phase
    }
    if (first.event.detail !== undefined) {
      proposal.detail = first.event.detail
    }
    for (const { event } of ordered) {
      if (event.event === 'accepted' || event.event === 'rejected') {
        proposal.decidedAt = event.ts
      } else if (event.event === 'confirmed') {
        proposal.confirmedAt = event.ts
      }
    }
    effective.push(proposal)
  }

  return effective.sort((a, b) => {
    if (a.proposedAt !== b.proposedAt) {
      return a.proposedAt.localeCompare(b.proposedAt)
    }
    return a.fingerprint.localeCompare(b.fingerprint)
  })
}

// ── Investigation notes (mirrored fold) ────────────────────────────────────
//
// A MINIMAL mirror of the CLI investigation-store's fold (source of truth:
// src/cli/blueprint/investigation-store.ts). The app surfaces only ACTIVE
// notes as compact `BlueprintInvestigation`s for the board; it never writes
// the store and never hashes content. Parity is deliberately narrow:
//   - fingerprint = `<text>+<JSON array of sorted anchor refs>` (matches the
//     CLI's investigationFingerprint EXACTLY — verified against that module)
//   - active = a note whose fingerprint is NOT named by any other note's
//     `supersedes` (the CLI's plain supersede drop)
// The CLI is the AUTHORITY for the full lifecycle — cycle rescue, heat
// aggregation, compaction — none of which the board needs. A parity fixture
// (pinned in the test) keeps the shared, cycle-free cases in lockstep.

/**
 * Max active notes projected into the snapshot; excess sets the truncation flag.
 *
 * DISPLAY ONLY. This number governs what the board renders and NOTHING else.
 *
 * It was once an input to a correctness decision: `resolveSupersede` scanned
 * this projection to find the note a re-learn had to supersede. On a mature
 * project the note is simply not in the list — orbit-app carries 362 active
 * notes and the one blocking `e2e/tests/chats` sat at index 356 — so no
 * fingerprint resolved, no `--supersedes` was passed, `blueprint observe`
 * refused under its contradiction rule, and EVERY re-learn failed. The bug
 * scaled with project age, which is why it survived so long.
 *
 * Supersede now asks the CLI (`blueprint notes --anchor`), which answers
 * against the whole store. If you ever need "which note is on this anchor",
 * ask the store — never this list. Raising the number is not a fix for
 * anything; it only moves the cliff.
 */
export const INVESTIGATIONS_CAP = 100
const INVESTIGATION_SUMMARY_MAX = 200

/** One parsed `kind: "note"` line — only the fields the board projection needs. */
interface ParsedInvestigationNote {
  ts: string
  text: string
  provenance: string
  anchors: BlueprintAnchor[]
  supersedes?: string
}

/**
 * Stable investigation fingerprint: `<text>+<JSON array of sorted anchor
 * refs>` — must match the CLI's investigationFingerprint exactly, since
 * supersede pointers target notes by this string.
 */
export function investigationFingerprint(
  note: Pick<ParsedInvestigationNote, 'text' | 'anchors'>,
): string {
  const sortedRefs = note.anchors.map((anchor) => anchor.ref).sort()
  return `${note.text}+${JSON.stringify(sortedRefs)}`
}

/** Parse one investigations.jsonl line, keeping only `kind: "note"` records. */
function parseInvestigationNoteLine(line: string): ParsedInvestigationNote | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // Corrupt line — skip it rather than failing the whole read.
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  if (record.kind !== 'note' || typeof record.text !== 'string') {
    return null
  }
  const note: ParsedInvestigationNote = {
    ts: typeof record.ts === 'string' ? record.ts : '',
    text: record.text,
    provenance: typeof record.provenance === 'string' ? record.provenance : '',
    anchors: Array.isArray(record.anchors) ? record.anchors.filter(isValidAnchor) : [],
  }
  if (typeof record.supersedes === 'string') {
    note.supersedes = record.supersedes
  }
  return note
}

/**
 * Fold investigations.jsonl content to ACTIVE notes only — a note is active
 * unless another note's `supersedes` names its fingerprint. Sorted by ts then
 * fingerprint for deterministic output (mirrors the CLI's sortNotes).
 * Exported for parity tests.
 */
export function foldActiveInvestigations(content: string): ParsedInvestigationNote[] {
  const notes: ParsedInvestigationNote[] = []
  for (const line of nonEmptyLines(content)) {
    const note = parseInvestigationNoteLine(line)
    if (note !== null) {
      notes.push(note)
    }
  }
  const superseded = new Set<string>()
  for (const note of notes) {
    if (note.supersedes !== undefined) {
      superseded.add(note.supersedes)
    }
  }
  const active = notes.filter((note) => !superseded.has(investigationFingerprint(note)))
  return active.sort((a, b) => {
    if (a.ts !== b.ts) {
      return a.ts.localeCompare(b.ts)
    }
    return investigationFingerprint(a).localeCompare(investigationFingerprint(b))
  })
}

/**
 * Project folded active notes into `BlueprintInvestigation`s, capped at
 * `INVESTIGATIONS_CAP`. A note is flagged `stale` when any of its anchor refs
 * names a module the `staleModules` set marks stale (a cheap name join — no
 * hashing; the CLI `blueprint stale-check` is the authority). Exported for
 * tests. Returns the cap-truncation flag alongside the projection.
 */
export function buildInvestigations(
  content: string,
  staleModules: ReadonlySet<string>,
): { investigations: BlueprintInvestigation[]; truncated: boolean } {
  const active = foldActiveInvestigations(content)
  const truncated = active.length > INVESTIGATIONS_CAP
  const investigations = active.slice(0, INVESTIGATIONS_CAP).map((note) => {
    const firstLine = note.text.split('\n')[0]
    const summary =
      firstLine.length > INVESTIGATION_SUMMARY_MAX ? firstLine.slice(0, INVESTIGATION_SUMMARY_MAX) : firstLine
    const anchorRefs = note.anchors.map((anchor) => anchor.ref)
    const investigation: BlueprintInvestigation = {
      anchorRefs,
      summary,
      provenance: note.provenance,
      ts: note.ts,
      fingerprint: investigationFingerprint(note),
    }
    if (anchorRefs.some((ref) => staleModules.has(ref))) {
      investigation.stale = true
    }
    return investigation
  })
  return { investigations, truncated }
}

// ── Observer ──────────────────────────────────────────────────────────────

interface RootWatch {
  watcher: FSWatcher
  /** The directories the watcher was given, symlinks RESOLVED — see `resolveWatchDirs`. */
  watchedDirs: string[]
  changeTimer: NodeJS.Timeout | null
  /** Second watcher on graphify-out/ for the code-graph landing (#535). */
  graphifyWatcher: FSWatcher | null
  graphifyTimer: NodeJS.Timeout | null
}

/**
 * The effects the drift assembly needs, all INJECTED so the observer stays
 * plain-Node loadable and the assembly is testable with a fake spawn/git. Wired
 * in main from the bundled CLI, GitManager, and LearnRunTriggers; when unset,
 * `read()` simply omits `drift` (fully backward compatible).
 */
export interface DriftObserverDeps {
  /** Run `blueprint drift-check --json` and parse it (null → no drift). */
  runDriftCheck: (rootPath: string) => Promise<DriftReport | null>
  /** Last-commit authorship for a set of repo-relative paths. */
  fileAuthors: (rootPath: string, paths: string[]) => Promise<Map<string, DriftAuthorInfo>>
  /** Repo-relative paths with uncommitted working-tree changes. */
  dirtyPaths: (rootPath: string) => Promise<Set<string>>
  /** The repo's configured `user.email` (external-vs-yours split). */
  currentUserEmail: (rootPath: string) => Promise<string | undefined>
  /** Whether a module node is in play for an active run (→ 'agent' origin). */
  isNodeInPlay: (rootPath: string, node: BlueprintNode) => boolean
  /** Read the drift-ack store for a root's structure dir. Default readDriftAcks. */
  readAcks?: (structureDir: string) => Promise<DriftAck[]>
  /** Max drift nodes shown. Default DEFAULT_DRIFT_CAP. */
  cap?: number
}

/**
 * Events:
 *   'changed' → { rootId: string }
 */
export class BlueprintObserver extends EventEmitter {
  private readonly watches = new Map<string, RootWatch>()
  private unsubscribeRoots: (() => void) | null = null
  private disposed = false
  private driftDeps: DriftObserverDeps | null = null
  /** PERF: cached drift assembly per root. `read()` runs on every board
   *  refresh, and re-spawning `blueprint drift-check` plus the git fan-out
   *  (fileAuthors/dirtyPaths/currentUserEmail) each time dominated it. The
   *  in-flight promise is cached so concurrent reads share one assembly.
   *  Invalidated on blueprint structure changes (queueChanged), on git
   *  HEAD/index changes (invalidateDriftCache — wired from GitManager in
   *  main), and by the ack/reset handlers whose writes neither watcher sees. */
  private readonly driftCache = new Map<string, DriftWork>()

  /**
   * The vault's sibling projects, swept at most once a minute.
   *
   * WHY THIS IS NOT A READ ANY MORE: `readSiblings` opens one file per project
   * directory in ~/plan-flow/brain/projects, sequentially — and that directory
   * grows by one for every project ever opened, temp checkouts included. On the
   * machine this was written on it holds 4,764 of them, which measured at
   * ~2.5 SECONDS of main-process time. `blueprint:read` paid that on every
   * call, and the board plus the conversation pane fire several at open, so the
   * app spent the first seconds of every launch with main unable to answer
   * anything — the thread list included.
   *
   * A snapshot a minute old is fine: these are other repos' derived surfaces,
   * and one appearing a moment late reads as an update.
   */
  private siblingsSnapshot: { at: number; value: BlueprintSibling[] | undefined } | null = null

  private siblingsSweep: Promise<void> | null = null
  /** PERF (#1653): cached stale-tier set per root. The stale sweep sync-hashes
   *  every adjudicated doc plus its witnesses (readFileSync + sha256) on the
   *  main process — ~1.1s per read at 300 files on a WSL /mnt/c checkout — and
   *  `read()` runs on every board refresh. Keyed by the raw file-tiers.json
   *  content so a re-adjudication recomputes even when its watcher event races
   *  the read; invalidated alongside driftCache (queueChanged, git HEAD/index
   *  changes, unwatch, dispose) so a committed doc edit flips `stale` on the
   *  next read. */
  private readonly staleTierCache = new Map<string, { tiersRaw: string; stale: Set<string> }>()

  constructor(private readonly roots: RootsProvider) {
    super()
  }

  /**
   * Late-bind the drift assembly's effects (git/CLI/run/ack). Called by main
   * after GitManager and the run triggers exist; until then, and whenever any
   * effect fails, `read()` omits `drift`. All drift work is fail-soft.
   */
  setDriftDeps(deps: DriftObserverDeps): void {
    this.driftDeps = deps
    // New effects invalidate every cached assembly (deps are late-bound once,
    // but a re-bind must never serve results computed with the old seams).
    this.driftCache.clear()
  }

  /**
   * Drop a root's cached drift assembly and stale-tier set so the next
   * `read()` recomputes them. Called on git HEAD/index changes (main wires
   * GitManager's git:changed here) and by the drift ack/reset write paths.
   */
  invalidateDriftCache(rootPath: string): void {
    this.driftCache.delete(rootPath)
    this.staleTierCache.delete(rootPath)
  }

  /** Start watching current roots and follow root list changes. */
  start(): void {
    this.syncRoots()
    this.unsubscribeRoots = this.roots.onRootsChanged(() => this.syncRoots())
  }

  /**
   * Read the blueprint data for a root (rootId === absolute rootPath).
   * Unknown roots and absent files both resolve to the empty snapshot —
   * the read never fails, and never touches any path other than the fixed
   * files under `<root>/flow/.blueprint/`.
   */
  /**
   * The cached sibling list, kicking off a refresh when it is missing or old.
   * Never awaits the sweep — see `siblingsSnapshot`.
   */
  private siblingsFor(rootPath: string): BlueprintSibling[] | undefined {
    const snapshot = this.siblingsSnapshot
    const fresh = snapshot !== null && Date.now() - snapshot.at < SIBLINGS_TTL_MS
    if (!fresh && this.siblingsSweep === null) {
      this.siblingsSweep = readSiblings(rootPath)
        .then((value) => {
          this.siblingsSnapshot = { at: Date.now(), value }
          this.emit(BLUEPRINT_CHANGED_EVENT, { rootId: rootPath })
        })
        .catch(() => undefined)
        .finally(() => {
          this.siblingsSweep = null
        })
    }
    // A sibling belonging to THIS repo is never its own sibling — the sweep
    // filters by repoPath, and a cached sweep was taken for another root, so
    // re-apply it here rather than trusting the snapshot's origin.
    return snapshot?.value?.filter((sibling) => sibling.repoPath !== rootPath)
  }

  /** Last parsed graph, keyed by the file's own identity (size + mtime). */
  private graphCache: { key: string; graph: BlueprintGraph | null } | null = null

  /** Parse graph.json, reusing the last parse when the file has not moved. */
  private parseGraphCached(
    content: string,
    stat: { size: number; mtimeMs: number } | null,
  ): BlueprintGraph | null {
    const key = stat === null ? `len:${String(content.length)}` : `${String(stat.size)}:${String(stat.mtimeMs)}`
    const cached = this.graphCache
    if (cached !== null && cached.key === key) return cached.graph
    const graph = parseGraphContent(content)
    this.graphCache = { key, graph }
    return graph
  }

  /** One in-flight read per root — see `read`. */
  private readonly readsInFlight = new Map<string, Promise<BlueprintSnapshot>>()

  /**
   * The snapshot, with concurrent callers sharing one pass.
   *
   * Every learning transition writes learning-state.jsonl, the watcher pushes
   * blueprint:changed, and every surface re-reads — measured on a real machine
   * mid-learn: FIVE reads of the same root, each reported at ~30 s, for one
   * change to one small file. They were the same work, five times over, while
   * the machine was already busy running the learn pass.
   */
  async read(rootPath: string): Promise<BlueprintSnapshot> {
    // TIMED FROM THE OUTSIDE TOO. The stage timings inside readUncached kept
    // adding up to nothing while the handler reported seconds — which means the
    // time is spent somewhere the stages cannot see: joining a read that
    // started earlier, or waiting for a main process too busy to run this
    // function's continuations. Saying WHICH is the whole point.
    const startedAt = performance.now()
    let bodyStartedAt = 0
    let bodyEndedAt = 0
    const joined = this.readsInFlight.get(rootPath)
    const work =
      joined ??
      (() => {
        bodyStartedAt = performance.now()
        return this.readUncached(rootPath).finally(() => {
          bodyEndedAt = performance.now()
          this.readsInFlight.delete(rootPath)
        })
      })()
    if (joined === undefined) this.readsInFlight.set(rootPath, work)
    try {
      return await work
    } finally {
      const elapsed = performance.now() - startedAt
      if (elapsed >= BlueprintObserver.#SLOW_READ_MS) {
        const where =
          joined !== undefined
            ? 'joined one already running'
            : `body ${String(Math.round(bodyEndedAt - bodyStartedAt))}ms, ` +
              `handed back ${String(Math.round(performance.now() - bodyEndedAt))}ms later`
        recordSlow(
          `[blueprint] read ${basename(rootPath)} answered in ${String(Math.round(elapsed))}ms (${where})`,
        )
      }
    }
  }

  /** Just the compiled story — one small file, parsed, nothing else read.
   *
   *  The conversation pane wants one field; the full read costs ten files and
   *  ships a graph measured at 1.1 MB to hand it over. */
  async readStory(rootPath: string): Promise<BlueprintSnapshot['story']> {
    return parseStoryContent(await readFileCached(join(rootPath, BLUEPRINT_DIR, STORY_FILE)))
  }

  /** Just the learning rows — one small file, parsed, nothing else read. */
  async readLearning(rootPath: string): Promise<BlueprintSnapshot['learning']> {
    const content = await readFileOrNull(join(rootPath, BLUEPRINT_DIR, LEARNING_STATE_FILE))
    return parseLearningStateContent(content)
  }

  /** A read past this is worth a line; below it, nobody felt anything. */
  static readonly #SLOW_READ_MS = 250

  /**
   * Stage timings for one read, recorded ONLY when the read was slow enough for
   * somebody to feel it.
   *
   * Measured live at 725–1,110 ms — the largest number in the channel map — and
   * the parts, measured separately, are all sub-millisecond: the 1.1 MB graph
   * parses in 0.4 ms, every store reads in under 0.2 ms. So the time is in a
   * stage nobody has isolated, and a total with no breakdown cannot say which.
   * This costs two clock reads per stage and one line per slow read.
   */
  #recordReadStages(rootPath: string, stages: Array<[string, number]>): void {
    const total = stages.reduce((sum, [, ms]) => sum + ms, 0)
    if (total < BlueprintObserver.#SLOW_READ_MS) return
    const worst = [...stages]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([name, ms]) => `${name} ${String(Math.round(ms))}ms`)
      .join(', ')
    recordSlow(`[blueprint] read ${basename(rootPath)} in ${String(Math.round(total))}ms — ${worst}`)
  }

  private async readUncached(rootPath: string): Promise<BlueprintSnapshot> {
    const stages: Array<[string, number]> = []
    /** Time one stage and hand back its value unchanged. */
    const stage = async <T>(name: string, work: () => Promise<T> | T): Promise<T> => {
      const started = performance.now()
      try {
        return await work()
      } finally {
        stages.push([name, performance.now() - started])
      }
    }
    if (!this.roots.getRoots().some((root) => root.rootPath === rootPath)) {
      return EMPTY_SNAPSHOT
    }
    // Try the new location first, then the legacy one (#69: a stale embedded CLI
    // may still write to flow/.blueprint/).
    const found = await stage('graph:read', async () => {
      for (const dir of GRAPH_DIRS) {
        const graphPath = join(rootPath, dir, GRAPH_FILE)
        const content = await readFileCached(graphPath)
        if (content !== null) {
          const stat = await fsPromises.stat(graphPath).catch(() => null)
          return { content, stat }
        }
      }
      return { content: null, stat: null }
    })
    const graphContent = found.content
    const graphStat = found.stat
    // PARSED ONCE PER VERSION. graph.json is 2.7-9 MB in real projects and the
    // learner rewrites its neighbour (learning-state.jsonl) hundreds of times
    // per run — re-parsing megabytes of unchanged JSON on each of those is work
    // nobody asked for.
    const graph = await stage('graph:parse', () =>
      graphContent === null ? null : this.parseGraphCached(graphContent, graphStat),
    )
    // story.json has no legacy location — it only ever lives under the new
    // flow/brain/.structure/ dir (introduced after the #52 consolidation).
    const story = await stage('story', async () =>
      parseStoryContent(await readFileCached(join(rootPath, BLUEPRINT_DIR, STORY_FILE))),
    )
    // learning-state.jsonl (progressive-learning) — same new-only location.
    const learning = await stage('learning', async () =>
      parseLearningStateContent(
        await readFileCached(join(rootPath, BLUEPRINT_DIR, LEARNING_STATE_FILE)),
      ),
    )
    // investigations.jsonl — active notes folded and projected for the board.
    // Cheap stale join: a note is flagged stale when one of its anchors names a
    // module the learning state marks stale (no hashing here; the CLI is the
    // stale-check authority — Phase 8 wires the actual staleness pass).
    const investigationsContent = await stage('investigations:read', () =>
      readFileCached(join(rootPath, BLUEPRINT_DIR, INVESTIGATIONS_FILE)),
    )
    const staleModules = new Set(
      (learning ?? []).filter((item) => item.status === 'stale').map((item) => item.module),
    )
    const { investigations, truncated } = await stage('investigations:fold', () =>
      buildInvestigations(investigationsContent ?? '', staleModules),
    )
    // file-tiers.json (trust-tiers) — tallies only, fail-soft; new-only location.
    const tiersContent = await stage('tiers:read', () =>
      readFileCached(join(rootPath, BLUEPRINT_DIR, FILE_TIERS_FILE)),
    )
    const tiers = await stage('tiers:summary', () => parseTierSummary(tiersContent))
    const tierFiles = await stage('tiers:files', () => parseTierFiles(tiersContent))
    if (tierFiles !== undefined && tiersContent !== null) {
      // Revocation surface (doc-verification decision #5): re-hash each
      // verdict's doc + witnesses; a moved file expires the trust. Only
      // entries WITH verdicts hash — the common all-unadjudicated read is
      // free. PERF (#1653): between invalidations the sweep is served from
      // staleTierCache — see the field's comment.
      const cachedStale = this.staleTierCache.get(rootPath)
      const staleSet = await stage('tiers:staleSweep', () =>
        cachedStale !== undefined && cachedStale.tiersRaw === tiersContent
          ? cachedStale.stale
          : computeStaleTierPaths(rootPath, tiersContent),
      )
      this.staleTierCache.set(rootPath, { tiersRaw: tiersContent, stale: staleSet })
      for (const file of tierFiles) {
        if (staleSet.has(file.path)) file.stale = true
      }
    }
    const crossLinksContent = await stage('crossLinks:read', () =>
      readFileCached(join(rootPath, BLUEPRINT_DIR, 'cross-links.jsonl')),
    )
    let crossLinks = parseCrossLinks(crossLinksContent)
    const siblings = await stage('siblings', () => this.siblingsFor(rootPath))
    if (crossLinks !== undefined && crossLinks.length > 0) {
      // Evidence join: consumer call sites (outbound sidecar) + provider-side
      // source files (each linked provider's own vault graph, read once).
      const outboundRaw = await stage('crossLinks:outbound', () =>
        readFileCached(join(rootPath, BLUEPRINT_DIR, 'outbound.json')),
      )
      const providerGraphs = await stage('crossLinks:providerGraphs', async () => {
        const graphs = new Map<string, string | null>()
        for (const provider of new Set((crossLinks ?? []).map((link) => link.provider))) {
          graphs.set(
            provider,
            await readFileCached(
              join(homedir(), 'plan-flow', 'brain', 'projects', provider, 'flow', 'brain', '.structure', 'graph.json'),
            ),
          )
        }
        return graphs
      })
      crossLinks = await stage('crossLinks:enrich', () =>
        enrichCrossLinks(crossLinks ?? [], outboundRaw, providerGraphs),
      )
    }
    // Drift (Phase 4): assembled from `blueprint drift-check` + injected git/run/
    // ack facts. Fully fail-soft — a stale/failed CLI, missing baseline, or git
    // failure yields undefined and NEVER breaks this read. PERF: served from
    // the per-root cache between invalidations — board reads never re-spawn
    // the CLI or re-run the git fan-out while nothing relevant changed.
    // NO READ EVER WAITS FOR DRIFT. `assembleDriftSafe` spawns the bundled CLI
    // and fans out over git, and the first read of a root was measured at
    // 2,343ms of MAIN-process time because of it. That was fixed for the FIRST
    // read — start the work, answer without it — and left in place for every
    // read after: `await driftWork` blocked the board on a projection it had
    // already agreed to live without. Measured on this repo: `blueprint:read
    // answered in 5,695ms (body 5,695ms)`, with every internal stage under a
    // millisecond.
    //
    // So: use the drift if it is READY, and never wait for it. When it lands,
    // the board is told and re-reads (the same blueprint:changed push a file
    // edit uses) — an update a second later, rather than a freeze now.
    let work = this.driftCache.get(rootPath)
    if (work === undefined) {
      const promise = this.assembleDriftSafe(rootPath, graph)
      const entry: DriftWork = { promise, ready: false }
      this.driftCache.set(rootPath, entry)
      work = entry
      void promise
        .then((value) => {
          entry.value = value
          entry.ready = true
          this.emit(BLUEPRINT_CHANGED_EVENT, { rootId: rootPath })
        })
        .catch(() => {
          entry.ready = true
        })
    }
    const drift = work.ready ? work.value : undefined
    // #1393: FOLD THE STORES THE BOARD STILL RENDERS.
    //
    // #52's cull ("the board is structure-only") removed the READ and left
    // everything else: the writers still append to annotations.jsonl and
    // proposals.jsonl on every `blueprint observe` / `blueprint propose`, the
    // renderers still draw annotations and ghost nodes, and derive still
    // reports `proposals: N confirmed`. So every recorded ghost and every
    // promoted run decision went into a file nothing read back — the board
    // showed none of it while the CLI kept saying it was there.
    //
    // Either half would be coherent; today's state is the incoherent one, and
    // restoring the read is the smaller change: both folds are already
    // implemented and exported in this file.
    const annotations = await stage('annotations:fold', async () =>
      foldAnnotationStream(
        (await readFileCached(join(rootPath, BLUEPRINT_DIR, ANNOTATIONS_FILE))) ?? '',
        (await readFileCached(join(rootPath, BLUEPRINT_DIR, STATUS_EVENTS_FILE))) ?? '',
      ),
    )
    const proposals = await stage('proposals:fold', async () =>
      foldProposalStream(
        (await readFileCached(join(rootPath, BLUEPRINT_DIR, PROPOSALS_FILE))) ?? '',
      ),
    )
    this.#recordReadStages(rootPath, stages)
    return {
      graph,
      annotations,
      proposals,
      mtime: graph !== null && graphStat !== null ? Math.trunc(graphStat.mtimeMs) : null,
      story,
      learning,
      investigations: investigations.length > 0 ? investigations : undefined,
      investigationsTruncated: truncated ? true : undefined,
      drift,
      tiers,
      tierFiles,
      crossLinks,
      siblings,
    }
  }

  /**
   * Assemble the snapshot's drift projection for a root, or `undefined` when
   * drift is unavailable. Every step is fail-soft and the whole method is
   * try/caught — drift must NEVER throw out of `read()`. Returns undefined when:
   * the drift deps are unwired, the CLI can't run (stale bundle / no baseline),
   * or there is zero drift to show.
   */
  private async assembleDriftSafe(
    rootPath: string,
    graph: BlueprintGraph | null,
  ): Promise<BlueprintDrift | undefined> {
    const deps = this.driftDeps
    if (deps === null) {
      return undefined
    }
    try {
      const report = await deps.runDriftCheck(rootPath)
      if (report === null || report.entries.length === 0) {
        return undefined
      }

      // The distinct paths that need git authorship (all drifted paths).
      const paths = [...new Set(report.entries.map((entry) => entry.path))]
      const [authorsByPath, dirtyPaths, currentUserEmail, acks] = await Promise.all([
        deps.fileAuthors(rootPath, paths).catch(() => new Map<string, DriftAuthorInfo>()),
        deps.dirtyPaths(rootPath).catch(() => new Set<string>()),
        deps.currentUserEmail(rootPath).catch(() => undefined),
        (deps.readAcks ?? readDriftAcks)(join(rootPath, BLUEPRINT_DIR)).catch(() => [] as DriftAck[]),
      ])

      // Pre-compute the in-play node set: resolve each entry's owning node, then
      // ask the run triggers whether that module node is in play right now.
      // #1155: the SAME attribution the assembler uses — exact sourceFile, then
      // the deepest directory-owning module. Built from one index so the in-play
      // set can't disagree with the drift rows the user is shown.
      const nodeById = new Map<string, BlueprintNode>()
      if (graph !== null && Array.isArray(graph.nodes)) {
        for (const node of graph.nodes) {
          nodeById.set(node.id, node)
        }
      }
      const sourceFileIndex = buildDriftOwnerIndex(
        graph !== null && Array.isArray(graph.nodes) ? graph.nodes : [],
      )
      const inPlayNodeIds = new Set<string>()
      for (const entry of report.entries) {
        const nodeId = ownerNodeId(entry, sourceFileIndex)
        if (nodeId === undefined || inPlayNodeIds.has(nodeId)) {
          continue
        }
        const node = nodeById.get(nodeId)
        if (node !== undefined && deps.isNodeInPlay(rootPath, node)) {
          inPlayNodeIds.add(nodeId)
        }
      }

      const drift = assembleDrift({
        driftEntries: report.entries,
        graph,
        authorsByPath,
        dirtyPaths,
        currentUserEmail,
        inPlayNodeIds,
        acks,
        cap: deps.cap ?? DEFAULT_DRIFT_CAP,
      })
      // Nothing landed in either bucket (all entries unattributable) — omit.
      if (drift.nodes.length === 0 && drift.system.length === 0) {
        return undefined
      }
      return drift
    } catch (error) {
      console.warn(`[BlueprintObserver] drift assembly failed for ${rootPath}:`, error)
      return undefined
    }
  }

  /** Stop all watchers. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeRoots?.()
    this.unsubscribeRoots = null
    const closing: Array<Promise<void>> = []
    for (const entry of this.watches.values()) {
      if (entry.changeTimer) clearTimeout(entry.changeTimer)
      if (entry.graphifyTimer) clearTimeout(entry.graphifyTimer)
      closing.push(entry.watcher.close())
      if (entry.graphifyWatcher) closing.push(entry.graphifyWatcher.close())
    }
    this.watches.clear()
    this.driftCache.clear()
    this.staleTierCache.clear()
    await Promise.all(closing)
    this.removeAllListeners()
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private syncRoots(): void {
    if (this.disposed) return
    const current = new Set(this.roots.getRoots().map((root) => root.rootPath))
    for (const rootPath of [...this.watches.keys()]) {
      if (!current.has(rootPath)) this.stopWatch(rootPath)
    }
    for (const rootPath of current) {
      if (!this.watches.has(rootPath)) this.startWatch(rootPath)
    }
  }

  /**
   * The directories to watch, with any symlink on the way RESOLVED.
   *
   * `<repo>/flow` is usually a LINK — into the project's Workspace folder (the
   * hard migration, 2026-10-06) or the vault. macOS FSEvents reports the REAL
   * path of a change, so a watcher handed the path through the link hears
   * nothing that happens behind it.
   *
   * A directory that does not exist YET still has its link resolved: the
   * deepest existing ancestor is realpath'd and the missing rest appended
   * (chokidar tolerates the missing leaf and emits once it appears). Falling
   * back to the path as given handed the watcher exactly the through-the-link
   * form FSEvents never reports — so a project whose `brain/.structure` was
   * created after launch (every fresh Workspace project) never heard its first
   * derive.
   */
  private resolveWatchDirs(rootPath: string): string[] {
    const dirs = [
      ...GRAPH_DIRS.map((dir) => join(rootPath, dir)),
      join(rootPath, FEATURES_DIR), // #1306
    ]
    return dirs.map((dir) => realPathThroughLinksSync(dir))
  }

  /** The directories a root's watcher was aimed at, or null when it has none. */
  watchedDirsOf(rootPath: string): readonly string[] | null {
    return this.watches.get(rootPath)?.watchedDirs ?? null
  }

  /**
   * Re-aim every watcher whose directories now resolve somewhere else.
   *
   * A project's `flow/` is REPLACED under a running watcher when it joins a
   * Workspace: the folder is renamed to `flow.pre-workspace-<date>/` and a link
   * to the Workspace's copy takes its place. The watcher keeps listening to
   * the renamed backup, so the board never heard another derive, learn pass
   * or tier verdict for that project until the app restarted. Called whenever
   * a project is placed (and when provisioning settles); a root whose
   * directories did not move keeps its watcher untouched. A re-aimed root is
   * announced as changed, because whatever landed while nobody listened is
   * exactly what the board is missing.
   */
  rewatchMovedRoots(): void {
    if (this.disposed) return
    for (const [rootPath, entry] of [...this.watches]) {
      const now = this.resolveWatchDirs(rootPath)
      if (now.length === entry.watchedDirs.length && now.every((dir, index) => dir === entry.watchedDirs[index])) {
        continue
      }
      this.stopWatch(rootPath)
      this.startWatch(rootPath)
      this.queueChanged(rootPath)
    }
  }

  private startWatch(rootPath: string): void {
    // Watch both the new and legacy graph dirs (#69 skew resilience). chokidar
    // tolerates a directory not existing yet and emits once it appears.
    const watchDirs = this.resolveWatchDirs(rootPath)
    const watcher = watch(watchDirs, {
      depth: 0,
      ignoreInitial: true,
      persistent: true,
      // Derive rewrites graph.json whole — wait for writes to settle so the
      // view never reads a half-written document.
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    const onFileEvent = (path: string): void => {
      // #1306: any feature markdown counts — the store is one file per
      // feature, so there is no fixed filename to allowlist. Auto-captured
      // working sets live here too and will occasionally trigger a redundant
      // re-read; the debounce absorbs it, and an extra refresh is a far better
      // failure than a board frozen for the whole session.
      if (path.endsWith('.md') && (path.includes(FEATURES_DIR) || path.includes(FEATURES_SUBPATH))) {
        this.queueChanged(rootPath)
        return
      }
      if (WATCHED_FILES.has(basename(path))) this.queueChanged(rootPath, basename(path))
    }
    watcher.on('add', onFileEvent)
    watcher.on('change', onFileEvent)
    watcher.on('unlink', onFileEvent)
    watcher.on('error', (error) => {
      console.error(`[BlueprintObserver] Watcher error for ${rootPath}:`, error)
    })

    // #535: a SEPARATE watcher for graphify's code graph. We only care about the
    // FIRST appearance (`add`) — that's a background build landing, and a re-derive
    // folds it into the board. `change` events (graphify's own incremental refreshes
    // during a normal derive) are deliberately ignored: re-deriving on them would
    // loop, since the stale-refresh path rewrites graph.json on every derive.
    const graphifyWatcher = watch(join(rootPath, GRAPHIFY_OUT_DIR), {
      depth: 0,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    })
    graphifyWatcher.on('add', (path: string) => {
      if (basename(path) === GRAPHIFY_GRAPH_FILE) this.queueGraphifyLanded(rootPath)
    })
    graphifyWatcher.on('error', (error) => {
      console.error(`[BlueprintObserver] graphify watcher error for ${rootPath}:`, error)
    })

    this.watches.set(rootPath, {
      watcher,
      watchedDirs: watchDirs,
      changeTimer: null,
      graphifyWatcher,
      graphifyTimer: null,
    })
  }

  private stopWatch(rootPath: string): void {
    const entry = this.watches.get(rootPath)
    if (!entry) return
    this.watches.delete(rootPath)
    this.driftCache.delete(rootPath)
    this.staleTierCache.delete(rootPath)
    if (entry.changeTimer) clearTimeout(entry.changeTimer)
    if (entry.graphifyTimer) clearTimeout(entry.graphifyTimer)
    entry.watcher.close().catch((error) => {
      console.error(`[BlueprintObserver] Failed to close watcher for ${rootPath}:`, error)
    })
    entry.graphifyWatcher?.close().catch((error) => {
      console.error(`[BlueprintObserver] Failed to close graphify watcher for ${rootPath}:`, error)
    })
  }

  /** Debounced emit of GRAPHIFY_LANDED — the code graph first appeared (#535). */
  private queueGraphifyLanded(rootPath: string): void {
    const entry = this.watches.get(rootPath)
    if (!entry || this.disposed) return
    if (entry.graphifyTimer) clearTimeout(entry.graphifyTimer)
    entry.graphifyTimer = setTimeout(() => {
      entry.graphifyTimer = null
      this.emit(GRAPHIFY_LANDED_EVENT, { rootId: rootPath })
    }, CHANGE_DEBOUNCE_MS)
  }

  /**
   * Something the board draws changed outside the watched files — the
   * storyline import index landing after a partial feature-graph read
   * (import-index-warmer.ts) — so surfaces re-read, through the same debounce.
   */
  announceChanged(rootPath: string): void {
    this.queueChanged(rootPath)
  }

  /** Files touched since the last push, per root — see queueChanged. */
  private readonly changedFiles = new Map<string, Set<string>>()

  private queueChanged(rootPath: string, file?: string): void {
    const entry = this.watches.get(rootPath)
    if (!entry || this.disposed) return
    // WHAT CHANGED, not just THAT something did. A learn run rewrites
    // learning-state.jsonl hundreds of times, and each push made every surface
    // re-read the WHOLE snapshot — 2.7 MB of graph in a real project,
    // structured-cloned into the renderer, which is where its main thread was
    // measured spending its time (v8::ValueSerializer, 11% of a supposedly
    // idle window). A change that only touched the learning file does not need
    // the graph re-sent.
    const touched = this.changedFiles.get(rootPath) ?? new Set<string>()
    if (file !== undefined) touched.add(file)
    this.changedFiles.set(rootPath, touched)
    // Structure changed — cached drift may reference a stale graph/baseline.
    // Invalidate immediately (not on the debounce) so a read racing the
    // debounce window doesn't re-cache against the old files.
    this.invalidateDriftCache(rootPath)
    if (entry.changeTimer) clearTimeout(entry.changeTimer)
    entry.changeTimer = setTimeout(() => {
      entry.changeTimer = null
      this.invalidateDriftCache(rootPath)
      const files = this.changedFiles.get(rootPath) ?? new Set<string>()
      this.changedFiles.delete(rootPath)
      const learningOnly = files.size > 0 && [...files].every((name) => name === LEARNING_STATE_FILE)
      this.emit(BLUEPRINT_CHANGED_EVENT, {
        rootId: rootPath,
        ...(learningOnly ? { learningOnly: true } : {}),
      })
    }, CHANGE_DEBOUNCE_MS)
  }
}

async function readFileOrNull(filePath: string): Promise<string | null> {
  try {
    return await fsPromises.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * The same read, served from memory while the file has not moved.
 *
 * The board's read touches ten files, and on a real profile the stage timings
 * put them at tens of milliseconds each: `graph:read 71ms`, `learning 61ms`,
 * `story 35ms`, `tiers:read 29ms`, `crossLinks:providerGraphs 83ms`. They are
 * re-read on every board refresh, and during a learn run the learner rewrites
 * one of their neighbours hundreds of times, so every one of those refreshes
 * re-read all ten.
 *
 * A stat is a fraction of a millisecond and answers the only question that
 * matters: is this the same file? Size AND mtime, because either alone can
 * repeat. The parse caches downstream (graph) key off the same facts.
 *
 * Bounded, and dropped when a file's identity moves — this is a read-through
 * cache, not a store: nothing here is authoritative, and a miss simply costs
 * what the read always cost.
 */
const fileCache = new Map<string, { key: string; content: string }>()
/** Files kept in memory at once. Ten per root, a handful of roots, plus the
 *  vault's sibling graphs — well above what a session touches. */
const FILE_CACHE_LIMIT = 64

async function readFileCached(filePath: string): Promise<string | null> {
  let key: string
  try {
    const stat = await fsPromises.stat(filePath)
    key = `${String(stat.size)}:${String(stat.mtimeMs)}`
  } catch {
    fileCache.delete(filePath)
    return null
  }
  const cached = fileCache.get(filePath)
  if (cached !== undefined && cached.key === key) return cached.content
  const content = await readFileOrNull(filePath)
  if (content === null) {
    fileCache.delete(filePath)
    return null
  }
  if (fileCache.size >= FILE_CACHE_LIMIT) {
    const oldest = fileCache.keys().next().value
    if (oldest !== undefined) fileCache.delete(oldest)
  }
  fileCache.set(filePath, { key, content })
  return content
}

/** Test-only: forget every cached file. */
export function clearBlueprintFileCache(): void {
  fileCache.clear()
}

/**
 * Read the persisted corpus index for a root (changes-discovery-view #1532).
 *
 * A PLAIN FILE READ, deliberately — no CLI spawn, no mining: the CLI's
 * discover pass owns writing the index, and this channel only reports what
 * the last pass left behind. Fail-soft by contract (the index lives in the
 * derived/regenerable tier): a missing, unreadable or shape-invalid file is
 * an EMPTY index (`indexedAt: null`), never a throw across IPC.
 */
export async function readCorpusIndexFile(rootId: string): Promise<BlueprintCorpusIndexResult> {
  const raw = await readFileOrNull(join(rootId, CORPUS_INDEX_FILE))
  if (raw === null) return { indexedAt: null, entries: [] }
  try {
    const parsed = JSON.parse(raw) as BlueprintCorpusIndexResult
    if (typeof parsed?.indexedAt !== 'string' || !Array.isArray(parsed.entries)) {
      return { indexedAt: null, entries: [] }
    }
    // Mirrors the CLI reader's per-entry guard (src/cli/blueprint/
    // corpus-index.ts) minus the `created` requirement — legacy records
    // without dates still travel, per the contract's optional fields.
    return {
      indexedAt: parsed.indexedAt,
      entries: parsed.entries.filter((entry) => typeof entry?.path === 'string'),
    }
  } catch {
    // Sanctioned fail-soft: corrupt JSON in a derived store reads as empty.
    return { indexedAt: null, entries: [] }
  }
}

// ── Bundled drift-check runner (drift feature, Phase 4) ──────────────────────

/** Hard cap on one drift-check spawn — a hung CLI must not pin a read. */
const DRIFT_CHECK_TIMEOUT_MS = 30_000
/** Keep only the tail of stdout — the JSON report is small. */
const DRIFT_STDOUT_TAIL_CHARS = 1_000_000

/**
 * Build the default drift-check runner: spawn the app-embedded CLI as
 * Electron-as-Node (`blueprint drift-check --json`) in the root, capture stdout,
 * and parse it. Read-only — drift-check never writes. Fail-soft: a spawn
 * failure, non-zero exit (e.g. a STALE bundle that predates the `drift-check`
 * verb → "unknown action"), timeout, or unparseable output resolves to null.
 * Mirrors makeBundledStaleCheck in learn-triggers.ts.
 */
export function makeBundledDriftCheck(
  bundledCli: BundledCli,
  spawnFn: typeof spawn = spawn,
): (rootPath: string) => Promise<DriftReport | null> {
  return (rootPath) =>
    new Promise<DriftReport | null>((resolve) => {
      let stdout = ''
      let settled = false
      const settle = (value: DriftReport | null): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      let child: ReturnType<typeof spawnFn>
      try {
        child = spawnFn(
          bundledCli.execPath,
          [bundledCli.cliPath, 'blueprint', 'drift-check', '--json'],
          {
            cwd: rootPath,
            stdio: ['ignore', 'pipe', 'ignore'],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          },
        )
      } catch {
        resolve(null)
        return
      }
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        settle(null)
      }, DRIFT_CHECK_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer | string) => {
        stdout = (stdout + String(chunk)).slice(-DRIFT_STDOUT_TAIL_CHARS)
      })
      child.on('error', () => settle(null))
      child.on('close', (code) => {
        settle(code === 0 ? parseDriftReport(stdout) : null)
      })
    })
}

// ── IPC registration ──────────────────────────────────────────────────────

export interface BlueprintChannelDeps {
  /** Project roots provider (adapter over ProjectRegistry — see rootsProviderFrom). */
  roots: RootsProvider
  /** Optional pre-built observer (tests); defaults to one built from `roots`. */
  observer?: BlueprintObserver
  /** Optional pre-built derive runner (tests); defaults to one built from `roots`. */
  deriveRunner?: BlueprintDeriveRunner
  /** The app-embedded planflow-ai CLI, tried first by the default derive runner. */
  bundledCli?: BundledCli | null
  /** Builds a project's import index after a `partial` feature-graph read (import-index-warmer.ts). */
  importIndexWarmer?: Pick<ImportIndexWarmer, 'followUp'>
}

/**
 * Implements the contract's `blueprint:read` and `blueprint:derive` invoke
 * channels and pushes `blueprint:changed` events to every window. Returns a
 * dispose function that unregisters the handlers and stops the observer.
 */
export function registerBlueprintChannels(deps: BlueprintChannelDeps): () => void {
  // Lazy require keeps this module importable from plain Node (harnesses);
  // typing stays exact via `typeof import('electron')`.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ipcMain, BrowserWindow } = require('electron') as typeof import('electron')

  const observer = deps.observer ?? new BlueprintObserver(deps.roots)
  observer.start()

  const registeredChannels: IpcInvokeChannel[] = []

  /** Contract-typed ipcMain.handle (same pattern as src/main/ipc/index.ts). */
  function handle<C extends IpcInvokeChannel>(
    channel: C,
    handler: (request: IpcRequest<C>) => IpcResponse<C> | Promise<IpcResponse<C>>,
  ): void {
    registeredChannels.push(channel)
    ipcMain.handle(channel, (_event, request: IpcRequest<C>) => timed(channel, handler)(request))
  }

  function broadcast<C extends IpcEventChannel>(
    channel: C,
    payload: IpcEventPayload<C>,
  ): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) {
        window.webContents.send(channel, payload)
      }
    }
  }

  const deriveRunner =
    deps.deriveRunner ??
    new BlueprintDeriveRunner(deps.roots, undefined, undefined, deps.bundledCli ?? null)

  handle('blueprint:read', ({ rootId }) => observer.read(rootId))
  // Derive runs in main so the view never has to tell the user to run a CLI
  // command; completion is observed via the watcher's blueprint:changed push.
  // First run: if the project has no flow/ yet, provision it under the hood
  // (`init --yes` via the embedded CLI) so a brand-new project derives out of
  // the box — no terminal, no manual setup. Fail-soft: derive runs regardless.
  handle('blueprint:derive', async ({ rootId }) => {
    const setup = await ensureProjectInitialized(rootId, { bundledCli: deps.bundledCli ?? null })
    if (setup.ranInit && !setup.ok) {
      console.warn(`[Blueprint] under-the-hood init failed for ${rootId}: ${setup.error ?? '?'}`)
    }
    const result = await deriveRunner.derive(rootId)
    // RE-CHECK MEANS RE-CHECK. The Learning panel's ⟳ ("re-derive the map,
    // re-read docs and staleness") lands here, but the stale-tier sweep is
    // cached until git's HEAD/index moves (#1653) — so a witness edited in the
    // working tree kept its doc reading `verified` through the very press that
    // promised to look again. An explicit derive drops the cached sweep.
    observer.invalidateDriftCache(rootId)
    return result
  })
  // Live change-simulation reconciliation (blueprint-simulation): predicted
  // baseline vs the run's actual touched anchors, computed by the bundled CLI.
  // Same rootId validation; fail-soft (available:false) on any error.
  handle('blueprint:reconcile', async ({ rootId, plan }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { available: false, reason: 'unknown root', nodes: [], surprises: [] }
    }
    return runReconcile(deps.bundledCli ?? null, rootId, plan)
  })
  // Change-brief delta (change-brief): the plan's before/after world, computed
  // by the bundled CLI. Same rootId validation; fail-soft (available:false) on
  // any error so a missing story or CLI simply leaves brief mode unavailable
  // rather than breaking the board.
  handle('blueprint:brief', async ({ rootId, plan, feature, doc }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return {
        available: false,
        reason: 'unknown root',
        nodes: [],
        wires: [],
        fails: [],
        anchors: [],
        steps: [],
      }
    }
    return runBrief(deps.bundledCli ?? null, rootId, plan, {
      ...(feature !== undefined ? { feature } : {}),
      ...(doc !== undefined ? { doc } : {}),
    })
  })
  // Feature graph (feature-blueprint): the board's default view. Same rootId
  // validation; fail-soft so an empty store simply renders the empty state.
  handle('blueprint:featureGraph', async ({ rootId }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      // `limitations: null` is UNKNOWN, not clean — nothing was measured for a
      // root that does not exist, and the board says exactly that.
      return { available: false, reason: 'unknown root', nodes: [], edges: [], limitations: null }
    }
    const graph = await runFeatures(deps.bundledCli ?? null, rootId)
    // A cold import index left the folder rows partial: build it now (off this
    // path) and announce the change, so the board's next read is whole.
    if (graph.importIndex === 'partial') deps.importIndexWarmer?.followUp(rootId)
    return graph
  })
  // The Workspace map (decision workspace-blueprint): every project of the
  // root's Workspace side by side, plus the links between them — the board's
  // root level. Same rootId validation; fail-soft so a project in no Workspace
  // (or a failed read) draws on its own exactly as before.
  handle('blueprint:workspaceGraph', async ({ rootId }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { available: false, reason: 'unknown root', workspace: null, projects: [], links: null, linksError: null }
    }
    const graph = await runWorkspaceGraph(deps.bundledCli ?? null, rootId)
    return alignLocalPaths(graph, deps.roots.getRoots().map((root) => root.rootPath))
  })
  // Feature code map (#1533): one feature's file/import graph, computed on
  // demand by the bundled CLI. Same rootId validation; fail-soft so an unknown
  // feature or a missing CLI renders the honest empty state.
  handle('blueprint:featureMap', async ({ rootId, feature }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return {
        available: false,
        reason: 'unknown root',
        feature: '',
        files: [],
        edges: [],
        unresolved: [],
      }
    }
    return runFeatureMap(deps.bundledCli ?? null, rootId, feature)
  })

  // One feature's recorded couplings, with the store's own words — the reader
  // channel `featureGraph` deliberately leaves open by carrying shape only.
  handle('blueprint:featureRelations', async ({ rootId, feature }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { available: false, reason: 'unknown root', feature: '', name: '', relations: [] }
    }
    return runFeatureRelations(deps.bundledCli ?? null, rootId, feature)
  })
  // Persisted corpus index (changes-discovery-view #1532): a read of
  // flow/brain/.derived/corpus-index.json — with ONE self-heal (#1716). The
  // index used to be written only by a discover pass, and automatic discovery
  // fires only on an EMPTY feature store (#1307), so any store populated
  // before #1532 showed "no corpus index yet — the next discovery pass writes
  // it" while promising a pass that could never run. An absent index now
  // triggers the index-only verb once per root per session (it mines the
  // corpus and writes the index, touching nothing else), then re-reads.
  // Fail-soft: a failed backfill serves the honest empty read it always did.
  const corpusBackfillTried = new Set<string>()
  handle('blueprint:corpusIndex', async ({ rootId }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { indexedAt: null, entries: [] }
    }
    const first = await readCorpusIndexFile(rootId)
    if (first.indexedAt !== null || corpusBackfillTried.has(rootId)) return first
    corpusBackfillTried.add(rootId)
    const backfill = await runFeatureIndexing(deps.bundledCli ?? null, rootId)
    if (!backfill.ok) {
      console.warn(`flow: corpus index backfill failed for ${rootId} — ${backfill.reason ?? 'unknown'}`)
      return first
    }
    return readCorpusIndexFile(rootId)
  })
  // #1307: populate an EMPTY feature store from the IDE. Same rootId
  // validation; fail-soft, and it reports WHY so the board can say so rather
  // than leaving the reader at another dead end.
  handle('blueprint:discoverFeatures', async ({ rootId }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { ok: false, reason: 'unknown root' }
    }
    return runFeatureDiscovery(deps.bundledCli ?? null, rootId)
  })
  // A person pins (or clears) a feature's home folder from a row on the map
  // (plan feature-home-folders, FR-10) — the CLI's one writer, in the root's
  // checkout. Same rootId validation; the board re-reads the graph after.
  handle('blueprint:setFeatureHome', async (request) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === request.rootId)) {
      return { ok: false, reason: 'unknown root', folder: request.folder ?? null }
    }
    return runFeatureHome({ bundledCli: deps.bundledCli }, request)
  })
  // Basic fallback graph — derived in-memory by main (no CLI, never written
  // to disk). Same rootId validation as blueprint:read: unknown roots get
  // an empty result, and no path outside the validated root is ever read.
  // The cheap half of read: the learning rows, for a change that touched
  // nothing else (see blueprint:changed's `learningOnly`).
  handle('blueprint:readStory', async ({ rootId }) => ({
    story: await observer.readStory(rootId),
  }))
  // A file (or a part's files) read as a story by the CLI. Same rootId
  // validation as blueprint:read; the compiler and tree-sitter paths are
  // resolved once, lazily (undefined = not looked yet, null = the app ships
  // none). Never throws.
  let storylineTypeScript: string | null | undefined
  let storylineTreeSitter: string | null | undefined
  // Concurrent asks for the same story share one CLI run (a cold one builds
  // the import index) — see `shareStorylineRuns`.
  const sharedStoryline = shareStorylineRuns((request) =>
    runStoryline(
      { bundledCli: deps.bundledCli, typescriptPath: storylineTypeScript, treeSitterPath: storylineTreeSitter },
      request,
    ),
  )
  handle('blueprint:storyline', async (request) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === request.rootId)) {
      return { ok: false, reason: 'not-found', sentence: "That project isn't open." }
    }
    if (storylineTypeScript === undefined) storylineTypeScript = resolveTypeScriptPath()
    if (storylineTreeSitter === undefined) storylineTreeSitter = resolveTreeSitterPath()
    return sharedStoryline(request)
  })
  // A plan's change notes, read and decided through the CLI's one reader and
  // one writer (plan `plan_change_review`). Same root validation as
  // blueprint:storyline — a root the renderer may not address is refused
  // before anything runs; the reader resolves quotes with the storyline's
  // compiler and tree-sitter paths. Never throws.
  const PROJECT_NOT_OPEN = "That project isn't open."
  handle('plan:notes', async (request) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === request.rootPath)) {
      return { ok: false, reason: null, detail: PROJECT_NOT_OPEN }
    }
    if (storylineTypeScript === undefined) storylineTypeScript = resolveTypeScriptPath()
    if (storylineTreeSitter === undefined) storylineTreeSitter = resolveTreeSitterPath()
    return readPlanNotes(
      { bundledCli: deps.bundledCli, typescriptPath: storylineTypeScript, treeSitterPath: storylineTreeSitter },
      request,
    )
  })
  // One write per plan at a time — see `serializePlanNoteWrites`.
  const writePlanNote = serializePlanNoteWrites((request) => setPlanNote({ bundledCli: deps.bundledCli }, request))
  handle('plan:setNote', async (request) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === request.rootPath)) {
      return { ok: false, reason: null, detail: PROJECT_NOT_OPEN }
    }
    return writePlanNote(request)
  })
  // What connects to a feature's diagram, read by the CLI. Same rootId
  // validation as blueprint:storyline; one run per root + feature shared by
  // concurrent asks, dropped on that root's next blueprint:changed. Never throws.
  const featurePortsCache = createFeaturePortsCache((request) =>
    runFeaturePorts({ bundledCli: deps.bundledCli }, request),
  )
  handle('blueprint:featurePorts', async (request) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === request.rootId)) {
      return { ports: null, reason: 'not-found', sentence: "That project isn't open." }
    }
    return featurePortsCache.get(request)
  })
  handle('blueprint:readLearning', async ({ rootId }) => ({
    learning: (await observer.readLearning(rootId)) ?? [],
  }))
  handle('blueprint:readBasic', async ({ rootId }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { graph: null }
    }
    try {
      return { graph: await deriveBasicGraph(rootId) }
    } catch (error) {
      console.warn(`[BlueprintObserver] basic derive failed for ${rootId}:`, error)
      return { graph: null }
    }
  })
  // "What was implemented" — feature/phase/file view read from the project's
  // plan files (CLI-independent). Same rootId validation; never throws.
  handle('blueprint:features', async ({ rootId }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { features: [] }
    }
    try {
      return { features: await readPlanFeatures(rootId) }
    } catch (error) {
      console.warn(`[BlueprintObserver] features read failed for ${rootId}:`, error)
      return { features: [] }
    }
  })
  // Board Review Mode (#609): append one file verdict to flow/.rounds.jsonl.
  // Same rootId validation as the read channels — an unknown root never writes
  // and comes back fail-soft (ok:false) with the deterministic fingerprint.
  // The renderer passes the approve→'kept' / refuse→'dismissed' classification
  // directly, so it flows through untouched.
  handle('flow:recordVerdict', async ({ rootId, filePath, classification, reason }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { ok: false, fingerprint: buildVerdictFingerprint(filePath) }
    }
    return appendReviewVerdict(rootId, { filePath, classification, reason })
  })

  // Drift ack (Phase 5): append one human "I've seen this drift" acknowledgement
  // to the precious, append-only drift-acks store under the root's
  // flow/brain/.structure/ dir. Same rootId validation as the read channels — an
  // unknown root never writes and comes back fail-soft (ok:false). The store is
  // itself fail-soft, so a write failure surfaces as ok:false, never a throw.
  handle('blueprint:ackDrift', async ({ rootId, nodeId, commit, paths }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { ok: false }
    }
    await appendDriftAck(join(rootId, BLUEPRINT_DIR), { nodeId, commit, ackedAt: new Date().toISOString() })
    // ALSO advance the drift baseline so the acked node stops reading as drift —
    // the drift-acks.jsonl record stays the audit trail. Fail-soft: a missing
    // CLI or a spawn failure leaves the baseline untouched (drift re-shows), it
    // never fails the ack.
    if (deps.bundledCli && paths.length > 0) {
      await runBundledCliCapturing(deps.bundledCli, rootId, [
        'blueprint',
        'drift-ack',
        '--paths',
        paths.join(','),
      ]).catch(() => undefined)
    }
    // The ack store + advanced baseline aren't in either watcher's file set —
    // drop the cached drift so the acked node disappears on the next read.
    observer.invalidateDriftCache(rootId)
    return { ok: true }
  })

  // "Mark everything reviewed" — re-establish the drift baseline to the current
  // tree via the bundled CLI (`blueprint drift-reset`). Same rootId validation;
  // fail-soft: a missing CLI or a spawn failure returns ok:false, never throws.
  handle('blueprint:driftReset', async ({ rootId }) => {
    if (!deps.roots.getRoots().some((root) => root.rootPath === rootId)) {
      return { ok: false }
    }
    if (!deps.bundledCli) {
      return { ok: false }
    }
    const result = await runBundledCliCapturing(deps.bundledCli, rootId, [
      'blueprint',
      'drift-reset',
    ]).catch(() => ({ ok: false as const, stdout: '' }))
    // Baseline rewritten out-of-watcher — same cache-drop rule as ackDrift.
    observer.invalidateDriftCache(rootId)
    return { ok: result.ok }
  })

  const onChanged = (event: IpcEventPayload<'blueprint:changed'>): void => {
    featurePortsCache.clear(event.rootId)
    broadcast('blueprint:changed', event)
  }
  observer.on(BLUEPRINT_CHANGED_EVENT, onChanged)

  // #535: graphify's background code-graph build just landed for this root —
  // re-derive so the enrichment folds it in. The derive writes the structure
  // graph.json, which the normal watcher observes → blueprint:changed → the board
  // reloads with full structure, replacing the "building…" banner. Fail-soft: a
  // failed re-derive just leaves the last state (the user can still Refresh).
  const onGraphifyLanded = (event: { rootId: string }): void => {
    void deriveRunner.derive(event.rootId).catch((error) => {
      console.warn(`[Blueprint] re-derive after graphify build failed for ${event.rootId}:`, error)
    })
  }
  observer.on(GRAPHIFY_LANDED_EVENT, onGraphifyLanded)

  return function disposeBlueprintChannels(): void {
    for (const channel of registeredChannels) {
      ipcMain.removeHandler(channel)
    }
    registeredChannels.length = 0
    observer.off(BLUEPRINT_CHANGED_EVENT, onChanged)
    observer.dispose().catch((error) => {
      console.error('[BlueprintObserver] Dispose failed:', error)
    })
  }
}

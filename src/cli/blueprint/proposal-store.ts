/**
 * File I/O for the proposal store at `<flowDir>/brain/.structure/proposals.jsonl`.
 *
 * Proposals are PREDICTED graph nodes ("ghosts") named by a plan before the
 * code that would make the extractors derive them exists. They live in their
 * own store with their own lifecycle — `graph.json` stays derived-only and is
 * never touched by this module. Ghost→real confirmation is mechanical: a
 * proposal is confirmed only when its EXACT `predictedNodeId` appears in a
 * freshly derived graph (Phase 3's derive pass owns that wiring).
 *
 * CONFIRMATION IS PER-KIND, because there is more than one graph. The four
 * extractor kinds live in `graph.json`; a `part` lives in the FEATURE graph,
 * built from a feature's `## Parts` markdown, and appears in `graph.json`
 * never. Checked against the extractor graph alone, every proposed part would
 * miss, stay unconfirmed and quietly stale on the next sweep — a step that
 * never runs while everything upstream reports healthy. So the ids each kind is
 * matched against are supplied per kind (`confirmableProposals`), and both
 * halves stay exact-id matches: no fuzzy matching, no judgment.
 *
 * NEW vs CHANGED IS DERIVED, NEVER DECLARED. A proposal whose anchors already
 * resolve names something that exists, so it is a CHANGE to it; one whose
 * anchors resolve to nothing is NEW. The alternative — a `--state` flag — was
 * rejected because a declared state can disagree with reality and still be
 * repeated back as fact. Derivation reuses `resolveAnchors`, the one resolver,
 * so the three anchor forms (bare path, `file:`, `module:`) cannot drift apart.
 *
 * Lifecycle is EVENT-fold: every line is one `ProposalEvent`, and the
 * effective state of a proposal (identified by its fingerprint,
 * `<plan>+<predictedNodeId>`) is the LAST event for that fingerprint —
 * simpler than the investigation store's supersede chains; no cycle
 * machinery exists or is needed. Fold-on-read mirrors the sibling stores:
 * fail-soft per-line parse (malformed lines are skipped AND counted),
 * deterministic ordering (ts, then file order within a fingerprint;
 * proposedAt then fingerprint across proposals).
 *
 * Single-writer invariants live in code, never prompt convention: the only
 * writer is `appendProposalEvent`, invoked exclusively via the mediated
 * `blueprint propose` CLI, and every append acquires the store's ONE lock
 * file (`proposals.lock`, shared `acquireGraphLock` semantics — brief retry,
 * stale reclaim). A contended append throws a one-line busy error surfaced
 * fail-soft by the CLI; nothing is written. Reads never lock.
 *
 * ACCOUNTING IS NEVER SILENT. Emission stays a judgment the agent makes, but
 * the outcome of that judgment is reported, not assumed: every mediated write
 * reports the plan's resulting store state (`countProposals` /
 * `formatProposalsRecorded`) and every refusal carries a caller-surfaceable
 * reason (`validateProposalRecord` / `validateProposalDecision` /
 * `formatProposeRefusal`). A run that records nothing must be able to SAY it
 * recorded nothing — the store went un-written in every project on this
 * machine precisely because no code path could count to zero out loud.
 */

import { appendFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireGraphLock,
  BLUEPRINT_DIRNAME,
  ensureBlueprintDir,
  isValidAnchor,
  readJsonlLines,
} from './store.js';
import { normalizeAnchorRef, resolveAnchors } from './feature-graph.js';
import { FEATURE_ID_PREFIX, FEATURE_NAMESPACE_SEPARATOR, slugifyFeatureName } from './feature-store.js';
import type { Anchor, BlueprintGraph, BlueprintNodeKind } from './types.js';

/** Filename of the proposal store inside `<flowDir>/brain/.structure/`. */
export const PROPOSALS_FILENAME = 'proposals.jsonl';
/** Lock file shared by every proposal-store writer (ONE lock per store). */
const PROPOSALS_LOCK_FILENAME = 'proposals.lock';

/**
 * One-line notice thrown when an append cannot acquire the store lock after
 * `acquireGraphLock`'s brief retry loop. Surfaced fail-soft by the CLI as
 * `propose refused: proposal store busy — retry`.
 */
export const PROPOSAL_STORE_BUSY_NOTICE = 'proposal store busy — retry';

/** The six lifecycle events a proposal line may carry. */
export type ProposalEventName = 'proposed' | 'accepted' | 'rejected' | 'confirmed' | 'stale' | 'cleared';

/** Every lifecycle event name, in lifecycle order (for validation). */
export const PROPOSAL_EVENT_NAMES: readonly ProposalEventName[] = [
  'proposed',
  'accepted',
  'rejected',
  'confirmed',
  'stale',
  'cleared',
];

/**
 * What a proposal may predict — the four EXTRACTOR node kinds plus `part`.
 *
 * A part is deliberately NOT a `BlueprintNodeKind`: it is not derived by any
 * extractor and never appears in `graph.json`. It is a piece of a feature, read
 * from that feature's `## Parts` section and turned into a node by
 * `buildFeatureGraph` — a different graph, on a different axis. Widening
 * `BlueprintNodeKind` to hold it would have told every extractor consumer that
 * a kind it can never produce exists, and would have collided with the frozen
 * `VIEW_NODE_KINDS`. So proposals get their own union, one wider than the
 * extractors', and the two stay separable by name everywhere it matters
 * (`isExtractorProposalKind`).
 */
export type ProposalKind = BlueprintNodeKind | 'part';

/** The four node kinds an EXTRACTOR emits — the subset confirmed against `graph.json`. */
export const EXTRACTOR_PROPOSAL_KINDS: readonly BlueprintNodeKind[] = [
  'integration',
  'endpoint',
  'datastore',
  'module',
];

/** Every kind a proposal may predict: the extractor kinds plus `part`. */
export const PROPOSAL_KINDS: readonly ProposalKind[] = [...EXTRACTOR_PROPOSAL_KINDS, 'part'];

/** Whether a proposal kind is one the extractors derive (i.e. lives in `graph.json`). */
export function isExtractorProposalKind(kind: ProposalKind): kind is BlueprintNodeKind {
  return kind !== 'part';
}

/**
 * One line of the proposal store. Decision/terminal events re-carry the
 * payload fields (kind/label/…) so every line is self-describing, but the
 * fold always trusts the FIRST `proposed` event's payload.
 */
export interface ProposalEvent {
  /** ISO timestamp of the event. */
  ts: string;
  /** Plan name the proposal belongs to (fingerprint half). */
  plan: string;
  /** Optional plan phase number that predicted the node. */
  phase?: number;
  /** Exact node id the extractors are predicted to derive (fingerprint half). */
  predictedNodeId: string;
  /** Predicted node kind — must agree with the id's prefix. */
  kind: ProposalKind;
  /** Human display label for the ghost card. */
  label: string;
  /** Optional free-text detail. */
  detail?: string;
  /** Optional anchors into existing code related to the prediction. */
  anchors?: Anchor[];
  /** Lifecycle event this line records. */
  event: ProposalEventName;
  /** Where the event came from (e.g. `cli:propose`) — never self-narration. */
  provenance: string;
}

/**
 * The folded (effective) state of one proposal: the first `proposed` event's
 * payload plus the current state (LAST event for the fingerprint wins) and
 * the lifecycle timestamps observed along the way. Timestamps are historical
 * — a re-`proposed` event resets `state` but never erases an earlier
 * `decidedAt`/`confirmedAt` (the state alone reflects the current lifecycle).
 */
export interface EffectiveProposal {
  /** Stable identity: `<plan>+<predictedNodeId>`. */
  fingerprint: string;
  plan: string;
  phase?: number;
  predictedNodeId: string;
  kind: ProposalKind;
  label: string;
  detail?: string;
  anchors: Anchor[];
  /** Current lifecycle state — the latest event for the fingerprint. */
  state: ProposalEventName;
  /** Provenance of the first `proposed` event. */
  provenance: string;
  /** Timestamp of the first `proposed` event. */
  proposedAt: string;
  /** Timestamp of the most recent `accepted`/`rejected` event, when any. */
  decidedAt?: string;
  /** Timestamp of the most recent `confirmed` event, when any. */
  confirmedAt?: string;
}

// ── predicted-id grammar ─────────────────────────────────
//
// One named pattern per extractor id convention. A predicted id is valid
// only when it matches ITS kind's pattern — the kind prefix is anchored
// inside each pattern, so kind/id agreement is inherent (an id with the
// wrong prefix can never match another kind's pattern).

/** `integration:<name>` — SDK or host name, no spaces, no further colons. */
export const INTEGRATION_ID_PATTERN = /^integration:[^\s:]+$/;
/** `integration:webhook:<path>` — webhook mount, path starts with `/`. */
export const INTEGRATION_WEBHOOK_ID_PATTERN = /^integration:webhook:\/[^\s]+$/;
/** `endpoint:<METHOD> <path>` — uppercase HTTP verb, path starts with `/`. */
export const ENDPOINT_HTTP_ID_PATTERN = /^endpoint:[A-Z]+ \/[^\s]*$/;
/** `endpoint:cli <command>` — CLI command name, single token. */
export const ENDPOINT_CLI_ID_PATTERN = /^endpoint:cli [^\s]+$/;
/** `datastore:<name>` — datastore name (migration dirs keep their colons). */
export const DATASTORE_ID_PATTERN = /^datastore:[^\s]+$/;
/** `module:<repo-relative-dir>` — posix path, relative (no leading `/`). */
export const MODULE_ID_PATTERN = /^module:(?!\/)[^\s\\]+$/;
/**
 * `feature:<slug>/<part-slug>` — the id `partNodeId` mints, and the ONLY
 * proposal grammar that is not an extractor's.
 *
 * Both halves are `slugifyFeatureName` output, so the pattern is that
 * function's range written as a regex: lowercase alphanumerics in
 * dash-separated runs, never leading, trailing or doubled dashes. Writing it
 * loosely as `[a-z0-9-]+` would accept `feature:-chats/-sse-` — ids nothing can
 * ever mint, so a proposal carrying one could never confirm and would sit
 * looking valid until it silently staled.
 *
 * In a Workspace project the feature id carries its project
 * (`feature:<project>::<slug>`, feature-store's FEATURE_NAMESPACE_SEPARATOR),
 * so its parts are `feature:<project>::<slug>/<part-slug>` — the optional
 * leading `<project>::` group. The project slug follows the same slug grammar.
 */
export const PART_ID_PATTERN =
  /^feature:(?:[a-z0-9]+(?:-[a-z0-9]+)*::)?[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Human-readable grammar hint per kind, for refusal messages and docs. */
export const PREDICTED_ID_GRAMMAR: Record<ProposalKind, string> = {
  integration: 'integration:<name> or integration:webhook:</path>',
  endpoint: 'endpoint:<METHOD> </path> or endpoint:cli <command>',
  datastore: 'datastore:<name>',
  module: 'module:<repo-relative-dir>',
  part: 'feature:<slug>/<part-slug> or feature:<project>::<slug>/<part-slug>',
};

/**
 * One valid id per kind, quoted in every refusal so the asker sees the shape
 * filled in rather than only its placeholders. Each one passes its own kind's
 * grammar (pinned by a test).
 */
export const PREDICTED_ID_EXAMPLE: Record<ProposalKind, string> = {
  integration: 'integration:stripe',
  endpoint: 'endpoint:POST /api/apps/rebuild',
  datastore: 'datastore:postgres',
  module: 'module:src/scheduler',
  part: 'feature:orbit-app::apps/scheduler',
};

/**
 * The valid part id a refused one most plausibly meant, or null when the
 * intent cannot be read. A SUGGESTION, never a rewrite (allowed-pattern #22):
 * the refusal names it and the caller re-runs with it.
 *
 * REPORTED LIVE (2026-10-08): an agent in a two-project Workspace had a part
 * refused and gave up — "the part grammar is finicky; I'll record the
 * scheduler as a module". The grammar accepts every id `partNodeId` can mint
 * (and every shape the board's `featureOfPartId` reads that a slug can
 * produce); what it refused were near-misses the refusal did not help with.
 * The ones a Workspace discovery naturally writes:
 *   `part:apps/scheduler`                    → `feature:apps/scheduler`
 *   `feature:orbit-app/apps/scheduler`     → `feature:orbit-app::apps/scheduler`
 *     (`<project>/<ref>` is how `workspace link-knowledge` addresses a sibling;
 *     a feature id namespaces with `::`, because `/` already means "part")
 *   `feature:orbit-app:apps/scheduler`     → `feature:orbit-app::apps/scheduler`
 *   `feature:Orbit_App::Apps/Scheduler`    → `feature:orbit-app::apps/scheduler`
 */
export function suggestPartId(id: string): string | null {
  // Only an id that says it is a feature or a part: `module:src/x` refused as
  // a part is a wrong --kind, not a misspelt part.
  const prefix = [FEATURE_ID_PREFIX, 'part:'].find((candidate) => id.trim().toLowerCase().startsWith(candidate));
  if (prefix === undefined) return null;
  const body = id.trim().slice(prefix.length);
  let namespace: string | null = null;
  let rest = body;
  const separator = body.indexOf(FEATURE_NAMESPACE_SEPARATOR);
  if (separator !== -1) {
    namespace = body.slice(0, separator);
    rest = body.slice(separator + FEATURE_NAMESPACE_SEPARATOR.length);
  } else {
    const single = /^([^/:]+):([^:]+)$/.exec(body);
    if (single !== null) {
      namespace = single[1] ?? null;
      rest = single[2] ?? '';
    }
  }
  const segments = rest.split('/');
  if (namespace === null && segments.length === 3) {
    namespace = segments.shift() ?? null;
  }
  if (segments.length !== 2 || segments.some((segment) => !/[A-Za-z0-9]/.test(segment))) return null;
  if (namespace !== null && !/[A-Za-z0-9]/.test(namespace)) return null;
  const [feature, part] = segments.map(slugifyFeatureName);
  const candidate =
    namespace === null
      ? `${FEATURE_ID_PREFIX}${feature}/${part}`
      : `${FEATURE_ID_PREFIX}${slugifyFeatureName(namespace)}${FEATURE_NAMESPACE_SEPARATOR}${feature}/${part}`;
  return candidate !== id && PART_ID_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Whether a predicted node id matches the extractor id grammar for its kind.
 * The kind must agree with the id prefix — `isValidPredictedNodeId('module',
 * 'endpoint:cli x')` is false because every pattern anchors its own prefix.
 */
export function isValidPredictedNodeId(kind: ProposalKind, id: string): boolean {
  switch (kind) {
    case 'part':
      return PART_ID_PATTERN.test(id);
    case 'integration':
      return INTEGRATION_ID_PATTERN.test(id) || INTEGRATION_WEBHOOK_ID_PATTERN.test(id);
    case 'endpoint':
      return ENDPOINT_HTTP_ID_PATTERN.test(id) || ENDPOINT_CLI_ID_PATTERN.test(id);
    case 'datastore':
      return DATASTORE_ID_PATTERN.test(id);
    case 'module':
      return MODULE_ID_PATTERN.test(id);
  }
}

/**
 * Compute the stable fingerprint of a proposal: `<plan>+<predictedNodeId>`.
 * All lifecycle events for one prediction share this fingerprint; the fold
 * groups by it.
 */
export function proposalFingerprint(event: Pick<ProposalEvent, 'plan' | 'predictedNodeId'>): string {
  return `${event.plan}+${event.predictedNodeId}`;
}

/** Absolute path of the proposal store file for a flow directory. */
function proposalsPath(flowDir: string): string {
  return join(flowDir, BLUEPRINT_DIRNAME, PROPOSALS_FILENAME);
}

/**
 * Append one proposal event to the store — the ONLY writer of
 * `proposals.jsonl`. Creates `<flowDir>/brain/.structure/` if it does not exist
 * yet (silent-record semantics: no board, no graph required). Takes the
 * store's single write lock; throws the one-line busy notice when the lock
 * stays contended — nothing is written.
 */
export function appendProposalEvent(flowDir: string, event: ProposalEvent): void {
  const blueprintDir = ensureBlueprintDir(flowDir);
  const filePath = join(blueprintDir, PROPOSALS_FILENAME);
  const lockPath = join(blueprintDir, PROPOSALS_LOCK_FILENAME);

  if (!acquireGraphLock(lockPath)) {
    throw new Error(PROPOSAL_STORE_BUSY_NOTICE);
  }
  try {
    appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf-8');
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      // Sanctioned fail-soft: lock already removed (e.g. reclaimed as stale) — nothing to clean up
    }
  }
}

/**
 * Parse one raw record into a `ProposalEvent`. Malformed anchor elements are
 * dropped individually; missing OPTIONAL fields default rather than
 * invalidating the event. Returns null when any REQUIRED field (plan,
 * predictedNodeId, kind, label, event) is missing or invalid — the caller
 * counts the line as skipped.
 */
function parseProposalRecord(record: Record<string, unknown>): ProposalEvent | null {
  if (typeof record.plan !== 'string' || record.plan.length === 0) {
    return null;
  }
  if (typeof record.predictedNodeId !== 'string' || record.predictedNodeId.length === 0) {
    return null;
  }
  if (!PROPOSAL_KINDS.includes(record.kind as ProposalKind)) {
    return null;
  }
  if (typeof record.label !== 'string') {
    return null;
  }
  if (!PROPOSAL_EVENT_NAMES.includes(record.event as ProposalEventName)) {
    return null;
  }

  const event: ProposalEvent = {
    ts: typeof record.ts === 'string' ? record.ts : '',
    plan: record.plan,
    predictedNodeId: record.predictedNodeId,
    kind: record.kind as ProposalKind,
    label: record.label,
    event: record.event as ProposalEventName,
    provenance: typeof record.provenance === 'string' ? record.provenance : '',
  };
  if (typeof record.phase === 'number' && Number.isInteger(record.phase)) {
    event.phase = record.phase;
  }
  if (typeof record.detail === 'string') {
    event.detail = record.detail;
  }
  if (Array.isArray(record.anchors)) {
    event.anchors = record.anchors.filter(isValidAnchor);
  }
  return event;
}

/** Raw parse of the store file, before folding. */
export interface ParsedProposalsFile {
  /** Valid events, in file order. */
  events: ProposalEvent[];
  /** Count of malformed lines skipped (corrupt JSON or invalid shape). */
  skipped: number;
}

/**
 * Read and parse every line of a proposal store file.
 * Missing file yields empty results; corrupt or shape-invalid lines are
 * skipped AND counted so one bad line never poisons the whole read.
 * Exported for tests — production readers use `readEffectiveProposals`.
 */
export function parseProposalsFile(filePath: string): ParsedProposalsFile {
  const events: ProposalEvent[] = [];
  let skipped = 0;

  for (const line of readJsonlLines(filePath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Sanctioned fail-soft: corrupt line — skip it (counted) rather than failing the whole read
      skipped += 1;
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      skipped += 1;
      continue;
    }
    const event = parseProposalRecord(parsed as Record<string, unknown>);
    if (event === null) {
      skipped += 1;
      continue;
    }
    events.push(event);
  }

  return { events, skipped };
}

/**
 * Fold proposal events into effective proposals: events group by
 * fingerprint, sort ascending by ts (ties broken by file order — a later
 * line wins), and the LAST event's name becomes the state. The payload
 * (kind/label/detail/anchors/phase/provenance) always comes from the FIRST
 * `proposed` event; fingerprints with no `proposed` event at all are dropped
 * (there is no payload to carry — decision events without a proposal are
 * refused at write time by the CLI, so these only arise from bad data).
 * Result is sorted by proposedAt, then fingerprint — deterministic for the
 * same event list.
 */
export function foldProposalEvents(events: ProposalEvent[]): EffectiveProposal[] {
  /** fingerprint → its events with file positions, in file order. */
  const groups = new Map<string, Array<{ event: ProposalEvent; fileIndex: number }>>();
  for (let fileIndex = 0; fileIndex < events.length; fileIndex += 1) {
    const fingerprint = proposalFingerprint(events[fileIndex]);
    const group = groups.get(fingerprint) ?? [];
    group.push({ event: events[fileIndex], fileIndex });
    groups.set(fingerprint, group);
  }

  const effective: EffectiveProposal[] = [];
  for (const [fingerprint, group] of groups) {
    const ordered = [...group].sort((a, b) => {
      if (a.event.ts !== b.event.ts) {
        return a.event.ts.localeCompare(b.event.ts);
      }
      return a.fileIndex - b.fileIndex;
    });

    const first = ordered.find((entry) => entry.event.event === 'proposed');
    if (first === undefined) {
      // No `proposed` event — nothing to carry; drop the fingerprint
      continue;
    }

    const proposal: EffectiveProposal = {
      fingerprint,
      plan: first.event.plan,
      predictedNodeId: first.event.predictedNodeId,
      kind: first.event.kind,
      label: first.event.label,
      anchors: first.event.anchors ?? [],
      state: ordered[ordered.length - 1].event.event,
      provenance: first.event.provenance,
      proposedAt: first.event.ts,
    };
    if (first.event.phase !== undefined) {
      proposal.phase = first.event.phase;
    }
    if (first.event.detail !== undefined) {
      proposal.detail = first.event.detail;
    }
    for (const { event } of ordered) {
      if (event.event === 'accepted' || event.event === 'rejected') {
        proposal.decidedAt = event.ts;
      } else if (event.event === 'confirmed') {
        proposal.confirmedAt = event.ts;
      }
    }
    effective.push(proposal);
  }

  return effective.sort((a, b) => {
    if (a.proposedAt !== b.proposedAt) {
      return a.proposedAt.localeCompare(b.proposedAt);
    }
    return a.fingerprint.localeCompare(b.fingerprint);
  });
}

/**
 * Read the proposal store with fold-on-read semantics (last event per
 * fingerprint wins), optionally filtered to one plan. Missing file yields an
 * empty array; malformed lines are skipped. Never locks — reads are always
 * safe against the single-writer appends.
 */
export function readEffectiveProposals(flowDir: string, plan?: string): EffectiveProposal[] {
  const { events } = parseProposalsFile(proposalsPath(flowDir));
  const scoped = plan === undefined ? events : events.filter((event) => event.plan === plan);
  return foldProposalEvents(scoped);
}

// ── new vs changed (DERIVED at read time, never declared) ─
//
// The store records what a plan predicts; whether that prediction touches
// something that already exists is a fact about the CODE, so it is computed
// against the code every time it is asked for rather than written down. A
// stored `state` field would be a second answer able to disagree with the first
// — and the disagreeing one gets repeated back to the user as fact.

/** Whether a proposal adds something or changes something that already exists. */
export type ProposalChangeState = 'new' | 'changed';

/** An effective proposal plus its derived change state. */
export interface ProposalWithChange extends EffectiveProposal {
  /** `changed` when at least one anchor already resolves, else `new`. */
  change: ProposalChangeState;
  /** The anchors that resolved, exactly as authored — the evidence for `changed`. */
  resolvedAnchors: string[];
}

/**
 * Put one anchor into the vocabulary the ONE resolver reads — normalization,
 * NOT a second resolver.
 *
 * `resolveAnchors` judges `<kind>:<ref>` strings; an `Anchor` is the same fact
 * already split in two, and the three forms a stored ref can take have to
 * collapse back to one string before it can judge them:
 *
 *   BARE PATH        `{kind:'file',   ref:'src/routes/sse.ts'}`  → `file:src/routes/sse.ts`
 *   PRE-RESOLVED     `{kind:'module', ref:'module:src/cli'}`     → `module:src/cli` (untouched)
 *   file:-PREFIXED   `{kind:'file',   ref:'file:src/x.ts'}`      → `file:src/x.ts`  (untouched)
 *
 * `parseAnchorFlag` STRIPS the kind off `--anchor file:src/x.ts`, so nearly
 * every stored ref is bare and the kind is the only thing that says how to
 * judge it — dropping it would send `src/routes/sse.ts` to the resolver as a
 * kindless string and report every anchored proposal as `new`. A ref that
 * already carries a prefix must NOT be prefixed again: `file:module:src/cli`
 * resolves to nothing, which is the same bug with the sign flipped.
 */
function anchorRefString(anchor: Anchor): string {
  const ref = anchor.ref.trim();
  return ref.includes(':') ? ref : `${anchor.kind}:${ref}`;
}

/**
 * Derive one proposal's change state from whether its anchors already resolve.
 *
 * ANY anchor resolving makes it `changed`: an anchor names existing code the
 * prediction touches, so one that resolves means the prediction is against
 * something real. A proposal with NO anchors is `new` — it names nothing that
 * exists, which is the honest reading of silence and never an assertion that
 * nothing exists.
 *
 * Resolution is delegated to `resolveAnchors` — the one resolver — so bare
 * paths, `file:` refs and `module:` ids are judged by the same code that judges
 * a feature's own anchors.
 */
export function deriveProposalChange(
  proposal: EffectiveProposal,
  graph: BlueprintGraph | null,
  repoRoot: string | null = null,
  fileExists?: (path: string) => boolean,
): ProposalWithChange {
  const refs = proposal.anchors.map(anchorRefString);
  const resolutions =
    fileExists === undefined
      ? resolveAnchors(refs, graph, repoRoot)
      : resolveAnchors(refs, graph, repoRoot, fileExists);
  // `resolveAnchors` sorts its output and reports the normalized string it was
  // handed. The evidence is mapped back onto the anchors AS AUTHORED, in the
  // order they were authored, so nothing quotes a ref the store never held.
  const resolvedRefs = new Set(
    resolutions.filter((entry) => entry.resolved).map((entry) => entry.ref),
  );
  const resolvedAnchors = proposal.anchors
    .filter((anchor) => resolvedRefs.has(anchorRefString(anchor)))
    .map((anchor) => anchor.ref);
  return {
    ...proposal,
    change: resolvedAnchors.length > 0 ? 'changed' : 'new',
    resolvedAnchors,
  };
}

/**
 * Derive the change state of every proposal in a list, preserving the fold's
 * order. Pure and deterministic for the same store + graph + disk: two reads
 * yield deep-equal results, which is the property the view depends on to not
 * flicker between `new` and `changed` on consecutive renders.
 */
export function deriveProposalChanges(
  proposals: readonly EffectiveProposal[],
  graph: BlueprintGraph | null,
  repoRoot: string | null = null,
  fileExists?: (path: string) => boolean,
): ProposalWithChange[] {
  return proposals.map((proposal) => deriveProposalChange(proposal, graph, repoRoot, fileExists));
}

/**
 * Read the store and derive each proposal's change state in one call — the
 * read-time path production callers use. Same fold, same order, plus the
 * derived field.
 */
export function readProposalsWithChange(
  flowDir: string,
  graph: BlueprintGraph | null,
  repoRoot: string | null = null,
  plan?: string,
): ProposalWithChange[] {
  return deriveProposalChanges(readEffectiveProposals(flowDir, plan), graph, repoRoot);
}

// ── attachment by anchor overlap ─────────────────────────
//
// WHERE a discovery view appears is derived from the anchors a proposal already
// carries, never from a declared `--feature` field. A declared field would be a
// second place for the answer to live, free to disagree with the anchors — the
// same class of mistake `--state` was rejected for. The consequence is
// deliberate: a proposal whose anchors fall inside TWO features' claims shows on
// both, because that is what a cross-cutting change is.

/**
 * A feature as attachment sees it: identity plus the anchors it claims.
 *
 * Structurally satisfied by `FeatureNode`, so callers pass `readFeatures()`
 * output directly. Deliberately NOT `FeatureGraphNode` — the graph node carries
 * `anchorCount` but not the anchors themselves, and attachment needs the refs.
 * Parts are out of scope for v1 (discovery open question #4): a part's anchors
 * are read from its owner's `## Parts`, and giving parts their own attachment
 * before the feature-level surface exists would ship a second answer nobody has
 * asked for yet.
 */
export interface AttachableFeature {
  id: string;
  slug: string;
  name: string;
  /** Anchors this feature claims, in any of the three stored forms. */
  anchors: readonly string[];
}

/**
 * The path an anchor names, or null when it names an identity rather than a
 * region.
 *
 * `module:` and `file:` anchors — and BARE refs, which the feature store writes
 * for parts and for promoted prose — are paths, so containment is meaningful
 * between them. `symbol:`, `table:` and `endpoint:` anchors are identities: one
 * matches another only by being the same string. Returning null for those keeps
 * containment from inventing a hierarchy the ref does not have (`endpoint:GET
 * /users` is not a parent of `endpoint:GET /users/1`).
 */
export function anchorPath(ref: string): string | null {
  const normalized = normalizeAnchorRef(ref.trim());
  const colon = normalized.indexOf(':');
  if (colon < 0) return normalized.length > 0 ? normalized : null;
  const kind = normalized.slice(0, colon);
  if (kind !== 'module' && kind !== 'file') return null;
  const path = normalized.slice(colon + 1);
  return path.length > 0 ? path : null;
}

/** Depth of a claim, in path segments — `module:src/cli/blueprint` is 3. */
function claimDepth(path: string): number {
  return path.split('/').filter((segment) => segment.length > 0).length;
}

/**
 * Whether a feature's claim CONTAINS a proposal anchor — equal, or an ancestor
 * directory of it. Direction matters and is asserted here rather than left to
 * the caller: `anchorContains('module:src', 'module:src/cli')` is true, the
 * reverse is false.
 */
export function anchorContains(claim: string, anchor: string): boolean {
  const claimNormalized = normalizeAnchorRef(claim.trim());
  const anchorNormalized = normalizeAnchorRef(anchor.trim());
  if (claimNormalized === anchorNormalized) return true;
  const claimPath = anchorPath(claim);
  const targetPath = anchorPath(anchor);
  if (claimPath === null || targetPath === null) return false;
  if (claimPath === targetPath) return true;
  return targetPath.startsWith(`${claimPath}/`);
}

/** One feature an anchor overlaps, with the claim that matched it. */
export interface AnchorOverlap {
  /** The proposal anchor, exactly as authored. */
  ref: string;
  featureId: string;
  featureSlug: string;
  featureName: string;
  /** The feature claim that matched, exactly as the feature authored it. */
  claim: string;
  /** True when the claim names the anchor itself rather than a region holding it. */
  exact: boolean;
  /** Path depth of the claim — 0 for an identity match. */
  depth: number;
}

/**
 * The RAW overlap relation: every (anchor, feature) pair where the feature
 * claims a region containing the anchor, or the anchor contains the feature's
 * claim. Both directions are reported here on purpose — this is the relation,
 * not the rule. `attachProposal` narrows it (see `MAX_ANCHOR_CLAIMANTS`); this
 * function is what shows how wide the unrestricted answer would be, and exists
 * so that width is measurable rather than asserted.
 */
export function overlappingFeatures(
  anchors: readonly string[],
  features: readonly AttachableFeature[],
): AnchorOverlap[] {
  const out: AnchorOverlap[] = [];
  for (const ref of anchors) {
    for (const feature of features) {
      for (const claim of feature.anchors) {
        if (!anchorContains(claim, ref) && !anchorContains(ref, claim)) continue;
        const claimPath = anchorPath(claim);
        out.push({
          ref,
          featureId: feature.id,
          featureSlug: feature.slug,
          featureName: feature.name,
          claim,
          exact: normalizeAnchorRef(claim.trim()) === normalizeAnchorRef(ref.trim()) ||
            (claimPath !== null && claimPath === anchorPath(ref)),
          depth: claimPath === null ? 0 : claimDepth(claimPath),
        });
        break; // one match per (anchor, feature) is enough for the raw relation
      }
    }
  }
  return out;
}

/** One feature a proposal attaches to, with the anchors that put it there. */
export interface ProposalAttachment {
  featureId: string;
  featureSlug: string;
  featureName: string;
  /** The proposal anchors that attached it here, as authored, sorted. */
  viaAnchors: string[];
}

/** An anchor the specificity rule refused, with what it would have attached to. */
export interface AmbiguousAnchor {
  /** The proposal anchor, exactly as authored. */
  ref: string;
  /** Feature ids the anchor would have attached to, sorted. */
  claimants: string[];
  /** One-line reason, surfaceable verbatim — never a silent drop. */
  reason: string;
}

/** Where one proposal attaches, and what it could not decide. */
export interface ProposalAttachments {
  fingerprint: string;
  plan: string;
  predictedNodeId: string;
  kind: ProposalKind;
  /** Carried through — the ghost card's title. */
  label: string;
  /** Carried through — what makes a `changed` node informative at all. */
  detail?: string;
  /** Carried through when the input already had its change state derived. */
  change?: ProposalChangeState;
  /** Features this proposal attaches to, sorted by feature id. */
  features: ProposalAttachment[];
  /** Anchors refused as too broad to discriminate — reported, never silent. */
  ambiguous: AmbiguousAnchor[];
  /** Anchors no feature claims at all, as authored, sorted. */
  unclaimed: string[];
}

/**
 * THE SPECIFICITY RULE, clause 3 — the claimant cap.
 *
 * Three is not a legibility budget; it is the line between a change to some
 * capabilities and a change to the project. The discovery view is a
 * FEATURE-SCOPED surface answering "what is about to change about THIS
 * capability". An anchor that answers that for four or more capabilities at once
 * identifies none of them — it names a shared region, and a button on every one
 * of them tells the reader nothing they did not already know.
 *
 * MEASURED, NOT GUESSED, against this repo's own live store (3 real proposals,
 * 33 real features). Raw anchor overlap attached them to 10, 3 and 16 features;
 * direction and nearest-claim alone still left 5, 2 and 9. The two survivors are
 * `module:src/cli/blueprint` — claimed OUTRIGHT by five features
 * (blueprint-simulation, brain-first-retrieval, drift, progressive-learning,
 * trust-tiers) — and `module:app/src/renderer/blueprint`, claimed outright by
 * nine. Both are ordinary directories that an ordinary discovery anchors at, and
 * both would have put a permanent panel on a third of the board.
 */
export const MAX_ANCHOR_CLAIMANTS = 3;

/**
 * THE SPECIFICITY RULE, in full. A proposal attaches to a feature through an
 * anchor only when that anchor DISCRIMINATES — three clauses, each doing visible
 * work on this repo's real store:
 *
 *   1. DIRECTION — only claims that contain (or equal) the anchor are
 *      candidates. A proposal anchored at `module:src` never attaches to a
 *      feature claiming `module:src/cli/blueprint`: naming the whole tree says
 *      nothing about any one thing in it. On the live store this alone drops
 *      five of the ten features raw overlap gave `module:src/cli/blueprint`.
 *
 *   2. NEAREST CLAIM WINS — a claim naming the anchor exactly beats one merely
 *      containing it, and among containing claims the deepest wins. This is what
 *      stops `drift`, which really does claim all of `module:src`, from
 *      collecting every proposal in the project, while leaving attached the
 *      features that claim the actual directory.
 *
 *   3. CLAIMANT CAP — if the winning tier still names more than
 *      `MAX_ANCHOR_CLAIMANTS` features, the anchor is a commons rather than an
 *      identity. It attaches to NONE of them and is reported in `ambiguous` with
 *      its full claimant list and a reason, so an over-broad anchor is a visible,
 *      fixable fact instead of a crowded board nobody can explain.
 *
 * The rule is built to REWARD precision, which is what makes an ambiguous result
 * actionable rather than a dead end: re-anchoring a refused proposal at the file
 * it actually changes (`file:src/cli/blueprint/proposal-store.ts`) promotes the
 * one feature claiming that file into the exact tier, and it alone attaches.
 *
 * THE FAILURE MODE, STATED: a genuinely project-wide change anchored at a single
 * broad directory attaches nowhere, and surfaces as `ambiguous` instead. That is
 * the failure this deliberately chooses — a proposal the reader has to be told
 * about beats a proposal on every feature, because the second is
 * indistinguishable from the surface being broken.
 */
export function attachProposal(
  proposal: EffectiveProposal,
  features: readonly AttachableFeature[],
): ProposalAttachments {
  /** featureId → the anchors that attached it, in author order. */
  const attached = new Map<string, { feature: AttachableFeature; viaAnchors: string[] }>();
  const ambiguous: AmbiguousAnchor[] = [];
  const unclaimed: string[] = [];

  for (const anchor of proposal.anchors) {
    const ref = anchorRefString(anchor);

    // Clause 1 — direction: only claims CONTAINING the anchor are candidates.
    /** featureId → the nearest claim that feature has on this anchor. */
    const candidates = new Map<string, { feature: AttachableFeature; exact: boolean; depth: number }>();
    for (const feature of features) {
      for (const claim of feature.anchors) {
        if (!anchorContains(claim, ref)) continue;
        const claimPath = anchorPath(claim);
        const exact =
          normalizeAnchorRef(claim.trim()) === normalizeAnchorRef(ref) ||
          (claimPath !== null && claimPath === anchorPath(ref));
        const depth = claimPath === null ? 0 : claimDepth(claimPath);
        const best = candidates.get(feature.id);
        // Clause 2, within one feature: its nearest claim is the one that represents it.
        if (best === undefined || (exact && !best.exact) || (exact === best.exact && depth > best.depth)) {
          candidates.set(feature.id, { feature, exact, depth });
        }
      }
    }
    if (candidates.size === 0) {
      unclaimed.push(anchor.ref);
      continue;
    }

    // Clause 2, across features: only the nearest tier competes.
    const entries = [...candidates.values()];
    const anyExact = entries.some((entry) => entry.exact);
    const deepest = entries.reduce((max, entry) => Math.max(max, entry.depth), 0);
    const winners = entries.filter((entry) => (anyExact ? entry.exact : entry.depth === deepest));

    // Clause 3 — the claimant cap. Refused loudly, with the evidence attached.
    if (winners.length > MAX_ANCHOR_CLAIMANTS) {
      ambiguous.push({
        ref: anchor.ref,
        claimants: winners.map((entry) => entry.feature.id).sort(),
        reason: `anchor '${anchor.ref}' is claimed by ${winners.length} features — too broad to attach (max ${MAX_ANCHOR_CLAIMANTS}); anchor the proposal at the file it changes`,
      });
      continue;
    }

    for (const winner of winners) {
      const existing = attached.get(winner.feature.id);
      if (existing === undefined) {
        attached.set(winner.feature.id, { feature: winner.feature, viaAnchors: [anchor.ref] });
      } else if (!existing.viaAnchors.includes(anchor.ref)) {
        existing.viaAnchors.push(anchor.ref);
      }
    }
  }

  const result: ProposalAttachments = {
    fingerprint: proposal.fingerprint,
    plan: proposal.plan,
    predictedNodeId: proposal.predictedNodeId,
    kind: proposal.kind,
    label: proposal.label,
    features: [...attached.values()]
      .map(({ feature, viaAnchors }) => ({
        featureId: feature.id,
        featureSlug: feature.slug,
        featureName: feature.name,
        viaAnchors: [...viaAnchors].sort(),
      }))
      .sort((a, b) => a.featureId.localeCompare(b.featureId)),
    ambiguous: [...ambiguous].sort((a, b) => a.ref.localeCompare(b.ref)),
    unclaimed: [...unclaimed].sort(),
  };
  // `detail` is what makes a CHANGED node informative — a `changed` mark on an
  // existing node says only "something here moves"; the detail says what. It is
  // carried through attachment rather than re-read downstream so no consumer has
  // to hold the store open to render a card.
  if (proposal.detail !== undefined) result.detail = proposal.detail;
  // Carried only when the caller already derived it (`ProposalWithChange`);
  // attachment never derives it itself, because deriving needs the graph and
  // this function is graph-free by design.
  const change = (proposal as Partial<ProposalWithChange>).change;
  if (change !== undefined) result.change = change;
  return result;
}

/** Attach every proposal, preserving the fold's order. Pure and deterministic. */
export function attachProposals(
  proposals: readonly EffectiveProposal[],
  features: readonly AttachableFeature[],
): ProposalAttachments[] {
  return proposals.map((proposal) => attachProposal(proposal, features));
}

/**
 * The proposals attached to one feature, in the order they were attached in.
 * The board's question ("does THIS feature have live proposals") asked of the
 * attachment result, so no consumer re-implements the membership test.
 */
export function proposalsForFeature(
  attachments: readonly ProposalAttachments[],
  featureId: string,
): ProposalAttachments[] {
  return attachments.filter((entry) =>
    entry.features.some((feature) => feature.featureId === featureId),
  );
}

// ── per-kind confirmation (mechanical, exact-id, two graphs) ─
//
// Extractor kinds are matched against `graph.json`'s node ids; `part` against
// the FEATURE graph's part-node ids. Both are exact string matches — the split
// is about WHICH id set a kind is entitled to match, never about how carefully
// it matches.

/** The id sets confirmation matches against, one per graph. */
export interface ConfirmationSources {
  /** Node ids from the freshly derived `graph.json` (extractor kinds). */
  graphNodeIds: ReadonlySet<string>;
  /** Part-node ids from the feature graph (`kind: 'part'` only). */
  partNodeIds: ReadonlySet<string>;
}

/** States a proposal must be in to be eligible for confirmation. */
const CONFIRMABLE_STATES: readonly ProposalEventName[] = ['proposed', 'accepted'];

/**
 * Whether one proposal's predicted id now exists — checked against the graph
 * its KIND lives in.
 *
 * A part is never in `graph.json`; it is built from a feature's `## Parts`
 * markdown by `buildFeatureGraph`. Checking every kind against the extractor
 * graph therefore guaranteed that no proposed part could ever confirm, while
 * the derive line still reported healthily and the next sweep quietly staled
 * it. Per-kind lookup is what makes the confirm step actually run for parts.
 */
export function isProposalConfirmed(
  proposal: Pick<EffectiveProposal, 'kind' | 'predictedNodeId'>,
  sources: ConfirmationSources,
): boolean {
  const ids = proposal.kind === 'part' ? sources.partNodeIds : sources.graphNodeIds;
  return ids.has(proposal.predictedNodeId);
}

/**
 * The proposals a derive should append a `confirmed` event for: those in a
 * confirmable state whose predicted id now exists in their kind's graph.
 * Order follows the fold's, so the appended events are deterministic.
 */
export function confirmableProposals(
  proposals: readonly EffectiveProposal[],
  sources: ConfirmationSources,
): EffectiveProposal[] {
  return proposals.filter(
    (proposal) =>
      CONFIRMABLE_STATES.includes(proposal.state) && isProposalConfirmed(proposal, sources),
  );
}

// ── accounting (never silent) ────────────────────────────
//
// The store's resulting state is reported by the mediated CLI after every
// write, so a caller can read back what landed instead of inferring it from
// an exit code. Zero is a reportable outcome, not an absence of one.

/** States whose proposals still render as ghosts on the board. */
export const LIVE_PROPOSAL_STATES: readonly ProposalEventName[] = ['proposed', 'accepted', 'rejected'];

/** Counts of a plan's effective proposals: the total, the live subset, and per state. */
export interface ProposalCounts {
  /** Every effective proposal in scope, whatever its state. */
  total: number;
  /** The subset still rendering as ghosts (`proposed`/`accepted`/`rejected`). */
  live: number;
  /** Per-state counts — every state key present, zero-filled. */
  byState: Record<ProposalEventName, number>;
}

/**
 * Count effective proposals by state. Every state key is present (zero-filled)
 * so a reader never has to distinguish "absent" from "none" — the distinction
 * that let an empty store pass for a healthy one.
 */
export function countProposals(proposals: readonly EffectiveProposal[]): ProposalCounts {
  const byState = Object.fromEntries(
    PROPOSAL_EVENT_NAMES.map((name) => [name, 0]),
  ) as Record<ProposalEventName, number>;
  for (const proposal of proposals) {
    byState[proposal.state] += 1;
  }
  const live = LIVE_PROPOSAL_STATES.reduce((sum, state) => sum + byState[state], 0);
  return { total: proposals.length, live, byState };
}

/**
 * The one reportable accounting line: `proposals: N recorded`, with a live
 * subset only when it differs from the total (`proposals: 3 recorded (1 live)`).
 * `0 recorded` is a legitimate, expected output — the whole point of the line.
 */
export function formatProposalsRecorded(counts: ProposalCounts): string {
  const suffix = counts.live === counts.total ? '' : ` (${counts.live} live)`;
  return `proposals: ${counts.total} recorded${suffix}`;
}

// ── expiry: source gone (STALE, NEVER DELETE) ────────────
//
// `blueprint sweep --plan <p>` fires at ONE moment — plan archive — so a
// discovery that was explored and abandoned leaves its ghosts live forever.
// Nobody noticed because ghosts lived on a code map nobody opened; the moment
// they become a button on a feature, that leak is a permanent stale panel on a
// capability whose "upcoming change" was dropped months ago.
//
// AGE-OUT WAS REJECTED, and this is the rule that replaces it. A slow-moving
// exploration — opened, thought about for six weeks, still live — is
// indistinguishable from an abandoned one by AGE, and expiring it would delete a
// live prediction for the crime of being deliberate. The observable difference is
// not time, it is whether the work still EXISTS: its source doc, or a plan
// carrying its slug. So that is what is asked.
//
// Staling mirrors the annotations layer exactly (`status-events.jsonl`): an
// append-only transition, never a rewrite and never a delete. A source that comes
// back — an unarchived plan, a restored doc — can be re-proposed, and the whole
// history of what was predicted survives either way.

/** Directories under `flow/` whose docs keep a proposal's source alive. */
export const PROPOSAL_SOURCE_DIRS: readonly string[] = ['plans', 'discovery', 'brainstorms'];

/** What the source docs on disk say about which proposals still have a source. */
export interface ProposalSourceIndex {
  /** Doc basenames (no `.md`) present in the live source dirs. */
  liveDocs: ReadonlySet<string>;
  /**
   * Feature slugs with at least one live doc in ANY source dir.
   *
   * Slug-wide on purpose, and the live store is why. All three of this repo's
   * real proposals carry `plan: plan_change-record-parts_v1` — a plan name the
   * discovery NAMED but had not created yet; what exists on disk is
   * `discovery_change-record-parts_v1.md`. Keyed on plan docs alone, the very
   * first proposals ever written would have staled on their first expiry sweep
   * while their discovery sat open in the editor. FR12's two clauses — the
   * source doc gone, AND no plan of that slug — are both "nothing of this slug
   * survives anywhere", so that is what is asked once.
   */
  liveSlugs: ReadonlySet<string>;
}

/**
 * The feature slug inside a doc name — `plan_discovery-view_v1` is
 * `discovery-view`, and so is `discovery_discovery-view_v1`.
 *
 * A plan name that follows no convention IS its own slug: an unrecognised name
 * must stay matchable against a doc of the same name rather than collapsing to
 * something shorter that some other plan might also produce.
 */
export function proposalSourceSlug(plan: string): string {
  const match = plan.match(/^(?:plan|discovery|brainstorm)_(.+)_v\d+$/);
  return match === null ? plan : match[1];
}

/**
 * Read which sources are still live. Missing directories are not an error — a
 * project with no `flow/brainstorms/` simply has no brainstorm sources, and
 * treating that as "everything is gone" would stale a whole store on a
 * fresh checkout.
 */
export function readProposalSourceIndex(flowDir: string): ProposalSourceIndex {
  const liveDocs = new Set<string>();
  const liveSlugs = new Set<string>();
  for (const dirname of PROPOSAL_SOURCE_DIRS) {
    const dir = join(flowDir, dirname);
    if (!existsSync(dir)) continue;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // Sanctioned fail-soft: an unreadable dir costs its sources, never the read
    }
    for (const entry of entries) {
      if (!entry.endsWith('.md')) continue;
      const base = entry.slice(0, -'.md'.length);
      liveDocs.add(base);
      // Only CONVENTIONAL names contribute a slug. A stray `notes.md` must not
      // claim the slug `notes` and keep an unrelated plan's ghosts alive.
      const match = base.match(/^(?:plan|discovery|brainstorm)_(.+)_v\d+$/);
      if (match !== null) liveSlugs.add(match[1]);
    }
  }
  return { liveDocs, liveSlugs };
}

/**
 * Whether a proposal's source still exists — the ONE question expiry asks.
 *
 * Live on either of two counts, and the second is what keeps the ordinary
 * workflow from staling itself: the work of one slug moves between documents —
 * a discovery becomes a plan, a plan is created before it is written, a
 * brainstorm precedes both — and none of those transitions is an abandonment.
 * Requiring the exact named doc to survive would stale every proposal at exactly
 * the moment the work moved forward.
 */
export function isProposalSourceLive(plan: string, index: ProposalSourceIndex): boolean {
  if (index.liveDocs.has(plan)) return true;
  return index.liveSlugs.has(proposalSourceSlug(plan));
}

/**
 * The proposals an expiry sweep should stale: every proposal still RENDERING
 * (`LIVE_PROPOSAL_STATES`) whose source is gone.
 *
 * `rejected` is included deliberately, though the plan-scoped sweep clears it
 * instead. A rejected ghost still draws on the board, so leaving it live would
 * close the leak only halfway — and `stale` is the honest state for it: the
 * decision is not being undone, its source is simply no longer there.
 * Already-terminal proposals (confirmed/stale/cleared) are untouched, which
 * makes a repeated expiry sweep idempotent.
 */
export function proposalsWithMissingSource(
  proposals: readonly EffectiveProposal[],
  index: ProposalSourceIndex,
): EffectiveProposal[] {
  return proposals.filter(
    (proposal) =>
      LIVE_PROPOSAL_STATES.includes(proposal.state) && !isProposalSourceLive(proposal.plan, index),
  );
}

/** The expiry sweep's one accounting line, in the sweep vocabulary. */
export function formatProposalsStaled(count: number): string {
  return `proposals: ${count} staled (source gone)`;
}

// ── refusal reasons (never a silent non-event) ───────────
//
// The refusal VOCABULARY lives here rather than in the CLI so that the one
// code path deciding what is invalid is also the one a test can interrogate
// (allowed-pattern #14). The CLI owns only the transport: stderr + exit 1.

/** A record-mode propose as supplied by a caller, before validation. */
export interface ProposalRecordInput {
  plan: string;
  /** The predicted node id (`--node`). */
  node: string;
  /** The raw `--kind` value, possibly absent or not a proposal kind. */
  kind?: string;
  label: string;
}

/**
 * Validate a record-mode propose. Returns `null` when valid, otherwise the
 * one-line reason — always non-empty, always naming what to fix, so the caller
 * can surface it verbatim rather than swallowing the failure.
 */
export function validateProposalRecord(input: ProposalRecordInput): string | null {
  if (input.plan.length === 0) {
    return 'a proposal requires --plan <plan>';
  }
  if (input.node.length === 0) {
    return 'a proposal requires --node <predicted-id>';
  }
  if (input.kind === undefined || !PROPOSAL_KINDS.includes(input.kind as ProposalKind)) {
    return `invalid --kind '${input.kind ?? ''}' — expected ${PROPOSAL_KINDS.join('|')}`;
  }
  if (input.label.length === 0) {
    return 'a proposal requires --label <text>';
  }
  const kind = input.kind as ProposalKind;
  if (!isValidPredictedNodeId(kind, input.node)) {
    const suggestion = kind === 'part' ? suggestPartId(input.node) : null;
    return (
      `predicted id '${input.node}' does not match the ${kind} id grammar — expected ${PREDICTED_ID_GRAMMAR[kind]}` +
      ` (e.g. ${PREDICTED_ID_EXAMPLE[kind]})` +
      (suggestion === null ? '' : ` — did you mean '${suggestion}'?`)
    );
  }
  return null;
}

/**
 * Validate a decide-mode propose against the effective proposal it targets
 * (`undefined` when the fingerprint has never been proposed). Returns `null`
 * when the decision is allowed, otherwise the one-line reason naming the state
 * that blocked it — a refused decision is reportable, never a no-op.
 */
export function validateProposalDecision(
  proposal: EffectiveProposal | undefined,
  plan: string,
  node: string,
): string | null {
  if (proposal === undefined) {
    return `no proposal '${node}' recorded for plan '${plan}'`;
  }
  if (proposal.state === 'confirmed' || proposal.state === 'cleared') {
    return `proposal '${node}' is already terminal (${proposal.state})`;
  }
  if (proposal.state === 'accepted' || proposal.state === 'rejected') {
    return `proposal '${node}' is already decided (${proposal.state})`;
  }
  if (proposal.state === 'stale') {
    return `proposal '${node}' is stale — re-propose it before deciding`;
  }
  return null;
}

/** The caller-surfaceable form of a refusal: `propose refused: <reason>`. */
export function formatProposeRefusal(reason: string): string {
  return `propose refused: ${reason}`;
}

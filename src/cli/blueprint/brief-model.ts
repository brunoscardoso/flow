/**
 * Change-brief delta model (change-brief).
 *
 * Turns a compiled story + the derived graph + the effective proposal set into
 * everything the brief renders: per-node change kinds, per-wire deltas, and
 * derived edge labels. Pure and side-effect-free — same inputs yield deep-equal
 * output, no clock, no randomness, no I/O (mirrors the blueprint render rule).
 *
 * TWO WORLDS
 * ==========
 * The brief shows one graph in two time states:
 *
 *   TODAY — the pre-plan world. A node the plan INTRODUCES is not ghosted and
 *           not dimmed, it is ABSENT: ghosting still leaks the execution plan
 *           into a world where the plan does not exist yet. Wires the plan adds,
 *           and wires with an absent endpoint, are not drawn at all.
 *   AFTER — the post-plan world, with the board's Review-Mode git tints.
 *
 * WHY `remove` IS FINALLY DERIVABLE
 * =================================
 * `simulation-model.ts` documents that a story ANCHOR carries no honest signal
 * that a node will be deleted, so it never emits `remove`. A before/after flow
 * PAIR does carry that signal: `flow_before` is resolved against the derived
 * graph only (a claim about what exists today — see `story-compile.ts`), so a
 * node that appears in some `flow_before` and in NO `flow_after` is provably
 * present now and provably absent later. That is a removal, derived rather than
 * guessed. The conclusion is only sound because before refuses ghosts.
 *
 * PRECEDENCE
 * ==========
 * A node reached by both an anchor and a flow is classified once, by the
 * strongest claim: remove > new > modify > stable. `remove` wins because it is
 * the only kind backed by evidence from BOTH worlds.
 */
import { resolveStoryAnchors } from './anchors.js';
import {
  LIVE_PROPOSAL_STATES,
  proposalSourceSlug,
  type EffectiveProposal,
  type ProposalChangeState,
  type ProposalEventName,
  type ProposalKind,
  type ProposalWithChange,
} from './proposal-store.js';
import { computeTouchedSets } from './simulation-model.js';
import { parseFlowItem } from './story-grammar.js';
import type {
  BlueprintGraph,
  BlueprintNode,
  CompiledStory,
  TouchedChangeKind,
} from './types.js';

/** How a node differs between the two worlds. `stable` = present and untouched. */
export type BriefNodeKind = TouchedChangeKind | 'stable';

/** How a wire differs between the two worlds. */
export type BriefWireDelta = 'kept' | 'added' | 'removed';

// ── provenance (discovery-view) ────────────────────────────────────────────
//
// A PREDICTION MUST NEVER BE PRESENTABLE AS A FACT, and "must never" is a
// property of the PAYLOAD, not of a renderer's diligence. Every renderer that
// has to *infer* which nodes are predicted will eventually infer wrong — and
// the failure mode is a screenshot of speculation that reads as the current
// architecture. So the two questions a renderer asks are answered in the data,
// on every node, always present:
//
//   existsToday             — is this node REAL right now? (drives dashed vs solid)
//   provenance.predicted    — is this node's CLAIM unexecuted? (drives the band)
//
// The two are independent, and the case that proves it is the ordinary one: a
// proposal that CHANGES `module:src/cli/blueprint` draws a node that exists
// today (solid) carrying a claim that has not happened yet (predicted). Neither
// field alone describes it.

/** Where a brief node's claim came from. */
export type BriefNodeSource = 'graph' | 'story' | 'proposal';

/** The kind of document backing a proposal — `none` when nothing on disk does. */
export type ProposalDocKind = 'plan' | 'discovery' | 'brainstorm' | 'none';

/** The document a proposal came out of, resolved against what is on disk. */
export interface ProposalSource {
  /** The proposal's `plan` field — the name the store recorded, verbatim. */
  plan: string;
  /** Live doc basename backing it (no `.md`), or null when none survives. */
  doc: string | null;
  /** What kind of document that is — discovery vs plan is the band's headline. */
  kind: ProposalDocKind;
}

/**
 * One proposal's claim on a node, carried WHOLE.
 *
 * `label` and `detail` are not decoration and not optional-in-spirit. Measured
 * on this repo's real store: all three live proposals derive as `changed`,
 * because their anchors resolve — so the ordinary discovery view is the
 * CHANGED-only case, three marks on three boxes that already exist. A bare mark
 * says "something here moves" and stops. The label says what moves and the
 * detail says how. Strip them and the surface is theatre.
 */
export interface BriefNodeProposal {
  /** Stable identity of the proposal (`<plan>+<predictedNodeId>`). */
  fingerprint: string;
  /** The proposal's own display title — NOT the graph's label for the node. */
  label: string;
  /** What the prediction actually says. The whole reason a mark is informative. */
  detail?: string;
  /** Anchor-derived: `changed` when this touches existing code, else `new`. */
  change: ProposalChangeState;
  /** Lifecycle state at read time (`proposed`/`accepted`/`rejected`). */
  state: ProposalEventName;
  /** What the proposal predicts — extractor kind or `part`. */
  kind: ProposalKind;
  /** The anchors that resolved, as authored — the evidence for `changed`. */
  resolvedAnchors: string[];
  /**
   * Every anchor the proposal was filed with, as authored — resolved or not.
   * A NEW part's anchors resolve to nothing yet (that is what makes it new),
   * and the review's planned cell still owes the reader where it will live.
   * Omitted when the proposal carried none.
   */
  anchors?: string[];
  /** The plan phase that builds it, when the proposal was filed with one. */
  phase?: number;
  /** The source document, already resolved so no renderer re-derives it. */
  source: ProposalSource;
}

/** Why a node is in the brief, and whether its claim has actually happened. */
export interface BriefNodeProvenance {
  /** Where the node's presence came from. */
  source: BriefNodeSource;
  /**
   * True when the node is here because of an UNEXECUTED claim — a plan story's
   * delta or a proposal — rather than an observation of the derived graph.
   * `kind !== 'stable' || proposals.length > 0`, computed once, here.
   */
  predicted: boolean;
  /** Every proposal claiming this node, sorted by fingerprint. Often empty. */
  proposals: BriefNodeProposal[];
}

/** One node in the brief, with the world it belongs to made explicit. */
export interface BriefNode {
  nodeId: string;
  kind: BriefNodeKind;
  /** False when the plan introduces this node — it does not exist in TODAY. */
  existsToday: boolean;
  /** Display label from the graph, or the raw id for a not-yet-real node. */
  label: string;
  /** Predicted-vs-real and its evidence. Always present, never inferred. */
  provenance: BriefNodeProvenance;
}

/** One directed wire in the brief. */
export interface BriefWire {
  from: string;
  to: string;
  delta: BriefWireDelta;
  /** Label shown in TODAY. Empty when the wire is not drawn there. */
  labelBefore: string;
  /** Label shown in AFTER. */
  labelAfter: string;
  /** True when this wire is painted in the TODAY state. */
  drawnToday: boolean;
}

/** A proposal that is NOT rendered, and the stated reason. Never silent. */
export interface SkippedProposal {
  fingerprint: string;
  predictedNodeId: string;
  /** One line, surfaceable verbatim. */
  reason: string;
}

/**
 * The proposal layer of a brief, at whatever scope the brief was opened with.
 *
 * `nothingProposed` is an explicit field rather than `nodes.length === 0`
 * because the two readings of an empty list are not the same fact and the
 * caller cannot tell them apart: "this feature has no upcoming change" is an
 * answer, "the store had nothing to say" is a shrug. Measured on the live
 * store, the empty case is the MAJORITY case — of 33 features, two attach a
 * proposal and thirty-one attach none — so the empty answer is the one this
 * surface gives most often and it has to be a real answer.
 */
export interface BriefProposals {
  /** Proposal-sourced nodes, sorted by node id. Also merged into `nodes`. */
  nodes: BriefNode[];
  /** The documents behind them, deduped and sorted — the provenance band. */
  sources: ProposalSource[];
  /** Explicit: nothing is proposed at this scope. */
  nothingProposed: boolean;
  /** One line stating what the reader is looking at, empty case included. */
  summary: string;
  /** Proposals excluded from the render, each with its reason. */
  skipped: SkippedProposal[];
}

/** The full delta the brief renders. */
export interface BriefDelta {
  nodes: BriefNode[];
  wires: BriefWire[];
  /** Authored negative-space claim, if any step carried one. Unverifiable. */
  unchanged?: string;
  /** Authored failure modes, in story order. Unverifiable. */
  fails: string[];
  /** The proposal layer. Always present — the empty case is an answer. */
  proposed: BriefProposals;
}

/** Strongest-claim-wins ordering. Higher rank overrides lower. */
const KIND_RANK: Record<BriefNodeKind, number> = {
  stable: 0,
  modify: 1,
  new: 2,
  remove: 3,
};

/** Stable key for a directed pair. */
function wireKey(from: string, to: string): string {
  return `${from} ${to}`;
}

/** Index the graph's nodes by id (null graph → empty index). */
function indexNodes(graph: BlueprintGraph | null): Map<string, BlueprintNode> {
  const index = new Map<string, BlueprintNode>();
  for (const node of graph?.nodes ?? []) index.set(node.id, node);
  return index;
}

// ── proposals as a delta SOURCE (discovery-view) ───────────────────────────
//
// ONE RENDERER, TWO ENTRY POINTS. The change brief and the discovery view show
// the same room; the scope it was opened with is the only difference. This
// project has twice had to absorb a surface that grew up beside an existing one
// — story absorbed lavish, the change brief absorbed story — and both times the
// cost was paid in delta rules that had already drifted apart. So proposals do
// not get a model of their own: they fold into THIS one, emitting the same
// `BriefNode` shape the existing renderer already draws.
//
// The rule deciding new-vs-changed is deliberately the SAME rule the story path
// uses (`nodeIndex.has(id)`), not the proposal store's anchor-derived `change`.
// Those answer different questions — the graph is asked whether the NODE
// exists, the anchors whether the prediction TOUCHES something that exists —
// and a node can honestly be new while changing something old. Both answers are
// carried (`kind` and `proposals[].change`); neither is derived from the other,
// so neither can quietly overwrite it.

/** Doc-name prefixes, in the order a slug match prefers them. */
const DOC_KIND_PREFERENCE: readonly ProposalDocKind[] = ['plan', 'discovery', 'brainstorm'];

/** The doc kind a conventional basename declares, or null when unconventional. */
function docKindOf(basename: string): ProposalDocKind | null {
  for (const kind of DOC_KIND_PREFERENCE) {
    if (basename.startsWith(`${kind}_`)) return kind;
  }
  return null;
}

/**
 * Resolve which document a proposal actually came out of.
 *
 * The store records a PLAN NAME, which is routinely not a plan: all three of
 * this repo's live proposals carry `plan_change-record-parts_v1`, a plan the
 * discovery named before it existed, while what is on disk is
 * `discovery_change-record-parts_v1.md`. A band printing the recorded name
 * would tell the reader they are looking at a plan when they are looking at a
 * discovery — the one distinction FR10 exists to make.
 *
 * So the name is resolved against the docs that survive: the exact name first,
 * then the same slug under the strongest available kind. Nothing on disk yields
 * `{doc: null, kind: 'none'}` — stated, never guessed.
 */
export function resolveProposalSource(plan: string, docs: ReadonlySet<string>): ProposalSource {
  const exact = docKindOf(plan);
  if (docs.has(plan) && exact !== null) return { plan, doc: plan, kind: exact };
  const slug = proposalSourceSlug(plan);
  const candidates = [...docs].filter((doc) => proposalSourceSlug(doc) === slug).sort();
  for (const kind of DOC_KIND_PREFERENCE) {
    const match = candidates.find((doc) => docKindOf(doc) === kind);
    if (match !== undefined) return { plan, doc: match, kind };
  }
  return { plan, doc: null, kind: 'none' };
}

/**
 * Split proposals into the ones that render and the ones that do not, with a
 * reason attached to every exclusion. A terminal proposal (confirmed, stale,
 * cleared) is not a bug and not an error — but dropping it without saying so is
 * how a surface starts silently under-reporting, so it is reported.
 */
export function renderableProposals(proposals: readonly ProposalWithChange[]): {
  live: ProposalWithChange[];
  skipped: SkippedProposal[];
} {
  const live: ProposalWithChange[] = [];
  const skipped: SkippedProposal[] = [];
  for (const proposal of proposals) {
    if (proposal.predictedNodeId.length === 0) {
      skipped.push({
        fingerprint: proposal.fingerprint,
        predictedNodeId: proposal.predictedNodeId,
        reason: 'proposal names no predicted node id — nothing to draw',
      });
      continue;
    }
    if (!LIVE_PROPOSAL_STATES.includes(proposal.state)) {
      skipped.push({
        fingerprint: proposal.fingerprint,
        predictedNodeId: proposal.predictedNodeId,
        reason: `proposal is ${proposal.state} — no longer a prediction`,
      });
      continue;
    }
    live.push(proposal);
  }
  return { live, skipped };
}

/** The shape `withPredicted` completes — everything but the decided field. */
type UnpredictedNode = Omit<BriefNode, 'provenance'> & {
  provenance: Omit<BriefNodeProvenance, 'predicted'>;
};

/** Decide `predicted` from the node's own facts — the ONE place it is decided. */
function withPredicted(node: UnpredictedNode): BriefNode {
  return {
    nodeId: node.nodeId,
    kind: node.kind,
    existsToday: node.existsToday,
    label: node.label,
    provenance: {
      source: node.provenance.source,
      predicted: node.kind !== 'stable' || node.provenance.proposals.length > 0,
      proposals: node.provenance.proposals,
    },
  };
}

/** A node with no proposal behind it — the observed case, stated explicitly. */
function derivedNode(
  nodeId: string,
  kind: BriefNodeKind,
  existsToday: boolean,
  label: string,
  source: BriefNodeSource,
): BriefNode {
  return withPredicted({ nodeId, kind, existsToday, label, provenance: { source, proposals: [] } });
}

/**
 * Turn live proposals into brief nodes, one per predicted node id.
 *
 * Several proposals may predict the same node — a discovery naming three
 * changes to one module is ordinary, not an edge case — so claims ACCUMULATE on
 * the node instead of the last one winning.
 */
export function proposalBriefNodes(
  proposals: readonly ProposalWithChange[],
  graph: BlueprintGraph | null,
  docs: ReadonlySet<string>,
): BriefNode[] {
  const nodeIndex = indexNodes(graph);
  /** nodeId → the claims made on it, in fold order. */
  const claims = new Map<string, BriefNodeProposal[]>();
  for (const proposal of proposals) {
    const claim: BriefNodeProposal = {
      fingerprint: proposal.fingerprint,
      label: proposal.label,
      change: proposal.change,
      state: proposal.state,
      kind: proposal.kind,
      resolvedAnchors: [...proposal.resolvedAnchors].sort(),
      source: resolveProposalSource(proposal.plan, docs),
    };
    if (proposal.detail !== undefined) claim.detail = proposal.detail;
    if (proposal.anchors.length > 0) {
      // `kind:ref`, the vocabulary every other anchor on the board is written in.
      claim.anchors = proposal.anchors.map((anchor) =>
        anchor.ref.includes(':') ? anchor.ref : `${anchor.kind}:${anchor.ref}`,
      );
    }
    if (proposal.phase !== undefined) claim.phase = proposal.phase;
    const existing = claims.get(proposal.predictedNodeId);
    if (existing === undefined) claims.set(proposal.predictedNodeId, [claim]);
    else existing.push(claim);
  }

  return [...claims.entries()]
    .map(([nodeId, list]) => {
      const real = nodeIndex.get(nodeId);
      const sorted = [...list].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
      return withPredicted({
        nodeId,
        // Same rule as the story path: in the graph → the prediction changes
        // something that exists; not in the graph → it introduces it.
        kind: real !== undefined ? 'modify' : 'new',
        existsToday: real !== undefined,
        // The graph's label when the node is real; the proposal's own when it
        // is not — a ghost titled `module:src/cli/x` tells the reader nothing.
        label: real?.label ?? (sorted[0].label.length > 0 ? sorted[0].label : nodeId),
        provenance: { source: 'proposal', proposals: sorted },
      });
    })
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

/**
 * Fold proposal nodes into derived nodes. A node reached by both keeps the
 * strongest claim (`KIND_RANK`) and its non-proposal source — it is still a
 * real, observed node; what is predicted is the CHANGE to it, which is exactly
 * what the accumulated `proposals` say.
 */
function mergeProposalNodes(base: readonly BriefNode[], predicted: readonly BriefNode[]): BriefNode[] {
  const byId = new Map<string, BriefNode>();
  for (const node of base) byId.set(node.nodeId, node);
  for (const node of predicted) {
    const current = byId.get(node.nodeId);
    if (current === undefined) {
      byId.set(node.nodeId, node);
      continue;
    }
    byId.set(
      node.nodeId,
      withPredicted({
        nodeId: current.nodeId,
        kind: KIND_RANK[node.kind] > KIND_RANK[current.kind] ? node.kind : current.kind,
        existsToday: current.existsToday && node.existsToday,
        // A story flow names a node by its ID; for a node that does not exist
        // yet that id is all the story knows, and it became the card's title
        // (`feature:my-assistant/memory-management`). The proposal carries the
        // name a person wrote, so it wins whenever the story's label is only
        // the id.
        label: current.label !== current.nodeId ? current.label : node.label,
        provenance: {
          source: current.provenance.source,
          proposals: [...current.provenance.proposals, ...node.provenance.proposals].sort((a, b) =>
            a.fingerprint.localeCompare(b.fingerprint),
          ),
        },
      }),
    );
  }
  return [...byId.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

/** The empty answer, in words. Not an error, not a blank panel — an answer. */
export const NOTHING_PROPOSED_SUMMARY =
  'nothing proposed — no live proposal names anything in this scope';

/**
 * Assemble the proposal layer for one scope. Pure: same proposals + graph + doc
 * set yield a deep-equal (and JSON-identical) result, every list sorted.
 */
export function assembleProposals(
  proposals: readonly ProposalWithChange[],
  graph: BlueprintGraph | null,
  docs: ReadonlySet<string>,
): BriefProposals {
  const { live, skipped } = renderableProposals(proposals);
  const nodes = proposalBriefNodes(live, graph, docs);

  const sources = [
    ...new Map(live.map((p) => [p.plan, resolveProposalSource(p.plan, docs)])).values(),
  ].sort((a, b) => a.plan.localeCompare(b.plan));

  const counts = { new: 0, changed: 0 };
  for (const node of nodes) counts[node.kind === 'new' ? 'new' : 'changed'] += 1;
  const summary =
    nodes.length === 0
      ? NOTHING_PROPOSED_SUMMARY
      : `proposed: ${nodes.length} node(s) from ${sources.length} source(s) — ` +
        `${counts.new} new, ${counts.changed} changed`;

  return {
    nodes,
    sources,
    nothingProposed: nodes.length === 0,
    summary,
    skipped: [...skipped].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint)),
  };
}

/**
 * The proposals belonging to one plan's story, matched by SLUG rather than by
 * exact name. `plan_change-record-parts_v1` and `change-record-parts` are the
 * same work spelled two ways — the store records the first, `story.plan` the
 * second — and an exact-name match would render a plan brief with none of its
 * own proposals while still reporting healthily.
 */
function proposalsOfPlan(
  proposals: readonly ProposalWithChange[],
  plan: string,
): ProposalWithChange[] {
  const slug = proposalSourceSlug(plan);
  return proposals.filter((proposal) => proposalSourceSlug(proposal.plan) === slug);
}

/**
 * Optional inputs the proposal layer needs. Absent means no proposal layer —
 * every existing caller keeps its exact behaviour (NFR3).
 */
export interface BriefProposalOptions {
  /**
   * Proposals in scope, change state already derived
   * (`readProposalsWithChange`). Deriving reads the repo; this model stays
   * pure, so the derivation happens at the caller.
   */
  proposals?: readonly ProposalWithChange[];
  /** Live source-doc basenames (`readProposalSourceIndex(...).liveDocs`). */
  docs?: ReadonlySet<string>;
}

/** Normalize the optional inputs once, so every entry point behaves the same. */
function proposalInputs(options?: BriefProposalOptions): {
  proposals: readonly ProposalWithChange[];
  docs: ReadonlySet<string>;
} {
  return { proposals: options?.proposals ?? [], docs: options?.docs ?? new Set<string>() };
}

/**
 * The label for a wire, DERIVED from the graph. Falls back through:
 * the target's HTTP route (endpoints carry method + route), then its tables
 * (datastores), then the declared edge relation, then a bare arrow. Never
 * invents prose — everything here is already in the graph.
 */
function deriveWireLabel(
  from: string,
  to: string,
  nodes: Map<string, BlueprintNode>,
  relations: Map<string, string>,
): string {
  const target = nodes.get(to);
  const meta = target?.meta;
  if (typeof meta?.route === 'string' && meta.route.length > 0) {
    const method = typeof meta.method === 'string' ? `${meta.method} ` : '';
    return `${method}${meta.route}`;
  }
  if (Array.isArray(meta?.tables) && meta.tables.length > 0) {
    return meta.tables.join(', ');
  }
  const relation = relations.get(wireKey(from, to));
  return relation ?? '';
}

/**
 * Consecutive pairs of a flow path, carrying any authored label for each hop.
 * A one-element (or empty) flow yields no wires. Item parsing comes from
 * `story-grammar` — the single definition the grammar validates against.
 */
function flowPairs(flow: string[]): Array<{ from: string; to: string; label?: string }> {
  const parsed = flow.map(parseFlowItem);
  const pairs: Array<{ from: string; to: string; label?: string }> = [];
  for (let i = 0; i + 1 < parsed.length; i += 1) {
    const pair: { from: string; to: string; label?: string } = {
      from: parsed[i].id,
      to: parsed[i + 1].id,
    };
    // An override is written on the hop it labels, i.e. on the SOURCE item.
    if (parsed[i].label !== undefined) pair.label = parsed[i].label;
    pairs.push(pair);
  }
  return pairs;
}

/**
 * Compute the full brief delta.
 *
 * Node kinds come from two independent sources, merged by strongest claim:
 *   - anchors, via `computeTouchedSets` → `modify` (real node) / `new` (ghost)
 *   - the before/after flow pair → `remove` (in before, in no after) and
 *     `stable` (in both, otherwise unclassified)
 *
 * `phases` is deliberately NOT a parameter: the brief shows the whole change,
 * and the rollout ladder re-reads `computeTouchedSets` for its per-phase view.
 *
 * TWO PROPOSAL PARAMETERS, TWO JOBS — and they are not interchangeable. The
 * positional `proposals` is what `resolveStoryAnchors` consults so a story
 * ANCHOR naming a not-yet-real node resolves to a ghost instead of nothing; it
 * has been here since the simulation model and renders no node by itself.
 * `options.proposals` is the RENDER set: proposals drawn as nodes in their own
 * right, carrying label, detail and change state. Merging the two would make
 * every anchor-resolution ghost appear as a proposed node, which is exactly the
 * "prediction presented as fact" this feature exists to prevent.
 */
export function computeBriefDelta(
  story: CompiledStory,
  graph: BlueprintGraph | null,
  proposals: EffectiveProposal[],
  options?: BriefProposalOptions,
): BriefDelta {
  const nodeIndex = indexNodes(graph);
  const relations = new Map<string, string>();
  for (const edge of graph?.edges ?? []) {
    const key = wireKey(edge.source, edge.target);
    if (!relations.has(key)) relations.set(key, edge.relation);
  }

  // ── node kinds ────────────────────────────────────────────
  const kinds = new Map<string, BriefNodeKind>();
  const claim = (nodeId: string, kind: BriefNodeKind): void => {
    const current = kinds.get(nodeId);
    if (current === undefined || KIND_RANK[kind] > KIND_RANK[current]) {
      kinds.set(nodeId, kind);
    }
  };

  // Anchors: reuse the existing derivation rather than re-deriving it, so the
  // brief and the rollout ladder can never disagree about modify/new.
  for (const set of computeTouchedSets(story, graph, proposals)) {
    for (const touched of set.touched) claim(touched.nodeId, touched.kind);
  }

  const beforeIds = new Set<string>();
  const afterIds = new Set<string>();
  for (const step of story.steps) {
    for (const item of step.flowBefore) beforeIds.add(parseFlowItem(item).id);
    for (const item of step.flowAfter) afterIds.add(parseFlowItem(item).id);
  }

  for (const id of afterIds) {
    // In after and in the graph today → it survives; in after only → the plan
    // introduces it. Anchors may already have claimed it more strongly.
    claim(id, nodeIndex.has(id) ? 'stable' : 'new');
  }
  for (const id of beforeIds) {
    // THE derivation: provably present today (before refuses ghosts) and
    // absent from every after-path → removed.
    claim(id, afterIds.has(id) ? 'stable' : 'remove');
  }

  const storyNodes: BriefNode[] = [...kinds.entries()]
    .map(([nodeId, kind]) =>
      derivedNode(
        nodeId,
        kind,
        // Only a node the plan INTRODUCES is missing from today's world. A
        // removed node still exists now — that is the whole point of showing it.
        kind !== 'new',
        nodeIndex.get(nodeId)?.label ?? nodeId,
        'story',
      ),
    )
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));

  // ── wires ─────────────────────────────────────────────────
  const beforePairs = new Map<string, { from: string; to: string; label?: string }>();
  const afterPairs = new Map<string, { from: string; to: string; label?: string }>();
  for (const step of story.steps) {
    for (const pair of flowPairs(step.flowBefore)) {
      if (!beforePairs.has(wireKey(pair.from, pair.to))) {
        beforePairs.set(wireKey(pair.from, pair.to), pair);
      }
    }
    for (const pair of flowPairs(step.flowAfter)) {
      if (!afterPairs.has(wireKey(pair.from, pair.to))) {
        afterPairs.set(wireKey(pair.from, pair.to), pair);
      }
    }
  }

  const absentToday = new Set(storyNodes.filter((node) => !node.existsToday).map((n) => n.nodeId));
  const wires: BriefWire[] = [];
  for (const key of [...new Set([...beforePairs.keys(), ...afterPairs.keys()])].sort()) {
    const before = beforePairs.get(key);
    const after = afterPairs.get(key);
    const { from, to } = (after ?? before)!;
    const delta: BriefWireDelta =
      before !== undefined && after !== undefined
        ? 'kept'
        : after !== undefined
          ? 'added'
          : 'removed';
    const derived = deriveWireLabel(from, to, nodeIndex, relations);
    // A wire is painted in TODAY only when it is not added AND both of its
    // endpoints exist there — otherwise it would connect to nothing.
    const drawnToday =
      delta !== 'added' && !absentToday.has(from) && !absentToday.has(to);
    wires.push({
      from,
      to,
      delta,
      labelBefore: drawnToday ? (before?.label ?? derived) : '',
      labelAfter: delta === 'removed' ? (before?.label ?? derived) : (after?.label ?? derived),
      drawnToday,
    });
  }

  // ── authored slots (unverifiable — the ledger must say so) ─
  const unchanged = story.steps.find((step) => step.unchanged !== undefined)?.unchanged;
  const fails = story.steps.flatMap((step) => step.fails);

  // ── the proposal layer ────────────────────────────────────
  // Scoped to THIS plan by slug: a brief opened on one plan must not sprout a
  // different plan's ghosts, and the two spellings of one plan's name are not
  // two plans.
  const { proposals: withChange, docs } = proposalInputs(options);
  const proposed = assembleProposals(proposalsOfPlan(withChange, story.plan), graph, docs);

  const delta: BriefDelta = {
    nodes: mergeProposalNodes(storyNodes, proposed.nodes),
    wires,
    fails,
    proposed,
  };
  if (unchanged !== undefined) delta.unchanged = unchanged;
  return delta;
}

// ── feature-scoped brief (feature-blueprint) ───────────────────────────────
//
// A plan-scoped brief dies when its plan archives. A FEATURE-scoped one
// outlives every plan that touched it, which is what makes "what will be
// built" and "what was built" the same document at different times.
//
// The consequence is that the brief becomes TWO documents, and which one you
// get is decided by whether work is in flight:
//
//   no plan touching it → ANATOMY  (Today only: how this feature works)
//   a plan touching it  → DELTA    (Today ⇄ After, sliced to this feature)
//
// Nothing switches modes explicitly — anatomy is simply what a delta degrades
// to when there is no "after" to compare against.

/** The graph-node id an anchor points at, or null when it names none. */
function nodeIdOfAnchor(anchor: string): string | null {
  const colon = anchor.indexOf(':');
  if (colon < 0) return null;
  const kind = anchor.slice(0, colon);
  const ref = anchor.slice(colon + 1);
  if (kind === 'module' || kind === 'datastore' || kind === 'endpoint' || kind === 'integration') {
    return anchor;
  }
  if (kind === 'file') {
    const slash = ref.lastIndexOf('/');
    return slash > 0 ? `module:${ref.slice(0, slash)}` : null;
  }
  // Defensive: a bare path stored before anchors were normalized still
  // resolves, so an old store is not silently empty.
  const slash = anchor.lastIndexOf('/');
  return slash > 0 ? `module:${anchor.slice(0, slash)}` : null;
}

/**
 * The set of graph-node ids a feature claims, including descendants of a
 * claimed module — claiming `module:src/auth` should pull in
 * `module:src/auth/tokens` rather than leaving it out of the feature's own view.
 */
export function featureNodeIds(anchors: readonly string[], graph: BlueprintGraph | null): Set<string> {
  const direct = new Set<string>();
  for (const anchor of anchors) {
    const id = nodeIdOfAnchor(anchor);
    if (id !== null) direct.add(id);
  }
  const out = new Set(direct);
  for (const node of graph?.nodes ?? []) {
    if (out.has(node.id) || !node.id.startsWith('module:')) continue;
    const path = node.id.slice('module:'.length);
    for (const claimed of direct) {
      if (!claimed.startsWith('module:')) continue;
      if (path.startsWith(`${claimed.slice('module:'.length)}/`)) {
        out.add(node.id);
        break;
      }
    }
  }
  return out;
}

/**
 * The brief for ONE feature.
 *
 * `story` is the compiled story of a plan currently touching this feature, or
 * null. With null the result is ANATOMY: every claimed node is `stable`, wires
 * come from the derived graph, and there are no authored claims because none
 * have been made about a change that is not happening.
 *
 * With a story, the full delta is computed and then SLICED to this feature —
 * a plan spanning several features appears in each one's brief showing only
 * that feature's part (discovery decision #20).
 */
export function computeFeatureBrief(
  anchors: readonly string[],
  story: CompiledStory | null,
  graph: BlueprintGraph | null,
  proposals: EffectiveProposal[],
  options?: BriefProposalOptions,
): BriefDelta & { mode: 'anatomy' | 'delta' } {
  const claimed = featureNodeIds(anchors, graph);
  const nodeIndex = indexNodes(graph);

  // THE ATTACHED PROPOSALS, at this scope.
  //
  // The caller has already run attachment (`attachProposal`'s specificity rule
  // needs every feature's claims, which this pure model does not have and must
  // not read), so what arrives here is exactly the set that belongs to this
  // feature — possibly, and USUALLY, empty. Measured on the live store: of 33
  // features, one proposal attaches to two of them and two attach to none at
  // all, their anchors being commons claimed by ten and sixteen features. The
  // empty result is therefore the surface's normal output, and `proposed`
  // carries `nothingProposed` + a summary line so it reads as an answer rather
  // than as a panel that failed to load.
  const { proposals: withChange, docs } = proposalInputs(options);
  const proposed = assembleProposals(withChange, graph, docs);

  if (story === null) {
    // ANATOMY — what this feature IS today, plus anything predicted about it.
    // A proposal does not need a plan in flight to exist: a discovery writes
    // one long before any plan is narrated, which is precisely the moment the
    // discovery view is for.
    const own: BriefNode[] = [...claimed]
      .filter((id) => nodeIndex.has(id))
      .sort()
      .map((id) => derivedNode(id, 'stable', true, nodeIndex.get(id)?.label ?? id, 'graph'));
    const nodes = mergeProposalNodes(own, proposed.nodes);
    // Wires stay ANATOMY-only: they are observed edges between observed nodes.
    // A proposal carries no wire, and inventing one would draw a connection
    // nothing has claimed.
    const present = new Set(own.map((node) => node.nodeId));
    const wires: BriefWire[] = (graph?.edges ?? [])
      .filter((edge) => present.has(edge.source) && present.has(edge.target))
      .map((edge) => ({
        from: edge.source,
        to: edge.target,
        delta: 'kept' as const,
        labelBefore: edge.relation,
        labelAfter: edge.relation,
        drawnToday: true,
      }))
      .sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to));
    return { mode: 'anatomy', nodes, wires, fails: [], proposed };
  }

  // DELTA — compute the whole change, then keep only this feature's slice.
  // The story's own proposal layer is NOT passed through: at feature scope the
  // proposals are the attached ones, which is a different (and narrower)
  // question than "which proposals belong to this plan".
  const full = computeBriefDelta(story, graph, proposals);
  const sliceIds = new Set([...claimed, ...full.nodes.map((node) => node.nodeId).filter((id) => claimed.has(id))]);
  const storySlice = full.nodes.filter((node) => sliceIds.has(node.nodeId));
  const kept = new Set(storySlice.map((node) => node.nodeId));
  const wires = full.wires.filter((wire) => kept.has(wire.from) && kept.has(wire.to));
  const sliced: BriefDelta & { mode: 'anatomy' | 'delta' } = {
    mode: 'delta',
    nodes: mergeProposalNodes(storySlice, proposed.nodes),
    wires,
    fails: full.fails,
    proposed,
  };
  if (full.unchanged !== undefined) sliced.unchanged = full.unchanged;
  return sliced;
}

/** Re-exported so callers need not reach into anchors.js for the same helper. */
export { resolveStoryAnchors };

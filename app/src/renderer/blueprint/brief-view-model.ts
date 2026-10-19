/**
 * Change-brief view model (change-brief) — PURE, no DOM.
 *
 * Maps the CLI's `BriefDelta` onto per-time-state render instructions: which
 * cards paint, which are absent, which wires draw, and what class each carries.
 * The board consumes this and does nothing but apply it, so every rule below is
 * unit-testable without a renderer.
 *
 * THE CORE BET: ONE LAYOUT, TWO STATES
 * ====================================
 * A node the plan INTRODUCES is `absent` in TODAY — hidden, but still occupying
 * its box. That is deliberate: the frame is computed from the union of both
 * worlds, so every surviving card holds its exact position when the state
 * flips. The diagram GROWS into After; it never re-lays-out. If absent nodes
 * were removed from the layout instead, the eye would have to re-find every
 * card on each flip and the comparison would be lost.
 *
 * WHY NOT GHOSTS IN TODAY
 * =======================
 * The board already renders proposals as dashed ghosts, and reusing that here
 * was the obvious move — but it is wrong. A ghost still SHOWS the plan, and
 * Today is the world in which the plan does not exist yet. Ghosting leaks the
 * execution plan into the pre-plan view. Absent means absent.
 */
import type { BlueprintNodeKind } from '../../shared/ipc-contract'

/** Which world the brief is showing. */
export type BriefTime = 'now' | 'next'

/** The band's label when a brief cannot open. */
export const BRIEF_UNAVAILABLE_LABEL = 'No brief'

/**
 * Why the brief could not open, in the board's own words.
 *
 * LIVES HERE, NOT ON THE BOARD, so the ui-text-hygiene scan can see it. The
 * board's version ended with the narrate command and a `flow/plans/<plan>.md`
 * path — forbidden-pattern #12, reached from a band that exists precisely
 * because a control that does nothing is unanswerable for a user. Replacing a
 * dead end with a sentence nobody can press is the same dead end.
 *
 * `reason` comes straight from the CLI and may itself end in a command hint;
 * that is a terminal tool writing for terminal users, so it is trimmed at this
 * display boundary and nowhere else (the `withoutCommandHint` rule).
 */
export function briefUnavailableText(reason: string): string {
  const trimmed = withoutCliInstruction(reason).replace(/[.\s]+$/, '')
  const cause = trimmed.length > 0 ? `${trimmed}. ` : ''
  return `${cause}A brief is the Today-and-After picture of a plan, and this project has no plan narrated yet. Ask the agent to narrate one and it opens here.`
}

/**
 * A CLI refusal, with the invocation taken off the end.
 *
 * THE CLI WRITES FOR A TERMINAL AND THIS IS NOT ONE. Its refusal reads
 * "no compiled story for 'x' — run `blueprint narrate --from <plan-doc>` first",
 * which is exactly right where you can type it and exactly wrong on a board
 * whose very next sentence is "Ask the agent to narrate one and it opens here"
 * (forbidden-pattern #12). The SUBSTANCE is kept verbatim; only the instruction
 * to go and do it by hand is removed.
 *
 * The board's own `withoutCommandHint` could not do this: it anchors on
 * `planflow-ai`, and the blueprint verbs are quoted bare.
 */
export function withoutCliInstruction(reason: string): string {
  const stripped = reason
    .trim()
    // "— run `x` first" / ", then run `x`" — the clause, not just the span,
    // so no dangling "— run  first" is left behind.
    .replace(/\s*[—,-]?\s*(?:then\s+)?run\s+`[^`]*`(?:\s+first)?\.?/gi, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\s+([—,-])\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return stripped.length > 0 ? stripped : reason.trim()
}

/** How a node differs between the two worlds (mirrors the CLI model). */
export type BriefNodeKind = 'stable' | 'modify' | 'new' | 'remove'

/** How a wire differs between the two worlds (mirrors the CLI model). */
export type BriefWireDelta = 'kept' | 'added' | 'removed'

// ── provenance (discovery-view) ────────────────────────────────────────────
//
// The app-side MIRROR of the CLI's provenance block (`src/cli/blueprint/
// brief-model.ts`). It is mirrored rather than re-derived for one reason: the
// CLI already answered both questions a renderer would otherwise have to
// infer, and a renderer that infers "is this predicted?" will eventually infer
// wrong — producing a screenshot of speculation that reads as the current
// architecture.
//
//   existsToday          — is this node REAL right now?
//   provenance.predicted — is this node's CLAIM unexecuted?
//
// They are INDEPENDENT, and the ordinary case is the one where they disagree:
// measured on this repo's live store, all three proposals derive as `changed`,
// so the typical predicted node is a box that exists today (real) carrying a
// claim that has not happened yet (predicted). Neither field alone describes
// it, which is why neither may be computed from the other.
//
// Every field here is OPTIONAL: an older CLI emits none of it, and a feature
// brief must still open against one.

/** Where a brief node's claim came from. */
export type BriefNodeSource = 'graph' | 'story' | 'proposal'

/** The kind of document backing a proposal — `none` when nothing on disk does. */
export type ProposalDocKind = 'plan' | 'discovery' | 'brainstorm' | 'none'

/** The document a proposal came out of, already resolved against disk. */
export interface BriefProposalSource {
  /** The proposal's `plan` field — the name the store recorded, verbatim. */
  plan: string
  /** Live doc basename backing it (no `.md`), or null when none survives. */
  doc: string | null
  kind: ProposalDocKind
}

/**
 * One proposal's claim on a node, carried WHOLE.
 *
 * `label` and `detail` are load-bearing, not decoration. The ordinary discovery
 * view is the CHANGED-only case — marks on boxes that already exist — and a
 * bare mark says "something here moves" and stops. The label says what moves;
 * the detail says how. Strip them and the surface is theatre.
 */
export interface BriefNodeProposal {
  /** Stable identity (`<plan>+<predictedNodeId>`). */
  fingerprint: string
  /** The proposal's own title — NOT the graph's label for the node. */
  label: string
  /** What the prediction actually says. */
  detail?: string
  /** Anchor-derived: `changed` when it touches existing code, else `new`. */
  change: 'new' | 'changed'
  /** Lifecycle state at read time (`proposed` / `accepted` / `rejected`). */
  state: string
  /** What the proposal predicts — an extractor kind, or `part`. */
  kind: string
  /** The anchors that resolved — the evidence for `changed`. */
  resolvedAnchors: string[]
  /** Every anchor it was filed with, resolved or not (`kind:ref`). */
  anchors?: string[]
  /** The plan phase that builds it, when it was filed with one. */
  phase?: number
  source: BriefProposalSource
}

/** Why a node is in the brief, and whether its claim has actually happened. */
export interface BriefNodeProvenance {
  source: BriefNodeSource
  /** True ⇒ the node is here because of an UNEXECUTED claim. */
  predicted: boolean
  /** Every proposal claiming this node, sorted by fingerprint. Often empty. */
  proposals: BriefNodeProposal[]
}

/** A proposal that is NOT rendered, and the stated reason. Never silent. */
export interface BriefSkippedProposal {
  fingerprint: string
  predictedNodeId: string
  reason: string
}

/**
 * The proposal layer, at whatever scope the brief was opened with.
 *
 * `nothingProposed` is carried as its own field rather than read off
 * `nodes.length === 0` because the two readings of an empty list are different
 * facts: "this feature has no upcoming change" is an ANSWER, "the store had
 * nothing to say" is a shrug. Measured on the live store the empty case is the
 * MAJORITY — 31 of 33 features attach nothing — so this is the answer this
 * surface gives most often, and it has to be a real one.
 */
export interface BriefProposalLayer {
  nodes: BriefDeltaNode[]
  sources: BriefProposalSource[]
  nothingProposed: boolean
  summary: string
  skipped: BriefSkippedProposal[]
}

/** One node of the CLI delta, as the renderer receives it. */
export interface BriefDeltaNode {
  nodeId: string
  kind: BriefNodeKind
  existsToday: boolean
  label: string
  /** Graph kind, when the node is real; absent for a not-yet-built node. */
  nodeKind?: BlueprintNodeKind
  /** True when a stamped source range drifted (Progressive Learning T3). */
  stale?: boolean
  /** Predicted-vs-real and its evidence. Absent on an older CLI payload. */
  provenance?: BriefNodeProvenance
}

/** One wire of the CLI delta, as the renderer receives it. */
export interface BriefDeltaWire {
  from: string
  to: string
  delta: BriefWireDelta
  labelBefore: string
  labelAfter: string
  drawnToday: boolean
}

/** One resolved-or-not anchor, for the verification ledger. */
export interface BriefAnchor {
  ref: string
  resolved: boolean
}

/** Minimal story metadata the chrome needs (kicker drives the problem band). */
export interface BriefStoryStep {
  title: string
  kicker?: string
  body: string
  decisions: string[]
  rejected: string[]
}

/** The delta the CLI produced, plus the authored slots. */
export interface BriefDeltaInput {
  nodes: BriefDeltaNode[]
  wires: BriefDeltaWire[]
  unchanged?: string
  fails: string[]
  /** Story steps, in arc order. Optional — an empty brief still renders. */
  steps?: BriefStoryStep[]
  /** Every anchor the story declared, with its resolution verdict. */
  anchors?: BriefAnchor[]
  /** Who a FEATURE brief is about. Absent for plan-scoped briefs. */
  identity?: BriefIdentity
  /**
   * Which world this brief describes, straight from the CLI.
   *
   * `anatomy` — no plan is in flight; the brief is what EXISTS.
   * `delta`   — a plan is narrated; the brief is Today ⇄ After.
   *
   * Optional for back-compat: an older payload without it is treated as a
   * delta, which is what every brief was before feature briefs existed.
   */
  mode?: 'anatomy' | 'delta'
  /**
   * The proposal layer (discovery-view). Absent on an older CLI payload —
   * which is NOT the same as `nothingProposed: true`, and the discovery-view
   * decider treats the two differently for exactly that reason.
   */
  proposed?: BriefProposalLayer
}

/** The feature a brief is about — its name, its prose, its change records. */
/** A change record under this feature. `id` empty ⇒ label only, not openable. */
export interface BriefChild {
  id: string
  name: string
}

/** One learning, as the brief renders it. */
export interface BriefLearning {
  text: string
  provenance: string
  date: string
  pinned?: boolean
  supersededReason?: string
}

export interface BriefIdentity {
  name: string
  prose: string
  children: BriefChild[]
  learnings?: BriefLearning[]
}

/** Render instruction for one card. */
export interface BriefNodeView {
  nodeId: string
  label: string
  /** True → the card is painted. False → hidden but still occupying its box. */
  painted: boolean
  /**
   * CSS classes to add. Empty in TODAY: the pre-plan world has no deltas to
   * show, so a card there looks exactly like an ordinary board card.
   */
  classes: string[]
  /** Badge word, or null when the card carries none (always null in TODAY). */
  badge: string | null
  /** True when a stamped range drifted — the amber corner dot. */
  staleDot: boolean
}

/** Render instruction for one wire. */
export interface BriefWireView {
  from: string
  to: string
  drawn: boolean
  classes: string[]
  label: string
  /** True when the label should render struck through (a dead path in AFTER). */
  struck: boolean
}

/**
 * The band above the stage. Its MEANING flips with the time state, which is
 * the point: After states a guarantee about the change, Today states a fact
 * about the present. Rendering the guarantee in Today would be a promise about
 * a world that has not happened.
 */
export interface BriefBand {
  tone: 'problem' | 'guarantee'
  /** Short uppercase label: `Known issue` / `Unchanged`. */
  label: string
  text: string
}

/** The honesty ledger — what the brief claims versus what it can prove. */
export interface BriefLedger {
  /** Anchors that resolved against the graph or a live proposal. */
  resolved: number
  /** Anchors that did not resolve — the brief names them rather than hiding them. */
  unresolved: string[]
  /**
   * Claims nothing in the code can prove. `unchanged` and every `fails` entry
   * are AUTHORED; no extractor produces them, so the ledger must say so rather
   * than let the format's authority launder them into derived facts.
   */
  authoredClaims: number
}

/** Everything the board needs to paint one time state. */
export interface BriefView {
  time: BriefTime
  nodes: BriefNodeView[]
  wires: BriefWireView[]
  /** The band, or null when the state has nothing honest to put there. */
  band: BriefBand | null
  /** The band. In TODAY this is null — Today states a problem, not a guarantee. */
  unchangedBand: string | null
  /** Ledger for the current state — Today counts only what exists today. */
  ledger: BriefLedger
  /** Slot ids, in display order. Differs by state on purpose. */
  slots: string[]
  /** True when the rollout ladder is shown. Never in TODAY: it IS the plan. */
  showLadder: boolean
  /**
   * Feature identity, painted as the brief's opening block. A feature whose
   * anchors resolve to no graph node draws NO cards — without this the drawer
   * opens blank, which reads as "nothing is known about this feature" when the
   * truth is "no extractor has reached it yet".
   */
  intro: BriefIdentity | null
  /** Census line for TODAY (the ladder's replacement). */
  census: { components: number } | null
  /**
   * Whether the Today ⇄ After switch means anything.
   *
   * Only a DELTA has two worlds to move between. An anatomy brief describes
   * what exists, so offering "Today · before this plan" / "After · this plan"
   * names a plan that is not there — a control that cannot do what it says.
   *
   * A LIVE PROPOSAL SUPPLIES THE SECOND WORLD an anatomy brief lacks. The rule
   * above is about whether there IS another world, not about where it came
   * from: a feature with no plan in flight but a discovery predicting changes
   * to it has exactly two worlds — what exists, and what is claimed — so the
   * switch means something and is offered.
   */
  showTimeSwitch: boolean
}

/**
 * Does this brief carry an unexecuted claim from the proposal store?
 *
 * Read off the LAYER, never off `nodes`: the layer's `nothingProposed` is the
 * CLI's explicit answer, and a brief from an older CLI carries no layer at all
 * — which must read as "unknown, offer nothing", not as "nothing proposed".
 */
export function hasLiveProposals(delta: BriefDeltaInput): boolean {
  const layer = delta.proposed
  if (layer === undefined) return false
  return !layer.nothingProposed && layer.nodes.length > 0
}

/** Delta kind → the board's Review-Mode git-tint class. */
const DELTA_CLASS: Record<Exclude<BriefNodeKind, 'stable'>, string> = {
  new: 'd-new',
  modify: 'd-modify',
  remove: 'd-remove',
}

/** Delta kind → badge word shown on the card in AFTER. */
const DELTA_BADGE: Record<Exclude<BriefNodeKind, 'stable'>, string> = {
  new: 'new',
  modify: 'changed',
  remove: 'removed',
}

/** Wire delta → wire class in AFTER. `kept` carries none. */
const WIRE_CLASS: Partial<Record<BriefWireDelta, string>> = {
  added: 'w-added',
  removed: 'w-dead',
}

/** Slot ids per state. Today's slots must not reference the plan at all. */
const SLOTS_TODAY = ['todayHow', 'todayProblems', 'verify'] as const
const SLOTS_AFTER = ['why', 'fails', 'rollout', 'verify'] as const

/** The concept arc opens on the problem — that step supplies Today's band. */
const PROBLEM_KICKER = /problem/i

/**
 * Today's band text: the story's PROBLEM step, which the concept arc convention
 * (problem → shape → data flow → decisions → risks) always puts first. This is
 * derived, not authored twice — the arc already states why the change is worth
 * making, and that statement is a fact about the present.
 */
function problemText(steps: readonly BriefStoryStep[]): string | null {
  // ONLY an explicit problem step. This used to fall back to `steps[0]`, on the
  // assumption that a concept arc always opens on the problem. Plans authored
  // as PHASES do not: "Close the doors first" is the first thing to build, and
  // labelling it `KNOWN ISSUE` states a defect that does not exist. A band is a
  // claim about the present — inventing one from whatever came first is worse
  // than showing none.
  const step = steps.find(
    (candidate) => candidate.kicker !== undefined && PROBLEM_KICKER.test(candidate.kicker),
  )
  if (step === undefined) return null
  const text = step.body.trim().length > 0 ? step.body.trim() : step.title.trim()
  return text.length > 0 ? text : null
}

/**
 * Build the render instructions for one time state.
 *
 * TODAY paints only the pre-plan world: introduced nodes are absent, added
 * wires are not drawn, no delta classes, no badges, no ladder. AFTER paints
 * the full delta.
 */
export function buildBriefView(delta: BriefDeltaInput, time: BriefTime): BriefView {
  const today = time === 'now'
  const absent = new Set(delta.nodes.filter((n) => !n.existsToday).map((n) => n.nodeId))

  const nodes: BriefNodeView[] = delta.nodes.map((node) => {
    const painted = today ? node.existsToday : true
    const classes: string[] = []
    let badge: string | null = null
    if (!today && node.kind !== 'stable') {
      classes.push(DELTA_CLASS[node.kind], 'show-badge')
      badge = DELTA_BADGE[node.kind]
    }
    if (!painted) classes.push('t-absent')
    return {
      nodeId: node.nodeId,
      label: node.label,
      painted,
      classes,
      badge,
      // Drift is a fact about the code, true in both worlds.
      staleDot: node.stale === true,
    }
  })

  const wires: BriefWireView[] = delta.wires.map((wire) => {
    // In TODAY a wire draws only when the CLI says so AND neither endpoint is
    // absent — belt and braces, because a wire to nothing is worse than none.
    const drawn = today
      ? wire.drawnToday && !absent.has(wire.from) && !absent.has(wire.to)
      : true
    const classes: string[] = []
    if (!today) {
      const cls = WIRE_CLASS[wire.delta]
      if (cls !== undefined) classes.push(cls)
    }
    return {
      from: wire.from,
      to: wire.to,
      drawn,
      classes,
      label: today ? wire.labelBefore : wire.labelAfter,
      struck: !today && wire.delta === 'removed',
    }
  })

  // The band flips MEANING with the state. After carries the authored
  // guarantee; Today carries the derived problem. Neither renders empty.
  const guarantee = delta.unchanged ?? null
  const problem = problemText(delta.steps ?? [])
  const band: BriefBand | null = today
    ? problem === null
      ? null
      : { tone: 'problem', label: 'Known issue', text: problem }
    : guarantee === null
      ? null
      : { tone: 'guarantee', label: 'Unchanged', text: guarantee }

  const anchors = delta.anchors ?? []
  const authoredClaims = (delta.unchanged !== undefined ? 1 : 0) + delta.fails.length
  const ledger: BriefLedger = {
    resolved: anchors.filter((a) => a.resolved).length,
    unresolved: anchors.filter((a) => !a.resolved).map((a) => a.ref).sort(),
    // Today makes no claim about the change, so the authored claims — which
    // are all ABOUT the change — do not belong to its ledger.
    authoredClaims: today ? 0 : authoredClaims,
  }

  return {
    time,
    nodes,
    wires,
    band,
    // The band is a claim ABOUT THE CHANGE, so it belongs to After only.
    unchangedBand: today ? null : guarantee,
    ledger,
    intro: delta.identity ?? null,
    slots: [...(today ? SLOTS_TODAY : SLOTS_AFTER)],
    showLadder: !today,
    census: today ? { components: delta.nodes.filter((n) => n.existsToday).length } : null,
    // Only a DELTA has two worlds. An anatomy brief describes what exists, so
    // "Today · before this plan / After · this plan" names a plan that is not
    // there. Absent mode ⇒ delta, which is what every brief was before feature
    // briefs existed.
    //
    // …UNLESS a live proposal supplies the second world. An anatomy brief with
    // proposals attached is not one world: it is what exists and what is
    // claimed, and hiding the switch there would leave the discovery view with
    // no way back to the observed picture.
    showTimeSwitch: delta.mode !== 'anatomy' || hasLiveProposals(delta),
  }
}

/** One anchored investigation note — the causal glue for a card. */
export interface BriefNote {
  summary: string
  provenance: string
  stale: boolean
}

/** One wire touching a card, from that card's point of view. */
export interface BriefNodeWire {
  other: string
  direction: 'in' | 'out'
  delta: BriefWireDelta
  label: string
}

/** Everything the drawer shows for one card. */
export interface BriefNodeDetail {
  nodeId: string
  label: string
  kind: BriefNodeKind
  /** What this component IS today. Null when the plan introduces it. */
  today: string | null
  /** What it becomes. Null when the plan removes it. */
  after: string | null
  /** Story steps that name this node, for narrative context. */
  steps: Array<{ title: string; kicker?: string }>
  /**
   * Anchored notes from `investigations.jsonl` — the "why this matters" that
   * no extractor produces. THIS is the drawer's payload; the rest is scaffolding.
   */
  notes: BriefNote[]
  /** Wires touching this node, with how each changes. */
  wires: BriefNodeWire[]
  /**
   * Unexecuted claims on this node (discovery-view), in fingerprint order.
   *
   * The drawer is where a claim can be read WHOLE — a card note is clamped and
   * a band names only the source. Empty for every node nothing predicts, which
   * is the majority.
   */
  proposals: BriefNodeProposal[]
}

/** Derived one-liners per change kind. Deliberately terse — the notes teach. */
const TODAY_BY_KIND: Record<BriefNodeKind, string | null> = {
  stable: 'Present, and untouched by this plan.',
  modify: 'Present today.',
  remove: 'Present today.',
  new: null,
}
const AFTER_BY_KIND: Record<BriefNodeKind, string | null> = {
  stable: 'Unchanged.',
  modify: 'Changed by this plan.',
  remove: null,
  new: 'Introduced by this plan.',
}

/**
 * Whether an investigation anchor ref belongs to a node. Exact id match, or a
 * `file:`/`symbol:` ref living under a module node's directory — the same
 * roll-up the board uses to attach a file-level fact to its module card.
 */
export function anchorBelongsTo(ref: string, nodeId: string): boolean {
  if (ref === nodeId) return true
  if (!nodeId.startsWith('module:')) return false
  const dir = nodeId.slice('module:'.length)
  const colon = ref.indexOf(':')
  const path = colon >= 0 ? ref.slice(colon + 1) : ref
  return path.startsWith(`${dir}/`)
}

/**
 * Build the drawer content for one card. Pure. Returns null for a node the
 * delta does not know, so the caller falls back to the ordinary popover rather
 * than showing an empty brief drawer.
 */
export function buildBriefNodeDetail(
  delta: BriefDeltaInput,
  nodeId: string,
  investigations: ReadonlyArray<{ anchorRefs: string[]; summary: string; provenance: string; stale?: boolean }>,
): BriefNodeDetail | null {
  const node = delta.nodes.find((n) => n.nodeId === nodeId)
  if (node === undefined) return null

  const wires: BriefNodeWire[] = []
  for (const wire of delta.wires) {
    if (wire.from === nodeId) {
      wires.push({ other: wire.to, direction: 'out', delta: wire.delta, label: wire.labelAfter })
    } else if (wire.to === nodeId) {
      wires.push({ other: wire.from, direction: 'in', delta: wire.delta, label: wire.labelAfter })
    }
  }

  const steps = (delta.steps ?? [])
    .filter((step) => step.body.includes(nodeId) || step.title.includes(nodeId))
    .map((step) => ({ title: step.title, ...(step.kicker !== undefined ? { kicker: step.kicker } : {}) }))

  const notes: BriefNote[] = investigations
    .filter((note) => note.anchorRefs.some((ref) => anchorBelongsTo(ref, nodeId)))
    .map((note) => ({ summary: note.summary, provenance: note.provenance, stale: note.stale === true }))

  return {
    nodeId,
    label: node.label,
    kind: node.kind,
    today: TODAY_BY_KIND[node.kind],
    after: AFTER_BY_KIND[node.kind],
    steps,
    notes,
    wires,
    // Sorted by fingerprint so two renders of one store agree. The CLI already
    // sorts; re-sorting here costs nothing and removes the dependency on it.
    proposals: [...(node.provenance?.proposals ?? [])].sort((a, b) =>
      a.fingerprint.localeCompare(b.fingerprint),
    ),
  }
}

/**
 * The frame must be identical across states, so it is computed from the union
 * of BOTH worlds — every node, painted or not. Returning the id set keeps the
 * layout call site honest: it lays out this set once and never re-lays-out on
 * a flip.
 */
export function briefLayoutIds(delta: BriefDeltaInput): string[] {
  return delta.nodes.map((node) => node.nodeId).sort((a, b) => a.localeCompare(b))
}

/**
 * Nodes a rollout phase touches, for the ladder's hover highlight. Nodes not in
 * the set dim. An empty/unknown phase dims nothing — never invent a highlight.
 */
export function ladderHighlight(
  delta: BriefDeltaInput,
  touchedNodeIds: readonly string[],
): { lit: string[]; dimmed: string[] } {
  if (touchedNodeIds.length === 0) {
    return { lit: delta.nodes.map((n) => n.nodeId), dimmed: [] }
  }
  const touched = new Set(touchedNodeIds)
  const lit: string[] = []
  const dimmed: string[] = []
  for (const node of delta.nodes) {
    ;(touched.has(node.nodeId) ? lit : dimmed).push(node.nodeId)
  }
  return { lit, dimmed }
}

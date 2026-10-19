/**
 * Feature board view model (feature-blueprint) — PURE, no DOM.
 *
 * Turns the CLI's feature graph into the render state for the board's default
 * view. The blueprint's default view stops being "a picture of the files" and
 * becomes "what this project does"; the code map stays behind its own button.
 *
 * TWO LEVELS ONLY (decision #7) — GONE, WITH THE GRID
 * ===================================================
 * The ceiling was `blueprint-board.ts` holding `#featureFocus` as a single
 * `string | null`, and it was rendered by `buildFeatureBoardView` — a grid of
 * cards, deleted in Phase 4 along with `fb-feature-grid` / `fb-feature-card`.
 * What replaced it: a STACK plus one rule (`childrenOf`, in `focus-stack.ts`),
 * so depth follows the data. `toFocusGraph` below is where a flat feature graph
 * grows its domain layer, and `buildFeatureFocusView` is the level the
 * feature map draws.
 */

import {
  childrenOf,
  crumbs,
  type FocusCrumb,
  type FocusGraphInput,
  type FocusGraphNode,
  type FocusNode,
  type FocusNodeKind,
} from './focus-stack'
import type { BlueprintFeatureFolders } from '../../shared/ipc-contract'

/** Learning status, mirroring the module tier this replaces. */
export type FeatureUnderstanding = 'none' | 'learning' | 'learned' | 'stale'

/**
 * One node as the CLI emits it — mirrors `BlueprintFeatureNode` in the IPC
 * contract, and must carry every kind that contract admits.
 *
 * THREE KINDS, THREE MEANINGS — and three words, one meaning each: a FEATURE
 * (`core`) is a capability, a PART is a piece it is made of, a CHANGE (`child`)
 * is a plan or an issue that touched it. No surface may spend one of those
 * words on another's meaning; that collapse is the bug this phase closed.
 * `toFocusGraph` below is where each one learns its place; see the map there
 * for why that is a map and not a condition.
 */
export interface FeatureGraphNodeInput {
  id: string
  slug: string
  name: string
  kind: 'core' | 'child' | 'part'
  parent?: string
  /** For a `part`: the slug of the feature it belongs to. Absent otherwise. */
  partOf?: string
  /**
   * Grouping label for the root ring (Phase 3) — HUMAN-OWNED on the feature,
   * absent stays absent. Mirrors `FeatureGraphNode.domain` in the CLI.
   */
  domain?: string
  understanding: FeatureUnderstanding
  active: boolean
  anchorCount: number
  /** Files and lines the anchors resolve to — the Territory's area. Mirrors
   *  `BlueprintFeatureNode.size`; absent when the CLI did not measure. */
  size?: { files: number; lines: number }
  /** One line saying what this feature IS. */
  summary?: string
  /** Where it lives — its top folders. Mirrors `BlueprintFeatureNode.folders`;
   *  absent when the CLI found no files for it. */
  folders?: BlueprintFeatureFolders
}

/** A `relates` edge between two features. */
export interface FeatureGraphEdgeInput {
  from: string
  to: string
}

export interface FeatureGraphInput {
  nodes: FeatureGraphNodeInput[]
  edges: FeatureGraphEdgeInput[]
}

/** Render instruction for one relates wire. */
export interface FeatureWireView {
  from: string
  to: string
}

/**
 * Explicit bucket for core features carrying no `domain` — grouped, never
 * dropped. Mirrors `UNASSIGNED_DOMAIN` in `src/cli/blueprint/feature-graph.ts`;
 * the two must say the same word or the board and the CLI describe two
 * different groupings of the same features.
 */
export const UNASSIGNED_DOMAIN = 'Unassigned'

/**
 * What the ROOT of the focus stack is called on the breadcrumb.
 *
 * Exported because a second surface needs the same word: an open level's back
 * control names the depth it returns to (Phase 5.4), and "back to Features"
 * has to be the same "Features" the crumb says or the board has two names for
 * one place.
 */
export const FOCUS_ROOT_LABEL = 'Features'

/**
 * What the per-node control that opens a feature view is CALLED.
 *
 * It lives HERE, next to `FOCUS_ROOT_LABEL` and for the same reason: two
 * surfaces have to say the same thing. `territory-view.ts` draws the mark
 * (and re-exports this under its own name), and the empty-level messages below
 * point at it — "open the level (the diagram mark)" is only useful if the thing
 * it names is the thing the reader can see on the sheet.
 *
 * IT USED TO BE THE CHARACTER ITSELF: a circled `i`, interpolated straight into
 * the sentence. That was wrong twice over. `i` means "information", and what
 * the control actually opens is a FLOW DIAGRAM — typed component cards joined
 * by labelled edges. And a text character is at the mercy of whatever font
 * resolves inside a 15px disc, which is not something you can tune.
 *
 * So the sheet draws real geometry (see `openMark` in blueprint-board.ts) and
 * this constant became the mark's NAME. The single-source property is kept the
 * same way it always was — the renderer stamps this value on the drawn group as
 * `data-control-glyph`, so the sentence and the sheet still cannot disagree,
 * and a test can hold the two ends together.
 */
export const LEVEL_CONTROL_GLYPH = 'diagram'

/** Id grammar for a synthesised domain node. Domains are NOT features — they
 *  never carry a `feature:` id, and never render their own feature-view. */
export function domainId(domain: string): string {
  return `domain:${domain}`
}

/**
 * WHAT EACH CLI KIND BECOMES IN THE FOCUS GRAPH — a MAP, not a condition.
 *
 * This replaced `node.kind === 'core' ? 'feature' : 'part'`. The CLI emits
 * THREE kinds and that ternary knew about two, so its negation branch quietly
 * swept the third — `child`, a CHANGE RECORD (a plan or an issue) — into the
 * `part` bucket. Live consequence: drilling into Chats showed two plan names
 * under the kicker "2 parts" while its ten actual parts were invisible.
 *
 * A map is what stops that recurring. Every kind states its own answer, a kind
 * this map does not name resolves to `undefined` and is EXCLUDED from the graph
 * rather than defaulting into whichever bucket the negation happened to point
 * at, and the answer is read from the kind itself — never re-derived from a
 * child count or a parent link, which is the same discipline
 * `territory-view.ts`'s `activationOf` records ("the test is
 * `kind === 'part'`, NEVER `childCount === 0`").
 *
 * `change` is carried into the graph but never onto a ring — `focus-stack.ts`
 * owns that exclusion in one place. It is here for its parent link, which the
 * upward walks (the in-flight learning rollup) depend on.
 */
const FOCUS_KIND: Readonly<Record<string, FocusNodeKind | undefined>> = {
  core: 'feature',
  part: 'part',
  child: 'change',
}

/**
 * `FeatureGraphNodeInput` reshaped for `focus-stack.ts`.
 *
 * Kinds are translated by `FOCUS_KIND` above, and each distinct `domain`
 * across the CORE features becomes a synthesised `domain`-kind node that those
 * features hang off — which is what lets `childrenOf(null)` open on ~7
 * capabilities instead of 28 names. Domains group the ring ONLY: they are not
 * a feature kind, they carry no slug, and `VIEW_NODE_KINDS` stays frozen.
 *
 * TWO RULES, BOTH LOAD-BEARING
 * ============================
 * 1. A core feature with no `domain` lands in an explicit `Unassigned` bucket
 *    rather than vanishing off the root — the same "counted, never dropped"
 *    rule the CLI's `groupByDomain` enforces.
 * 2. When NO core feature carries a domain at all, NOTHING is synthesised. A
 *    project that has never been seeded would otherwise open on a single ring
 *    of one node called "Unassigned", which is strictly worse than the
 *    documented fallback (`childrenOf(null)` showing feature roots directly).
 *
 * Deterministic: domains sort by name with `Unassigned` last, matching
 * `groupByDomain`, and are emitted before the features so the root ring reads
 * in that order.
 */
export function toFocusGraph(graph: FeatureGraphInput): FocusGraphInput {
  const domains: string[] = []
  const seen = new Set<string>()
  let anyDomain = false
  for (const node of graph.nodes) {
    if (node.kind !== 'core') continue
    if (node.domain !== undefined && node.domain.trim().length > 0) anyDomain = true
    const domain = node.domain?.trim() ? node.domain.trim() : UNASSIGNED_DOMAIN
    if (seen.has(domain)) continue
    seen.add(domain)
    domains.push(domain)
  }
  domains.sort((a, b) => {
    if (a === UNASSIGNED_DOMAIN) return b === UNASSIGNED_DOMAIN ? 0 : 1
    if (b === UNASSIGNED_DOMAIN) return -1
    return a.localeCompare(b)
  })

  const domainNodes: FocusGraphNode[] = anyDomain
    ? domains.map((domain) => ({ kind: 'domain', id: domainId(domain), name: domain }))
    : []

  const featureNodes: FocusGraphNode[] = graph.nodes.flatMap((node) => {
    const kind = FOCUS_KIND[node.kind]
    // A KIND THIS BOARD HAS NEVER HEARD OF IS NOT A PART. Dropping it shows the
    // reader one node fewer; guessing shows them a wrong node they cannot tell
    // from a right one.
    if (kind === undefined) return []
    // A core feature's parent is its DOMAIN; a part's and a change record's is
    // the feature they belong to.
    const parent =
      kind === 'feature'
        ? anyDomain
          ? domainId(node.domain?.trim() ? node.domain.trim() : UNASSIGNED_DOMAIN)
          : undefined
        : node.parent
    const out: FocusGraphNode = { kind, id: node.id, name: node.name }
    if (parent !== undefined) out.parent = parent
    return [out]
  })

  return { nodes: [...domainNodes, ...featureNodes] }
}

/**
 * WHICH KIND OF NOTHING THIS IS.
 *
 * The board attaches an ACTION to an empty level, and the action differs per
 * kind — so "there is nothing here" had to stop being one undifferentiated
 * string. `fetch-failed` is the one that was actively lying: a bundled-CLI
 * timeout and an empty store both rendered as "No features yet", which would
 * put a "Run basic discovery" button in front of a project that already has
 * plenty of features and merely failed to be read.
 */
export type EmptyLevelKind =
  /** The query itself failed — NOTHING was measured. Never offers discovery. */
  | 'fetch-failed'
  /** The store really is empty. This is the one basic discovery repairs. */
  | 'no-features'
  /** A domain nothing carries — human-owned frontmatter, no action exists. */
  | 'domain'
  /**
   * A feature with no parts yet — parts come from learning it. Whether CHANGES
   * have touched that feature changes the WORDS (see `emptyLevelState`) but not
   * this kind: the repair is the same one either way, and a kind is what an
   * action hangs off, not what a sentence hangs off.
   */
  | 'feature'
  /** A leaf artifact: nothing is inside one, by definition. */
  | 'part'
  /** A level that is empty for none of the above reasons. */
  | 'level'

/** What an empty level says, and what family of fix (if any) applies. */
export interface EmptyLevel {
  kind: EmptyLevelKind
  text: string
}

/** Everything the board needs to paint the CURRENT focus-stack depth. */
export interface FeatureFocusView {
  /** The focus stack itself — [] at the root. */
  stack: FocusNode[]
  cards: FocusNode[]
  wires: FeatureWireView[]
  crumbs: FocusCrumb[]
  emptyReason: string | null
  /** The same absence, with its KIND — what the board hangs an action off. */
  empty: EmptyLevel | null
}

/** What the caller knows about the fetch that produced `graph`. */
export interface FeatureFocusOptions {
  /**
   * Non-null when the feature query FAILED, carrying the CLI's own one-line
   * reason. An empty `graph` then means "unknown", not "none" — see
   * `EmptyLevelKind`.
   */
  fetchFailure?: string | null
}

/**
 * Build the view for whatever depth `stack` names.
 *
 * `stack === []` renders the root (domains, or features when none exist).
 * Otherwise the top of the stack is the current focus and its `childrenOf`
 * result is what renders — depth follows the stack instead of a hardcoded
 * constant, which is the whole point of Phase 2.
 */
export function buildFeatureFocusView(
  graph: FeatureGraphInput,
  stack: readonly FocusNode[] = [],
  options: FeatureFocusOptions = {},
): FeatureFocusView {
  const focusGraph = toFocusGraph(graph)
  const current = stack.length === 0 ? null : stack[stack.length - 1]
  const cards = childrenOf(focusGraph, current)

  // Wires only between cards actually on screen — an edge to something one
  // level up would render as a line to nowhere.
  const present = new Set(cards.map((card) => card.id))
  const wires = graph.edges
    .filter((edge) => present.has(edge.from) && present.has(edge.to))
    .map((edge) => ({ from: edge.from, to: edge.to }))

  // WHAT ELSE IS ATTACHED TO THIS NODE THAT THE LEVEL CANNOT SHOW.
  //
  // Change records are deliberately off every ring (`RING_KINDS` in
  // `focus-stack.ts`), so a feature whose only attachments are changes drills
  // into a level with zero cards — indistinguishable, on screen, from a feature
  // nothing has ever touched. Counting them here is what lets the sentence tell
  // those two apart; it is read from `kind === 'child'`, never from "nodes that
  // aren't parts".
  const changeCount =
    current === null
      ? 0
      : graph.nodes.filter((node) => node.kind === 'child' && node.parent === current.id).length
  const empty =
    cards.length === 0
      ? emptyLevelState(current, graph.nodes.length, options.fetchFailure ?? null, changeCount)
      : null
  return {
    stack: [...stack],
    cards,
    wires,
    crumbs: crumbs(stack, FOCUS_ROOT_LABEL),
    emptyReason: empty?.text ?? null,
    empty,
  }
}

/**
 * WHAT AN EMPTY DRILLED LEVEL SAYS.
 *
 * A body click always drills now, so landing on an empty level is an ORDINARY
 * outcome rather than an error — most features claim no parts yet. It used to
 * be avoided by silently opening the feature view instead, which is what made
 * one gesture mean two things.
 *
 * So this message carries the whole weight: it names the node, states what is
 * absent IN THAT NODE'S OWN VOCABULARY (a domain is missing features, a feature
 * is missing parts), and points at the one control that reaches the other
 * surface. `${current.name} has no children` — what this replaced — did none of
 * those three.
 *
 * ONE WORD PER MEANING, EVERY SENTENCE HERE
 * ==========================================
 * A FEATURE is a capability, a PART is a piece of it, a CHANGE is a plan or an
 * issue that touched it. These strings are the last place the old two-word
 * vocabulary survived: "nothing recorded inside X" was said to features whose
 * changes the board simply refuses to draw, which reads as "nobody has ever
 * worked on this" about a capability with three plans against it. `changeCount`
 * exists for exactly that sentence — the absence is still parts, but the claim
 * of total silence is retracted when it is false.
 */
export function emptyLevelState(
  current: FocusNode | null,
  totalNodes: number,
  fetchFailure: string | null = null,
  changeCount = 0,
): EmptyLevel {
  // THE QUERY FAILED — SAY THAT, AND SAY IT FIRST.
  //
  // `runFeatures` returns `available: false` for a missing bundled CLI, a
  // 30-second timeout, a refusal line and unparseable output alike, and the
  // board used to collapse every one of them into an empty graph. Rendered as
  // "No features yet" that is a claim about the STORE made on the strength of
  // a reading that never happened — and once an action hangs off that
  // sentence, it invites a discovery run against a project that is already
  // full of features. A failure gets its own kind, its own words, and no
  // button.
  const failure = fetchFailure === null ? null : fetchFailure.trim()
  if (failure !== null && failure.length > 0) {
    return {
      kind: 'fetch-failed',
      text: `Couldn’t read this project’s features: ${failure}. That is not the same as having none — nothing was measured. Refresh to try again.`,
    }
  }
  if (current === null) {
    return totalNodes === 0
      ? // NOT `features seed`, which is what this used to name: seed ADOPTS
        // pre-existing markdown, so on the empty store this message describes
        // it reports "nothing to adopt" and the board stays exactly as blank.
        // Basic discovery is the gesture that actually mines the repo's
        // surfaces and writes the features. And it is named as a BUTTON, not
        // as a place to go: sending the reader to Settings for the one gesture
        // that repairs the screen they are looking at is a detour, and a CLI
        // verb is not an answer inside an IDE at all.
        {
          kind: 'no-features',
          text: 'No features yet — nothing here has been named as a capability. A basic discovery reads this project’s routes, tests and modules and names what it does.',
        }
      : { kind: 'level', text: 'No features at this level' }
  }
  if (current.kind === 'domain') {
    return {
      kind: 'domain',
      // GUIDANCE ONLY, DELIBERATELY. `domain:` is a human-owned frontmatter
      // key — no sweep may write it (that is the feature store's rule, not a
      // convention) — so there is no gesture this board could offer that would
      // fill a domain. Inventing a button here would be a fake action.
      text: `Nothing recorded inside ${current.name} yet · no features carry this domain. Grouping is yours to set: add \`domain: ${current.name}\` to a feature's frontmatter in flow/brain/features/.`,
    }
  }
  if (current.kind === 'part') {
    // REACHABLE, AND SAYING WHERE TO GO. A part's body click opens its level
    // rather than drilling, so this is what a caller lands on if it drills one
    // anyway — and the level it points at is now a real place (Phase 3): the
    // part's component in its feature's drawing, or the files it names, with
    // its own anchors and its own learnings beside them. This comment used to
    // claim the branch was unreachable, which stopped being true the moment
    // `resolveLevel` learned to answer for a part.
    //
    // Stated in the part's own vocabulary rather than left to the feature
    // wording below, which would promise parts a leaf can never have.
    return {
      kind: 'part',
      text: `${current.name} is a single artifact — there is nothing inside it. Open the level (the ${LEVEL_CONTROL_GLYPH} mark) to see its place in the feature’s drawing, the files it names, and what has been learned about it.`,
    }
  }
  if (current.kind === 'change') {
    // Also unreachable — a change is off every ring, so nothing can focus one —
    // and stated for the same reason as the `part` branch above: if a change
    // ever did reach this function, the fall-through below would tell the
    // reader a PLAN is missing its parts, which is the precise sentence this
    // phase set out to make impossible. No new `EmptyLevelKind`: an action
    // hangs off the kind, and there is no action for a record of past work.
    return {
      kind: 'level',
      text: `${current.name} is a change — a plan or issue that touched this feature, not a piece of it. Its record lives in the feature brief, not on the board.`,
    }
  }
  // A FEATURE WITH CHANGES IS NOT AN UNTOUCHED FEATURE. Changes never render on
  // a ring, so this level is blank either way — but "nothing recorded inside
  // Chats yet" said out loud to a capability with three plans against it is
  // false, and it is the exact confusion this phase exists to end. Same kind,
  // same repair, different claim.
  if (changeCount > 0) {
    const changes = `${changeCount} change${changeCount === 1 ? '' : 's'}`
    return {
      kind: 'feature',
      text: `No parts recorded inside ${current.name} yet · ${changes} (plans or issues) touched it, and a change is never drawn on the board. Open the level (the ${LEVEL_CONTROL_GLYPH} mark) to see what the code map resolves.`,
    }
  }
  return {
    kind: 'feature',
    text: `Nothing recorded inside ${current.name} yet · no parts have been learned. Open the level (the ${LEVEL_CONTROL_GLYPH} mark) to see what the code map resolves.`,
  }
}

/** The text alone — kept because that is all most callers ever wanted. */
export function emptyLevelReason(
  current: FocusNode | null,
  totalNodes: number,
  fetchFailure: string | null = null,
  changeCount = 0,
): string {
  return emptyLevelState(current, totalNodes, fetchFailure, changeCount).text
}

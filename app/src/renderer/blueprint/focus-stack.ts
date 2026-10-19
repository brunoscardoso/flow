/**
 * Focus stack (feature-blueprint, Phase 2) — PURE, no DOM.
 *
 * `blueprint-board.ts` used to hold `#featureFocus: string | null` — a SINGLE
 * value, which is why the board stopped at two levels (see the now-superseded
 * "TWO LEVELS ONLY" note in `feature-view-model.ts`). This module replaces that
 * one value with a STACK plus one rule, `childrenOf(node)`, so depth follows the
 * data instead of a constant. The centre of the board holds the current focus
 * (the top of the stack); popping is clicking it.
 *
 * THREE WORDS, ONE MEANING EACH
 * ==============================
 * A FEATURE is a capability. A PART is a piece of that capability. A CHANGE is
 * a plan or an issue that once touched it. Every count, kicker and label in this
 * file spends each word on exactly one of those — the reported symptom ("I don't
 * know what the name of that is") was two concepts sharing the word "part".
 *
 * THREE KINDS ON THE RING, ONE RULE
 * ==================================
 * `domain` groups `feature`s, `feature`s group `part`s, `part`s are leaves.
 * `childrenOf` is the single place that rule lives — callers never re-derive it.
 *
 * AND A FOURTH KIND THAT IS NEVER ON IT
 * ======================================
 * `change` is a plan or an issue that once touched a feature. It is in this
 * graph for ONE reason: ancestry. A change record has a parent feature, and
 * things that walk upwards through the graph — the in-flight learning rollup,
 * for one — need that link to exist. It is not a ring member at any depth, it
 * has no children, and it is not something a reader navigates INTO. Its own
 * surface is the feature brief's `Changes:` line, which reads the brief, not
 * this graph.
 *
 * That distinction is the bug this file was carrying: a change record used to
 * enter the graph as a `part`, so drilling into Chats showed two plan names
 * under the kicker "2 parts" while its ten real parts were nowhere. The single
 * place the exclusion lives is `directChildren` below, so ring membership and
 * the kicker's count cannot disagree about what a feature contains.
 *
 * NO DOMAIN DATA YET → FEATURES ARE THE ROOT
 * ===========================================
 * Domains are a human-owned field landing in Phase 3. Until a graph actually
 * contains a `domain`-kind node, `childrenOf(null)` falls back to showing
 * `feature`-kind roots directly — the root level is never emptied by a layer
 * that has no data in it yet.
 *
 * WHAT GATES A DIVE IS THE KIND, NOT THE COUNT
 * =============================================
 * This module used to refuse to push a node with zero children ("empty nodes
 * are not drillable"), and the board turned that refusal into "open the feature
 * view instead". The result was ONE gesture with TWO outcomes, chosen by data
 * the reader cannot see: most features currently claim no parts, so a body
 * click usually opened a view and occasionally drilled. That is the bug.
 *
 * The rule now: a body click ALWAYS drills, and the only node that cannot be
 * drilled into is one that cannot HAVE children at all — a `part`, which is a
 * leaf by definition (a single artifact). That is what `canDrill` says, and it
 * is a function of `kind` alone, so it never changes as the store fills up.
 *
 * `drillable` survives as what it always described — "there is something in
 * there" — and it is a LABEL, not a gate: nothing branches navigation on it.
 * Drilling into a feature with no parts is legal and lands on a level that says
 * what is missing (`buildFeatureFocusView`'s `emptyReason`); it must never fall
 * back into the feature view, which is a different surface reached by the
 * per-node control.
 *
 * PURE STACK: DATA IN, DATA OUT
 * ==============================
 * `push` / `pop` / `popTo` never mutate the stack they are given — each returns
 * a new array. The caller (the board) owns the actual `FocusNode[]` state.
 */

/**
 * The node kinds the focus graph carries.
 *
 * Three of them are navigable — `domain` → `feature` → `part`. `change` is
 * carried but never shown: see "AND A FOURTH KIND" in the module header.
 */
export type FocusNodeKind = 'domain' | 'feature' | 'part' | 'change'

/**
 * The kinds a level is built from. A `change` is deliberately absent — this set
 * is what keeps it off every ring at every depth, and it is consulted in
 * exactly one place (`directChildren`).
 */
const RING_KINDS: ReadonlySet<FocusNodeKind> = new Set<FocusNodeKind>(['domain', 'feature', 'part'])

/** The kinds that can CONTAIN something — what gates a dive. */
const CONTAINER_KINDS: ReadonlySet<FocusNodeKind> = new Set<FocusNodeKind>(['domain', 'feature'])

/** One node as a caller supplies it, before its kicker/drillable are computed. */
export interface FocusGraphNode {
  kind: FocusNodeKind
  id: string
  name: string
  /**
   * Parent id: a domain id for a `feature`, a feature id for a `part`. Absent
   * for a domain, or a feature with no domain (the root-level fallback above).
   */
  parent?: string
}

/** The flat graph `childrenOf` walks — mirrors `FeatureGraphInput`'s shape. */
export interface FocusGraphInput {
  nodes: FocusGraphNode[]
}

/** One node as the board renders it, at whatever depth it appears. */
export interface FocusNode {
  kind: FocusNodeKind
  id: string
  name: string
  /**
   * Secondary line depth shows — e.g. "7 features" under a domain, "3 parts"
   * under a feature. EMPTY when there is nothing worth a line (see `kickerFor`),
   * which is a deliberate answer and not a missing one. It never counts
   * CHANGES: a plan that touched a feature is not a piece of it, and the count
   * a reader scans has to mean one thing.
   */
  kicker: string
  /**
   * True when drilling reveals children — a DESCRIPTION of what is inside, not
   * a permission. Never branch navigation on it (see the module header): a
   * false here means the drilled level will say what is missing, not that the
   * click means something else.
   */
  drillable: boolean
  /**
   * True when this node's KIND can contain children at all — everything except
   * a `part`. THIS is what gates a dive, and it depends on nothing that changes
   * as the store fills up, which is exactly why the gesture is now stable.
   */
  canDrill: boolean
  childCount: number
}

/** One entry of the breadcrumb trail. `id === null` is the root. */
export interface FocusCrumb {
  id: string | null
  name: string
  current: boolean
}

/**
 * The children of `parentId` THAT A LEVEL IS MADE OF.
 *
 * The `RING_KINDS` test is the whole of the parts/changes fix, and it lives
 * here rather than at the call sites for a reason: this function feeds BOTH the
 * cards a level renders and the `childCount` its kicker reports. Filtering in
 * one of those two places and not the other is how a ring of ten parts would
 * end up labelled "12 parts".
 */
function directChildren(graph: FocusGraphInput, parentId: string): FocusGraphNode[] {
  return graph.nodes.filter((node) => node.parent === parentId && RING_KINDS.has(node.kind))
}

/**
 * What the depth-appropriate kicker says — or NOTHING, which is a real answer.
 *
 * A domain counts the FEATURES under it; a feature counts its PARTS; a part is
 * a leaf whose explanation lives in the brief, so it carries no count. A CHANGE
 * carries none either — and could not be counted here even if it wanted to be,
 * because `childCount` comes from `directChildren`, which admits ring kinds
 * only. The words are not interchangeable: "10 parts" under Chats means ten
 * pieces of the capability, never the two plans that rewrote it.
 *
 * THE EMPTY KICKER (the "no code claimed" nineteen times problem)
 * ===============================================================
 * A feature with no parts used to say "no code claimed". On a real board that
 * rendered the SAME sentence under 16 of 19 nodes — a line repeated on nearly
 * every node is not information, it is texture, and it drowned the three
 * kickers that WERE saying something ("2 parts", "1 part"). Those counts are
 * the thing a reader is actually scanning for.
 *
 * So a kicker now renders only when it carries information, and the empty
 * string is how this function says "there is nothing worth a line here".
 *
 * THE STATE IS NOT LOST — it is reported in three places that are about
 * exactly that question, none of which is a per-node repetition:
 *   1. the node's own emptiness is VISIBLE without words: a node with children
 *      is drawn as a container, so "has something inside"
 *      reads at rest, at a glance, at both label densities;
 *   2. drilling in says it in full, naming the node (`emptyLevelReason`);
 *   3. the board's limitations disclosure and the root note already count
 *      unclaimed features in aggregate.
 * A reader can therefore still discover the state from the map — which is the
 * condition for removing the words at all.
 */
/**
 * What a kind COUNTS, in the singular — `null` for a kind that counts nothing.
 *
 * A `Record<FocusNodeKind, …>` rather than a chain of `if`s, for the same
 * reason `FOCUS_KIND` in `feature-view-model.ts` is a map: the bug this phase
 * fixed was a fall-through branch answering for a kind nobody had thought
 * about. Here the compiler makes a new kind state its own noun — or state
 * `null` — before it can exist.
 */
const KICKER_NOUN: Readonly<Record<FocusNodeKind, string | null>> = {
  domain: 'feature',
  feature: 'part',
  // A leaf. Its explanation is the brief, not a count.
  part: null,
  // Never on a ring, so never a card that could carry a line — and if one ever
  // were drawn, "0 parts" is the one thing it must not say.
  change: null,
}

function kickerFor(kind: FocusNodeKind, childCount: number): string {
  const noun = KICKER_NOUN[kind]
  if (noun === null || childCount <= 0) return ''
  return `${childCount} ${noun}${childCount === 1 ? '' : 's'}`
}

function toFocusNode(graph: FocusGraphInput, raw: FocusGraphNode): FocusNode {
  const childCount = CONTAINER_KINDS.has(raw.kind) ? directChildren(graph, raw.id).length : 0
  return {
    kind: raw.kind,
    id: raw.id,
    name: raw.name,
    kicker: kickerFor(raw.kind, childCount),
    drillable: childCount > 0,
    // A `part` IS the single artifact — there is nothing under it to enter, so
    // its body click opens its level instead of drilling. Stated as a positive
    // list of the kinds that CAN contain something, so a kind added later has
    // to be admitted deliberately rather than inheriting drillability from a
    // negation it was never considered by. That negation is precisely what let
    // a change record be treated as a part.
    canDrill: CONTAINER_KINDS.has(raw.kind),
    childCount,
  }
}

/**
 * The single rule depth follows.
 *
 * `node === null` is the root: domains if the graph has any, otherwise
 * feature-kind roots directly (see the module header). A domain's children are
 * its features; a feature's are its parts; a part's are always `[]`.
 */
export function childrenOf(graph: FocusGraphInput, node: FocusNode | null): FocusNode[] {
  if (node === null) {
    const domains = graph.nodes.filter((n) => n.kind === 'domain')
    const raw = domains.length > 0 ? domains : graph.nodes.filter((n) => n.kind === 'feature' && n.parent === undefined)
    return raw.map((n) => toFocusNode(graph, n))
  }
  if (node.kind === 'part') return []
  return directChildren(graph, node.id).map((n) => toFocusNode(graph, n))
}

/**
 * Push a node onto the stack — becomes the new focus (the board's centre).
 *
 * No-ops ONLY for a node that cannot have children at all (`canDrill: false`,
 * i.e. a `part`). A childless domain or feature pushes fine and lands on a
 * level that names what is missing — refusing it here is what used to make one
 * gesture mean two things.
 */
export function push(stack: readonly FocusNode[], node: FocusNode): FocusNode[] {
  if (!node.canDrill) return [...stack]
  return [...stack, node]
}

/**
 * The path from the root down to `targetId`, or null when this graph does not
 * contain it.
 *
 * `stack` is the focus stack that puts `targetId` ON THE RING (i.e. the trail
 * of its ancestors, NOT including the target); `nodeId` is the target itself.
 * A caller that wants to reveal a node — the brain query's result rows do —
 * needs exactly that pair, and computing it by hand from `parent` links would
 * be a second copy of the layering rule `childrenOf` already owns. So this
 * WALKS `childrenOf` instead: whatever that function says the levels are, this
 * agrees with by construction.
 *
 * Cycle-safe: a hand-edited store can contain a `parent` loop, and a board that
 * hangs on one is worse than a board that cannot find the node.
 */
export function focusPathTo(
  graph: FocusGraphInput,
  targetId: string,
): { stack: FocusNode[]; nodeId: string } | null {
  const seen = new Set<string>()
  const walk = (
    parent: FocusNode | null,
    trail: readonly FocusNode[],
  ): { stack: FocusNode[]; nodeId: string } | null => {
    for (const child of childrenOf(graph, parent)) {
      if (child.id === targetId) return { stack: [...trail], nodeId: child.id }
      if (seen.has(child.id)) continue
      seen.add(child.id)
      const deeper = walk(child, [...trail, child])
      if (deeper !== null) return deeper
    }
    return null
  }
  return walk(null, [])
}

/** Pop the current focus, returning to its parent. No-ops at the root. */
export function pop(stack: readonly FocusNode[]): FocusNode[] {
  if (stack.length === 0) return [...stack]
  return stack.slice(0, -1)
}

/**
 * Jump straight to a depth — what clicking a breadcrumb does in one
 * transition instead of N pops. `depth` counts stack entries: 0 is the root.
 *
 * No-ops for an out-of-range depth (negative, or deeper than the current
 * stack) rather than clamping — a caller asking for a depth that does not
 * exist is a bug to surface, not silently correct.
 */
export function popTo(stack: readonly FocusNode[], depth: number): FocusNode[] {
  if (!Number.isInteger(depth) || depth < 0 || depth > stack.length) return [...stack]
  return stack.slice(0, depth)
}

/* ── DEPTH IS WHAT THE ARROWS DRIVE ─────────────────────────────────────────
 *
 * The board had two competing ideas of "back": the header's `‹ ›` (tab history
 * — which feature brief you were reading) and the feature map's own depth
 * (click a crumb, or the parent crumb). On the feature map those arrows now
 * mean DEPTH, because depth is the only thing that moves there.
 *
 * ONE SOURCE OF TRUTH, THREE ENTRANCES
 * ====================================
 * The arrows, the centre and the breadcrumbs all reduce to the functions
 * below — `depthPop` is what all three call. A second copy of "what back means"
 * living in a click handler is exactly how the three fell out of agreement in
 * the first place.
 *
 * WHY A FORWARD STACK, AND WHEN IT DIES
 * =====================================
 * Forward can only mean "re-enter the level I just left", so it holds the
 * levels a pop removed, SHALLOWEST FIRST. Diving somewhere new invalidates it —
 * with one exception: diving into exactly the level Forward was offering is the
 * same journey, so the rest of the trail survives. Without that exception an
 * arrow round-trip would quietly amputate the branch you came from.
 */

/** Where depth navigation is, and where it can go back to. */
export interface DepthNavState {
  stack: FocusNode[]
  /** Levels popped and not yet re-entered, SHALLOWEST FIRST. */
  forward: FocusNode[]
}

/** What the two arrows say and whether they can be pressed. */
export interface DepthNavLabels {
  backEnabled: boolean
  backTitle: string
  forwardEnabled: boolean
  forwardTitle: string
}

/** Dive into `node`. Clears the forward trail unless this IS its next step. */
export function depthDive(state: DepthNavState, node: FocusNode): DepthNavState {
  const stack = push(state.stack, node)
  if (stack.length === state.stack.length) return { stack, forward: [...state.forward] } // a leaf — no move
  const next = state.forward[0]
  return {
    stack,
    forward: next !== undefined && next.id === node.id ? state.forward.slice(1) : [],
  }
}

/** Pop one level. The level left becomes the head of the forward trail. */
export function depthPop(state: DepthNavState): DepthNavState {
  return depthPopTo(state, Math.max(0, state.stack.length - 1))
}

/**
 * Jump to `depth` — the breadcrumb's move, and a multi-level Back. Every level
 * it removes joins the forward trail in order, so Forward walks back down the
 * way you came rather than teleporting to the bottom.
 */
export function depthPopTo(state: DepthNavState, depth: number): DepthNavState {
  const stack = popTo(state.stack, depth)
  if (stack.length === state.stack.length) return { stack, forward: [...state.forward] }
  return { stack, forward: [...state.stack.slice(stack.length), ...state.forward] }
}

/**
 * Land on an arbitrary depth path — what "take me to this search result" needs.
 *
 * COMPOSED, NOT FORKED. It is `depthPopTo(0)` followed by one `depthDive` per
 * step, so a jump obeys exactly the same rules as walking there by hand: the
 * same push gate, the same forward-trail semantics, the same crumbs. A bespoke
 * `stack = path` assignment would be the second definition of "where you are"
 * that this module exists to prevent.
 */
export function depthGoTo(state: DepthNavState, path: readonly FocusNode[]): DepthNavState {
  return path.reduce<DepthNavState>((acc, node) => depthDive(acc, node), depthPopTo(state, 0))
}

/** Re-enter the level Back last left. No-op with nothing to re-enter. */
export function depthForward(state: DepthNavState): DepthNavState {
  const next = state.forward[0]
  if (next === undefined) return { stack: [...state.stack], forward: [] }
  return { stack: [...state.stack, next], forward: state.forward.slice(1) }
}

/**
 * What the arrows say HERE — never a bare "Back"/"Forward". An arrow that names
 * its destination is the difference between a control you trust and one you
 * press to find out.
 */
export function depthNavLabels(state: DepthNavState, rootLabel: string): DepthNavLabels {
  const parent = state.stack[state.stack.length - 2]
  const next = state.forward[0]
  return {
    backEnabled: state.stack.length > 0,
    backTitle:
      state.stack.length === 0
        ? `Already at ${rootLabel}`
        : `Back out to ${parent?.name ?? rootLabel}`,
    forwardEnabled: next !== undefined,
    forwardTitle: next === undefined ? 'Nothing to go forward into' : `Forward into ${next.name}`,
  }
}

/**
 * The trail from the root to the current focus — always includes the root, so
 * there is always a way back out. The last entry (or the root, at depth 0) is
 * marked `current`.
 */
export function crumbs(stack: readonly FocusNode[], rootLabel: string): FocusCrumb[] {
  const trail: FocusCrumb[] = [{ id: null, name: rootLabel, current: stack.length === 0 }]
  stack.forEach((node, index) => {
    trail.push({ id: node.id, name: node.name, current: index === stack.length - 1 })
  })
  return trail
}

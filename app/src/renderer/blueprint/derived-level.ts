/**
 * THE DERIVED LEVEL — PURE, no DOM.
 *
 * WHY THIS EXISTS
 * ===============
 * Measured on this repo: `feature-views/` holds ONE artifact and it fails the
 * validator, so `readFeatureView` returns null for every feature. Phase 5's
 * resolution therefore answers `derived` almost everywhere, and until now that
 * verdict carried `derived: null` — a door that opened onto nothing.
 *
 * There is material, though. A feature's parts resolve to components of the
 * code map, and the code map records how those components are actually wired
 * (`contains`, `imports`, `uses`, `exposes`, `calls` — 344 such edges here).
 * That is a real picture. It is just a DIFFERENT picture from a curated view,
 * and the whole value of showing it depends on never letting the two be
 * confused:
 *
 *   a curated view says WHAT THE FEATURE DOES — authored components, human
 *   titles, labelled flows;
 *   a derived level says HOW THE CODE CONNECTS — nothing more, and it says so
 *   out loud in its own kicker and summary.
 *
 * IT WAS NEVER VALIDATED, AND IT NEVER CLAIMS TO BE (Task 6.5)
 * ===========================================================
 * `validateFeatureView` runs at WRITE time on an artifact the CLI generated.
 * Nothing here is written and nothing here is validated, so this module's
 * output carries `validated: false` as a literal type and a `provenance` of
 * `derived` — never a plan name, never a generation date. The prototype had
 * exactly this bug in reverse: it rendered "fails the real validator" on a
 * synthesised level no validator had ever seen. A level cannot pass or fail a
 * check that was never run on it.
 *
 * THREE MEASURED FACTS SHAPE THE REST
 * ===================================
 * 1. PARALLEL RELATIONS OVERPRINT. Of 206 directed pairs in this repo's code
 *    map, 120 carry more than one relation — two modules routinely both
 *    `import` and `call` each other. As separate edges they produce identical
 *    geometry, so `curated-view`'s layout puts both labels at the same
 *    midpoint and they print through one another (observed in the prototype as
 *    the literal string `icallss`). They are merged per DIRECTED pair into one
 *    edge labelled `imports · calls`. Directed, not undirected: a reverse edge
 *    already routes under the row, so it has its own geometry and its own
 *    meaning — collapsing it would throw away the direction to fix a collision
 *    that is not there.
 * 2. STRUCTURAL EDGES DO NOT SURVIVE AGGREGATION. Within one feature they read
 *    (17 edges over 9 parts); across features they form a near-complete graph
 *    that says nothing (86 over 10). So pairs are weighted by how many code
 *    edges back them and pruned to a cap.
 * 3. AND A CAP MUST REPORT WHAT IT HID. Silent truncation is a hard rule in
 *    this repo, so what the cap removed is counted, carried on the result, and
 *    written into the level's own summary where the reader meets it.
 */
import type { BriefNodeKind } from './brief-view-model'
import type { CuratedEdge, CuratedLevel, CuratedNode, CuratedView } from './curated-view'

/**
 * Component kinds, mirroring the CLI's FROZEN `VIEW_NODE_KINDS`
 * (`src/cli/blueprint/feature-view.ts`). Mirrored rather than imported for the
 * same reason `curated-view.ts` mirrors the artifact shape: the CLI owns and
 * validates the contract, and the renderer is a separate compilation unit.
 *
 * NOT EXTENDED. A derived level maps whatever the code map calls a node onto
 * one of these six; a kind the frozen list does not have becomes `module`,
 * which is what an unclassified piece of code is.
 */
export const DERIVED_NODE_KINDS = [
  'project',
  'endpoint',
  'integration',
  'datastore',
  'function',
  'module',
] as const
export type DerivedNodeKind = (typeof DERIVED_NODE_KINDS)[number]

/**
 * How many connections a derived level draws.
 *
 * Measured, not guessed: 17 connections over 9 components is readable, and 86
 * over 10 is a grey mat. The cap sits above the readable measurement so the
 * case that works keeps working untouched, and far below the one that does
 * not. Whatever it removes is reported.
 */
export const DERIVED_EDGE_CAP = 20

/** How merged relations read on one wire — the code map's own words, joined. */
export const RELATION_SEPARATOR = ' · '

/** One component of the code map, as the brief resolved it. */
export interface StructuralComponent {
  id: string
  /** Human label, when the brief has one. Falls back to the id's last segment. */
  label?: string
  /** The code map's own kind. Anything unrecognised becomes `module`. */
  kind?: string
  /**
   * WHAT THE BRIEF SAYS ABOUT THIS COMPONENT'S TWO WORLDS. Defaults to
   * `stable`, which is what the code map alone can ever say.
   *
   * The code map only knows about things that EXIST, so on its own every
   * derived component is stable. The brief knows more: a live proposal
   * predicts a component nothing has built, and the CLI folds it into the
   * brief's nodes as `new`. Dropping that here painted the predicted card
   * exactly like an observed one — no badge in After, and no second world for
   * the time switch to offer (found by the Phase 10 e2e).
   */
  delta?: BriefNodeKind
}

/** One code-map edge. `relation` is the map's own vocabulary, unmapped. */
export interface StructuralRelation {
  source: string
  target: string
  relation: string
}

/** The material a derived level is built from. */
export interface DerivedStructure {
  /** The components the level is about, in the order the brief resolved them. */
  components: readonly StructuralComponent[]
  /** Every code-map edge; scoped to `components` here. */
  edges: readonly StructuralRelation[]
  /** Override the connection cap. Omit for `DERIVED_EDGE_CAP`. */
  cap?: number
  /**
   * Connections a DOCUMENT declared between the components — a discovery's
   * `flow_after`, via the brief's wires. The code map cannot have them: the
   * components they join mostly do not exist yet. Drawn as `added`, never as
   * code; a pair the code map already connects keeps the code edge.
   */
  declared?: readonly { from: string; to: string; label: string }[]
}

/** One merged connection between two components. */
export interface DerivedWire {
  from: string
  to: string
  /** Every relation backing this pair, in the code map's own order. */
  relations: string[]
  /** Those relations, joined — what the wire says on the canvas. */
  label: string
  /** How many code edges back this pair. Drives the prune order. */
  weight: number
}

/** What the cap removed. Reported, never silent. */
export interface DerivedHidden {
  /** Merged connections dropped by the cap. */
  pairs: number
  /** Code edges behind those connections. */
  relations: number
}

export interface DerivedLevel {
  /**
   * Artifact-SHAPED, so the curated pipeline (`curated-view`, `curated-chrome`,
   * `curated-drawer`, `curated-nav`) draws it with no changes at all. Shaped
   * like one, never claiming to BE one: `provenance` is `derived` and
   * `generatedAt` is empty, because nothing generated it.
   */
  view: CuratedView
  /** The root level of that view — what the stage draws. */
  level: CuratedLevel
  /** The connections drawn, after merge and prune, in draw order. */
  wires: DerivedWire[]
  /** Components drawn. */
  componentCount: number
  /** Merged connections before the cap. */
  totalPairs: number
  /** What the cap hid. */
  hidden: DerivedHidden
  /** Code edges backing the connections that survived. */
  backingEdges: number
  /** The cap actually applied. */
  cap: number
  /** The sentence the reader meets above the diagram. Also `level.summary`. */
  notice: string
  /** Never a plan name. This came from the code map. */
  provenance: 'derived'
  /**
   * ALWAYS FALSE, as a literal type (Task 6.5). No validator has ever seen
   * this level, so no surface may render a validator verdict for it — neither
   * "valid" nor "fails".
   */
  validated: false
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`
}

/**
 * Map a code-map kind onto the frozen six.
 *
 * The map's own kinds (`module`, `endpoint`, `integration`, `datastore`,
 * `project`) are already five of the six, so this is a narrowing, not a
 * translation. When the map says nothing, the id's prefix does — ids are
 * `<kind>:<path>` by the extractor grammar — and when neither does, the answer
 * is `module`.
 */
export function derivedNodeKind(id: string, kind?: string): DerivedNodeKind {
  const known = new Set<string>(DERIVED_NODE_KINDS)
  const given = (kind ?? '').trim()
  if (known.has(given)) return given as DerivedNodeKind
  const colon = id.indexOf(':')
  const prefix = colon > 0 ? id.slice(0, colon) : ''
  if (known.has(prefix)) return prefix as DerivedNodeKind
  return 'module'
}

/**
 * What a component is CALLED when the brief gave it no label.
 *
 * The id's last segment, which is the directory or route the extractor named
 * it after. Never blank: a card with no title is unreadable, and the id itself
 * beats nothing.
 */
export function derivedTitle(id: string, label?: string): string {
  const given = (label ?? '').trim()
  if (given.length > 0) return given
  const colon = id.indexOf(':')
  const path = colon > 0 ? id.slice(colon + 1) : id
  const slash = path.lastIndexOf('/')
  const tail = slash >= 0 ? path.slice(slash + 1) : path
  return tail.trim().length > 0 ? tail.trim() : id
}

/**
 * Merge parallel relations per directed pair (Task 6.2).
 *
 * Only edges with BOTH ends among the components survive — the same rule
 * `brief-scope` already applies, and for the same reason: a wire to something
 * off screen asserts a relationship the reader cannot check. Self-edges are
 * dropped too; `curated-view`'s layering already ignores them and the geometry
 * for one is a degenerate path.
 *
 * Order is the code map's own: pairs in first-seen order, relations within a
 * pair in first-seen order. Deterministic for a given graph, which is what
 * lets the same feature draw the same picture twice.
 */
export function mergeStructuralEdges(
  components: readonly StructuralComponent[],
  edges: readonly StructuralRelation[],
): DerivedWire[] {
  const present = new Set(components.map((component) => component.id))
  const byPair = new Map<string, DerivedWire>()
  for (const edge of edges) {
    const from = edge.source
    const to = edge.target
    if (from === to || !present.has(from) || !present.has(to)) continue
    const relation = edge.relation.trim()
    if (relation.length === 0) continue
    const key = `${from}\u0000${to}`
    const existing = byPair.get(key)
    if (existing === undefined) {
      byPair.set(key, { from, to, relations: [relation], label: relation, weight: 1 })
      continue
    }
    // WEIGHT COUNTS EDGES, NOT DISTINCT RELATIONS. Two `imports` between the
    // same pair are two facts about how tightly they are coupled, and that is
    // exactly what the prune order is asking about.
    existing.weight += 1
    if (!existing.relations.includes(relation)) {
      existing.relations.push(relation)
      existing.label = existing.relations.join(RELATION_SEPARATOR)
    }
  }
  return [...byPair.values()]
}

/**
 * Weight, prune, and say what was hidden (Task 6.3).
 *
 * Heaviest pairs first — the connections most backed by real code — with the
 * ids as a tiebreak so a tie never reshuffles between renders. A cap of zero
 * or less is refused rather than obeyed: a level with every wire removed and a
 * note saying so is worse than one that simply obeys its documented default.
 */
export function pruneWires(
  wires: readonly DerivedWire[],
  cap: number = DERIVED_EDGE_CAP,
): { kept: DerivedWire[]; hidden: DerivedHidden } {
  const limit = Number.isInteger(cap) && cap > 0 ? cap : DERIVED_EDGE_CAP
  const ranked = [...wires].sort(
    (a, b) => b.weight - a.weight || a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
  )
  const kept = ranked.slice(0, limit)
  const dropped = ranked.slice(limit)
  return {
    kept,
    hidden: {
      pairs: dropped.length,
      relations: dropped.reduce((sum, wire) => sum + wire.weight, 0),
    },
  }
}

/**
 * The sentence above the diagram.
 *
 * Three claims, in this order: where this came from, what it is NOT, and what
 * the cap removed. The middle one is the point — a diagram of real components
 * with real wires looks exactly like a curated view, and only the words stop a
 * reader taking it for one.
 */
function derivedNotice(
  componentCount: number,
  shown: number,
  totalPairs: number,
  hidden: DerivedHidden,
  declared = 0,
): string {
  // A DECLARED CONNECTION IS NOT A CODE CONNECTION, and the count says which
  // is which: "wired by 0 connections" over a picture with four arrows on it
  // would contradict the picture.
  const predicted =
    declared === 0 ? '' : `, plus ${plural(declared, 'predicted connection')} the document declares`
  const head =
    `Derived from the code map: ${plural(componentCount, 'component')} ` +
    `wired by ${plural(shown, 'connection')}${predicted}.`
  const what =
    'This is how the code connects — not what the feature does. No curated view ' +
    'has been generated for it, and nothing here was validated.'
  if (hidden.pairs === 0) return `${head} ${what}`
  const cut =
    `${plural(hidden.pairs, 'weaker connection')} hidden to keep it readable ` +
    `(${String(shown)} of ${String(totalPairs)} shown, ` +
    `${plural(hidden.relations, 'code edge')} behind the hidden ones).`
  return `${head} ${what} ${cut}`
}

/**
 * Build a derived level for one node (Task 6.1).
 *
 * Returns null when there are no components — there is nothing to draw, and
 * that case is the `empty` verdict's, which says WHY rather than showing a
 * blank stage.
 *
 * Every CONNECTION is `kept`: the code map records edges between things that
 * exist, and a derived level invents no others. A component's delta is the
 * caller's to supply and defaults to `stable` — the code map's own answer —
 * because a brief can know something the map cannot: that a live proposal
 * predicts a component nothing has built yet. A level of nothing but stable
 * components and kept wires makes `curatedHasDelta` false, so the stage offers
 * no Today ⇄ After switch between two identical pictures; one predicted
 * component is a real second world, and then it does.
 */
export function buildDerivedLevel(
  target: { id: string; name: string },
  structure: DerivedStructure,
): DerivedLevel | null {
  const seen = new Set<string>()
  const components: StructuralComponent[] = []
  for (const component of structure.components) {
    const id = component.id.trim()
    // A REPEATED ID would give the layout two cards under one key and the
    // contract a duplicate component. Keep the first, which is the order the
    // brief resolved them in.
    if (id.length === 0 || seen.has(id)) continue
    seen.add(id)
    components.push({ ...component, id })
  }
  if (components.length === 0) return null

  const merged = mergeStructuralEdges(components, structure.edges)
  const cap = Number.isInteger(structure.cap ?? NaN) && (structure.cap ?? 0) > 0
    ? (structure.cap ?? DERIVED_EDGE_CAP)
    : DERIVED_EDGE_CAP
  const { kept, hidden } = pruneWires(merged, cap)

  const nodes: CuratedNode[] = components.map((component) => ({
    id: component.id,
    kind: derivedNodeKind(component.id, component.kind),
    title: derivedTitle(component.id, component.label),
    // CARRIED, NEVER INVENTED. `stable` when the caller says nothing — the
    // code map's own answer — and the brief's word when it has one.
    delta: component.delta ?? 'stable',
  }))
  const edges: CuratedEdge[] = kept.map((wire) => ({
    from: wire.from,
    to: wire.to,
    label: wire.label,
    delta: 'kept',
  }))
  const connected = new Set(edges.flatMap((edge) => [`${edge.from}→${edge.to}`, `${edge.to}→${edge.from}`]))
  let declaredCount = 0
  for (const wire of structure.declared ?? []) {
    if (!seen.has(wire.from) || !seen.has(wire.to) || wire.from === wire.to) continue
    if (connected.has(`${wire.from}→${wire.to}`)) continue
    connected.add(`${wire.from}→${wire.to}`)
    connected.add(`${wire.to}→${wire.from}`)
    edges.push({ from: wire.from, to: wire.to, label: wire.label, delta: 'added' })
    declaredCount += 1
  }

  const notice = derivedNotice(components.length, kept.length, merged.length, hidden, declaredCount)
  const level: CuratedLevel = {
    title: target.name.trim().length > 0 ? target.name.trim() : target.id,
    // THE DERIVED BAND IS ITS OWN THING (Task 6.4). It rides in the kicker and
    // the summary, which `curated-chrome` reads straight off the artifact —
    // NOT in `brief.problem`, which would put this under a heading reading
    // `KNOWN ISSUE`. There is no known issue here; there is a different kind
    // of picture, and borrowing the problem band to say so would manufacture
    // the exact claim `curated-chrome`'s never-synthesise rule exists to stop.
    kicker: 'Derived · built from the code map, not a curated view',
    summary: notice,
    nodes,
    edges,
  }

  const view: CuratedView = {
    feature: target.id,
    // NEVER A PLAN NAME. `curated-nav` and the brief bar print provenance, and
    // `plan_x_v1` on a level no plan produced would be a fabricated citation.
    provenance: 'derived',
    // NOTHING GENERATED THIS. The curated branch prints "generated <date>";
    // an empty string is what there is to say here, and `resolveLevel` never
    // reaches that branch for a derived level anyway.
    generatedAt: '',
    meta: {
      title: target.name.trim().length > 0 ? target.name.trim() : target.id,
      sub: 'Derived level — the code map’s own wiring',
    },
    // DELIBERATELY EMPTY. `buildCuratedChrome` renders a band only when the
    // artifact supplies `problem` or `unchanged`, and a derived level supplies
    // neither — so no band is synthesised, and `authoredClaims` is 0 because
    // nothing here is authored.
    brief: {},
    views: { root: level },
  }

  return {
    view,
    level,
    wires: kept,
    componentCount: components.length,
    totalPairs: merged.length,
    hidden,
    backingEdges: kept.reduce((sum, wire) => sum + wire.weight, 0),
    cap,
    notice,
    provenance: 'derived',
    validated: false,
  }
}

/**
 * Is this level a derived one?
 *
 * One predicate, so no surface re-derives "is this curated?" from the shape of
 * an artifact and gets it wrong. A curated view's provenance names where it
 * came from (`plan:<name>`, `code`); only a derived level says `derived`.
 */
export function isDerivedView(view: CuratedView | null): boolean {
  return view !== null && view.provenance === 'derived'
}

/**
 * What a node's LEVEL is, and why —
 * PURE, no DOM, no IPC.
 *
 * THE ONE DOOR PROBLEM
 * ====================
 * A curated feature view has been reachable through exactly one entrance —
 * `showBrief`, fed by `blueprint:brief` — and only a feature could walk through
 * it. Phase 5 gives every node its own control, which means the board now has
 * to answer a question it never had to ask: *given this node, what is behind
 * the control?* That answer is a decision, not a render, so it lives here where
 * it can be tested rather than inside a 12,588-line board.
 *
 * THE ORDER IS FIXED (plan, Phase 5)
 * ==================================
 *   1. a CURATED view, when one exists and is usable;
 *   2. the DERIVED level, built from the node's own structure (Phase 6);
 *   3. an EMPTY state that says WHY there is nothing.
 *
 * Phase 6 filled the seam Phase 5 left: a `derived` verdict now carries the
 * level `derived-level.ts` built from the node's own components and the code
 * map's relations, alongside the count of the material it came from. The
 * DECISION did not move — this module still only chooses; the building lives
 * next door, and `derived` stays null whenever no structural material was
 * handed in (an older caller, or a node the code map does not cover).
 *
 * THE REASON IS NEVER BLANK (FR8)
 * ===============================
 * A blank panel and a missing artifact must not look alike. Every verdict —
 * including the two that DO render something — carries a specific sentence
 * naming the thing that is or is not there ("no curated view generated for
 * 'Chats'"). There is no code path that produces an empty reason; the tests
 * assert that for every branch.
 *
 * A PART RESOLVES AGAINST ITS OWNER (plan_feature-parts-as-nodes_v1, Phase 3)
 * ==========================================================================
 * A part now has a node on the ring and a control of its own, and the question
 * behind that control is the same one — but the material is not. There is no
 * brief for `feature:chats/sse-events-endpoint`; the CLI resolves features, and
 * a part lives INSIDE its owner's record. So the board fetches the OWNER's
 * brief and hands it here with `source.part` naming which part was opened.
 *
 * The ORDER IS THE SAME ORDER, one level down (`part-level.ts` builds each):
 *   1. `curated` — the part's own component in the owner's view, plus what it
 *      is wired to. A slice of a curated artifact is still curated.
 *   2. `derived` — the files the part names, when no component carries its
 *      name. Built from the part's own anchors, exactly as the plan fixes it.
 *   3. `empty` — neither, and the sentence is the CLI's OWN refusal
 *      (`partNoAnchorRefusal`) whenever the reason is that the part anchors
 *      nothing. That refusal was previously only ever seen by whoever read
 *      stderr.
 *
 * The built level travels on `resolution.part`, alongside `view`/`level` so
 * every existing reader of a curated resolution keeps working unchanged.
 *
 * FAIL-SOFT
 * =========
 * A domain, an unavailable brief, a view whose root level is missing or empty,
 * a `view` field that is not an object at all, a part that the owner's record
 * does not list — each resolves to a verdict with a sentence. Nothing here
 * throws.
 */

import { rootLevel, type CuratedLevel, type CuratedView } from './curated-view'
import { buildDerivedLevel, type DerivedLevel, type DerivedStructure } from './derived-level'
import type { FocusNodeKind } from './focus-stack'
import {
  buildPartLevel,
  findPartRecord,
  partEmptyReason,
  possessive,
  readPartRecords,
  type PartLevel,
} from './part-level'

/** The three things that can be behind a node's control. */
export type LevelVerdict = 'curated' | 'derived' | 'empty'

/** The node whose level was asked for, and where it was asked from. */
export interface LevelTarget {
  id: string
  kind: FocusNodeKind
  name: string
  /**
   * Focus-stack depth the control was pressed at. Carried through the
   * resolution as `returnDepth` so closing the level lands back exactly where
   * it was opened from — a level opened from depth 3 must not exit to the root.
   */
  depth?: number
}

/** What the store answered with — the brief result, narrowed to what decides. */
export interface LevelSource {
  /** The CLI's own availability flag. */
  available: boolean
  /** The CLI's own one-line reason when it refused. */
  reason?: string | null
  /** The curated artifact, exactly as IPC delivered it (UNVALIDATED here — the
   *  CLI validated it at write time; this module only checks it is usable). */
  view?: unknown
  /**
   * How many structural components the brief resolved for this node — the
   * material a derived level is built from. Zero means there is nothing to
   * derive, which is the difference between "not curated yet" and "nothing at
   * all", and the board must not render those two the same way.
   */
  structuralCount?: number
  /**
   * The material a DERIVED level is built from (Phase 6): the node's resolved
   * components plus the code map's own relation edges.
   *
   * Optional on purpose. A caller that supplies none still gets the `derived`
   * verdict from `structuralCount` — it simply gets no payload with it, which
   * is the pre-Phase-6 behaviour and keeps the anchor-subgraph stage working
   * for every entrance that never had structure to hand.
   */
  structure?: DerivedStructure
  /**
   * Set when the target is a PART (Phase 3).
   *
   * Its presence is what routes the resolution down the part branch — and
   * `target.kind === 'part'` is checked too, because a caller that opened a
   * part WITHOUT fetching its owner's brief must get a sentence rather than
   * the feature branch's answer about a feature nobody asked for.
   */
  part?: LevelPartSource
}

/**
 * The owner's side of a part resolution: whose brief this is, and what it said
 * about its parts.
 */
export interface LevelPartSource {
  /** The OWNER feature's id or slug — whatever the brief was fetched with. */
  ownerId: string
  /** The owner's human name, which every sentence in this branch names. */
  ownerName: string
  /**
   * The owner's `parts` array, exactly as IPC delivered it (UNVALIDATED here —
   * the CLI owns the shape; `readPartRecords` performs the narrowest check).
   */
  parts?: unknown
  /** The owner's own anchors, as the brief resolved them. */
  anchors?: ReadonlyArray<{ ref: string; resolved: boolean }>
}

export interface LevelResolution {
  verdict: LevelVerdict
  /** Specific, never blank. Names the thing that is or is not there. */
  reason: string
  target: { id: string; kind: FocusNodeKind; name: string }
  /** The curated artifact when (and only when) the verdict is `curated`. */
  view: CuratedView | null
  /** That artifact's root level — what the curated stage draws. */
  level: CuratedLevel | null
  /**
   * The derived level, on a `derived` verdict with structural material to hand
   * (Phase 6). Null on every other verdict, and null on a `derived` verdict
   * whose source carried no `structure` — the count still says how much
   * material a level would have had.
   *
   * It is artifact-SHAPED but never validated, and it says so itself
   * (`validated: false`, `provenance: 'derived'`).
   */
  derived: DerivedLevel | null
  /**
   * The PART level, on a part target that resolved to something (Phase 3).
   * Null on every other target and on a part that resolved to `empty`.
   *
   * It carries its OWN artifact-shaped `view` (provenance `part`), so the
   * stage draws it through the same pipeline as the other two. It rides on its
   * own field rather than in `view`/`derived` because it is neither: a curated
   * SLICE is not the feature's curated artifact, and a level built from a
   * part's anchors is not `derived-level.ts`'s code-map picture.
   */
  part: PartLevel | null
  /** Components a derived level would be built from. 0 on an empty verdict. */
  structuralCount: number
  /** The focus-stack depth to restore when this level closes. */
  returnDepth: number
}

/** How the empty state reads. Three parts so no surface has to parse prose. */
export interface LevelEmptyState {
  /** Heading — names the node, so it cannot read as a generic failure. */
  title: string
  /** The resolution's own reason, verbatim. */
  detail: string
  /** What would make a level exist. Never a promise, never a command that
   *  would not actually produce one. */
  hint: string
}

/**
 * Is this `unknown` a curated artifact at all?
 *
 * The IPC layer passes the view through uninspected on purpose (the CLI owns
 * its schema and validated it at write time), so the renderer sees an
 * `unknown`. This is the narrowest possible check: an object with a `views`
 * record. Anything else is not a view, and saying so is what stops a malformed
 * payload from rendering as a blank curated stage.
 */
export function asCuratedView(value: unknown): CuratedView | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const views = (value as { views?: unknown }).views
  if (typeof views !== 'object' || views === null || Array.isArray(views)) return null
  return value as CuratedView
}

function quoted(name: string): string {
  const trimmed = name.trim()
  return trimmed.length === 0 ? 'this node' : `'${trimmed}'`
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`
}

/**
 * Decide what is behind a node's control.
 *
 * Order: curated → derived → empty, exactly as the plan fixes it. Each branch
 * returns its own sentence; there is no shared fallback string, because a
 * shared one would be the generic message this whole module exists to avoid.
 */
export function resolveLevel(target: LevelTarget, source: LevelSource): LevelResolution {
  const returnDepth = Number.isInteger(target.depth) && (target.depth ?? 0) >= 0 ? (target.depth ?? 0) : 0
  const base = {
    target: { id: target.id, kind: target.kind, name: target.name },
    view: null,
    level: null,
    derived: null,
    part: null,
    returnDepth,
  } as const
  const empty = (reason: string): LevelResolution => ({
    ...base,
    verdict: 'empty',
    reason,
    structuralCount: 0,
  })

  // A DOMAIN HAS NO LEVEL OF ITS OWN, and that is a contract rather than a gap:
  // domains group the ring so the root reads as capabilities, and giving one a
  // feature-view would force `feature` into the frozen `VIEW_NODE_KINDS`.
  if (target.kind === 'domain') {
    return empty(
      `${quoted(target.name)} is a domain — domains group the ring and have no level of their own`,
    )
  }

  if (!source.available) {
    const said = (source.reason ?? '').trim()
    return empty(
      said.length > 0
        ? `no level for ${quoted(target.name)}: ${said}`
        : `no level for ${quoted(target.name)}: the brief was unavailable and gave no reason`,
    )
  }

  const structuralCount = Math.max(0, Math.trunc(source.structuralCount ?? 0))
  const view = asCuratedView(source.view)
  const level = rootLevel(view)

  // ── A PART RESOLVES AGAINST ITS OWNER (Phase 3) ───────────────────────────
  //
  // The brief in hand is the OWNER's, so everything below this point — which
  // reads `source.view` as "this node's curated view" and `structuralCount` as
  // "components resolved for this node" — would be answering about the feature
  // rather than about the piece the reader opened. Same three verdicts, built
  // from the owner's record next door in `part-level.ts`.
  if (target.kind === 'part' || source.part !== undefined) {
    return resolvePartLevel(target, source, base, level)
  }

  if (view !== null && level !== null) {
    const generated = typeof view.generatedAt === 'string' ? view.generatedAt.trim() : ''
    return {
      ...base,
      verdict: 'curated',
      reason:
        generated.length > 0
          ? `curated view for ${quoted(target.name)}, generated ${generated}`
          : `curated view for ${quoted(target.name)}`,
      view,
      level,
      structuralCount,
    }
  }

  // WHY THERE IS NO CURATED VIEW — the two cases read differently and must not
  // be collapsed. "None was written" is a gap in the content; "one was written
  // and its root level is unusable" is a broken artifact, which Phase 8 goes on
  // to surface with the validator's own words.
  const missing =
    view === null
      ? `no curated view generated for ${quoted(target.name)}`
      : `the curated view for ${quoted(target.name)} has no usable root level`

  if (structuralCount > 0) {
    // PHASE 6. The level is BUILT next door and only chosen here, so this
    // module keeps being one decision and nothing else.
    const derived =
      source.structure === undefined
        ? null
        : buildDerivedLevel({ id: target.id, name: target.name }, source.structure)
    // WHAT THE CAP HID GOES IN THE REASON TOO, not only in the level's own
    // summary. The reason is what the empty/unavailable surfaces print and
    // what a test reads, and a count that exists in only one of the two places
    // is a count that can quietly stop being true.
    const cut =
      derived === null || derived.hidden.pairs === 0
        ? ''
        : `, ${plural(derived.hidden.pairs, 'weaker connection')} hidden`
    return {
      ...base,
      verdict: 'derived',
      reason: `${missing} — showing the derived level from ${plural(structuralCount, 'resolved component')}${cut}`,
      derived,
      structuralCount,
    }
  }

  return empty(`${missing}, and nothing resolved to derive one from`)
}

/** Everything a resolution carries that neither branch has to restate. */
type ResolutionBase = Omit<LevelResolution, 'verdict' | 'reason' | 'structuralCount'>

/**
 * WHAT IS BEHIND A PART'S CONTROL (Phase 3).
 *
 * Same three verdicts, one level down and against the OWNER's brief. The
 * building is `part-level.ts`'s; this stays what the module has always been —
 * the decision and the sentence.
 *
 * Every branch names the part, and the two that name an absence name the owner
 * too: "no component carries this name" is only useful if the reader can tell
 * which drawing was searched.
 */
function resolvePartLevel(
  target: LevelTarget,
  source: LevelSource,
  base: ResolutionBase,
  ownerLevel: CuratedLevel | null,
): LevelResolution {
  const empty = (reason: string): LevelResolution => ({
    ...base,
    verdict: 'empty',
    reason,
    structuralCount: 0,
  })

  // THE OWNER WAS NEVER FETCHED. A part carries no brief of its own, so an
  // entrance that reached here with a part target and no owner material has
  // measured nothing — and saying "this part has no level" on the strength of
  // a lookup nobody performed is the exact class of claim this module refuses
  // to make (see `modulePaths: null` in `understand-action.ts`).
  const part = source.part
  if (part === undefined) {
    return empty(
      `no level for ${quoted(target.name)}: it is a part, and the feature that owns it was not read`,
    )
  }

  const ownerName = part.ownerName.trim()
  const owner = {
    id: part.ownerId,
    name: ownerName.length > 0 ? ownerName : part.ownerId,
  }
  const records = readPartRecords(part.parts)
  const record = findPartRecord(records, target.name)
  // NAMED ON THE RING, ABSENT FROM THE RECORD. The ring node came from the
  // same markdown the brief reads, so this means the two were read at
  // different moments — a part renamed or removed while the board was open.
  // Counting what the record DOES list is what tells a stale node apart from
  // a feature whose parts have never been written.
  if (record === null) {
    return empty(
      records.length === 0
        ? `${owner.name} has no parts recorded, so there is nothing behind ${quoted(target.name)}`
        : `${owner.name} lists no part called ${quoted(target.name)} — its record names ${plural(records.length, 'other part')}`,
    )
  }

  const built = buildPartLevel({
    part: record,
    owner,
    ownerLevel,
    ...(part.anchors === undefined ? {} : { ownerAnchors: part.anchors }),
  })
  // NEITHER A COMPONENT NOR AN ANCHOR — and the CLI already wrote the sentence
  // for the case that produces it. `partEmptyReason` repeats
  // `partNoAnchorRefusal` verbatim rather than paraphrasing it.
  if (built === null) return empty(partEmptyReason(record, owner, ownerLevel !== null))

  const structuralCount = built.level.nodes.length
  if (built.source === 'curated') {
    return {
      ...base,
      verdict: 'curated',
      reason:
        `${quoted(record.name)} as ${owner.name} draws it — its component in that ` +
        `curated view and ${plural(built.neighbours.length, 'component')} it connects to`,
      part: built,
      structuralCount,
    }
  }
  return {
    ...base,
    verdict: 'derived',
    reason:
      (ownerLevel === null
        ? `${owner.name} has no curated view to slice`
        : `no component named ${quoted(record.name)} in ${possessive(owner.name)} curated view`) +
      ` — showing the ${plural(built.anchors.length, 'file')} ${quoted(record.name)} anchors`,
    part: built,
    structuralCount,
  }
}

/**
 * How the empty verdict READS. Returns null for a verdict that renders
 * something — callers get a type-level reminder that curated and derived are
 * not empty states.
 *
 * The hint says what would make a level exist and stops there. It deliberately
 * does not print a command that would not actually produce one: a curated view
 * is written when a plan that touches the feature is archived, not on demand.
 */
export function levelEmptyState(resolution: LevelResolution): LevelEmptyState | null {
  if (resolution.verdict !== 'empty') return null
  const name = resolution.target.name.trim()
  const title = name.length === 0 ? 'No level here' : `No level for ${name}`
  if (resolution.target.kind === 'domain') {
    return {
      title,
      detail: resolution.reason,
      hint: 'Open one of the features inside it instead.',
    }
  }
  // A PART'S HINT IS NOT A FEATURE'S (Phase 3). The feature wording below sends
  // the reader to plan archival, which writes nothing into a part: parts and
  // their anchors are written by the understand pass over the OWNING feature,
  // and that is the one gesture that would give this level something to show.
  if (resolution.target.kind === 'part') {
    return {
      title,
      detail: resolution.reason,
      hint:
        'A part’s level is its component in its feature’s drawing, or the files it ' +
        'names — understanding the feature writes both, and a part that anchors ' +
        'nothing cannot be learned at all until its record names a file.',
    }
  }
  return {
    title,
    detail: resolution.reason,
    hint:
      'A curated view is written when a plan that touches this feature is archived; ' +
      'until then a level needs anchors that resolve to something in the code map.',
  }
}

/**
 * Whether this resolution puts something on the stage.
 *
 * One predicate, so the board never re-derives "curated or derived" as two
 * separate checks that can drift apart.
 */
export function levelOpens(resolution: LevelResolution): boolean {
  return resolution.verdict !== 'empty'
}

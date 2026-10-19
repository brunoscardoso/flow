/**
 * Territory at the FEATURE level (plan_blueprint_territory_v1, Phase 6) —
 * PURE, no DOM.
 *
 * WHAT CHANGED, AND WHY
 * =====================
 * The brief's stage used to be a column diagram: `layoutCuratedLevel` sorted
 * the components into columns by their wires and drew them in mid-air. Nothing
 * on that sheet said what a component BELONGS to — the parts a feature is made
 * of were invisible, and the reader had to hold "which of these is part of
 * which" in their head while looking at a picture that could have said it.
 *
 * Territory says it: the PARTS are the ground, and each component stands in the
 * part that claims its file. That makes a feature's level the same kind of
 * picture as the level above it (area is a count, position is adjacency) rather
 * than a different diagram wearing the same chrome.
 *
 * WHAT THIS MODULE OWNS
 * =====================
 *  - `claimFor` — which part a component stands in, and on what evidence.
 *  - `placeComponents` — parts as strips, components on a grid inside them,
 *    the feature's own (`part: null`) strip always present.
 *  - `deltaBadge` / `struckIn` / `ghostPartNames` — the Today ⇄ After rules
 *    this ground draws, read off the delta the brief already carries.
 *  - `wireEndpoints` / `levelWires` — where the existing wire canvas draws to.
 *  - `ladderLit` — the phase ladder's lit set, delegated to `phaseHighlight`.
 *  - `changesStripFor` — the pressable strip along the stage floor.
 *
 * WHAT IT DOES NOT OWN
 * ====================
 * No DOM, no IPC, no colours, no class names (the board spells those), and no
 * delta SEMANTICS of its own: `BriefNodeKind` and `BriefWireDelta` come from
 * `brief-view-model.ts` and every rule about what a kind MEANS stays there.
 * One delta vocabulary, whichever ground it is drawn on.
 *
 * A CHANGE IS NEVER A CELL. `kind: 'child'` records are the `Changes:` line and
 * the strip `changesStripFor` describes — never ground, never a component, at
 * any depth. That rule lives in `territory-layout.ts`'s `levelItems` for the
 * sheet above; here it is simply never violated, because nothing in this module
 * reads the feature graph at all.
 */

import { phaseHighlight } from './curated-nav'
import type { CuratedEdge, CuratedLevel } from './curated-view'
import type { BriefChild, BriefDeltaInput, BriefNodeKind, BriefTime } from './brief-view-model'
import { moduleOfPath, type Rect } from './territory-layout'

/** Re-exported so a consumer of this module needs one import, not two. */
export type { Rect } from './territory-layout'

/** The gap taken out of every part's own rectangle, so provinces do not touch. */
export const PART_GAP = 6

/**
 * The lane between two provinces, top to bottom.
 *
 * SEPARATE FROM `PART_GAP`, which is the ground's own horizontal inset, for the
 * reason every other threshold in this family is separate: they answer
 * different questions and one number for both makes a change to either silently
 * re-tier the other.
 *
 * IT IS SIZED FOR THE WIRE LABELS, not for whitespace. A wire between a card in
 * one province and a card in the next puts its label at their vertical midpoint
 * (`levelWires`) — which, at a 6px lane, landed on top of the next province's
 * 18px label row. Every screenshot of a real feature view had wire text sitting
 * across a province name. 24 gives that text a lane of its own.
 */
export const PART_ROW_GAP = 24
/** The label row at the top of a part's ground — dot plus the part's name. */
export const PART_LABEL_H = 18
/** Breathing room between a part's border and the components standing in it. */
export const PART_PAD = 6
/** A component card's maximum width. Smaller when its part cannot hold one. */
export const COMPONENT_W = 190
/** A component card's maximum height. */
export const COMPONENT_H = 58
/** The gap between component cards on a part's grid. */
export const COMPONENT_GAP = 8
/**
 * The area the feature's OWN strip is owed when it holds nothing.
 *
 * The strip is always drawn (see `placeComponents`) because "no component is
 * unclaimed" is an answer and an absent strip is a silence. A zero-valued strip
 * would be a hairline nobody can read that answer off, so it is floored at the
 * area of three components — enough to print its label and its note.
 */
export const OWN_STRIP_MIN = 3

/**
 * The dim note beside the own strip's label, naming what it stands for.
 *
 * IN THE READER'S WORDS, NOT THE MODEL'S. It read `part: null` — the literal
 * field name and value from the data behind the sheet — which tells someone
 * looking at a map of their code exactly nothing (forbidden-pattern #12: no
 * formats, keys or internals in UI text). What the strip actually holds is the
 * feature's anchors that no part claimed.
 */
export const OWN_STRIP_NOTE = 'not inside any part'

/** The id prefix `part-level.ts` gives a card that stands for one file. */
export const FILE_CARD_PREFIX = 'file:'

/** True when a curated node id is one of a part level's file cards. */
export function isFileCardId(id: string): boolean {
  return id.startsWith(FILE_CARD_PREFIX)
}

/** One part of the feature, as the ground draws it. */
export interface LevelPart {
  name: string
  /** The refs this part claims — `file:`/`module:` prefixed or bare paths. */
  anchors: readonly string[]
}

/** One component standing on the ground. */
export interface LevelComponent {
  id: string
  /** The file this component names, when it names one. */
  file: string | null
  /** Further references, tried in order after `file`. */
  refs?: readonly string[]
  /** The delta kind, straight off the curated node. */
  delta: BriefNodeKind
}

/** WHY a component landed where it did — evidence, never a guess. */
export type ClaimKind = 'file' | 'module' | 'unclaimed'

/** A component with the rectangle and the part it was given. */
export interface PlacedComponent {
  id: string
  /** The claiming part's name, or `null` for the feature's own strip. */
  part: string | null
  claim: ClaimKind
  rect: Rect
  delta: BriefNodeKind
  /** The delta badge word, or null. Always null in Today. */
  badge: string | null
  /** True when the card renders struck through. Only ever in After. */
  struck: boolean
}

/** One part's ground: its rectangle, its label row and what stands in it. */
export interface PlacedPart {
  /** The part's name, or `null` for the feature's own strip. */
  part: string | null
  label: string
  /** The dim note under the label, or null. */
  note: string | null
  /** True ⇒ a plan CREATES this part; it is drawn as a dashed province. */
  ghost: boolean
  /**
   * True ⇒ the province holds its box and draws NOTHING.
   *
   * ONE LAYOUT, TWO STATES — the same rule `curated-view.ts` states for cards,
   * applied to ground: the sheet is cut from the UNION of both worlds and never
   * re-cut on a flip, because a province that moves when you toggle Today ⇄
   * After destroys the comparison the toggle exists to make. A part a plan
   * creates therefore keeps its rectangle in Today and is simply not drawn —
   * Today is the world in which the plan has not happened.
   */
  absent: boolean
  rect: Rect
  /** The rect components are laid out in — inside the border, under the label. */
  inner: Rect
  components: PlacedComponent[]
}

/** Everything the feature level's ground draws. */
export interface LevelGround {
  parts: PlacedPart[]
  /** Every placed component, in input order — the flat view for wiring. */
  components: PlacedComponent[]
  width: number
  height: number
}

/** What `placeComponents` needs beyond the parts and the components. */
export interface PlaceOptions {
  /** The ground the parts are cut out of. */
  rect: Rect
  /** The feature's name — the own strip is labelled `<feature> · own anchors`. */
  feature: string
  /** Which world is showing. Badges and strikes exist only in After. */
  time?: BriefTime
  /** Parts a plan CREATES, by name (see `ghostPartNames`). */
  ghostParts?: ReadonlySet<string>
}

/**
 * Strip a ref down to the path it names, lower-cased for comparison.
 *
 * `file:src/a.ts`, `` `src/a.ts` `` and `src/a.ts:handle` all name one file, and
 * a part's anchors are written by hand — an exact string match on the raw ref
 * would leave half of them unclaimed for punctuation reasons.
 */
function bare(ref: string): string {
  const trimmed = ref
    .trim()
    .replace(/^[`[\s]+/, '')
    .replace(/[`\]\s]+$/, '')
  const colon = trimmed.indexOf(':')
  if (colon < 0) return trimmed.toLowerCase()
  const kind = trimmed.slice(0, colon)
  if (kind !== 'file' && kind !== 'module') return trimmed.toLowerCase()
  const rest = trimmed.slice(colon + 1)
  // A locator suffix follows the extension: `foo.ts:sym`, not `foo.ts`.
  const locator = rest.match(/^(.*\.[A-Za-z0-9]+):[^/]*$/)
  return (locator === null ? rest : locator[1]).toLowerCase()
}

/** The module a ref sits in, lower-cased — `null` when it names none. */
function moduleKey(ref: string): string | null {
  const module = moduleOfPath(ref)
  return module === null ? null : module.toLowerCase()
}

/**
 * Every path a component might be claimed by, in precedence order.
 *
 * THE ID COUNTS TOO, and only when it carries the extractor grammar. A DERIVED
 * level — which is what a feature with no authored artifact shows, and
 * therefore nearly always — builds its components straight from the code map,
 * so they have no excerpt and no references: their whole address is the id
 * (`module:src/chats`). Ignoring it would put every component on the own strip
 * and leave every province empty on the commonest level there is.
 *
 * An AUTHORED view's ids are invented names (`bff`, `engine`), which is
 * precisely why the prefix test is there: a bare word must never be matched
 * against a part's anchors, or a component called `store` would be claimed by
 * whichever part happens to anchor a directory of that name.
 */
function componentPaths(component: LevelComponent): string[] {
  const out: string[] = []
  if (component.file !== null && component.file.trim().length > 0) out.push(component.file)
  for (const ref of component.refs ?? []) {
    if (ref.trim().length > 0) out.push(ref)
  }
  if (/^(module|file):/.test(component.id)) out.push(component.id)
  return out
}

/**
 * WHICH PART A COMPONENT STANDS IN.
 *
 * Two rounds, in this order and never merged: an EXACT file match across every
 * part first, then a directory match. Merging them would let a part that
 * happens to own the enclosing directory take a file another part names
 * outright — the coarser evidence beating the finer one because it was checked
 * first. Parts are walked in declaration order, so a tie is settled by the
 * store rather than by iteration order over a Map.
 *
 * No match is `unclaimed`, which is a real answer and not a failure: the file
 * belongs to the feature itself, and the own strip is where it goes.
 */
export function claimFor(
  component: LevelComponent,
  parts: readonly LevelPart[],
): { part: string | null; claim: ClaimKind } {
  const paths = componentPaths(component)
  if (paths.length === 0) return { part: null, claim: 'unclaimed' }

  const keys = paths.map((path) => bare(path))
  for (const part of parts) {
    for (const anchor of part.anchors) {
      if (keys.includes(bare(anchor))) return { part: part.name, claim: 'file' }
    }
  }

  const modules = paths.map((path) => moduleKey(path)).filter((key): key is string => key !== null)
  if (modules.length > 0) {
    for (const part of parts) {
      for (const anchor of part.anchors) {
        const key = moduleKey(anchor)
        if (key !== null && modules.includes(key)) return { part: part.name, claim: 'module' }
      }
    }
  }
  return { part: null, claim: 'unclaimed' }
}

/** The badge word one delta kind wears. `null` ⇒ the card wears none. */
const BADGE_WORD: Record<BriefNodeKind, string | null> = {
  stable: null,
  modify: 'MODIFY',
  new: 'NEW',
  remove: 'REMOVE',
}

/**
 * The delta badge, or null.
 *
 * TODAY NEVER BADGES. Today is the world in which the plan has not happened, so
 * a `NEW` pill there would announce a component that does not exist — the same
 * rule `buildBriefView` applies to its own badges, restated for the ground's.
 */
export function deltaBadge(kind: BriefNodeKind, time: BriefTime): string | null {
  return time === 'next' ? BADGE_WORD[kind] : null
}

/** True when a card renders struck through — a removal, in After, only. */
export function struckIn(kind: BriefNodeKind, time: BriefTime): boolean {
  return time === 'next' && kind === 'remove'
}

/** The band an EMPTY province keeps under its label, so it still reads as ground. */
export const EMPTY_PROVINCE_H = 24

/**
 * A WRAPPING GRID of fixed-size cards across `innerW`: as many columns as fit
 * (floored at one — a province narrower than a card gets one column of
 * narrower cards rather than none), and however many rows that takes.
 *
 * Rects are relative to the province's inner origin. `height` is what the
 * rows need — the province is sized FROM it.
 */
function rowsInside(
  count: number,
  innerW: number,
  cardH: number,
): { rects: Rect[]; height: number } {
  if (count <= 0) return { rects: [], height: EMPTY_PROVINCE_H }
  const cols = Math.max(
    1,
    Math.min(count, Math.floor((innerW + COMPONENT_GAP) / (COMPONENT_W + COMPONENT_GAP))),
  )
  const rows = Math.ceil(count / cols)
  const w = Math.max(0, Math.min(COMPONENT_W, (innerW - COMPONENT_GAP * (cols - 1)) / cols))
  const rects: Rect[] = []
  for (let index = 0; index < count; index += 1) {
    rects.push({
      x: (index % cols) * (w + COMPONENT_GAP),
      y: Math.floor(index / cols) * (cardH + COMPONENT_GAP),
      w,
      h: cardH,
    })
  }
  return { rects, height: rows * cardH + (rows - 1) * COMPONENT_GAP }
}

/** The rect a part's components stand in: inside its border, under its label. */
function innerOf(rect: Rect): Rect {
  return {
    x: rect.x + PART_PAD,
    y: rect.y + PART_LABEL_H,
    w: Math.max(0, rect.w - 2 * PART_PAD),
    h: Math.max(0, rect.h - PART_LABEL_H - PART_PAD),
  }
}

/**
 * THE FEATURE LEVEL'S GROUND: parts as provinces, components inside them.
 *
 * EVERY PROVINCE IS A FULL-WIDTH ROW, as tall as the cards it holds need — a
 * wrapping grid of fixed-size cards (`COMPONENT_W × COMPONENT_H`), as many
 * columns as the width allows and one more row whenever they run out. The
 * ground's height is the sum of its rows, so it GROWS to fit and scrolls
 * rather than crushing a card to fit a rectangle.
 *
 * The first cut cut the ground into strips sized by each part's ANCHOR COUNT
 * and divided whatever a strip got among its cards. A part with one anchor
 * and six components got a sliver and six illegible cards; a narrow pane got
 * cards narrower than their own padding, painted over their neighbours; and
 * nothing re-laid on resize. "The cards are not aligned, they are
 * overlapping" — the user, 2026-08-28. A component's AREA says nothing (it is
 * one component), so no part's area should be decided by one either: the
 * sheet's job here is to keep every card readable and every card in its
 * part, and rows are the layout that cannot fail at that.
 *
 * THE OWN STRIP IS ALWAYS PRESENT, even when every component is claimed. "No
 * component is unclaimed" is an answer the reader is owed; an absent strip
 * would leave them unable to tell it from "nobody has looked".
 *
 * Deterministic: parts keep declaration order, the own strip is last, and
 * duplicates by name are dropped first-wins.
 */
export function placeComponents(
  parts: readonly LevelPart[],
  components: readonly LevelComponent[],
  options: PlaceOptions,
): LevelGround {
  const time = options.time ?? 'now'
  const ghosts = options.ghostParts ?? new Set<string>()
  const maxH = COMPONENT_H

  // First-wins dedupe. Two parts with one name would share a bucket below and
  // silently double one of them's components.
  const unique: LevelPart[] = []
  const seen = new Set<string>()
  for (const part of parts) {
    const name = part.name.trim()
    if (name.length === 0 || seen.has(name)) continue
    seen.add(name)
    unique.push({ name, anchors: part.anchors })
  }

  const buckets = new Map<string | null, LevelComponent[]>()
  buckets.set(null, [])
  for (const part of unique) buckets.set(part.name, [])

  const claims = new Map<string, { part: string | null; claim: ClaimKind }>()
  for (const component of components) {
    const claim = claimFor(component, unique)
    claims.set(component.id, claim)
    ;(buckets.get(claim.part) ?? (buckets.get(null) as LevelComponent[])).push(component)
  }

  const provinces: Array<{ part: string | null; held: LevelComponent[] }> = [
    ...unique.map((part) => ({
      part: part.name as string | null,
      held: buckets.get(part.name) ?? [],
    })),
    { part: null, held: buckets.get(null) ?? [] },
  ]

  const groundX = options.rect.x
  const groundY = options.rect.y
  const groundW = Math.max(0, options.rect.w)
  const width = Math.max(0, groundW - PART_GAP)
  const innerW = Math.max(0, width - 2 * PART_PAD)

  const placedParts: PlacedPart[] = []
  const flat: PlacedComponent[] = []
  let cursor = groundY + PART_GAP / 2
  for (const province of provinces) {
    const grid = rowsInside(province.held.length, innerW, maxH)
    const rect: Rect = {
      x: groundX + PART_GAP / 2,
      y: cursor,
      w: width,
      h: PART_LABEL_H + grid.height + PART_PAD,
    }
    const inner = innerOf(rect)
    const placed = province.held.map((component, index) => {
      const claim = claims.get(component.id) ?? {
        part: province.part,
        claim: 'unclaimed' as ClaimKind,
      }
      const cell = grid.rects[index]
      const entry: PlacedComponent = {
        id: component.id,
        part: province.part,
        claim: claim.claim,
        rect: { x: inner.x + cell.x, y: inner.y + cell.y, w: cell.w, h: cell.h },
        delta: component.delta,
        badge: deltaBadge(component.delta, time),
        struck: struckIn(component.delta, time),
      }
      flat.push(entry)
      return entry
    })
    placedParts.push({
      part: province.part,
      label: province.part ?? `${options.feature} · own anchors`,
      note: province.part === null ? OWN_STRIP_NOTE : null,
      ghost: province.part !== null && ghosts.has(province.part),
      absent: province.part !== null && ghosts.has(province.part) && time === 'now',
      rect,
      inner,
      components: placed,
    })
    cursor += rect.h + PART_ROW_GAP
  }

  return {
    parts: placedParts,
    components: flat,
    width: groundW,
    // THE GROUND IS AS TALL AS ITS ROWS — never the rect it was offered. A
    // level with more cards than the pane can show is taller than the pane and
    // the canvas scrolls; a level with fewer leaves paper below.
    // The cursor is left one LANE past the last province; the ground ends one
    // half-inset past it, matching the half-inset it started with.
    height: Math.max(0, cursor - PART_ROW_GAP + PART_GAP / 2 - groundY),
  }
}

/** Where the wire canvas draws to: the centre of every placed card, by id. */
export function wireEndpoints(
  placed: readonly PlacedComponent[],
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>()
  for (const card of placed) {
    out.set(card.id, { x: card.rect.x + card.rect.w / 2, y: card.rect.y + card.rect.h / 2 })
  }
  return out
}

/** One wire, ready for the existing `fb-curated-wire-*` canvas. */
export interface LevelWire {
  from: string
  to: string
  label: string
  labelNext: string
  /** `kept` / `added` / `removed`, carried straight off the curated edge. */
  delta: CuratedEdge['delta']
  path: string
  labelX: number
  labelY: number
}

/** How far above a wire's midpoint its label sits. */
export const WIRE_LABEL_LIFT = 8

/**
 * The wires between placed cards.
 *
 * An edge whose either end is not on the ground is DROPPED, not drawn to a
 * guessed point: a wire to nowhere is a claim about a component the reader
 * cannot see. The path is a plain horizontal-tangent cubic, which reads as a
 * connection at any angle without the column assumptions
 * `layoutCuratedLevel`'s router makes (there are no columns here).
 */
export function levelWires(
  edges: readonly CuratedEdge[],
  centres: ReadonlyMap<string, { x: number; y: number }>,
): LevelWire[] {
  const out: LevelWire[] = []
  for (const edge of edges) {
    const from = centres.get(edge.from)
    const to = centres.get(edge.to)
    if (from === undefined || to === undefined) continue
    const mid = (from.x + to.x) / 2
    out.push({
      from: edge.from,
      to: edge.to,
      label: edge.label,
      labelNext: edge.labelNext ?? edge.label,
      delta: edge.delta,
      path: `M ${String(from.x)} ${String(from.y)} C ${String(mid)} ${String(from.y)}, ${String(mid)} ${String(to.y)}, ${String(to.x)} ${String(to.y)}`,
      labelX: mid,
      labelY: (from.y + to.y) / 2 - WIRE_LABEL_LIFT,
    })
  }
  return out
}

/**
 * WHAT A LADDER RUNG LIGHTS.
 *
 * Delegates to `phaseHighlight` rather than re-deriving it: the ladder's rules
 * (an empty selection lights everything, a phase that touches nothing lights
 * everything) are already settled and tested there, and a second copy is how a
 * lit card and a lit wire end up disagreeing (allowed-pattern #14).
 */
export function ladderLit(
  level: CuratedLevel,
  phase: number | null,
): { lit: Set<string>; dimming: boolean } {
  const highlight = phaseHighlight(level, phase)
  return { lit: new Set(highlight.lit), dimming: highlight.dimmed.length > 0 }
}

/** One pressable pill on the changes strip. */
export interface ChangeChip {
  id: string
  name: string
  /** The word before the name — `change` unless the graph says otherwise. */
  kind: string
  /** When it happened, when anything knows. `null` is not "no date". */
  date: string | null
  /** False for an older CLI payload with no id: a label, never a dead control. */
  openable: boolean
}

/** What a change is called when nothing supplies a better word. */
export const DEFAULT_CHANGE_KIND = 'change'

/**
 * THE CHANGES STRIP — a feature's change records, in the order the identity
 * lists them.
 *
 * A CHANGE IS NEVER A CELL: it is not ground, it is not a component, and it is
 * on no ring at any depth. This strip and the brief's `Changes:` line are its
 * only surfaces, which is why this function exists beside the ground rather
 * than inside it.
 *
 * Order is `identity.children`'s, untouched. A blank name is dropped — a pill
 * with nothing written on it is a control that cannot say what it does.
 */
export function changesStripFor(
  children: readonly BriefChild[],
  meta?: ReadonlyMap<string, { kind?: string; date?: string }>,
): ChangeChip[] {
  const out: ChangeChip[] = []
  for (const child of children) {
    const name = child.name.trim()
    if (name.length === 0) continue
    const extra = meta?.get(child.id)
    const kind = extra?.kind?.trim()
    const date = extra?.date?.trim()
    out.push({
      id: child.id,
      name,
      kind: kind === undefined || kind.length === 0 ? DEFAULT_CHANGE_KIND : kind,
      date: date === undefined || date.length === 0 ? null : date,
      openable: child.id.length > 0,
    })
  }
  return out
}

/**
 * THE PARTS A PLAN CREATES — the dashed ghost provinces.
 *
 * TODAY NAMES NONE. A part a plan will create does not exist in the world the
 * reader is looking at, and dashing a province there would draw the plan into
 * the picture that exists to be free of it (the same rule the discovery view
 * and `buildBriefView` both keep).
 *
 * Two honest sources, and no third: a live PROPOSAL whose `kind` is `part`
 * (its `label` is the part's name, written by whoever proposed it), and a delta
 * node whose id carries the `part:` grammar and whose kind is `new`. Anything
 * looser — "a new node whose label happens to match a part" — would dash a
 * province on a coincidence.
 */
export function ghostPartNames(delta: BriefDeltaInput, time: BriefTime): Set<string> {
  const out = new Set<string>()
  if (time === 'now') return out
  const nodes = [...delta.nodes, ...(delta.proposed?.nodes ?? [])]
  for (const node of nodes) {
    for (const proposal of node.provenance?.proposals ?? []) {
      if (proposal.kind !== 'part') continue
      const label = proposal.label.trim()
      if (label.length > 0) out.add(label)
    }
    if (node.kind !== 'new') continue
    if (!node.nodeId.startsWith('part:')) continue
    const label = node.label.trim()
    if (label.length > 0) out.add(label)
  }
  return out
}

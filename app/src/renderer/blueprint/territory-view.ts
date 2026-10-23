/**
 * The territory render plan (plan_blueprint_territory_v1, Phase 2) — PURE, no DOM.
 *
 * Everything the feature board draws on its default sheet that can be decided
 * WITHOUT a document: which cell sits in which rectangle, what each one is
 * called, how much of that name survives the rectangle it got, what the title
 * strip says, which cells an overlay lights and which it dims. It replaces
 * the retired ring's view module — `blueprint-board.ts` gains wiring only (it is
 * ~12,500 lines and nothing testable is allowed to land inside it).
 *
 * WHAT THIS MODULE DOES NOT OWN
 * =============================
 * The ARITHMETIC — strips, insets, label thresholds, the module/coverage join —
 * is `territory-layout.ts` and is only called from here. Depth is
 * `focus-stack.ts`. What a level CONTAINS, and what an empty one says, is
 * `feature-view-model.ts`. Motion is `territory-motion.ts` (Phase 3). This
 * module composes those; it re-derives none of them.
 *
 * WHAT SURVIVED THE RING, AND WHAT DID NOT
 * ========================================
 * Kept: `activationOf` (body = dive into a level below, the code story at the last level — plan
 * cell-hover-diagram), the CONTROL as the route to a feature view, the empty-level states, the root footer
 * note, and the control sentences.
 *
 * Gone with the ring, because the picture they served is gone: `labelsOnHover`,
 * `hiddenLabelIndices`, `countLabelCollisions`, `fitConstellation`,
 * `projectPoint`, the centre and brain models, and every ring constant. Those
 * existed to answer "which names must I hide because the ring has no room for
 * them all" — a question a treemap answers per cell, by size, in
 * `cellLabelClass`. A cell never loses its name because a SIBLING is crowded.
 *
 * A CHANGE IS NEVER A CELL
 * ========================
 * At any depth. `levelItems` delegates to `childrenOf`, which owns that rule in
 * one place; the counts on this sheet read `kind === 'child'` directly and are
 * never derived by subtracting one kind from a total. A change's surfaces are
 * the second line's `M changes`, the feature brief's `Changes:` line and the
 * root footer note — never a rectangle.
 *
 * FAIL-SOFT: an empty graph, an empty level, a degenerate stage or a stack
 * pointing at a node that no longer exists all yield a readable, cell-less
 * view — never a throw.
 */

import {
  buildFeatureFocusView,
  FOCUS_ROOT_LABEL,
  LEVEL_CONTROL_GLYPH,
  type EmptyLevel,
  type FeatureGraphInput,
  type FeatureGraphNodeInput,
  type FeatureUnderstanding,
} from './feature-view-model'
import type { FocusCrumb, FocusNode, FocusNodeKind } from './focus-stack'
import {
  hasRoomForSummary,
  cellLabelClass,
  detailsFit,
  grownBy,
  inset,
  isRoomy,
  levelItems,
  restingFolderTier,
  squarifyFocused,
  DETAILS_TARGET,
  FOCUS_MIN,
  FOCUS_OUTER_SHARE,
  FOCUS_SHARE,
  LABEL_SHORT_MIN,
  type CellSize,
  type FocusFit,
  type Rect,
} from './territory-layout'
import { queryAvailableAtDepth } from './brain-query-model'
import { cellFolders, folderSlice, type CellFolders } from './folder-rows-model'
import { relationsOf } from './feature-relations'
import { understoodBySlug } from './learn-progress-model'
import type { InFlightMark } from './learn-inflight'
import type { AppliedCap } from './limitations-model'
import { isFeatureRole, type FeatureRole, type FeatureRoleSource } from '../../shared/feature-role'
import { roleIconShownAt } from './role-icon-model'

/* ── THE SHEET'S OWN GEOMETRY ───────────────────────────────────────────────
 *
 * Measured off the approved exploration
 * (`flow/brainstorms/blueprint-territory-one-to-one.html`). They are constants
 * here — rather than inline arithmetic in the layout below — for the same
 * reason the label thresholds are constants in `territory-layout.ts`: Phase 4
 * re-checks them against the real stage, and that re-check must be an edit to
 * these numbers rather than to the render path.
 */

/** The title strip's band across the top of the stage. */
// The title strip lives in the board's header now (2026-10-06); the sheet
// keeps only a little air above its first row.
export const TITLE_STRIP_H = 8
/** The title block's band across the foot of it. */
export const TITLE_BLOCK_H = 32
/** Breathing room between the sheet and the stage's left/right edges. */
export const SHEET_MARGIN = 6
/** How far a domain group is drawn inside the rectangle it was given. */
export const GROUP_INSET = 2
/** The label row at the top of a group — features start below it. */
export const GROUP_LABEL_H = 22
/** The group's own left/right/bottom padding around its features. */
export const GROUP_PAD = 6
/**
 * A cell's gap from its neighbours.
 *
 * Two numbers, one rule: a cell standing on the BARE SHEET takes the full gap,
 * and a cell inside a group takes half of it because the group has already
 * taken its own inset and padding out of the same space. Sharing one constant
 * would either double the gutter inside every country or halve it everywhere
 * else.
 */
export const CELL_INSET = 2
export const CELL_INSET_IN_GROUP = 1
/**
 * The smallest a domain's ground is drawn while a feature in another domain
 * is grown: its label row and one row of cells at the short-name tier.
 */
export const GROUP_FOCUS_MIN: CellSize = { w: 120, h: GROUP_LABEL_H + 48 }

/** A measured stage, in CSS pixels. */
export interface StageSize {
  width: number
  height: number
}

/**
 * The stage the board draws on when the caller has not measured one — the
 * 1030 × 520 sheet the label thresholds were measured against.
 */
export const DEFAULT_STAGE: StageSize = { width: 1030, height: 520 }

/* ── THE CONTROLS' SENTENCES ────────────────────────────────────────────────
 *
 * Restated here rather than carried over from the retired ring's view module.
 * `LEVEL_CONTROL_GLYPH` itself still comes from
 * `feature-view-model.ts` — the empty-level messages name the same mark, and
 * two spellings of one mark is how a sentence and a sheet start disagreeing.
 */

/** The open-level mark's NAME, stamped on the drawn group by the board. */
export const CONTROL_GLYPH = LEVEL_CONTROL_GLYPH
/** The corpus-browser mark's name — "list", because a filterable list is what
 *  it opens. */
export const CORPUS_CONTROL_GLYPH = 'list'

/**
 * What the open-level control says — one sentence, two variants, in one place.
 *
 * It names the DESTINATION, not the mechanism, and it says so when the
 * destination is bare: a board that advertised a full view for a feature with
 * no anchors would be lying in exactly the way this whole change is about.
 */
export function controlTitle(name: string, hasContent: boolean): string {
  return hasContent
    ? `Open ${name}'s feature view`
    : `Open ${name}'s feature view — nothing is claimed yet, so it will say what is missing`
}

/** What the corpus-browser control says — same discipline, same shape. */
export function corpusControlTitle(name: string): string {
  return `Open ${name}'s changes & discoveries`
}

/* ── ASK THE BRAIN ──────────────────────────────────────────────────────────
 *
 * The affordance moved from inside the ring's centre to the right end of the
 * title strip; its WORDS did not change, and they are restated here rather
 * than carried over from the retired ring's view module, for the
 * same reason the control sentences are. The sentence still promises what
 * happens on the sheet, because that promise is the whole reason the field is
 * on the map at all rather than in a panel beside it.
 */

/** The field's own label. */
export const BRAIN_FIELD_LABEL = 'Ask the brain'
/** The mark that opens it. */
export const BRAIN_FIELD_GLYPH = '⌕'
/** Its tooltip AND its accessible name — one sentence, in one place. */
export const BRAIN_FIELD_TITLE = 'Ask the brain — matches light up on the map'

/* ── WHAT THE SHEET IS MADE OF ──────────────────────────────────────────────*/

/** Which depth is drawn. `'root'` is the whole project; the rest is the focused
 *  node's own kind, so a kind added to the focus graph cannot silently become
 *  one of the others. */
export type TerritoryLevel = 'root' | FocusNodeKind

/** How much of a cell's label survives its rectangle (see `cellLabelClass`). */
export type TerritoryLabelClass = '' | 'tiny' | 'dot' | 'blank'



/** One drawn rectangle: a dot, a name, and — when it has the room — one more line. */
export interface TerritoryCell {
  id: string
  kind: FocusNodeKind
  name: string
  /**
   * The FEATURE's (or part's) own understanding, `null` for a domain and for a
   * ghost. A domain has no knowledge of its own — claiming one aggregated from
   * its features would repeat the lie `d5ae3b83` removed — and a ghost has
   * nothing to know yet.
   */
  understanding: FeatureUnderstanding | null
  active: boolean
  /**
   * `N parts · M changes · active`, or null.
   *
   * Null in two different ways, both deliberate: the cell has no ROOM for it
   * (`isRoomy`), or it has room and nothing to say. A line printed under every
   * cell on the sheet is texture, not information — that is the lesson
   * `kickerFor` records, and it applies here for the same reason.
   */
  secondLine: string | null
  /**
   * How many other features this one touches (`relates`), 0 when none.
   *
   * ITS OWN FIELD RATHER THAN A PIECE OF `secondLine`, because it is the only
   * part of that line a reader can PRESS — it opens the connections panel. A
   * count buried in a joined string would have to be found again by splitting
   * the string back apart, which is how a label and its behaviour drift.
   */
  links: number
  /**
   * The feature's own one-paragraph description, or null.
   *
   * NULL FOR THREE DIFFERENT REASONS, and the cell does not distinguish them:
   * the node has no description written, it is a ghost (a prediction describes
   * nothing), or the rectangle is too small to hold one. All three mean the
   * same thing to the reader — there is nothing to read here — and inventing a
   * placeholder for any of them would put text on the sheet that no one wrote.
   */
  summary: string | null
  /**
   * The SAME description, whatever the rectangle's size — what the hover
   * reveals and the hover card's header prints (plan cell-hover-diagram).
   * `summary` is gated on room; this is not, because the hover is exactly the
   * moment a small cell gets the room it did not have. Null when nobody wrote one.
   */
  description: string | null
  /**
   * Where the feature lives — a module path read from its provenance line —
   * printed small at the cell's foot; null when unknown or the cell is not
   * roomy. Only the FALLBACK now: a node with folder rows says where it lives
   * through `folders` (its home line), and this is null for it.
   */
  path: string | null
  /**
   * WHERE IT LIVES, in the file explorer's words (plan feature-home-folders):
   * the whole slice (every row, the one-line form) whatever the rectangle's
   * size — what the grown cell prints — and `tier`/`shown`/`more` for what this
   * rectangle prints. Null when the CLI found no files for the node (no rows,
   * never a guessed folder), for a domain, and for a ghost.
   */
  folders: CellFolders | null
  /** The open-level control shows on hover. Never for a domain (a domain has no
   *  feature view) and never for a ghost (there is nothing there yet). */
  hasControl: boolean
  /** The control's tooltip AND its accessible name — one sentence, so the
   *  control is never a mystery button. Null when there is no control. */
  controlTitle: string | null
  /** This cell's knowledge has drifted past the code it describes. */
  stale: boolean
  /**
   * WHAT KIND OF THING IT IS (plan feature-type-icons) — the node's role and
   * who answered it, copied as the CLI resolved them. Null for a domain, a
   * ghost, a change and a node from a bundle that predates roles: nothing to
   * draw, never a guess made here.
   */
  role: FeatureRole | null
  roleSource: FeatureRoleSource | null
  /**
   * The icon shows: there is a role AND the cell prints its full name
   * (`roleIconShownAt`). Decided here so the three builders only spell it —
   * the icon can never take letters from a name.
   */
  showRoleIcon: boolean
  labelClass: TerritoryLabelClass
  /** True when the cell has room for its second line — the board's `roomy`
   *  class, and the gate `secondLine` was decided behind. */
  roomy: boolean
  rect: Rect
  /** Set by `decorate` — an overlay's answer, never a property of the data. */
  lit: boolean
  dim: boolean
}

/** A domain's ground: a label row and the rectangle its features are packed in. */
export interface TerritoryGroup {
  /** The synthesised domain id — what a dive into this country pushes. */
  id: string
  label: string
  /** What the country holds — `4 features · 120 files · 50% understood`; the
   *  label row's second half. `''` when there is nothing to say. */
  summary: string
  /** The whole country, label row included. */
  rect: Rect
  /** Where its features were packed — below the label row, inside the padding. */
  inner: Rect
  /** The cells packed into it, in drawn order. `decorate` reads this rather
   *  than re-deriving containment from rectangles. */
  cellIds: string[]
  lit: boolean
  dim: boolean
}

/**
 * The strip across the top — what the ring's centre used to be.
 *
 * The centre held the focus name, its kicker, the pop gesture and two controls.
 * All four move here, and the pop gesture becomes the parent crumb: a strip has
 * a left end, so "where you are" reads as a line rather than as a disc the
 * reader has to be told is clickable.
 */
export interface TerritoryTitleView {
  /** The focused node's name — the project's at the root. */
  name: string
  /** The ancestor lead-in (`Agent ›`), or `''` at the root and one level in. */
  prefix: string
  /** `10 features · 3 domains · 41k lines` · `4 features · 120 files` ·
   *  `3 parts · 12 files · 3.4k lines`. */
  kicker: string
  /** The drilled node's own open-level control. Never at the root (it stands
   *  for no node) and never on a domain (which has no feature view). */
  showControl: boolean
  controlTitle: string
  /** The corpus browser — a drilled FEATURE only. A domain is a grouping and a
   *  part's changes are its owner's, so a door on either could only mislead. */
  showCorpusControl: boolean
  corpusControlTitle: string
  /** Ask the brain — ROOT ONLY, via `queryAvailableAtDepth`, which is the one
   *  place that rule lives. */
  showBrainField: boolean
  /** The drafting title block: one line, foot of the sheet. */
  block: string
}

/** Everything the board needs to draw one depth of the territory. */
export interface TerritoryView {
  level: TerritoryLevel
  /** Depth of the focus stack — 0 at the root. */
  depth: number
  title: TerritoryTitleView
  /** Domain grounds — root only, and only when any core feature carries a
   *  `domain:`. Empty everywhere else, never null-and-checked. */
  groups: TerritoryGroup[]
  cells: TerritoryCell[]
  crumbs: FocusCrumb[]
  /** Shown instead of an empty sheet, with its KIND so the board can hang the
   *  right action off it. */
  empty: EmptyLevel | null
  /** The same absence as prose — kept because that is all most callers wanted. */
  emptyReason: string | null
  /**
   * What the ROOT is not showing. A change record whose feature could not be
   * identified belongs to no capability, so it appears at no depth — and
   * dropping it silently would hide a real file.
   */
  footerNote: string | null
  /** The rectangle the cells were packed into — the stage minus the two bands. */
  sheet: Rect
}

/** What the caller knows about the fetch, the stage and the store. */
export interface TerritoryOptions {
  /** The measured stage. Omitted → `DEFAULT_STAGE`. */
  stage?: StageSize
  /** The project's name — the root title, and the title block's third field. */
  project?: string
  /** Where this level's data came from — the title block's last field. */
  source?: string
  /** The feature query's own failure line, when it failed. An empty graph then
   *  means "unknown", not "none". */
  fetchFailure?: string | null
  /**
   * THE HOVERED CELL, grown in place (plan cell-hover-diagram): its id, or
   * null for the plain level. The same cells in the same order — the focused
   * one takes `FOCUS_SHARE` of its level (and its domain `FOCUS_OUTER_SHARE`
   * of the sheet), still containing where it was; every other shrinks, and its
   * label tier follows its new rectangle.
   */
  focus?: string | null
  /**
   * The cell grown BEFORE `focus`, when the grow moves from one cell to
   * another: the newly grown cell then contains where it was drawn shrunk —
   * where the pointer that chose it is resting — rather than its plain place.
   */
  previous?: string | null
  /**
   * HOW FAR `focus` GROWS: `open` (a click — the default) takes `FOCUS_SHARE`
   * of its level for its diagram; `details` (a hover) grows only as far as
   * its details need — `DETAILS_TARGET`, clamped to the level (`detailsFit`)
   * — and its country only as far as that cell needs. The same re-lay, the
   * same movement; a smaller share.
   */
  focusMode?: FocusMode
  /**
   * Room taken off the TOP of the sheet for a bar drawn above the cells (the
   * one-time classify offer). Omitted or 0 → the whole sheet. Every build of
   * one level must pass the same value, or a hover re-lay would move the map.
   */
  topBand?: number
}

/** How far a focused cell grows — see `TerritoryOptions.focusMode`. */
export type FocusMode = 'open' | 'details'

/**
 * WHAT A DETAILS GROW ADDS AROUND ITS CELL on a grouped root: the country's
 * inset, padding and label row, the cell's own gap — and room for a row or a
 * column of its neighbours at their floor, so the country never grows to a
 * size only the details cell fits in.
 */
export function detailsCountryTarget(cellTarget: CellSize, siblings: boolean): CellSize {
  return grownBy(cellTarget, {
    w: GROUP_INSET * 2 + GROUP_PAD * 2 + CELL_INSET_IN_GROUP * 2 + (siblings ? FOCUS_MIN.w : 0),
    h: GROUP_INSET * 2 + GROUP_LABEL_H + GROUP_PAD + CELL_INSET_IN_GROUP * 2 + (siblings ? FOCUS_MIN.h : 0),
  })
}

/**
 * The most of its country's inner a details cell may take: a country grown
 * only as far as the cell needs has little else in it, so the cell may take
 * most of it — the country stays small, and so the grow does.
 */
export const DETAILS_INNER_MAX_SHARE = 0.9

/** A focus fit as `squarifyFocused` options, or none. */
function fitOptions(fit: FocusFit | null, maxShare: number): { share?: number; minSide?: FocusFit['minSide']; maxShare?: number } {
  return fit === null ? {} : { share: fit.share, minSide: fit.minSide, maxShare }
}

/** The title block's constant lead — what this sheet IS, and what area means. */
const BLOCK_SHEET = 'Features'
/** What the title block says area MEANS — the sheet's resolved unit, in words.
 *  A sheet that fell back must say so, or the reader compares two pictures
 *  believing they were drawn to one scale. */
function blockMeasure(unit: SheetUnit): string {
  return unit === 'lines' ? 'area = lines of code' : 'area = anchors (not measured)'
}
const DEFAULT_SOURCE = 'features graph'

/**
 * `41.2k`, `120k`, `1.3M` — a count that fits a kicker. Under a thousand it is
 * the number itself; a figure nobody reads to the unit is rounded to one.
 */
export function formatCount(count: number): string {
  if (count < 1000) return String(count)
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, '')}k`
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/**
 * A country's label-row sentence: `4 features · 120 files · 50% understood`.
 *
 * The first cut printed the domain's NAME and nothing else, and a reader
 * looking at the root saw countries that said nothing about what they held
 * ("the domain modules without relevant information"). Each piece is read from
 * its own kind: features counted as features, files as the size the CLI
 * measured, understanding as the share of features whose own understanding is
 * `learned` — never a module count re-labelled.
 */
export function groupSummaryFor(input: { features: number; files: number; learned: number }): string {
  const pieces: string[] = []
  if (input.features > 0) pieces.push(plural(input.features, 'feature'))
  if (input.files > 0) pieces.push(plural(input.files, 'file'))
  if (input.features > 0) {
    pieces.push(`${String(Math.round((input.learned / input.features) * 100))}% understood`)
  }
  return pieces.join(' · ')
}


/**
 * WHAT A SHEET'S AREA IS COUNTED IN.
 *
 * `lines` when the CLI measured every node the sheet lays out; `anchors` when
 * even one node came back unmeasured.
 */
export type SheetUnit = 'lines' | 'anchors'

/**
 * THE UNIT IS A PROPERTY OF THE SHEET, NEVER OF A NODE.
 *
 * A per-node fallback (`size?.lines ?? anchorCount`) lets one packing mix two
 * scales: a feature standing on 54,000 lines reports `9` while a prediction is
 * valued at anchors x 120, and the prediction wins the sheet. Both numbers were
 * right; only the comparison was meaningless.
 *
 * So the fallback is decided ONCE, for everything laid out together. One
 * unmeasured node puts the whole sheet in anchors — a coarser picture in which
 * every rectangle is still comparable to every other, which is the only
 * property area has to have.
 *
 * An empty sheet is `lines`: there is nothing to be incomparable with, and it
 * keeps the title block on its normal reading.
 */
export function sheetUnitFor(
  nodes: readonly (Pick<FeatureGraphNodeInput, 'size'> | undefined)[],
): SheetUnit {
  return nodes.every((node) => (node?.size?.lines ?? null) !== null) ? 'lines' : 'anchors'
}


function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** A rect that can be drawn — never negative, so a degenerate stage collapses
 *  to a point instead of spilling the wrong way. */
function safeRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, w: Math.max(0, rect.w), h: Math.max(0, rect.h) }
}

/**
 * Whether a KIND may carry the open-level control.
 *
 * A function of the kind alone, and read from the kind — never re-derived from
 * a child count or an anchor total, which is the discipline `activationOf`
 * records ("the test is `kind === 'part'`, NEVER `childCount === 0`"). A domain
 * renders no feature view of its own, so drawing a control on one would
 * advertise a door that does not exist for that kind of node at all.
 */
export function hasControlFor(kind: FocusNodeKind): boolean {
  return kind === 'feature' || kind === 'part'
}

/**
 * The sheet the cells are packed into: the stage, less the two chrome bands —
 * and less `band` at the top when a bar is shown above the cells (the classify
 * offer), so the bar takes room from the sheet instead of covering a cell.
 */
export function sheetRect(stage: StageSize, band = 0): Rect {
  const top = Math.max(0, band)
  return safeRect({
    x: SHEET_MARGIN,
    y: TITLE_STRIP_H + top,
    w: stage.width - SHEET_MARGIN * 2,
    h: stage.height - TITLE_STRIP_H - TITLE_BLOCK_H - top,
  })
}

/** The rectangle `inset(rect, d)` was cut from. */
function outset(rect: Rect, d: number): Rect {
  return { x: rect.x - d, y: rect.y - d, w: rect.w + 2 * d, h: rect.h + 2 * d }
}

/** Where a group's features are packed: below its label row, inside its padding. */
export function groupInner(rect: Rect): Rect {
  return safeRect({
    x: rect.x + GROUP_PAD,
    y: rect.y + GROUP_LABEL_H,
    w: rect.w - GROUP_PAD * 2,
    h: rect.h - GROUP_LABEL_H - GROUP_PAD,
  })
}

/**
 * The second line — `N parts · M changes · active`, in the level's own nouns.
 *
 * EVERY PIECE IS READ FROM ITS OWN KIND. A feature counts its PARTS and, apart
 * from them, the CHANGES that touched it; a part counts the ANCHORS it names; a
 * domain counts its FEATURES. The three words are not interchangeable, and no
 * count here is a subtraction of one kind from a total.
 *
 * A piece worth nothing is left out rather than printed as a zero, and a line
 * with no pieces is `null`: "0 parts" under sixteen of nineteen cells is the
 * texture `kickerFor` was rewritten to remove.
 */
export function secondLineFor(input: {
  kind: FocusNodeKind
  childCount: number
  changeCount: number
  anchorCount: number
  active: boolean
  /** Files the node's anchors resolve to — its SIZE, first on the line. 0 or
   *  absent when the CLI did not measure, and the line says nothing about it. */
  files?: number
}): string | null {
  const pieces: string[] = []
  const files = input.files ?? 0
  if (input.kind === 'domain' && input.childCount > 0) {
    pieces.push(plural(input.childCount, 'feature'))
  }
  if (input.kind === 'feature') {
    if (files > 0) pieces.push(plural(files, 'file'))
    if (input.childCount > 0) pieces.push(plural(input.childCount, 'part'))
    if (input.changeCount > 0) pieces.push(plural(input.changeCount, 'change'))
  }
  if (input.kind === 'part') {
    if (files > 0) pieces.push(plural(files, 'file'))
    else if (input.anchorCount > 0) pieces.push(plural(input.anchorCount, 'anchor'))
  }
  if (input.active) pieces.push('active')
  return pieces.length === 0 ? null : pieces.join(' · ')
}

/** A `FocusNode` paired with the area it is owed — the join `strips` consumes. */
interface Measured {
  node: FocusNode
  value: number
}

/** How many changes name `featureId` as their parent — read from `kind`. */
function changesOf(graph: FeatureGraphInput, featureId: string): number {
  return graph.nodes.filter((node) => node.kind === 'child' && node.parent === featureId).length
}



/**
 * A node's description as a cell may print it: collapsed to single spaces so a
 * markdown paragraph's own line breaks do not become ragged gaps mid-sentence,
 * and null rather than empty so every "there is nothing here" is one value.
 */
function normalizeSummary(raw: string | undefined): string | null {
  return summaryParts(raw).about
}

/**
 * A FEATURE'S TEXT, SPLIT INTO WHAT IT IS AND WHERE IT LIVES (2026-10-06).
 *
 * A feature adopted by discovery is born with one line of PROVENANCE —
 * "Confirmed from code:module/orbit_core/web." — which says how it was
 * found, not what it is; printed as a description it filled every cell with
 * machine text. It is never the description: a module address in it becomes
 * the cell's PATH, any other provenance ("surface:api-route+…") is dropped,
 * and only prose a person or a learn pass wrote is the description.
 */
export function summaryParts(raw: string | undefined): { about: string | null; path: string | null } {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim()
  if (text.length === 0) return { about: null, path: null }
  const provenance = /^confirmed from\s+(\S+?)\.?$/i.exec(text)
  if (provenance === null) return { about: text, path: null }
  const module = /^code:module\/(.+)$/.exec(provenance[1] ?? '')
  return { about: null, path: module === null ? null : (module[1] ?? null) }
}

/** Build one cell from a placed rectangle. The single place a cell's grammar
 *  lives — the board never assembles one itself. */
function cellFor(
  measured: Measured,
  rect: Rect,
  source: FeatureGraphNodeInput | undefined,
  changeCount: number,
  linkCount = 0,
  projectName?: string,
): TerritoryCell {
  const { node } = measured
  const drawn = safeRect(rect)
  const understanding =
    node.kind === 'domain' || node.kind === 'change'
      ? null
      : (source?.understanding ?? 'none')
  const active = node.kind !== 'domain' && source?.active === true
  const anchorCount = source?.anchorCount ?? 0
  // THE TYPE, AS THE CLI RESOLVED IT — copied, never re-derived. Only a
  // feature or a part has one; a domain's ground and a ghost say nothing.
  const typed = node.kind === 'feature' || node.kind === 'part'
  const rawRole: unknown = source?.role
  const role = typed && isFeatureRole(rawRole) ? rawRole : null
  const roleSource = role === null ? null : (source?.roleSource ?? 'guess')
  const labelClass = cellLabelClass(drawn.w, drawn.h)
  const roomy = isRoomy(drawn.w, drawn.h)
  const hasControl = hasControlFor(node.kind)
  const secondLine = secondLineFor({
    kind: node.kind,
    childCount: node.childCount,
    changeCount,
    anchorCount,
    active,
    files: source?.size?.files ?? 0,
  })
  // A DOMAIN HAS NO FOLDERS OF ITS OWN — its features each say where they live.
  const folders =
    node.kind === 'feature' || node.kind === 'part'
      ? cellFolders(folderSlice(source?.folders, node.name, projectName), restingFolderTier(drawn.w, drawn.h), 0)
      : null
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    understanding,
    active,
    secondLine: roomy ? secondLine : null,
    links: linkCount,
    // AT REST: the name, one home line and the description (the user,
    // 2026-10-08: "by default we need show the description") — the folder
    // rows wait for the hover's details. The description is the store's own
    // words, trimmed and never generated; a cell too small for one says
    // nothing rather than a clipped half-sentence.
    summary: hasRoomForSummary(drawn.w, drawn.h) ? normalizeSummary(source?.summary) : null,
    description: normalizeSummary(source?.summary),
    // THE HOME LINE REPLACES THE PROVENANCE PATH: a node with rows says where
    // it lives through `folders`; the module path read from a provenance line
    // is kept only for a node the CLI found no files for.
    path: roomy && folders === null ? summaryParts(source?.summary).path : null,
    folders,
    hasControl,
    controlTitle: hasControl ? controlTitle(node.name, anchorCount > 0) : null,
    stale: understanding === 'stale',
    role,
    roleSource,
    showRoleIcon: role !== null && roleIconShownAt(labelClass),
    labelClass,
    roomy,
    rect: drawn,
    lit: false,
    dim: false,
  }
}

/**
 * Build the whole render plan for the depth `stack` names.
 *
 * `stack === []` is the root: domain GROUNDS when any core feature carries a
 * `domain:`, with that domain's features packed inside each one — else the
 * features directly, on a flat sheet. Deeper, the top of the stack is the title
 * strip and its `levelItems` result is the sheet.
 *
 * Deterministic: no clock, no randomness, no iteration over a Set for output
 * order. Same graph, same stack, same stage → identical output, which is what
 * lets the board redraw on every resize without the sheet reshuffling under the
 * reader.
 */
export function buildTerritoryView(
  graph: FeatureGraphInput,
  stack: readonly FocusNode[] = [],
  options: TerritoryOptions = {},
): TerritoryView {
  const stage = options.stage ?? DEFAULT_STAGE
  const sheet = sheetRect(stage, options.topBand ?? 0)
  const grown = options.focus ?? null
  const details = options.focusMode === 'details'
  // WHERE THE GROWN CELL IS DRAWN NOW, when the grow moves to it from another:
  // the layout around the previous one, read back (cells and countries are
  // drawn inset; the layout works on the rectangles before the gap).
  const previous = options.previous ?? null
  const prior =
    grown !== null && previous !== null && previous !== grown
      ? buildTerritoryView(graph, stack, { ...options, focus: previous, previous: null })
      : null
  const priorCell = prior?.cells.find((cell) => cell.id === grown) ?? null
  const priorGroup = prior?.groups.find((group) => group.cellIds.includes(grown ?? '')) ?? null
  const focusView = buildFeatureFocusView(graph, stack, {
    fetchFailure: options.fetchFailure ?? null,
  })
  const focus = stack.length === 0 ? null : stack[stack.length - 1]
  const items = levelItems(graph, focus)
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const grouped = focus === null && items.length > 0 && items.every((item) => item.kind === 'domain')

  // AREA IS SIZE: the lines a node's anchors stand on, measured by the CLI.
  // An older bundle sends no `size`, and then the whole sheet counts anchors
  // instead — resolved HERE, from every node that will be laid out, so no
  // caller can pick its own scale (see `sheetUnitFor`). On a grouped root the
  // laid-out population is the features inside the countries, not the
  // countries: a domain's value is a sum of theirs.
  const laidOut = grouped ? items.flatMap((domain) => levelItems(graph, domain)) : items
  const unit = sheetUnitFor(laidOut.map((node) => byId.get(node.id)))
  const sizeOf = (id: string): number => {
    const node = byId.get(id)
    if (node === undefined) return 0
    return unit === 'lines' ? (node.size?.lines ?? 0) : node.anchorCount
  }
  const filesOf = (id: string): number => byId.get(id)?.size?.files ?? 0
  const learnedOf = (id: string): number => (byId.get(id)?.understanding === 'learned' ? 1 : 0)

  const groups: TerritoryGroup[] = []
  const cells: TerritoryCell[] = []

  const emit = (measured: Measured, rect: Rect): TerritoryCell => {
    const cell = cellFor(
      measured,
      rect,
      byId.get(measured.node.id),
      measured.node.kind === 'feature' ? changesOf(graph, measured.node.id) : 0,
      // WHAT IT TOUCHES, counted from the same join the hover lights, so the
      // number on a cell and the set it highlights cannot disagree — one is
      // the length of the other.
      measured.node.kind === 'feature'
        ? relationsOf(measured.node.id, graph.edges ?? []).length
        : 0,
      options.project,
    )
    cells.push(cell)
    return cell
  }

  if (grouped) {
    // A COUNTRY IS SIZED BY WHAT STANDS IN IT — the lines its features stand
    // on — so a domain never gets an area its contents cannot fill.
    const countries = items.map((domain) => ({
      node: domain,
      features: levelItems(graph, domain),
    }))
    const countryItems = countries.map((country) => ({
      country,
      value: country.features.reduce((sum, feature) => sum + sizeOf(feature.id), 0),
    }))
    const focusCountry = grown === null ? -1 : countries.findIndex((country) => country.features.some((feature) => feature.id === grown))
    // WHERE EACH COUNTRY WAS before the focus — the cuts its cells regrow in.
    const plainCountries = squarifyFocused(countryItems, sheet, -1)
    const plainInner = new Map(plainCountries.map((placed) => [placed.country.node.id, groupInner(placed)]))
    // A DETAILS GROW: the country grows only as far as its cell's details need.
    const focusCountryNow =
      priorGroup !== null
        ? outset(priorGroup.rect, GROUP_INSET)
        : plainCountries.find((placed) => placed.country === countries[focusCountry])
    const countryFit =
      details && focusCountry >= 0 && focusCountryNow !== undefined
        ? detailsFit(
            sheet,
            focusCountryNow,
            detailsCountryTarget(DETAILS_TARGET, (countries[focusCountry]?.features.length ?? 0) > 1),
            FOCUS_OUTER_SHARE,
          )
        : null
    const placedCountries = squarifyFocused(countryItems, sheet, focusCountry, {
      share: FOCUS_OUTER_SHARE,
      min: GROUP_FOCUS_MIN,
      ...(priorGroup === null ? {} : { was: outset(priorGroup.rect, GROUP_INSET) }),
      ...fitOptions(countryFit, FOCUS_OUTER_SHARE),
    })
    for (const placed of placedCountries) {
      const whole: Rect = { x: placed.x, y: placed.y, w: placed.w, h: placed.h }
      const group: TerritoryGroup = {
        id: placed.country.node.id,
        label: placed.country.node.name,
        summary: groupSummaryFor({
          features: placed.country.features.length,
          files: placed.country.features.reduce((sum, feature) => sum + filesOf(feature.id), 0),
          learned: placed.country.features.reduce((sum, feature) => sum + learnedOf(feature.id), 0),
        }),
        rect: inset(whole, GROUP_INSET),
        inner: groupInner(whole),
        cellIds: [],
        lit: false,
        dim: false,
      }
      groups.push(group)
      const inhabitants: Measured[] = placed.country.features.map((feature) => ({
        node: feature,
        value: sizeOf(feature.id),
      }))
      const focusCell = grown === null ? -1 : inhabitants.findIndex((entry) => entry.node.id === grown)
      const before = plainInner.get(placed.country.node.id)
      const cellNow =
        focusCell < 0
          ? undefined
          : priorCell !== null
            ? outset(priorCell.rect, CELL_INSET_IN_GROUP)
            : before === undefined
              ? undefined
              : squarifyFocused(inhabitants, before, -1).find((entry) => entry.node.id === grown)
      const cellFit =
        details && cellNow !== undefined
          ? detailsFit(group.inner, cellNow, grownBy(DETAILS_TARGET, { w: CELL_INSET_IN_GROUP * 2, h: CELL_INSET_IN_GROUP * 2 }), DETAILS_INNER_MAX_SHARE)
          : null
      const packed = squarifyFocused(inhabitants, group.inner, focusCell, {
        ...(focusCell < 0 || before === undefined ? {} : { from: before }),
        // A DOMAIN THAT SHRANK for another's feature keeps its own names.
        ...(focusCell < 0 && focusCountry >= 0 ? { floor: FOCUS_MIN } : {}),
        ...(focusCell < 0 || priorCell === null ? {} : { was: outset(priorCell.rect, CELL_INSET_IN_GROUP) }),
        ...fitOptions(cellFit, DETAILS_INNER_MAX_SHARE),
      })
      for (const placedCell of packed) {
        const cell = emit(
          { node: placedCell.node, value: placedCell.value },
          inset(
            { x: placedCell.x, y: placedCell.y, w: placedCell.w, h: placedCell.h },
            CELL_INSET_IN_GROUP,
          ),
        )
        group.cellIds.push(cell.id)
      }
    }
  } else {
    const flat: Measured[] = items.map((item) => ({ node: item, value: sizeOf(item.id) }))
    const focusCell = grown === null ? -1 : flat.findIndex((entry) => entry.node.id === grown)
    const was = focusCell < 0 || priorCell === null ? {} : { was: outset(priorCell.rect, CELL_INSET) }
    const cellNow =
      focusCell < 0
        ? undefined
        : priorCell !== null
          ? outset(priorCell.rect, CELL_INSET)
          : squarifyFocused(flat, sheet, -1).find((entry) => entry.node.id === grown)
    const cellFit =
      details && cellNow !== undefined
        ? detailsFit(sheet, cellNow, grownBy(DETAILS_TARGET, { w: CELL_INSET * 2, h: CELL_INSET * 2 }))
        : null
    for (const placed of squarifyFocused(flat, sheet, focusCell, { ...was, ...fitOptions(cellFit, FOCUS_SHARE) })) {
      emit(
        { node: placed.node, value: placed.value },
        inset({ x: placed.x, y: placed.y, w: placed.w, h: placed.h }, CELL_INSET),
      )
    }
  }

  return {
    level: focus === null ? 'root' : focus.kind,
    depth: stack.length,
    title: titleFor(graph, stack, groups, options, unit),
    groups,
    cells,
    crumbs: focusView.crumbs,
    empty: focusView.empty,
    emptyReason: focusView.emptyReason,
    footerNote: footerNoteFor(graph, stack.length),
    sheet,
  }
}

/**
 * WHAT THE ROOT IS NOT SHOWING.
 *
 * Unparented CHANGE RECORDS — plans and issues whose feature could not be
 * identified. They belong to no capability, so they appear at no depth, and no
 * cap in this board is allowed to hide what it hid.
 *
 * The ring's version of this sentence counted the same records and called them
 * "features", which is the two-words-one-meaning collapse this whole feature
 * exists to end. Same measurement, same place, correct noun.
 */
export function footerNoteFor(graph: FeatureGraphInput, depth: number): string | null {
  if (depth !== 0) return null
  const known = new Set(graph.nodes.map((node) => node.id))
  const orphans = graph.nodes.filter(
    (node) => node.kind === 'child' && (node.parent === undefined || !known.has(node.parent)),
  ).length
  if (orphans === 0) return null
  return `${plural(orphans, 'change record')} whose feature could not be identified`
}

/**
 * The strip's own count line.
 *
 * At the root it is the whole store — every CAPABILITY, and the countries they
 * are grouped into. Deeper it is what the focused node holds, in that node's
 * own nouns. Each count is read from its own kind; none is a total minus
 * another kind.
 */
function kickerFor(
  graph: FeatureGraphInput,
  focus: FocusNode | null,
  domainCount: number,
  anchorCount: number,
  size: { files: number; lines: number } | null,
): string {
  if (focus === null) {
    const features = graph.nodes.filter((node) => node.kind === 'core').length
    const pieces = [plural(features, 'feature')]
    if (domainCount > 0) pieces.push(plural(domainCount, 'domain'))
    if (size !== null && size.lines > 0) pieces.push(`${formatCount(size.lines)} lines`)
    return pieces.join(' · ')
  }
  const pieces: string[] = []
  if (focus.kind === 'domain') pieces.push(plural(focus.childCount, 'feature'))
  if (focus.kind === 'feature') pieces.push(plural(focus.childCount, 'part'))
  // SIZE WHEN IT WAS MEASURED, the anchor count when it was not — never both,
  // and never a count of anchors dressed as a size.
  if (size !== null && size.files > 0) {
    pieces.push(plural(size.files, 'file'))
    if (size.lines > 0 && focus.kind !== 'domain') pieces.push(`${formatCount(size.lines)} lines`)
  } else if (anchorCount > 0) {
    pieces.push(plural(anchorCount, 'anchor'))
  }
  return pieces.join(' · ')
}

/**
 * How much code the focused level stands on. The root and a domain SUM their
 * features (a domain has no anchors of its own); a feature or a part carries
 * its own measurement. `null` when nothing on the level was measured.
 */
function sizeAt(graph: FeatureGraphInput, focus: FocusNode | null): { files: number; lines: number } | null {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const own = focus === null ? undefined : byId.get(focus.id)?.size
  if (own !== undefined) return own
  const members =
    focus === null
      ? graph.nodes.filter((node) => node.kind === 'core')
      : levelItems(graph, focus).map((item) => byId.get(item.id)).filter((node) => node !== undefined)
  let files = 0
  let lines = 0
  let measured = false
  for (const node of members) {
    if (node.size === undefined) continue
    measured = true
    files += node.size.files
    lines += node.size.lines
  }
  return measured ? { files, lines } : null
}

/** The title strip and the title block — where you are, what it holds, and what
 *  the sheet's areas mean. */
function titleFor(
  graph: FeatureGraphInput,
  stack: readonly FocusNode[],
  groups: readonly TerritoryGroup[],
  options: TerritoryOptions,
  unit: SheetUnit,
): TerritoryTitleView {
  const focus = stack.length === 0 ? null : stack[stack.length - 1]
  const parent = stack.length >= 2 ? stack[stack.length - 2] : null
  const project = (options.project ?? '').trim()
  const source = (options.source ?? '').trim()
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const anchorCount = focus === null ? 0 : (byId.get(focus.id)?.anchorCount ?? 0)
  const name = focus === null ? (project.length > 0 ? project : FOCUS_ROOT_LABEL) : focus.name
  const showControl = focus !== null && hasControlFor(focus.kind)
  const showCorpusControl = focus !== null && focus.kind === 'feature'
  return {
    name,
    prefix: parent === null ? '' : `${parent.name} ›`,
    kicker: kickerFor(graph, focus, groups.length, anchorCount, sizeAt(graph, focus)),
    showControl,
    controlTitle: showControl ? controlTitle(name, anchorCount > 0) : '',
    showCorpusControl,
    corpusControlTitle: showCorpusControl ? corpusControlTitle(name) : '',
    showBrainField: queryAvailableAtDepth(stack.length),
    block: [BLOCK_SHEET, blockMeasure(unit), project, source.length > 0 ? source : DEFAULT_SOURCE]
      .filter((part) => part.length > 0)
      .join(' · '),
  }
}

/* ── ONE LIT/DIM RULE, FOR EVERY OVERLAY ────────────────────────────────────
 *
 * The popover's neighbourhood, the brain query's hits (`buildBrainHighlight`),
 * a story step (`story-adapter.ts`), changeset mode and the Learning lens's
 * hover all say the same thing to the sheet: THESE, and not the others. They
 * said it five different ways on the ring, which is how "dim" came to mean
 * something slightly different depending on which overlay had spoken last.
 *
 * One function, so no overlay invents its own (allowed-pattern #14).
 */

export interface DecorateOptions {
  /** The ids to light. Anything not drawn at this level is ignored — an
   *  overlay is allowed to name nodes that are one depth away. */
  lit?: Iterable<string>
  /** True when everything unlit should recede. False (the default) lights
   *  without dimming, which is what a hover wants and a query does not. */
  dimOthers?: boolean
}

/**
 * Apply an overlay to a view, returning a NEW view — the argument is never
 * mutated, so a board can hold one undecorated render plan and derive every
 * overlay from it.
 *
 * THREE RULES:
 *  1. LIT WINS. A cell is never both lit and dim; a lit cell is the answer, and
 *     dimming the answer is the one thing an overlay must not do.
 *  2. A GHOST DIMS LIKE A CELL. A prediction is not exempt from the question
 *     being asked, and leaving ghosts bright while the sheet recedes would make
 *     a proposal read as a hit.
 *  3. A GROUP DIMS ONLY WHEN NOTHING INSIDE IT IS LIT. A country holding one
 *     lit province is part of the answer; dimming its ground would push that
 *     province into a hole.
 *
 * `decorate(view)` with no options is how an overlay is CLEARED.
 */
export function decorate(view: TerritoryView, options: DecorateOptions = {}): TerritoryView {
  const lit = new Set(options.lit ?? [])
  const dimOthers = options.dimOthers === true
  const cells = view.cells.map((cell) => {
    const isLit = lit.has(cell.id)
    return { ...cell, lit: isLit, dim: dimOthers && !isLit }
  })
  const litIds = new Set(cells.filter((cell) => cell.lit).map((cell) => cell.id))
  const groups = view.groups.map((group) => {
    const isLit = lit.has(group.id) || group.cellIds.some((id) => litIds.has(id))
    return { ...group, lit: isLit, dim: dimOthers && !isLit }
  })
  return { ...view, cells, groups }
}

/**
 * Which of a running pass's marks land on THIS sheet.
 *
 * `inFlightMarks` (in `learn-inflight.ts`) already decides what each mark
 * MEANS — `self` on the feature being understood and on each part whose record
 * that pass is writing, `within` on every ancestor above it. This is the join
 * to what is drawn: at the root a feature is a cell and its domain is a group,
 * so both collections are consulted, and an id the level does not draw is
 * dropped rather than reported to a board that has nowhere to put it.
 *
 * Deterministic: cells in drawn order, then groups, so the same pass marks the
 * same sheet the same way every render.
 */
/* ── THE ONE CHOOSER OF A NODE'S PROGRESS (Phase 8) ─────────────────────────*/

/** What a percentage is a percentage OF. The rim has room for "40%" and nothing
 *  else, so the population lives in the hover — and it must be carried, because
 *  40% of the files read is not 40% of the pass. */
export type ProgressPopulation = 'parts' | 'files'

/** The node fields `progressFor` reads. A `FeatureGraphNodeInput` satisfies it;
 *  the shape is narrowed so a test needs three fields rather than a graph. */
export interface ProgressNode {
  id: string
  slug: string
  kind: 'core' | 'child' | 'part'
  understanding: FeatureUnderstanding
  partOf?: string
}

/** What the pass and the store say about a node's progress. Two live maps and
 *  the graph — nothing here reads a snapshot, a panel, or the DOM. */
export interface ProgressSources {
  /** `learn:featureParts` — the pass's own `{parts, learned}`, by feature ref. */
  featureParts?: ReadonlyMap<string, { parts: number; learned: number }>
  /** `learn:featureReadProgress` — `{read, total}` files, by feature ref. */
  featureRead?: ReadonlyMap<string, { read: number; total: number }>
  /** The feature graph's nodes, for a feature whose pass has already gone. */
  nodes?: readonly ProgressNode[] | null
  /**
   * `standingProgress(nodes)`, computed once by a caller that is about to ask
   * about MANY nodes — the sheet painting a percentage on every cell.
   *
   * It is the same map `progressFor` would build for itself, so an index and a
   * bare `nodes` can never answer differently; passing it only decides whether
   * the graph is walked once per paint or once per rectangle.
   */
  standing?: ReadonlyMap<string, { done: number; total: number; of: ProgressPopulation }>
}

/**
 * THE STORE'S ANSWER FOR EVERY NODE, in one pass (source 3 of `progressFor`).
 *
 * A FEATURE'S FRACTION IS ITS PARTS'. `understoodBySlug` groups them by the
 * owner's slug and this joins that back to the owner's node id.
 *
 * A PART GETS NONE, DELIBERATELY. Parts carry their OWNER's slug (the CLI writes
 * `slug: feature.slug` on every part node), so looking a part's own slug up in
 * that index hands back the owner's figure — which is how main's collar came to
 * print the same "100%" under all ten parts of a feature that was 100%. Each of
 * those numbers was about the ring, not about the disc it sat under. A part is
 * a single artifact: it is learned or it is not, its dot says which, and a
 * percentage of one thing is not a measurement.
 *
 * Empty for a null graph — a board with nothing loaded reports nothing.
 */
export function standingProgress(
  nodes: readonly ProgressNode[] | null | undefined,
): Map<string, { done: number; total: number; of: ProgressPopulation }> {
  const out = new Map<string, { done: number; total: number; of: ProgressPopulation }>()
  if (nodes === null || nodes === undefined) return out
  const bySlug = understoodBySlug(nodes)
  for (const node of nodes) {
    if (node.kind === 'part') continue
    const understood = bySlug.get(node.slug)
    if (understood === undefined) continue
    out.set(node.id, { ...understood, of: 'parts' })
  }
  return out
}

/**
 * The real fraction behind a NODE's progress, or null when there is not one.
 *
 * ONE CHOOSER, WHATEVER WEARS THE ANSWER. Main's SVG collar asked
 * `#learnFraction`; the Territory cell's dial and the title strip's figure ask
 * this, and `#learnFraction` is a thin caller of it — one number with one
 * provenance, or the three drift (allowed-pattern #14). The board keeps only
 * the branch this cannot be pure about: the PROJECT's own figure, which needs
 * the learning snapshot and which sheet is on stage.
 *
 * THE SOURCE ORDER IS MAIN'S, UNCHANGED:
 *
 *  1. THE PASS'S OWN PARTS (`learn:featureParts`). The pass names them once it
 *     has found them and again after each is investigated, so this is a number
 *     the app actually knows.
 *  2. READING, the fraction that exists BEFORE the parts do. A pass ranks its
 *     files up front and reports each as it lands, so this is true from the
 *     first second — where parts only become true minutes in, and for a feature
 *     with no parts never do. It STOPS being a fraction when the reading ends:
 *     composing the drawing and the learnings is the rest of the pass and has no
 *     ratio of its own, and holding at a full 100% through it would be the
 *     "stuck at 99%" lie told the other way round.
 *  3. THE STORE, after the pass that drew it has gone — `standingProgress`,
 *     which is also what the sheet paints on every QUIET cell. The live maps
 *     are empty on a fresh window, so without this a finished feature has no
 *     figure at all until it is learned again, which is precisely the state a
 *     reader opening the board is normally in. `stale` is not done.
 *
 * Anything else is `null`, and the caller MARCHES instead of filling (or, for a
 * cell with no pass on it, shows nothing at all). A node with no parts named
 * yet has no percentage, and the one thing this must never do is put a figure
 * under a reader's eye that nothing computed.
 */
export function progressFor(
  nodeId: string | null,
  sources: ProgressSources = {},
): { done: number; total: number; of: ProgressPopulation } | null {
  if (nodeId === null) return null
  const parts = sources.featureParts?.get(nodeId)
  if (parts !== undefined && parts.parts > 0) {
    return { done: parts.learned, total: parts.parts, of: 'parts' }
  }
  const read = sources.featureRead?.get(nodeId)
  if (read !== undefined && read.total > 0 && read.read < read.total) {
    return { done: read.read, total: read.total, of: 'files' }
  }
  // ONE EXPRESSION OF SOURCE 3, whether the caller asks about one node or all
  // of them: a caller with an index passes it, and a caller without one builds
  // the same index for this one lookup. Two spellings of "what its parts say"
  // is exactly the drift this file exists to prevent.
  const standing = sources.standing ?? standingProgress(sources.nodes)
  return standing.get(nodeId) ?? null
}

export function inFlightFor(
  view: Pick<TerritoryView, 'cells' | 'groups'>,
  marks: ReadonlyMap<string, InFlightMark>,
): Map<string, InFlightMark> {
  const out = new Map<string, InFlightMark>()
  for (const cell of view.cells) {
    const mark = marks.get(cell.id)
    if (mark !== undefined) out.set(cell.id, mark)
  }
  for (const group of view.groups) {
    const mark = marks.get(group.id)
    if (mark !== undefined && !out.has(group.id)) out.set(group.id, mark)
  }
  return out
}

/**
 * WHAT THE SHEET ITSELF WITHHELD — this level's contribution to the
 * limitations disclosure (`limitations-model.ts`).
 *
 * Territory draws EVERY cell at the level: nothing is capped away, which is the
 * whole difference from a ring that hid every label once it passed twelve
 * nodes. But a cell smaller than `LABEL_SHORT_MIN` prints no name — and a name
 * that is not on the sheet is a name the reader cannot find, whatever the
 * reason. So it is counted and said, in the one place the board already reports
 * what it hid.
 *
 * Returns `[]` when every drawn cell carries its name, which is the honest
 * answer: a cap that did not bite produces no row (`cappedRows`).
 */
export function territoryCaps(view: Pick<TerritoryView, 'cells'>): AppliedCap[] {
  const nameless = view.cells.filter(
    (cell) => cell.labelClass === 'dot' || cell.labelClass === 'blank',
  ).length
  if (nameless === 0) return []
  return [
    {
      noun: { one: 'name', many: 'names' },
      hidden: nameless,
      of: view.cells.length,
      // The cap is a SIZE, in CSS pixels, not a count — a cell below it has
      // nowhere to put a line of text. `LABEL_SHORT_MIN` is the last tier that
      // still prints one, so it is the threshold a name is lost at.
      cap: LABEL_SHORT_MIN.w,
      where: 'the sheet',
    },
  ]
}

/**
 * What clicking a cell's BODY means — the one rule, stated once.
 *
 * A CELL WITH A LEVEL BELOW IT DIVES; THE LAST LEVEL READS AS A STORY (plan
 * cell-hover-diagram, FR-6). A `part` is a leaf by definition, and a feature
 * with no parts has nothing under it either, so pressing either opens its code
 * storyline — the part page (component strip + file boxes) is gone. A domain
 * always dives: it is a grouping with no files of its own to read.
 *
 * `partCount` is the node's own child count (`FocusNode.childCount`), which
 * counts PARTS only — never the changes that touched a feature.
 */
export type CellActivation = 'dive' | 'story'

export function activationOf(cell: Pick<TerritoryCell, 'kind'>, partCount: number): CellActivation {
  if (cell.kind === 'part') return 'story'
  if (cell.kind === 'feature' && partCount === 0) return 'story'
  return 'dive'
}

/**
 * THE FOCUS NODE BEHIND EVERY CELL THIS LEVEL DRAWS.
 *
 * A `TerritoryCell` carries what the sheet needs to DRAW — an id, a name, a
 * rectangle. A dive needs something else entirely: the `FocusNode` the depth
 * algebra pushes (`depthDive` → `push`), which knows whether the node can be
 * drilled at all and how many children it has. The board could re-derive that
 * from `levelItems`, and the first cut of Phase 4 did — but re-deriving it
 * restates the ROOT'S GROUPING RULE (countries first, then each country's
 * features) in the wiring, one copy away from disagreeing with the sheet it is
 * supposed to be about. So the rule stays here, beside the render plan that
 * already applies it, and the board looks a cell's node up by id.
 *
 * Keyed by id. Ghost cells are deliberately absent: a prediction has no node to
 * push, which is exactly why a press on one must not navigate.
 */
export function levelNodes(
  graph: FeatureGraphInput,
  stack: readonly FocusNode[] = [],
): Map<string, FocusNode> {
  const focus = stack.length === 0 ? null : stack[stack.length - 1]
  const items = levelItems(graph, focus)
  const out = new Map<string, FocusNode>()
  for (const item of items) out.set(item.id, item)
  // The root's countries are drawn as GROUNDS, and what stands on them is one
  // level further down — the same condition `buildTerritoryView` groups on.
  if (focus === null && items.length > 0 && items.every((item) => item.kind === 'domain')) {
    for (const domain of items) {
      for (const feature of levelItems(graph, domain)) out.set(feature.id, feature)
    }
  }
  return out
}

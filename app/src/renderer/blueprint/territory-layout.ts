/**
 * Territory layout (plan_blueprint_territory_v1, Phase 1) — PURE, no DOM.
 *
 * The arithmetic under the feature board's default sheet, replacing
 * the retired ring's geometry. The ring said one thing only — how many — because
 * position was `360 / n` and size was a constant disc. Territory answers three:
 * AREA is how much code a node stands on (lines, measured by the CLI), POSITION
 * is adjacency, and a level is a zoom of the level above.
 *
 * WHAT THIS MODULE OWNS
 * =====================
 *  - `squarify` — the size-sorted squarified treemap the feature sheet is packed
 *    with; `strips` — the ordered strip treemap for the surfaces where order is
 *    the information. Both turn valued items and a rectangle into placed
 *    rectangles that tile it exactly.
 *  - `inset` — the one place a gap is taken out of a rect.
 *  - `levelItems` — WHAT a level draws, by explicit kind.
 *  - `cellLabelClass` / `isRoomy` — how much of a cell's text survives its size.
 *  - `moduleOfPath` / `coverageOf` — the module join the Learning lens draws
 *    from, shared by the feature map and the code map.
 *
 * WHAT IT DOES NOT OWN
 * ====================
 * No DOM, no IPC, no CSS classes beyond the label-density word, no colours, no
 * animation (that is `territory-motion`, Phase 3), and no decision about what a
 * cell SAYS (that is `territory-view`, Phase 2). Nothing here reads a document
 * or a snapshot; everything is a function of its arguments.
 *
 * TWO PACKERS, ONE RULE EACH
 * ===========================
 *  - `squarify` — the feature sheet (root, domains, parts). Items are SORTED BY
 *    SIZE and packed so every cell is as near square as its row allows: a
 *    bigger feature is a bigger, rounder rectangle, and the biggest sits first.
 *    The first cut used ordered strips here, so a feature kept its place when
 *    its size changed — and the user could not read size off the sheet at all:
 *    "the size of each box is weird, there is no rule related to size". Area
 *    IS the rule now, and a legible area beats a remembered position.
 *  - `strips` — the ordered strip treemap, kept for the surfaces where ORDER
 *    is the information (the feature level's parts as ground, the code map's
 *    districts, the feature map's file groups): items keep input order and a
 *    cell moves only when its store does.
 */

import type { FeatureGraphInput } from './feature-view-model'
import { toFocusGraph } from './feature-view-model'
import { childrenOf, type FocusNode } from './focus-stack'
import type { BlueprintLearningEntry } from '../../shared/ipc-contract'
import { ignoreSource } from '../../shared/learn-ignore'

/** A rectangle in layout space. Origin top-left, `y` grows downward (DOM). */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** The one thing `strips` needs of an item: how much of the rect it is owed. */
export interface TerritoryValue {
  value: number
}

/** An item with the rectangle it was given. */
export type Placed<T> = T & Rect

/**
 * The smallest value any item is laid out with.
 *
 * A feature that claims no code has `anchorCount: 0`, and zero area is a lie by
 * omission — the reader sees a sheet that says the feature does not exist. The
 * floor is applied HERE rather than by each caller so "a zero still draws" is
 * one rule and not four (allowed-pattern #14); a caller that wants a different
 * measure supplies a different `value`, never a different floor.
 */
export const VALUE_FLOOR = 0.4

/**
 * How thin a tail strip may be, relative to the strip before it, before it is
 * folded into it.
 *
 * The last strip takes whatever area the ones before it left, which is
 * regularly a two-pixel ribbon across the foot of the sheet: unreadable, and
 * visually a border rather than a row of cells. Folding trades aspect ratio for
 * legibility in the one place aspect ratio has already lost.
 */
export const TAIL_FOLD_RATIO = 0.45

/** An item paired with the area it is owed, while the strips are being cut. */
interface Work<T> {
  item: T
  area: number
}

/**
 * Lay `items` out across `rect` as ordered strips.
 *
 * THE RULE, in three parts:
 *  1. items keep INPUT ORDER — a cell moves only when the store does;
 *  2. a strip keeps taking the next item while the strip's AVERAGE ASPECT RATIO
 *     improves (or holds), and closes when the next item would worsen it;
 *  3. a tail strip thinner than `TAIL_FOLD_RATIO` of the one before it is
 *     folded into it.
 *
 * Strips run along the rect's LONG side, so a wide sheet is cut into rows and a
 * tall one into columns. The placed rectangles tile `rect` exactly (up to
 * floating-point error): the strip thicknesses sum to the short side and each
 * strip's cell lengths sum to the long one.
 *
 * Deterministic: no randomness, no clock, no iteration over a Set or Map. Same
 * items and same rect → identical output, which is what lets the board redraw
 * on every resize without the sheet reshuffling under the reader.
 *
 * Returns `[]` for no items or a degenerate rect — never a cell of zero or
 * negative size.
 */
export function strips<T extends TerritoryValue>(items: readonly T[], rect: Rect): Placed<T>[] {
  const { x, y, w, h } = rect
  if (items.length === 0 || w <= 0 || h <= 0) return []

  const values = items.map((item) => Math.max(VALUE_FLOOR, item.value))
  const total = values.reduce((sum, value) => sum + value, 0)
  // Unreachable while VALUE_FLOOR > 0, and kept anyway: the guard is what makes
  // the division below safe on its own terms rather than on another constant's.
  if (total <= 0) return []

  const list: Work<T>[] = items.map((item, index) => ({
    item,
    area: (values[index] / total) * w * h,
  }))

  const horizontal = w >= h
  const side = horizontal ? w : h

  /** The mean aspect ratio (long/short, always ≥ 1) of a candidate strip. */
  const avgAspect = (strip: readonly Work<T>[]): number => {
    const stripArea = strip.reduce((sum, entry) => sum + entry.area, 0)
    const thick = stripArea / side
    return (
      strip.reduce((sum, entry) => {
        const len = entry.area / thick
        return sum + Math.max(len / thick, thick / len)
      }, 0) / strip.length
    )
  }

  const rows: Work<T>[][] = []
  let index = 0
  while (index < list.length) {
    let strip: Work<T>[] = []
    let best = Infinity
    while (index < list.length) {
      const candidate = strip.concat(list[index])
      const aspect = avgAspect(candidate)
      // The first item always joins: a strip of one has nothing to compare to,
      // and refusing it would loop forever.
      if (aspect <= best || strip.length === 0) {
        strip = candidate
        best = aspect
        index += 1
      } else {
        break
      }
    }
    rows.push(strip)
  }

  const thickOf = (strip: readonly Work<T>[]): number =>
    strip.reduce((sum, entry) => sum + entry.area, 0) / side

  if (rows.length > 1) {
    const last = rows[rows.length - 1]
    const previous = rows[rows.length - 2]
    if (thickOf(last) < TAIL_FOLD_RATIO * thickOf(previous)) {
      rows.splice(rows.length - 2, 2, previous.concat(last))
    }
  }

  const out: Placed<T>[] = []
  let across = 0
  for (const strip of rows) {
    const thick = thickOf(strip)
    let along = 0
    for (const entry of strip) {
      const len = entry.area / thick
      const placed: Rect = horizontal
        ? { x: x + along, y: y + across, w: len, h: thick }
        : { x: x + across, y: y + along, w: thick, h: len }
      out.push({ ...entry.item, ...placed })
      along += len
    }
    across += thick
  }
  return out
}

/**
 * The share of the total a valueless item is laid out with by `squarify`.
 *
 * `VALUE_FLOOR` is a count's floor — right when values are small integers,
 * invisible when they are tens of thousands of lines: a feature standing on no
 * code would be a rectangle a fraction of a pixel wide, which is the same lie
 * as not drawing it. Two percent of the sheet is small enough to say "little"
 * and big enough to show a dot.
 */
export const FLOOR_SHARE = 0.02

/**
 * THE MOST OF THE SHEET ONE ITEM MAY TAKE (user, 2026-10-06: "one module too
 * big … we should have a limit size"). By lines alone, a part standing on most
 * of a feature's code became a wall filling the screen with its eight siblings
 * crushed along the foot. Above this share an item is drawn AT this share —
 * still the biggest, by far — and the rest share what is left in proportion.
 * With fewer than four items nothing is crowded, and no ceiling applies.
 */
export const CEILING_SHARE = 0.4

/** Below this many items there is nobody to crowd, and size is drawn as it is. */
export const CEILING_MIN_ITEMS = 4

/** The ceiling for `count` items: none for a few, `CEILING_SHARE` for many. */
export function ceilingShare(count: number): number {
  return count < CEILING_MIN_ITEMS ? 1 : CEILING_SHARE
}

/**
 * Cap the largest values so none exceeds `share` of the CAPPED total. Pure.
 *
 * Capping changes the total, so the cap is solved, not guessed: capping the k
 * largest at s·T leaves T = rest / (1 − k·s); the first k for which every
 * uncapped value fits under s·T is the answer. Order and ties are kept.
 */
export function capValues(values: readonly number[], share: number): number[] {
  if (values.length <= 1 || share >= 1) return [...values]
  const sorted = values.map((value, index) => ({ value, index })).sort((a, b) => b.value - a.value)
  let rest = values.reduce((sum, value) => sum + value, 0)
  for (let k = 0; k < sorted.length; k += 1) {
    if (k * share >= 1) break
    const total = rest / (1 - k * share)
    const next = sorted[k]
    if (next === undefined || next.value <= share * total) {
      if (k === 0) return [...values]
      const capped = [...values]
      for (let i = 0; i < k; i += 1) capped[(sorted[i] as { index: number }).index] = share * total
      return capped
    }
    rest -= next.value
  }
  return [...values]
}

/**
 * Lay `items` out across `rect` as a SQUARIFIED treemap (Bruls, Huizing &
 * van Wijk), sorted by value, largest first.
 *
 * THE RULE, in three parts:
 *  1. items are sorted by DESCENDING VALUE (ties keep input order), so the
 *     biggest sits at the top-left and size reads left-to-right, top-to-bottom;
 *  2. a row keeps taking the next item while the row's WORST aspect ratio
 *     improves (or holds), and is laid along the SHORTER side of what is left,
 *     which is what keeps every cell near square;
 *  3. a value below `FLOOR_SHARE` of the total (or below `VALUE_FLOOR`) is
 *     raised to it, so a valueless item still draws — and one above
 *     `ceilingShare` is lowered to it, so no item fills the sheet alone.
 *
 * The placed rectangles tile `rect` exactly (up to floating-point error) and
 * never overlap. Deterministic: no randomness, no clock, a stable sort. Returns
 * `[]` for no items or a degenerate rect — never a zero or negative cell.
 */
export function squarify<T extends TerritoryValue>(items: readonly T[], rect: Rect): Placed<T>[] {
  return squarifyFocused(items, rect, -1)
}

/**
 * A GUILLOTINE CUT OF A RECTANGLE — how a treemap was laid out, kept so it can
 * be laid out again with other weights (plan cell-hover-diagram, the in-place
 * grow). A leaf is one item, by its index in the caller's input; a split cuts
 * its rectangle along `axis` into its children, in order, each as long as its
 * weight's share.
 *
 * Keeping the CUTS rather than the rectangles is what lets a hovered cell grow
 * where it already is: re-weighting the same tree moves every cut, but never
 * the order of the pieces — so nothing swaps places and the map breathes.
 */
export type SliceTree = { leaf: number } | { axis: 'x' | 'y'; children: SliceTree[] }

/** A squarified layout before it is drawn: its cuts, its weights, its order. */
export interface SquarifyPlan {
  /** Null for no items. */
  tree: SliceTree | null
  /** The value each input item was laid out with — floored and capped. */
  weights: number[]
  /** Input indices, in drawn order (largest first). */
  order: number[]
}

/** The squarified treemap's decisions — `squarify` is this, drawn. */
export function squarifyPlan(values: readonly number[], rect: Rect): SquarifyPlan {
  if (values.length === 0 || rect.w <= 0 || rect.h <= 0) return { tree: null, weights: [], order: [] }

  const raw = values.map((value) => Math.max(0, value))
  const rawTotal = raw.reduce((sum, value) => sum + value, 0)
  const floor = Math.max(VALUE_FLOOR, rawTotal * FLOOR_SHARE)
  const weights = capValues(
    raw.map((value) => Math.max(floor, value)),
    ceilingShare(values.length),
  )
  const total = weights.reduce((sum, value) => sum + value, 0)

  const order = weights
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value || a.index - b.index)
    .map((entry) => entry.index)
  const list = order.map((index) => ({ index, area: ((weights[index] as number) / total) * rect.w * rect.h }))
  type Entry = (typeof list)[number]

  /** The worst (largest) aspect ratio in a row of `areas` laid along `side`. */
  const worst = (row: readonly Entry[], side: number): number => {
    const sum = row.reduce((acc, entry) => acc + entry.area, 0)
    if (sum <= 0 || side <= 0) return Infinity
    let max = 0
    let min = Infinity
    for (const entry of row) {
      if (entry.area > max) max = entry.area
      if (entry.area < min) min = entry.area
    }
    const s2 = sum * sum
    const w2 = side * side
    return Math.max((w2 * max) / s2, s2 / (w2 * min))
  }

  // EACH ROW IS TWO CUTS: the row off what is left (across the long side), and
  // its cells along the row (the short side). Built innermost-last, so the tree
  // reads row 1, then everything after it.
  const rows: Array<{ across: 'x' | 'y'; cells: SliceTree }> = []
  let free: Rect = { ...rect }
  let index = 0
  while (index < list.length) {
    const alongShort = free.w >= free.h
    const side = alongShort ? free.h : free.w
    let row: Entry[] = []
    let best = Infinity
    while (index < list.length) {
      const candidate = row.concat(list[index] as Entry)
      const aspect = worst(candidate, side)
      if (aspect <= best || row.length === 0) {
        row = candidate
        best = aspect
        index += 1
      } else {
        break
      }
    }
    const rowArea = row.reduce((sum, entry) => sum + entry.area, 0)
    const thick = rowArea / side
    const leaves: SliceTree[] = row.map((entry) => ({ leaf: entry.index }))
    rows.push({
      across: alongShort ? 'x' : 'y',
      cells: leaves.length === 1 ? (leaves[0] as SliceTree) : { axis: alongShort ? 'y' : 'x', children: leaves },
    })
    free = alongShort
      ? { x: free.x + thick, y: free.y, w: free.w - thick, h: free.h }
      : { x: free.x, y: free.y + thick, w: free.w, h: free.h - thick }
  }
  // The last row takes ALL that is left — it is the rest, not a cut of it.
  let tree: SliceTree = (rows[rows.length - 1] as (typeof rows)[number]).cells
  for (let i = rows.length - 2; i >= 0; i -= 1) {
    const row = rows[i] as (typeof rows)[number]
    tree = { axis: row.across, children: [row.cells, tree] }
  }
  return { tree, weights, order }
}

/** Every leaf index of a tree, in order. */
export function treeLeaves(tree: SliceTree): number[] {
  if ('leaf' in tree) return [tree.leaf]
  return tree.children.flatMap(treeLeaves)
}

/** The same cuts with every leaf renamed through `map` — for a tree embedded in a bigger one. */
export function reindexTree(tree: SliceTree, map: readonly number[]): SliceTree {
  if ('leaf' in tree) return { leaf: map[tree.leaf] as number }
  return { axis: tree.axis, children: tree.children.map((child) => reindexTree(child, map)) }
}

function weightOf(tree: SliceTree, weights: readonly number[]): number {
  if ('leaf' in tree) return Math.max(0, weights[tree.leaf] ?? 0)
  return tree.children.reduce((sum, child) => sum + weightOf(child, weights), 0)
}

/** A child's rectangle: `length` of `parent` along `axis`, starting `offset` in. */
function sliceOf(parent: Rect, axis: 'x' | 'y', offset: number, length: number): Rect {
  return axis === 'x'
    ? { x: parent.x + offset, y: parent.y, w: length, h: parent.h }
    : { x: parent.x, y: parent.y + offset, w: parent.w, h: length }
}

/**
 * Lay a tree out across `rect`, each cut at its weight's share. Returns each
 * leaf's rectangle by its index. No minimums, no focus — the plain treemap.
 */
export function layoutTree(tree: SliceTree, rect: Rect, weights: readonly number[]): Rect[] {
  const out: Rect[] = []
  const place = (node: SliceTree, r: Rect): void => {
    if ('leaf' in node) {
      out[node.leaf] = r
      return
    }
    const total = weightOf(node, weights)
    const length = node.axis === 'x' ? r.w : r.h
    let offset = 0
    node.children.forEach((child, i) => {
      const share = total > 0 ? weightOf(child, weights) / total : 1 / node.children.length
      // The last piece takes what is left, so float error never opens a gap.
      const size = i === node.children.length - 1 ? length - offset : length * share
      place(child, sliceOf(r, node.axis, offset, size))
      offset += size
    })
  }
  place(tree, rect)
  return out
}

/**
 * THE HOVERED CELL'S SHARE OF ITS LEVEL while it is grown in place (user,
 * 2026-10-07: "decrease the others and make the selected bigger, same
 * component, same place"). Enough for its diagram to be read; the rest of the
 * level still a map.
 */
export const FOCUS_SHARE = 0.6
/**
 * THE SHARE A FOCUSED CELL'S COUNTRY TAKES — a domain on the Territory, a
 * project on the Workspace map. Higher than `FOCUS_SHARE` because the cell
 * inside still takes only its own share of it: 0.75 × 0.6 ≈ 0.45 of the sheet.
 */
export const FOCUS_OUTER_SHARE = 0.75
/**
 * THE SMALLEST A SHRUNK CELL IS DRAWN while another is grown, before its 2px
 * gap: enough for `cellLabelClass`'s short name (58 × 26) to survive, so a
 * reader can still see what is around the grown one. A floor, not a promise —
 * a level with more cells than room shares what there is.
 */
export const FOCUS_MIN: CellSize = { w: 64, h: 40 }

export interface FocusLayoutOptions {
  /** The focused leaf's share of the rect. Default `FOCUS_SHARE`; never less than its own. */
  share?: number
  /** The smallest any other leaf is drawn. Default `FOCUS_MIN`. */
  min?: CellSize
  /**
   * Where the focused leaf is drawn right now — what its new rectangle must
   * contain. Its plain place by default; the place it was SHRUNK to when the
   * grow moves to it from another cell (the pointer is resting there); its
   * place in a smaller rect when its country grew too.
   */
  was?: Rect
  /**
   * The share of the rect's width AND height the focused leaf must reach when
   * the room allows — `FOCUS_MIN_SIDE` on both axes by default (the opened
   * cell, big in both directions). A details grow passes its own target's
   * proportions (`detailsFit`); then, should the share alone come out too
   * thin or too flat, the share is raised step by step up to `maxShare`
   * until both sides are met.
   */
  minSide?: SideShare
  /** The most `share` is raised to meet an explicit `minSide`. Default `FOCUS_SHARE`. */
  maxShare?: number
}

/** A share of a rect's width and of its height. */
export interface SideShare {
  w: number
  h: number
}

/**
 * Share `total` among pieces by weight, none below its minimum — the ones a
 * plain share would put under their floor get the floor, and the rest share
 * what is left. When even the floors do not fit, they shrink together.
 */
function distribute(weights: readonly number[], mins: readonly number[], total: number): number[] {
  const n = weights.length
  if (n === 0) return []
  const minSum = mins.reduce((sum, value) => sum + value, 0)
  if (minSum >= total) {
    return minSum > 0 ? mins.map((value) => (total * value) / minSum) : weights.map(() => total / n)
  }
  const floored = weights.map(() => false)
  for (let pass = 0; pass < n; pass += 1) {
    const remaining = total - mins.reduce((sum, value, i) => (floored[i] ? sum + value : sum), 0)
    const free = weights.reduce((sum, value, i) => (floored[i] ? sum : sum + value), 0)
    const open = floored.filter((value) => !value).length
    let changed = false
    weights.forEach((weight, i) => {
      if (floored[i]) return
      const share = free > 0 ? (remaining * weight) / free : remaining / open
      if (share < (mins[i] as number) - 1e-9) {
        floored[i] = true
        changed = true
      }
    })
    if (!changed) {
      return weights.map((weight, i) => {
        if (floored[i]) return mins[i] as number
        return free > 0 ? (remaining * weight) / free : remaining / open
      })
    }
  }
  return mins.map((value) => value)
}

/**
 * THE SAME TREE WITH ONE LEAF FOCUSED — what a level looks like while its
 * hovered cell is grown in place.
 *
 * The focused leaf is weighted to `share` of the whole; every other leaf keeps
 * its weight relative to the others, shares what is left, and is never drawn
 * below `min`. ORDER IS PRESERVED — the tree's cuts are the plain layout's, in
 * the plain layout's order — so nothing swaps places.
 *
 * AND THE FOCUSED CELL GROWS WHERE IT IS: at every cut on its way down, its
 * piece is never allowed to start after, or end before, where it did before
 * (`from`). By induction its new rectangle contains its old one — so its old
 * centre, and the pointer resting on it, are still inside it. Only when the
 * other pieces' floors leave no room does that give.
 */
export function focusLayout(
  tree: SliceTree,
  weights: readonly number[],
  rect: Rect,
  focus: number,
  options: FocusLayoutOptions = {},
): Rect[] {
  const old = options.was ?? layoutTree(tree, rect, weights)[focus]
  const leaves = treeLeaves(tree)
  if (old === undefined || !leaves.includes(focus) || leaves.length === 1) return layoutTree(tree, rect, weights)
  const own = Math.max(0, weights[focus] ?? 0)
  const others = leaves.reduce((sum, leaf) => (leaf === focus ? sum : sum + Math.max(0, weights[leaf] ?? 0)), 0)
  if (others <= 0) return layoutTree(tree, rect, weights)
  const target = Math.min(1, Math.max(options.share ?? FOCUS_SHARE, own / (own + others)))
  const min = options.min ?? FOCUS_MIN
  const minSide = options.minSide ?? { w: FOCUS_MIN_SIDE, h: FOCUS_MIN_SIDE }
  let share = target
  let best = focusAtShare(tree, weights, rect, focus, old, others, share, min, minSide)
  if (options.minSide === undefined) return best
  // A DETAILS GROW REACHES ITS TARGET IN BOTH DIRECTIONS: a share met by a
  // thin strip is raised, a step at a time, until the cell is wide AND tall
  // enough — or the cap says the level has no more to give.
  const cap = Math.min(FOCUS_SHARE_CEILING, Math.max(share, options.maxShare ?? FOCUS_SHARE))
  for (let pass = 0; pass < FOCUS_GROW_PASSES && !meetsSides(best[focus], rect, minSide) && share < cap; pass += 1) {
    share = Math.min(cap, share * FOCUS_GROW_STEP)
    best = focusAtShare(tree, weights, rect, focus, old, others, share, min, minSide)
  }
  return best
}

/** True when `r` reaches `minSide` of `rect` on both axes (to the half pixel). */
function meetsSides(r: Rect | undefined, rect: Rect, minSide: SideShare): boolean {
  if (r === undefined) return false
  return r.w >= rect.w * minSide.w - SIDE_SLACK_PX && r.h >= rect.h * minSide.h - SIDE_SLACK_PX
}

/** How far `r` is from `minSide` on its worse axis: 1 = met exactly, below 1 = short. */
function sideReach(r: Rect | undefined, rect: Rect, minSide: SideShare): number {
  if (r === undefined) return 0
  const along = (size: number, whole: number, wanted: number): number =>
    wanted <= 0 ? Number.POSITIVE_INFINITY : size / Math.max(1, whole * wanted)
  return Math.min(along(r.w, rect.w, minSide.w), along(r.h, rect.h, minSide.h))
}

/**
 * The focused layout at one target share: the weight raised until the drawn
 * share reaches it, then — when the cell comes out short of `minSide` on an
 * axis — its neighbours' floors given up so it can take that axis back.
 */
function focusAtShare(
  tree: SliceTree,
  weights: readonly number[],
  rect: Rect,
  focus: number,
  old: Rect,
  others: number,
  target: number,
  min: CellSize,
  minSide: SideShare,
): Rect[] {
  // THE FLOORS COST THE FOCUS AREA: a neighbour held at its minimum height
  // across a wide row takes more than its weight. So the weight is raised until
  // the drawn share reaches the target (or stops improving) — a few
  // deterministic passes, never a search without an end.
  const whole = rect.w * rect.h
  let share = target
  let best = placeFocused(tree, weights, rect, focus, old, others, share, min)
  for (let pass = 0; pass < FOCUS_SHARE_PASSES; pass += 1) {
    const drawn = whole > 0 ? areaOfRect(best[focus]) / whole : target
    if (drawn >= target - FOCUS_SHARE_TOLERANCE || share >= FOCUS_SHARE_CEILING) break
    share = Math.min(FOCUS_SHARE_CEILING, drawn > 0 ? (share * target) / drawn : share + (target - drawn))
    best = placeFocused(tree, weights, rect, focus, old, others, share, min)
  }
  // BIG IN BOTH DIRECTIONS (the user, 2026-10-08: "we need to show big when is
  // selected, even if the rest can be really small around"). The share can be
  // met by a tall, thin rectangle when many sibling columns each keep their
  // floor; then the siblings give up their floors — they become small tiles —
  // and the opened cell takes the width (or height) back.
  const opened = best[focus]
  if (opened !== undefined && !meetsSides(opened, rect, minSide)) {
    const small = { w: Math.min(min.w, FOCUS_SMALL_MIN.w), h: Math.min(min.h, FOCUS_SMALL_MIN.h) }
    const retry = placeFocused(tree, weights, rect, focus, old, others, share, small)
    if (sideReach(retry[focus], rect, minSide) > sideReach(opened, rect, minSide)) return retry
  }
  return best
}

/**
 * THE DETAILS CELL (the user, 2026-10-08: "calm, details on hover … we should
 * make the same movement that we are already doing, move the others around").
 * A hovered cell grows in place through the same `focusLayout` re-lay a click
 * uses, but only as far as its details need: its name, a few lines of
 * description, its top folders and its foot. This is the size that holds them
 * — the cell's drawn rectangle, before its gap.
 */
export const DETAILS_TARGET: CellSize = { w: 320, h: 230 }

/** How a level is asked to grow one of its cells: the share, and both sides it must reach. */
export interface FocusFit {
  share: number
  minSide: SideShare
}

/**
 * THE SHARE A DETAILS GROW ASKS FOR — the target's area over the level's,
 * with the target clamped to the level and never smaller than the cell
 * already is (a big cell is not shrunk to show its details). `minSide` is the
 * same target as a share of each side, so `focusLayout` makes the cell wide
 * AND tall enough rather than an equal area in a thin strip. The share never
 * passes `maxShare` — a details grow stays smaller than an opened cell.
 */
export function detailsFit(
  level: CellSize,
  cell: CellSize,
  target: CellSize = DETAILS_TARGET,
  maxShare: number = FOCUS_SHARE,
): FocusFit {
  if (!(level.w > 0) || !(level.h > 0)) return { share: 0, minSide: { w: 0, h: 0 } }
  const w = Math.min(level.w, Math.max(cell.w, target.w))
  const h = Math.min(level.h, Math.max(cell.h, target.h))
  return {
    share: Math.min(maxShare, (w * h) / (level.w * level.h)),
    minSide: { w: w / level.w, h: h / level.h },
  }
}

/** `size` with `extra` added to each side — a target plus the chrome around it. */
export function grownBy(size: CellSize, extra: CellSize): CellSize {
  return { w: size.w + extra.w, h: size.h + extra.h }
}

/** An opened cell is at least this share of the level's width AND height when the room allows. */
export const FOCUS_MIN_SIDE = 0.5
/** The floor its neighbours fall to when the opened cell needs their room — a small tile. */
export const FOCUS_SMALL_MIN: CellSize = { w: 22, h: 16 }

/** How many times `focusLayout` re-weighs a focus its neighbours' floors starved. */
const FOCUS_SHARE_PASSES = 8
/** How many times a details grow raises its share to meet its sides. */
const FOCUS_GROW_PASSES = 10
/** Each raise of a details grow's share. */
const FOCUS_GROW_STEP = 1.2
/** A side within this of its target counts as met. */
const SIDE_SLACK_PX = 0.5
/** The most weight the focus is ever given — the others always keep a little. */
const FOCUS_SHARE_CEILING = 0.97
/** Close enough to the share that another pass would move nothing a reader sees. */
const FOCUS_SHARE_TOLERANCE = 1e-4

function areaOfRect(rect: Rect | undefined): number {
  return rect === undefined ? 0 : rect.w * rect.h
}

/** One pass of `focusLayout` with the focus weighted to `share`. */
function placeFocused(
  tree: SliceTree,
  weights: readonly number[],
  rect: Rect,
  focus: number,
  old: Rect,
  others: number,
  share: number,
  min: CellSize,
): Rect[] {
  const focused = weights.map((weight, i) => (i === focus ? share : ((1 - share) * Math.max(0, weight)) / others))
  return placeWithFloors(tree, focused, rect, min, focus, old)
}

/**
 * The plain treemap with a floor: every leaf at least `min` where the rect
 * allows. For the levels BESIDE a grown cell — a domain or project that shrank
 * to make room — so its own cells keep their names too.
 */
export function layoutTreeFloored(tree: SliceTree, rect: Rect, weights: readonly number[], min: CellSize): Rect[] {
  return placeWithFloors(tree, weights, rect, min, -1, null)
}

/**
 * Lay a tree out by weight with every leaf but `focus` held at `min` or more,
 * and — when `old` is given — the focused leaf never starting after, or
 * ending before, `old` at any cut on its way down.
 */
function placeWithFloors(
  tree: SliceTree,
  focused: readonly number[],
  rect: Rect,
  min: CellSize,
  focus: number,
  old: Rect | null,
): Rect[] {
  const minOf = new Map<SliceTree, CellSize>()
  const measure = (node: SliceTree): CellSize => {
    let size: CellSize
    if ('leaf' in node) size = node.leaf === focus ? { w: 0, h: 0 } : min
    else {
      const parts = node.children.map(measure)
      size =
        node.axis === 'x'
          ? { w: parts.reduce((sum, part) => sum + part.w, 0), h: Math.max(...parts.map((part) => part.h)) }
          : { w: Math.max(...parts.map((part) => part.w)), h: parts.reduce((sum, part) => sum + part.h, 0) }
    }
    minOf.set(node, size)
    return size
  }
  measure(tree)
  const along = (node: SliceTree, axis: 'x' | 'y'): number => {
    const size = minOf.get(node) as CellSize
    return axis === 'x' ? size.w : size.h
  }
  const holds = (node: SliceTree): boolean => ('leaf' in node ? node.leaf === focus : node.children.some(holds))

  const out: Rect[] = []
  const place = (node: SliceTree, r: Rect): void => {
    if ('leaf' in node) {
      out[node.leaf] = r
      return
    }
    const length = node.axis === 'x' ? r.w : r.h
    const childWeights = node.children.map((child) => weightOf(child, focused))
    const childMins = node.children.map((child) => along(child, node.axis))
    let lengths = distribute(childWeights, childMins, length)
    const k = node.children.findIndex(holds)
    if (k >= 0 && old !== null) lengths = clampAround(lengths, childWeights, childMins, k, r, node.axis, old)
    let offset = 0
    node.children.forEach((child, i) => {
      const size = i === node.children.length - 1 ? length - offset : (lengths[i] as number)
      place(child, sliceOf(r, node.axis, offset, size))
      offset += size
    })
  }
  place(tree, rect)
  return out
}

/**
 * Move a cut's pieces so the focused one (index `k`) starts no later and ends
 * no sooner than `old` did along `axis` — never squeezing a neighbour below
 * its floor to do it.
 */
function clampAround(
  lengths: readonly number[],
  weights: readonly number[],
  mins: readonly number[],
  k: number,
  parent: Rect,
  axis: 'x' | 'y',
  old: Rect,
): number[] {
  const start = axis === 'x' ? parent.x : parent.y
  const total = lengths.reduce((sum, value) => sum + value, 0)
  const oldStart = axis === 'x' ? old.x : old.y
  const oldEnd = oldStart + (axis === 'x' ? old.w : old.h)
  const sum = (from: number, to: number, values: readonly number[]): number =>
    values.slice(from, to).reduce((acc, value) => acc + value, 0)
  let before = sum(0, k, lengths)
  let after = sum(k + 1, lengths.length, lengths)
  before = Math.min(before, Math.max(sum(0, k, mins), oldStart - start))
  after = Math.min(after, Math.max(sum(k + 1, lengths.length, mins), start + total - oldEnd))
  const lead = distribute(weights.slice(0, k), mins.slice(0, k), before)
  const tail = distribute(weights.slice(k + 1), mins.slice(k + 1), after)
  return [...lead, Math.max(0, total - before - after), ...tail]
}

/**
 * `squarify` with one item grown in place (`focus` is its index in `items`;
 * -1 for none, which IS `squarify` — or, given `floor`, `squarify` with no
 * cell below it). `from` is the rect the level was laid out
 * in before the focus, when that differs from `rect` (a country that grew):
 * the cuts are that layout's. `was` is where the focused item is drawn right
 * now, when that is not its plain place (see `FocusLayoutOptions.was`). Drawn
 * order is `squarify`'s, whatever the focus.
 */
export function squarifyFocused<T extends TerritoryValue>(
  items: readonly T[],
  rect: Rect,
  focus: number,
  options: {
    share?: number
    min?: CellSize
    from?: Rect
    was?: Rect
    floor?: CellSize
    minSide?: SideShare
    maxShare?: number
  } = {},
): Placed<T>[] {
  const base = options.from ?? rect
  if (items.length === 0 || rect.w <= 0 || rect.h <= 0 || base.w <= 0 || base.h <= 0) return []
  const plan = squarifyPlan(
    items.map((item) => item.value),
    base,
  )
  if (plan.tree === null) return []
  const plain = (tree: SliceTree): Rect[] =>
    options.floor === undefined ? layoutTree(tree, rect, plan.weights) : layoutTreeFloored(tree, rect, plan.weights, options.floor)
  const rects =
    focus < 0 || focus >= items.length
      ? plain(plan.tree)
      : focusLayout(plan.tree, plan.weights, rect, focus, {
          share: options.share,
          min: options.min,
          was: options.was ?? layoutTree(plan.tree, base, plan.weights)[focus],
          ...(options.minSide === undefined ? {} : { minSide: options.minSide }),
          ...(options.maxShare === undefined ? {} : { maxShare: options.maxShare }),
        })
  return plan.order.map((index) => ({ ...(items[index] as T), ...(rects[index] as Rect) }))
}

/**
 * Shrink a rect by `d` on every side — the one place a gap is taken.
 *
 * Clamps at zero rather than going negative: a cell too small for its own gap
 * collapses to a point, and a negative width would be drawn by the browser as
 * a rect that spills the wrong way.
 */
export function inset(rect: Rect, d: number): Rect {
  return {
    x: rect.x + d,
    y: rect.y + d,
    w: Math.max(0, rect.w - 2 * d),
    h: Math.max(0, rect.h - 2 * d),
  }
}

/**
 * WHAT A LEVEL DRAWS — root, domain, feature or part.
 *
 * `focus === null` is the root: domains when any core feature carries one, else
 * the core features directly. A domain's level is its features; a feature's is
 * its PARTS; a part is a leaf and draws nothing below it.
 *
 * A CHANGE (`kind: 'child'`) IS NEVER HERE, at any depth. It is carried in the
 * graph for its parent link only; its surface is the feature brief's `Changes:`
 * line. This function does not enforce that itself — it delegates to
 * `childrenOf`, which is the single place the ring-kind rule lives (see
 * `focus-stack.ts`'s "AND A FOURTH KIND THAT IS NEVER ON IT"). That delegation
 * is the point: no count here is derived by subtracting one kind from a total,
 * so the sheet and the kicker cannot disagree about what a feature contains.
 */
export function levelItems(graph: FeatureGraphInput, focus: FocusNode | null): FocusNode[] {
  return childrenOf(toFocusGraph(graph), focus)
}

/** A minimum cell size, in CSS pixels. */
export interface CellSize {
  w: number
  h: number
}

/**
 * ALL FOUR THRESHOLDS WERE MEASURED ON A 1030 × 520 STAGE (the board's sheet at
 * the default window size with both panes open) and are re-checked against the
 * real stage in Phase 4 — they are constants here precisely so that re-check is
 * an edit to four numbers rather than to the render path.
 */

/** At or above this, a cell prints its full name. Measured on a 1030 × 520 stage; re-checked in Phase 4. */
export const LABEL_NAME_MIN: CellSize = { w: 96, h: 44 }
/** At or above this, a cell prints a smaller, truncated name (`tiny`). Measured on a 1030 × 520 stage; re-checked in Phase 4. */
export const LABEL_SHORT_MIN: CellSize = { w: 58, h: 26 }
/** At or above this, a cell prints its dot and no text (`dot`). Measured on a 1030 × 520 stage; re-checked in Phase 4. */
export const LABEL_DOT_MIN: CellSize = { w: 22, h: 16 }
/** At or above this, a cell has room for a SECOND line beneath its name. Measured on a 1030 × 520 stage; re-checked in Phase 4. */
export const ROOMY_MIN: CellSize = { w: 150, h: 64 }

const atLeast = (w: number, h: number, min: CellSize): boolean => w >= min.w && h >= min.h

/**
 * How much of a cell's label survives its size.
 *
 * `''` full name · `'tiny'` shortened name · `'dot'` the dot alone · `'blank'`
 * nothing at all. This is the whole of "names degrade by cell size instead of
 * vanishing past 12 nodes": the ring hid every label once it held more than a
 * dozen nodes — exactly when the sheet was full and the reader needed them most.
 * A cell never loses its name because a SIBLING is crowded, only because it is
 * itself too small to hold one.
 *
 * BOTH dimensions must clear a tier: a 400 × 12 ribbon has plenty of width and
 * nowhere to put a line of text.
 */
export function cellLabelClass(w: number, h: number): '' | 'tiny' | 'dot' | 'blank' {
  if (atLeast(w, h, LABEL_NAME_MIN)) return ''
  if (atLeast(w, h, LABEL_SHORT_MIN)) return 'tiny'
  if (atLeast(w, h, LABEL_DOT_MIN)) return 'dot'
  return 'blank'
}

/**
 * True when a cell has room for the SECOND line (`N parts · M changes · active`).
 *
 * Deliberately a separate function from `cellLabelClass` rather than a fifth
 * tier of it: the two answer different questions (how much of the NAME fits vs
 * whether an EXTRA line fits), and folding them together would make every
 * future change to one silently re-tier the other.
 */
export function isRoomy(w: number, h: number): boolean {
  return atLeast(w, h, ROOMY_MIN)
}

/** At or above this, a cell has room for its one-line DESCRIPTION under the
 *  name. Measured on a 1030 x 520 stage; re-checked in Phase 4. */
export const SUMMARY_MIN: CellSize = { w: 170, h: 100 }

/**
 * True when a cell can carry the feature's own description.
 *
 * A THIRD QUESTION, and a third function, for the reason `isRoomy` is already
 * separate from `cellLabelClass`: how much of the NAME fits, whether an extra
 * COUNT fits, and whether a PARAGRAPH fits are three different sizes, and
 * folding any two together makes a change to one silently re-tier the other.
 *
 * The floor is arithmetic, not taste: 6px padding, a 12px kicker, a 16px name,
 * 4px of air and four 14px lines is 94px — so 100 is the first height that
 * holds a description without clipping one mid-word. The width is what stops a
 * 170px column from printing two words a line.
 */
export function hasRoomForSummary(w: number, h: number): boolean {
  return atLeast(w, h, SUMMARY_MIN)
}

/**
 * At or above this, a cell prints its folders as file-tree ROWS (plan
 * feature-home-folders) — two of them. Arithmetic like `SUMMARY_MIN`: 6px
 * padding, a 12px kicker, a 16px name and 4px of air is 38px, and two 16px rows
 * plus 6px of foot padding is 76 — 92 leaves the rows a little air under the
 * name, which they never displace.
 */
export const FOLDER_ROWS_MIN: CellSize = { w: 150, h: 92 }
/** At or above this, the rows tier prints a THIRD row (one more 16px row plus air). */
export const FOLDER_ROWS_THREE_MIN: CellSize = { w: 150, h: 112 }

/**
 * How much of "where it lives" a cell prints: `rows` at `FOLDER_ROWS_MIN`, the
 * one-line home at the roomy tier (`ROOMY_MIN`), nothing below — the name
 * alone. A FOURTH question, kept apart from the label, second-line and summary
 * tiers for the reason those are apart from each other.
 */
export function folderTierFor(w: number, h: number): 'rows' | 'line' | null {
  if (atLeast(w, h, FOLDER_ROWS_MIN)) return 'rows'
  if (atLeast(w, h, ROOMY_MIN)) return 'line'
  return null
}

/**
 * WHAT A RESTING CARD SAYS ABOUT WHERE IT LIVES (the user, 2026-10-08: rows
 * AND a description on every card "is just too much information"). Calm at
 * rest: ONE home line at the roomy tier, nothing below it — the rows and the
 * description wait for the hover's details. `folderTierFor` still answers how
 * many rows a GROWN rectangle prints.
 */
export function restingFolderTier(w: number, h: number): 'line' | null {
  return isRoomy(w, h) ? 'line' : null
}

/** How many folder rows a rectangle holds: 3, 2, or 0 below the rows tier. */
export function folderRowsFit(w: number, h: number): number {
  if (atLeast(w, h, FOLDER_ROWS_THREE_MIN)) return 3
  if (atLeast(w, h, FOLDER_ROWS_MIN)) return 2
  return 0
}

const MODULE_PREFIX = 'module:'

/**
 * Normalize an anchor ref — a renderer-side mirror of `normalizeAnchorRef` in
 * `src/cli/blueprint/feature-graph.ts`.
 *
 * MIRRORED, NOT IMPORTED: the renderer's tsconfig covers `src/renderer` and
 * `src/shared` only, and the CLI ships as a separate bundle — there is no
 * module both processes can share today. The rule this reproduces is small and
 * frozen (it is what anchors are WRITTEN as), and the mirror is named here so
 * the next reader knows which copy is the original.
 */
function normalizeAnchorRef(ref: string): string {
  const colon = ref.indexOf(':')
  if (colon < 0) return ref
  const kind = ref.slice(0, colon)
  let target = ref
    .slice(colon + 1)
    .replace(/^[`[\s]+/, '')
    .replace(/[`\]\s]+$/, '')
  if (kind === 'file') {
    // A locator suffix follows the extension: `foo.ts:sym`, not `foo.ts`.
    const locator = target.match(/^(.*\.[A-Za-z0-9]+):[^/]*$/)
    if (locator !== null) target = locator[1]
  }
  return `${kind}:${target}`
}

/** The module a `module:` / `file:` ref belongs to — mirrors `moduleOfAnchor`. */
function moduleOfAnchor(anchor: string): string | null {
  const colon = anchor.indexOf(':')
  if (colon < 0) return null
  const kind = anchor.slice(0, colon)
  const ref = anchor.slice(colon + 1)
  if (kind === 'module') return ref
  if (kind === 'file') {
    const slash = ref.lastIndexOf('/')
    return slash > 0 ? ref.slice(0, slash) : null
  }
  return null
}

/**
 * The MODULE a reference names — the join between a feature's anchors and the
 * learning state the Learning lens draws.
 *
 * Mirrors `moduleOfPartAnchor` in `src/cli/blueprint/feature-graph.ts` exactly,
 * including the rule that decides between the two bare cases: a last segment
 * with a trailing extension is a FILE (so the module is the directory holding
 * it), anything else is already a directory (so it is its own module).
 *
 *   `src/lib/thing.ts`   → `src/lib`     (bare file)
 *   `src/lib`            → `src/lib`     (bare directory)
 *   `file:src/lib/a.ts`  → `src/lib`
 *   `module:src/lib`     → `src/lib`
 *   `thing.ts`           → `null`        (a file at the repo root has no module)
 *   `''`                 → `null`
 *
 * ONE helper, shared later by the feature map and the code map: two copies of
 * this rule is how a coverage line and a module row end up disagreeing about
 * which directory a file belongs to.
 */
export function moduleOfPath(ref: string): string | null {
  const trimmed = ref.trim()
  if (trimmed.length === 0) return null
  if (trimmed.includes(':')) return moduleOfAnchor(normalizeAnchorRef(trimmed))
  const slash = trimmed.lastIndexOf('/')
  const last = slash < 0 ? trimmed : trimmed.slice(slash + 1)
  if (!/\.[A-Za-z0-9]+$/.test(last)) return trimmed
  return slash > 0 ? trimmed.slice(0, slash) : null
}

/** Strip a `module:` prefix so a graph id and a bare learning entry compare
 *  equal — the same normalization `learn-progress-model.ts` performs, for the
 *  same reason (without it, learned modules read as never-learned). */
function normalizeModuleRef(ref: string): string {
  return ref.startsWith(MODULE_PREFIX) ? ref.slice(MODULE_PREFIX.length) : ref
}

/**
 * The Learning lens's number for one cell: learned ÷ total over the modules the
 * cell stands on, with learning-ignored modules removed.
 *
 * IGNORED MODULES LEAVE BOTH SIDES of the fraction. Counting a `__tests__`
 * directory in the denominator only would draw a coverage line that can never
 * reach full on a feature whose every real module is learned — the panel's own
 * counts already work this way (`computeLearnProgress`), and both read the SAME
 * matcher (`ignoreSource` in `app/src/shared/learn-ignore.ts`), so the lens and
 * the panel cannot disagree about what counts (allowed-pattern #14).
 *
 * ONLY `'learned'` COUNTS. `'stale'` is knowledge the code has since moved
 * past, `'learning'`/`'queued'` is work not yet done — drawing any of them as
 * coverage would say the ground is understood when it is not, which is the
 * exact lie the feature-understanding rule was written to stop.
 *
 * Returns 0 for an empty (or wholly ignored) module set — a cell standing on no
 * countable ground has no coverage, and 0/0 must not be drawn as full.
 * The result is a fraction in [0, 1]; the caller decides pixels.
 */
export function coverageOf(
  modulePaths: readonly string[],
  learning: readonly BlueprintLearningEntry[] = [],
  ignoreExtras: readonly string[] = [],
): number {
  const status = new Map<string, BlueprintLearningEntry['status']>()
  for (const entry of learning) status.set(normalizeModuleRef(entry.module), entry.status)

  const counted = new Set<string>()
  for (const raw of modulePaths) {
    const module = normalizeModuleRef(raw.trim())
    if (module.length === 0) continue
    if (ignoreSource(module, ignoreExtras) !== null) continue
    counted.add(module)
  }
  if (counted.size === 0) return 0

  let learned = 0
  for (const module of counted) {
    if (status.get(module) === 'learned') learned += 1
  }
  return learned / counted.size
}

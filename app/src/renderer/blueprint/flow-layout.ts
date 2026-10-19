/**
 * THE FEATURE VIEW AS A LAYERED FLOW — pure, DOM-free.
 *
 * WHAT THIS REPLACES, AND WHY. The level used to draw one full-width row per
 * PART, cards packed into the top-left of each row, and wires scribbled between
 * the rows with their labels landing wherever the midpoint fell. Every real
 * feature came out as a left-hand stack of boxes with text strewn across it: no
 * direction, no stages, and a reader could not tell what called what without
 * following a line by eye.
 *
 * A feature view IS a flow — a request enters somewhere, passes through a
 * handful of named things, and lands in a store or another service. The data
 * already says so: the edges ARE the flow, and they are labelled with what
 * crosses them. Nothing new has to be recorded to draw it properly; it only had
 * to be laid out along the direction it already has.
 *
 * SO: LAYERS ARE COLUMNS. A node's layer is its longest path from a source, so
 * everything that can happen at the same stage stands in the same column and
 * every arrow points the same way — left to right. That is the whole readable
 * difference, and it is derived, not authored.
 *
 * WHAT IS DERIVED AND WHAT IS STORED — worth being exact about, because one of
 * these is a guess:
 *   · the layers, the order within them, the boxes and the arrows: computed
 *     here from the stored edges. Not a guess.
 *   · a lane's HEADING: a word chosen from the kinds standing in that column
 *     (`laneHeading`). Nothing stores stage names. It is a summary of what is
 *     there, and it is labelled as derived wherever it is shown.
 *
 * DETERMINISTIC throughout: same nodes and edges in, same geometry out. A level
 * that reshuffled itself between two renders of the same feature would destroy
 * the one thing a map is for.
 */

/** A rectangle in the level's own coordinate space. */
export interface FlowRect {
  x: number
  y: number
  w: number
  h: number
}

/** What the layout needs of a component. `kind` is the stored uppercase word
 *  the card already prints (MODULE, ENDPOINT, FUNCTION, …). */
export interface FlowNodeInput {
  id: string
  kind: string
  /** The part that claims it, or null for the feature's own anchors. */
  part?: string | null
  /** `remove` and `new` drive the dashed/absent states; anything else is kept. */
  delta?: string
}

export interface FlowEdgeInput {
  from: string
  to: string
  delta?: string
}

export interface FlowBox extends FlowNodeInput {
  layer: number
  /** Position within the layer, top to bottom. */
  row: number
  /** Which wrapped band the layer landed in — see `layoutFlow`'s options. */
  band: number
  /** The column within that band. */
  column: number
  rect: FlowRect
}

export interface FlowLane {
  layer: number
  band: number
  column: number
  /** DERIVED from the kinds in this column — see `laneHeading`. */
  heading: string
  /** What the heading was derived from, for the sentence that admits it. */
  kinds: string[]
  rect: FlowRect
}

export interface FlowArrow extends FlowEdgeInput {
  path: string
  /** Where the label wants to sit, before collision resolution. */
  labelX: number
  labelY: number
  /** True when the arrow runs backwards, sideways, or wraps to the next band —
   *  all three are drawn as a detour rather than straight through the boxes. */
  back: boolean
}

export interface FlowLayout {
  boxes: FlowBox[]
  lanes: FlowLane[]
  arrows: FlowArrow[]
  width: number
  height: number
}

/* ── GEOMETRY ───────────────────────────────────────────────────────────────
 * Constants rather than inline arithmetic, for the same reason the territory's
 * label thresholds are: they are re-checked against a real stage, and that
 * re-check should be an edit to these numbers and not to the layout.
 */

/** A column's width. Wide enough for a two-line title plus a source line. */
export const COL_W = 208
/**
 * The lane between two columns — the arrows live here, AND SO DO THEIR LABELS.
 *
 * SIZED FOR THE TEXT, not for the line, and sized by ARITHMETIC rather than by
 * eye: a chip holds up to `WIRE_LABEL_MAX` (26) characters of 10px mono, which
 * is about 160px, plus its own padding. A lane narrower than that cannot hold a
 * label at all — the chip necessarily spills onto the column either side, and
 * the placement pass can only move a label to a clear spot that EXISTS. At 104
 * there was none and labels settled on the boxes; at 132 the widest chips still
 * overhung (measured: 2 of 17 on a card). If `WIRE_LABEL_MAX` ever changes,
 * this changes with it.
 */
export const COL_GAP = 176
/** A box's height: a kind row, a title of up to two lines, and a source line. */
export const BOX_H = 70
/**
 * THE BOX A READER CAN READ, when the layout is fitted to a stage.
 *
 * `COL_W` × `BOX_H` is the historical minimum, set for 13px titles. On a real
 * discovery view (1,223px of stage) that drew every card 208 × 70 in a
 * 620px-wide sheet — two thin columns in the left half of the pane, the same
 * size at 1,000px and at 2,200px. A fitted layout grows the box to share the
 * stage's width, up to `FIT_BOX_MAX_W`, and never below `FIT_BOX_MIN_W`.
 */
export const FIT_BOX_MIN_W = 240
/** The widest a fitted box grows: past this a title line is too long to read. */
export const FIT_BOX_MAX_W = 300
/** A fitted box's height: 10px kind row and two 14px title lines, in 10px padding. */
export const FIT_BOX_H = 78
/**
 * The gap between cards that share ONE stage and are laid out as a grid.
 * Not `COL_GAP`: that lane exists for arrow labels, and a single stage has no
 * arrows running between its own cards.
 */
export const GRID_GAP = 20
/**
 * The gap between two boxes in the same column.
 *
 * A LANE, NOT A MARGIN. An arrow between two stacked boxes puts its label here;
 * at 18 there was no room for one, so it landed on a box. Every gap in this
 * file is sized by what has to fit through it rather than by how it looks
 * empty.
 */
export const BOX_GAP = 38
/** The column heading's band above the first box. */
export const LANE_HEAD_H = 34
/** The sheet's own padding. */
export const FLOW_PAD = 14
/** How far below the boxes a detour runs. Its label rides the dip, so this is
 *  the clearance that keeps that label off the row it is passing. */
export const DETOUR_DROP = 26

/** The gap between two wrapped bands — bigger than a box gap, because a band
 *  break is a bigger break than a sibling. */
export const BAND_GAP = 84

/**
 * A column's heading, derived from the kinds standing in it.
 *
 * A GUESS, AND LABELLED AS ONE WHEREVER IT IS DRAWN. Nothing in the store names
 * the stages of a feature; the reference diagram this shape came from had them
 * written by hand. What IS knowable is what kind of thing each column holds, so
 * the heading says that — the dominant kind, in the vocabulary the cards
 * already use — and the lane carries `kinds` so the surface can admit what it
 * counted.
 *
 * Ties go to the first kind in input order, which keeps it deterministic.
 */
export function laneHeading(kinds: readonly string[]): string {
  if (kinds.length === 0) return 'STAGE'
  const counts = new Map<string, number>()
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1)
  let best = kinds[0] ?? 'STAGE'
  let bestCount = 0
  for (const kind of kinds) {
    const count = counts.get(kind) ?? 0
    if (count > bestCount) {
      bestCount = count
      best = kind
    }
  }
  return LANE_WORD[best.toUpperCase()] ?? best.toUpperCase()
}

/** The word a column of one kind is headed with. Anything unmapped keeps its
 *  own kind name, which is always better than a wrong category. */
const LANE_WORD: Record<string, string> = {
  MODULE: 'INTERFACE',
  ENDPOINT: 'API SURFACE',
  FUNCTION: 'LOGIC',
  INTEGRATION: 'OUTBOUND',
  DATASTORE: 'STORAGE',
  PROJECT: 'SERVICE',
}

/**
 * Each node's layer: the LONGEST path from a source, not the shortest.
 *
 * Longest, because a node that can only run after three others belongs after
 * all three — with shortest paths it would sit beside the first and its arrows
 * would run backwards past the rest.
 *
 * CYCLE-SAFE BY CONSTRUCTION. This is a bounded relaxation (n passes over the
 * edges, stopping early when nothing moves), so a store describing a cycle
 * produces a finite, if arbitrary, answer rather than hanging the render. A
 * feature map is human-authored text; it is allowed to be wrong, and the board
 * is not allowed to freeze when it is.
 */
export function assignLayers(
  nodes: readonly FlowNodeInput[],
  edges: readonly FlowEdgeInput[],
): Map<string, number> {
  const layer = new Map<string, number>()
  for (const node of nodes) layer.set(node.id, 0)
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false
    for (const edge of edges) {
      const from = layer.get(edge.from)
      const to = layer.get(edge.to)
      if (from === undefined || to === undefined) continue
      if (to < from + 1) {
        layer.set(edge.to, from + 1)
        moved = true
      }
    }
    if (!moved) break
  }
  return layer
}

/**
 * Squeeze the layer numbers down to 0, 1, 2, … with no gaps.
 *
 * A LAYER IS AN ORDINAL, NOT A DISTANCE — only its position in the sequence
 * matters — and `assignLayers` does not produce a tidy one. Relaxation over a
 * graph with a cycle pushes the numbers up on every pass: two nodes calling
 * each other come out as 3 and 4, and a real feature's worth of cycles reaches
 * the twenties.
 *
 * Left alone, those gaps became EMPTY BANDS. `layoutFlow` wraps at a column
 * budget, so layers numbered up to 30 make eight bands where three have
 * anything in them — and each empty one still takes a heading and a box's
 * height. That is the several hundred pixels of nothing between two rows of a
 * diagram, reported live: "look at the distance from one to another, that
 * doesn't make sense".
 */
export function compactLayers(raw: ReadonlyMap<string, number>): Map<string, number> {
  const distinct = [...new Set([...raw.values()])].sort((a, b) => a - b)
  const rank = new Map(distinct.map((value, index) => [value, index]))
  return new Map([...raw].map(([id, value]) => [id, rank.get(value) ?? 0]))
}

/**
 * The order of the nodes within each column.
 *
 * ONE BARYCENTRE SWEEP, left to right: a node sits at the average height of the
 * things that feed it. It is the cheapest thing that meaningfully reduces
 * crossings, and one pass is enough for the handful of nodes a feature view
 * holds — iterating to a fixed point would spend real time reordering a diagram
 * of nine boxes.
 *
 * STABLE: a node with no predecessors keeps its input position, and equal
 * barycentres keep their relative order, so the same feature always draws the
 * same way.
 */
export function orderLayers(
  nodes: readonly FlowNodeInput[],
  edges: readonly FlowEdgeInput[],
  layer: ReadonlyMap<string, number>,
): Map<string, number> {
  const byLayer = new Map<number, string[]>()
  for (const node of nodes) {
    const index = layer.get(node.id) ?? 0
    const list = byLayer.get(index) ?? []
    list.push(node.id)
    byLayer.set(index, list)
  }
  const row = new Map<string, number>()
  const layers = [...byLayer.keys()].sort((a, b) => a - b)
  for (const index of layers) {
    const ids = byLayer.get(index) ?? []
    if (index === layers[0]) {
      ids.forEach((id, position) => row.set(id, position))
      continue
    }
    const home = new Map(ids.map((id, position) => [id, position]))
    const bary = new Map<string, number>()
    for (const id of ids) {
      const feeders = edges
        .filter((edge) => edge.to === id && (layer.get(edge.from) ?? 0) < index)
        .map((edge) => row.get(edge.from))
        .filter((value): value is number => value !== undefined)
      bary.set(id, feeders.length === 0 ? (home.get(id) ?? 0) : mean(feeders))
    }
    const sorted = [...ids].sort((a, b) => {
      const delta = (bary.get(a) ?? 0) - (bary.get(b) ?? 0)
      return delta !== 0 ? delta : (home.get(a) ?? 0) - (home.get(b) ?? 0)
    })
    sorted.forEach((id, position) => row.set(id, position))
  }
  return row
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length

/**
 * THE WHOLE LAYOUT.
 *
 * Boxes are placed on a fixed grid — column by layer, row by order — rather
 * than packed: a flow diagram's value is that the same stage is always at the
 * same horizontal position, and packing would trade that away for whitespace.
 * The sheet is as wide and as tall as its own content; the canvas scrolls.
 *
 * An arrow leaves the right edge of its source and enters the left edge of its
 * target, as a horizontal-tangent cubic — the shape reads as a connection at
 * any angle. An arrow that does NOT go forwards (a cycle, or two things in the
 * same column) is marked `back` and given a detour below the boxes, because
 * drawing it as a straight cubic would run it through everything between.
 */
export interface FlowLayoutOptions {
  /** How many stages sit side by side before the flow wraps. */
  maxColumns?: number
  /**
   * The stage width to FIT: columns and box width are both derived from it, so
   * the diagram fills the pane it is shown in rather than a fixed 208px grid.
   * Overrides `maxColumns`.
   */
  fitWidth?: number
  /** A box's height; defaults to `BOX_H`. */
  boxHeight?: number
}

/** Columns and box width for a stage `fitWidth` wide holding `stages` stages. */
export function fitColumns(fitWidth: number, stages: number): { columns: number; boxWidth: number } {
  const usable = Math.max(0, fitWidth - FLOW_PAD * 2)
  const fits = Math.max(1, Math.floor((usable + COL_GAP) / (FIT_BOX_MIN_W + COL_GAP)))
  const columns = Math.max(1, Math.min(stages, fits))
  const share = (usable - (columns - 1) * COL_GAP) / columns
  const boxWidth = Math.floor(Math.min(FIT_BOX_MAX_W, Math.max(FIT_BOX_MIN_W, share)))
  return { columns, boxWidth }
}

export function layoutFlow(
  nodes: readonly FlowNodeInput[],
  edges: readonly FlowEdgeInput[],
  options: FlowLayoutOptions = {},
): FlowLayout {
  if (nodes.length === 0) return { boxes: [], lanes: [], arrows: [], width: 0, height: 0 }
  const layer = compactLayers(assignLayers(nodes, edges))
  const row = orderLayers(nodes, edges, layer)
  const layers = [...new Set([...layer.values()])].sort((a, b) => a - b)
  const fitted = options.fitWidth === undefined ? null : fitColumns(options.fitWidth, layers.length)
  const boxW = fitted?.boxWidth ?? COL_W
  const boxH = options.boxHeight ?? BOX_H
  if (options.fitWidth !== undefined && layers.length === 1) {
    return gridLayout(nodes, row, options.fitWidth, boxH)
  }

  // WRAPPED, BECAUSE A CHAIN IS AS LONG AS IT IS. A feature whose calls form a
  // straight line — a guard, a list, a builder, a BFF, a command, a client, an
  // engine — is SEVEN stages, and drawing seven columns is the honest answer to
  // "what happens in what order". It is also 1,880px, which no pane has, and a
  // diagram you arrive at already scrolled past the beginning is a diagram
  // nobody reads from the start (measured: the first card sat at x=-224).
  //
  // So the stages wrap. A band is a row of columns; the reader goes left to
  // right, then down and left again, which is how every other long sequence a
  // person reads is laid out. The stage order is untouched — only where the
  // page breaks.
  const maxColumns = fitted?.columns ?? Math.max(1, Math.floor(options.maxColumns ?? layers.length))
  const columnOf = (index: number): number => index % maxColumns
  const bandOf = (index: number): number => Math.floor(index / maxColumns)
  const tallestInBand = new Map<number, number>()
  for (const index of layers) {
    const held = [...layer.entries()].filter(([, value]) => value === index).length
    const band = bandOf(index)
    tallestInBand.set(band, Math.max(tallestInBand.get(band) ?? 0, held))
  }
  const bandHeight = (band: number): number => {
    const tallest = tallestInBand.get(band) ?? 1
    return LANE_HEAD_H + tallest * boxH + Math.max(0, tallest - 1) * BOX_GAP
  }
  const bandTop = (band: number): number => {
    let top = FLOW_PAD
    for (let n = 0; n < band; n += 1) top += bandHeight(n) + BAND_GAP
    return top
  }

  const boxes: FlowBox[] = nodes.map((node) => {
    const index = layer.get(node.id) ?? 0
    const position = row.get(node.id) ?? 0
    const band = bandOf(index)
    const column = columnOf(index)
    return {
      ...node,
      layer: index,
      row: position,
      band,
      column,
      rect: {
        x: FLOW_PAD + column * (boxW + COL_GAP),
        y: bandTop(band) + LANE_HEAD_H + position * (boxH + BOX_GAP),
        w: boxW,
        h: boxH,
      },
    }
  })

  const bands = [...new Set(layers.map(bandOf))]
  const boxesHeight = bandTop(Math.max(...bands)) + bandHeight(Math.max(...bands)) + FLOW_PAD
  const lanes: FlowLane[] = layers.map((index) => {
    const held = boxes.filter((box) => box.layer === index)
    const kinds = held.map((box) => box.kind)
    const band = bandOf(index)
    return {
      layer: index,
      band,
      column: columnOf(index),
      heading: laneHeading(kinds),
      kinds,
      rect: {
        x: FLOW_PAD + columnOf(index) * (boxW + COL_GAP),
        y: bandTop(band),
        w: boxW,
        h: bandHeight(band),
      },
    }
  })

  const byId = new Map(boxes.map((box) => [box.id, box]))
  const arrows: FlowArrow[] = []
  for (const edge of edges) {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    if (from === undefined || to === undefined) continue
    // A WRAP IS A DETOUR TOO. Forward in stage order, but drawn from the right
    // edge of one band to the left edge of the next — a straight cubic would
    // cut back across every box between.
    const back = to.layer <= from.layer || to.band !== from.band
    const x1 = from.rect.x + from.rect.w
    const y1 = from.rect.y + from.rect.h / 2
    const x2 = to.rect.x
    const y2 = to.rect.y + to.rect.h / 2
    if (back) {
      // UNDER EVERYTHING, and back. A cycle or a sideways call drawn as a
      // straight cubic runs through every box between its ends.
      //
      // HALF A LANE CLEAR OF THEM. At one box-gap the detour ran along the
      // bottom edge of the row it was passing and its label sat on the box.
      const dip = Math.max(from.rect.y + from.rect.h, to.rect.y + to.rect.h) + BOX_GAP / 2 + DETOUR_DROP
      arrows.push({
        ...edge,
        back,
        path: `M ${x1} ${y1} C ${x1 + 30} ${y1}, ${x1 + 30} ${dip}, ${(x1 + x2) / 2} ${dip} C ${x2 - 30} ${dip}, ${x2 - 30} ${y2}, ${x2} ${y2}`,
        labelX: (x1 + x2) / 2,
        labelY: dip,
      })
      continue
    }
    const mid = (x1 + x2) / 2
    arrows.push({
      ...edge,
      back,
      path: `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`,
      labelX: mid,
      labelY: (y1 + y2) / 2,
    })
  }

  const widest = Math.max(...layers.map(columnOf)) + 1
  const width = FLOW_PAD * 2 + widest * boxW + Math.max(0, widest - 1) * COL_GAP
  // THE SHEET COVERS ITS OWN DETOURS. A back-route dips BELOW the boxes and
  // carries its label there — so a canvas sized to the boxes alone ends above
  // its own arrows, and those labels spill onto whatever the level draws next.
  // Live, they landed on the changes strip under the diagram.
  const deepest = arrows.reduce((low, arrow) => Math.max(low, arrow.labelY), 0)
  const height = Math.max(boxesHeight, deepest + DETOUR_DROP + FLOW_PAD)
  return { boxes, lanes, arrows, width, height }
}

/**
 * ONE STAGE, LAID OUT AS A GRID.
 *
 * When nothing connects the components — a discovery predicting eight new
 * pieces with no wiring declared, the ordinary case — every one of them is in
 * the same stage, and the flow drew that stage as ONE column: eight 360px
 * cards stacked two thousand pixels deep, with the rest of the pane empty.
 * The stage order means nothing inside a single stage, so its cards share the
 * width instead: as many columns as fit at `FIT_BOX_MIN_W`, the box width
 * dividing what is left, row by row in the stage's own order.
 */
function gridLayout(
  nodes: readonly FlowNodeInput[],
  row: ReadonlyMap<string, number>,
  fitWidth: number,
  boxH: number,
): FlowLayout {
  const usable = Math.max(0, fitWidth - FLOW_PAD * 2)
  const fits = Math.max(1, Math.floor((usable + GRID_GAP) / (FIT_BOX_MIN_W + GRID_GAP)))
  const columns = Math.max(1, Math.min(nodes.length, fits))
  const share = (usable - (columns - 1) * GRID_GAP) / columns
  const boxW = Math.floor(Math.min(FIT_BOX_MAX_W, Math.max(FIT_BOX_MIN_W, share)))
  const ordered = [...nodes].sort((a, b) => (row.get(a.id) ?? 0) - (row.get(b.id) ?? 0))
  const boxes: FlowBox[] = ordered.map((node, index) => {
    const column = index % columns
    const line = Math.floor(index / columns)
    return {
      ...node,
      layer: 0,
      row: index,
      band: 0,
      column,
      rect: {
        x: FLOW_PAD + column * (boxW + GRID_GAP),
        y: FLOW_PAD + LANE_HEAD_H + line * (boxH + GRID_GAP),
        w: boxW,
        h: boxH,
      },
    }
  })
  const lines = Math.ceil(nodes.length / columns)
  const gridW = columns * boxW + (columns - 1) * GRID_GAP
  const gridH = LANE_HEAD_H + lines * boxH + Math.max(0, lines - 1) * GRID_GAP
  const lane: FlowLane = {
    layer: 0,
    band: 0,
    column: 0,
    heading: laneHeading(boxes.map((box) => box.kind)),
    kinds: boxes.map((box) => box.kind),
    rect: { x: FLOW_PAD, y: FLOW_PAD, w: gridW, h: gridH },
  }
  return {
    boxes,
    lanes: [lane],
    arrows: [],
    width: FLOW_PAD * 2 + gridW,
    height: FLOW_PAD * 2 + gridH,
  }
}

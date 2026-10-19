/**
 * WHERE A WIRE'S LABEL ACTUALLY GOES — pure, DOM-free.
 *
 * `levelWires` puts every label at the vertical midpoint of the two cards it
 * connects. For a wire between one province and the next, that midpoint is the
 * lane between them — which is exactly where the lower province prints its own
 * name. Widening the lane (`PART_ROW_GAP`) stopped the systematic case; it did
 * nothing for labels that simply share a midpoint with each other or land on a
 * short province's label row anyway. Measured on a real feature view after the
 * lane change: 2 labels still crossed a province name and 5 still crossed each
 * other, out of 17.
 *
 * So the placement is resolved rather than hoped for: each label is offered its
 * own position first, then positions stepping away above and below, and takes
 * the first that hits nothing already standing there.
 *
 * VERTICAL ONLY. These rows are horizontal bands and the collisions are
 * vertical; moving a label sideways would slide it along its own wire and past
 * the two cards it names, which is a worse kind of wrong than a small lift.
 *
 * DETERMINISTIC: same boxes in, same offsets out, in input order — the sheet
 * must not reshuffle its own labels between two renders of the same level.
 */

/** A rectangle in the level's own coordinate space. */
export interface LabelBox {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Something a label would rather not cover, and how much it costs to cover it.
 *
 * WEIGHTED, BECAUSE THE FIRST CUT WAS FIRST-FIT AND GOT WORSE. Take the first
 * clear offset, and a label with no clear offset at all stays at its wire's
 * midpoint — which on a crowded level is the very spot the whole pass exists to
 * leave. Adding cards to the obstacle set made a level go from 12 labels on a
 * card to 9 on a card, 4 on each other and 2 on a province name, because more
 * labels found nothing clear and gave up where they stood.
 *
 * Scoring every offer and taking the cheapest has no such cliff: when nothing
 * is free, a label still moves to wherever it does the least damage.
 */
export interface LabelObstacle extends LabelBox {
  /** Higher is worse to cover. See COST_* below. */
  cost: number
}

/** A component card: the name, the kind and the source line — the most
 *  expensive thing on this ground to sit on. */
export const COST_CARD = 9
/** A province's label row: a name the reader navigates by. */
export const COST_PART_LABEL = 6
/** Another wire label: legible through its chip even when stacked, so the
 *  cheapest of the three to disturb. */
export const COST_LABEL = 3

/* ── THE CHIP IS WHAT IS DRAWN, SO THE CHIP IS WHAT IS MEASURED ─────────────
 *
 * A label's `getBBox` is its TEXT. The thing on screen is a rounded rect four
 * pixels wider and two taller on every side, and the pass was resolving
 * collisions against the smaller one — so two labels it declared clear were
 * drawn as two chips overlapping by the padding it had not counted. Reported
 * live twice, both times as "still some overlapping texts", because from the
 * outside a near-miss and a miss look identical.
 *
 * These are the numbers the painter draws with. Exported so it uses these
 * rather than a duplicate of it: a chip measured differently from how it is drawn is
 * the whole defect.
 */
export const CHIP_PAD_X = 4
export const CHIP_PAD_Y = 2

/** A text box grown into the chip that will be drawn around it. */
export function chipBox(text: LabelBox): LabelBox {
  return {
    x: text.x - CHIP_PAD_X,
    y: text.y - CHIP_PAD_Y,
    w: text.w + CHIP_PAD_X * 2,
    h: text.h + CHIP_PAD_Y * 2,
  }
}

/**
 * One step away from a label's home position.
 *
 * TALLER THAN A CHIP, or a "lifted" label lands half on top of the one it was
 * sitting on. A 10px line of monospace measures about 13px, so a chip is ~17
 * — and the step was 15. Two labels a step apart still overlapped by two
 * pixels, which is what those stacked pairs in the screenshots were.
 */
export const WIRE_LABEL_STEP = 22

/** How many steps each way are offered. At 15px that is a reach of 120px,
 *  about two rows — far enough to escape a crowded lane, near enough that the
 *  label still reads as belonging to the wire beneath it. */
export const WIRE_LABEL_TRIES = 8

/** How much two boxes overlap, in square units. 0 when they do not. */
function overlapArea(a: LabelBox, b: LabelBox): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** The offsets a label is offered, in order: home, then alternating up/down. */
export function labelOffsets(step = WIRE_LABEL_STEP, tries = WIRE_LABEL_TRIES): number[] {
  const out = [0]
  for (let n = 1; n <= tries; n += 1) out.push(-n * step, n * step)
  return out
}

/**
 * The vertical offset for each label, in input order.
 *
 * Each label is scored at every offer — the weighted overlap area against
 * everything already standing there — and takes the cheapest. A tie goes to the
 * offer nearest home, so a label that gains nothing by moving does not move,
 * and `labelOffsets` puts 0 first so the tie-break needs no second rule.
 *
 * Placed labels JOIN the obstacles as they are decided, so two labels can never
 * be resolved onto each other, and the pass is order-stable: same boxes in,
 * same offsets out.
 *
 * Nothing is ever hidden. These labels are the answer a reader came for; the
 * chip is what keeps one legible wherever it has to land.
 */
export function placeWireLabels(
  labels: readonly LabelBox[],
  obstacles: readonly LabelObstacle[],
  step = WIRE_LABEL_STEP,
  tries = WIRE_LABEL_TRIES,
  bounds?: { top: number; bottom: number },
): number[] {
  const taken: LabelObstacle[] = [...obstacles]
  const offsets = labelOffsets(step, tries)
  const out: number[] = []
  for (const label of labels) {
    let best = 0
    let bestCost = Number.POSITIVE_INFINITY
    for (const dy of offsets) {
      const candidate = { ...label, y: label.y + dy }
      // A LABEL MAY NOT LEAVE ITS OWN SHEET. Everything this pass knows to
      // avoid is INSIDE the canvas — the cards, the lane headings — so an
      // offer that lifts a label off the top edge scores zero and wins, and
      // the label lands on whatever the level draws above the canvas. Live,
      // that was the part level's summary paragraph: three chips sitting in
      // the middle of a sentence.
      //
      // Rejected rather than penalised: outside is not "expensive", it is not
      // a position. Home always survives, because a wire's midpoint is inside
      // the canvas by construction.
      if (bounds !== undefined && (candidate.y < bounds.top || candidate.y + candidate.h > bounds.bottom)) {
        continue
      }
      let cost = 0
      for (const other of taken) cost += overlapArea(candidate, other) * other.cost
      if (cost < bestCost) {
        bestCost = cost
        best = dy
        if (cost === 0) break
      }
    }
    out.push(best)
    taken.push({ ...label, y: label.y + best, cost: COST_LABEL })
  }
  return out
}

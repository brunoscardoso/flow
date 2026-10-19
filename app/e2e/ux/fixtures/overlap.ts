/**
 * The overlap slack every board-legibility probe measures with.
 *
 * WHY THIS IS A MODULE AND NOT A LITERAL IN EACH SPEC
 * ==================================================
 * Three probes now measure overprinting on the same board —
 * `blueprint-part-ring-legibility.spec.ts` (ring labels),
 * `blueprint-parts-drill.spec.ts` (the same ring, from the reported bug's
 * angle) and `blueprint-discovery-view.spec.ts` (brief cards and their
 * predicted-claim notes). Each carried its own `> 1`, with a comment in each
 * saying "same rule as the other one, so the two probes agree" — a promise kept
 * by convention across three files, which is exactly the thing that drifts.
 * One exported number cannot.
 *
 * WHAT THE NUMBER IS
 * ==================
 * 1px. The board's SVG labels carry a 3.5px paint-order halo and its cards sit
 * on a 1px border, so two boxes touching at a hairline is a shared edge, not an
 * unreadable overprint. Anything wider than this genuinely covers glyphs.
 */
export const OVERLAP_SLACK_PX = 1

/** A measured box, in viewport coordinates. */
export interface MeasuredBox {
  /** How the box names itself in a failure message. */
  text: string
  x: number
  y: number
  width: number
  height: number
  /** How OTHER boxes address this one. Only needed alongside `partOf`. */
  id?: string
  /**
   * The `id` of the box this one is DRAWN INSIDE, when it is drawn inside one.
   *
   * Containment by design is not an overprint. A predicted-claim note used to
   * float below its card, where covering the card underneath was a real defect
   * (measured at 188×58px); it is now the card's own bottom band, so the note
   * and its card overlap completely and always — and every OTHER pair still
   * has to be clean. Omitted by every caller that has no such nesting, which
   * leaves their sweeps exactly as strict as they were.
   */
  partOf?: string
}

/**
 * Every pair of boxes that overprints by more than `slack` on BOTH axes,
 * described in words a failure can print.
 *
 * Pure and DOM-free so it can run either in the spec process or, serialized,
 * inside `page.evaluate` — the measurement itself has to happen in the page,
 * but the judgement does not have to be written twice.
 */
export function overlappingPairs(boxes: readonly MeasuredBox[], slack: number): string[] {
  const pairs: string[] = []
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]
      const b = boxes[j]
      // Drawn inside each other on purpose — see `partOf`.
      if (
        (a.partOf !== undefined && a.partOf === b.id) ||
        (b.partOf !== undefined && b.partOf === a.id)
      ) {
        continue
      }
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
      if (overlapX > slack && overlapY > slack) {
        pairs.push(`"${a.text}" ∩ "${b.text}" (${overlapX.toFixed(1)}×${overlapY.toFixed(1)}px)`)
      }
    }
  }
  return pairs
}

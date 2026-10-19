/**
 * A RUNNING UNDERSTAND PASS, VISIBLE ON THE MAP — PURE, no DOM, no IPC.
 *
 * THE COMPLAINT THIS ANSWERS
 * ==========================
 * "If the user opens one module, clicks to understand, and goes back to do
 * another thing while the understanding is running, we should show some kind of
 * indicator on the node."
 *
 * The board already knew. `#featureViewRunning` is what enforces one caged pass
 * at a time, and `decideUnderstandAction` already reads it — but ONLY to word
 * the button on the level the press happened on. Navigate away and a
 * multi-minute pass became completely invisible: no node was busy, nothing was
 * happening, and the only way back to that fact was to re-open the exact
 * feature you started from.
 *
 * So the state existed and the visual language existed (`fb-learn-learning`,
 * the breathing dot) and nothing joined them. This module is the join, and it
 * is a decision — which is why it is here and not in `blueprint-board.ts`,
 * where nothing in this repo could test it (app jest is `testEnvironment:
 * 'node'`).
 *
 * TWO MARKS, TWO DIFFERENT CLAIMS
 * ===============================
 * `self`   — THIS node's own knowledge is being written by the running pass.
 *            Its understanding IS `learning` and it says so in the vocabulary
 *            every other state already uses.
 * `within` — something INSIDE this node is being understood. A weaker, honest
 *            claim about a container: the domain is not being drawn, one of its
 *            features is. It must never be mistaken for `self`, because a
 *            reader who reads "this domain is being learned" has been told
 *            something no pass is doing.
 *
 * `self` IS NOT "THE NODE THE PRESS HAPPENED ON"
 * ==============================================
 * It is "this node's own record is being written", and one pass writes more
 * than one record. `understandFeature` draws the feature's view and then walks
 * every PART the drawing named, writing each part's own `learnings` through
 * `writeParts` — so while a feature's pass runs, each of its parts is being
 * learned in its own right, right now.
 *
 * A part therefore carries `self`, and its corner dot reads `learning` exactly
 * as a module's does while the module tier works on it. The alternative —
 * leaving parts unmarked because the press was aimed at their parent — would
 * mean drilling into a part DURING the pass that is learning it shows a level
 * claiming nothing is happening, which is the same invisibility this module was
 * written to remove, one level further down. Marking them `within` would be
 * worse still: it would say something inside the part is busy, and a part is a
 * leaf with nothing inside it.
 *
 * Only ONE level of descent, and only to `part` kinds. Parts do not nest
 * (`canDrill` is false for a part) and a `change` record is not learned by
 * anything, so the walk that goes UP is unbounded ancestry while the step that
 * goes DOWN is a single, kind-checked hop.
 *
 * The two are separated three ways, deliberately, so no single channel carries
 * the whole distinction: a different CSS class, a different stroke (a pulsing
 * solid accent ring around the cell that owns the pass vs a dashed accent
 * border on the ground that merely contains it), and a different sentence.
 * Neither depends on the animation — a reduced-motion reader sees both borders,
 * still, and can still tell them apart.
 *
 * NOT A FOURTH DECORATION LANGUAGE
 * ================================
 * `self` re-uses `fb-learn-learning` exactly — the same dot the module tier
 * lights, in the same kicker slot. `within` re-uses the same slot and the same
 * breath. Nothing new is invented; what is added is one border saying "the
 * thing you are looking at holds this event".
 *
 * THE CLASS NAMES ARE THE SHEET'S. The marks land on `.fb-terr-cell` and
 * `.fb-terr-group` — the territory's own vocabulary — so they are spelled
 * `fb-terr-inflight` / `fb-terr-inflight-within` here and nowhere else.
 *
 * NO PROGRESS IS INVENTED. The pass reports none — it is one caged read that
 * ends in an artifact or a refusal — so the mark is indeterminate, and a
 * percentage here would be a number with nothing behind it.
 */

import { toFocusGraph, type FeatureGraphInput } from './feature-view-model'

/** What a node is showing about the running pass. */
export type InFlightMark =
  /** This node's own feature is being understood right now. */
  | 'self'
  /** Something below this node is. NOT a claim about this node. */
  | 'within'

/** The group class each mark puts on a glyph (and on the centre). ONE
 *  vocabulary, so a mark cannot be spelled two ways in two places. */
export const IN_FLIGHT_CLASS: Record<InFlightMark, string> = {
  self: 'fb-terr-inflight',
  within: 'fb-terr-inflight-within',
}

/** Every class this module can apply — what the painter clears before it adds. */
export const IN_FLIGHT_CLASSES: string[] = Object.values(IN_FLIGHT_CLASS)

/**
 * Which nodes carry a mark while `runningRef` is being understood.
 *
 * ANCESTRY COMES FROM `toFocusGraph`, NOT FROM A SECOND COPY OF THE RULE. A
 * core feature's parent is its synthesised domain — but only when any feature
 * carries one — and a child's parent is its feature. Re-deriving that here is
 * how the map and the marks would drift apart on the exact projects where the
 * domain layer is absent.
 *
 * EVERY ancestor is marked, not just the immediate one: the whole point is that
 * the pass stays visible from wherever the reader wandered to, and at the root
 * the only node on screen may be three levels above the running feature.
 *
 * A `runningRef` the graph has never heard of still marks ITSELF — the feature
 * graph is fetched asynchronously and may be older than the press, and marking
 * an id that is not on screen costs nothing while refusing to would blank the
 * indicator for a feature that is about to appear.
 *
 * AND ITS PARTS ARE MARKED TOO, because the pass is writing their records as
 * well as its own (see the header). That is one hop down, kind-checked.
 */
export function inFlightMarks(
  graph: FeatureGraphInput | null,
  runningRef: string | null,
): Map<string, InFlightMark> {
  const marks = new Map<string, InFlightMark>()
  const ref = typeof runningRef === 'string' && runningRef.trim().length > 0 ? runningRef : null
  if (ref === null) return marks
  marks.set(ref, 'self')
  if (graph === null) return marks

  const focus = toFocusGraph(graph)
  const byId = new Map(focus.nodes.map((node) => [node.id, node]))
  let cursor = byId.get(ref)?.parent
  // A malformed store could describe a cycle (a feature whose parent chain
  // returns to itself). Walking it would hang the render, so the walk is
  // bounded by the ids it has already seen rather than by a magic depth.
  const seen = new Set<string>([ref])
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor)
    const parent = byId.get(cursor)
    if (parent === undefined) break
    marks.set(parent.id, 'within')
    cursor = parent.parent
  }

  // THE PARTS OF THE RUNNING FEATURE ARE BEING LEARNED, so they say so. Read
  // off the SAME focus graph as the ancestry above — a second copy of "what is
  // a part of what" is how the map and the marks would disagree.
  //
  // Never overwrite a mark already set: an ancestor that some malformed store
  // also lists as a child keeps the weaker, safer `within`.
  for (const node of focus.nodes) {
    if (node.kind !== 'part') continue
    if (node.parent !== ref) continue
    if (marks.has(node.id)) continue
    marks.set(node.id, 'self')
  }
  return marks
}

/**
 * What the mark SAYS, on the node's tooltip and to a screen reader.
 *
 * The two sentences make different claims on purpose. `self` names the act;
 * `within` names the containment and then names what is actually running, so a
 * reader is never left guessing which of the things inside is busy.
 *
 * AND `self` ON A PART NAMES THE PASS IT BELONGS TO. The part IS being learned
 * — that is why it carries `self` at all — but the pass is its feature's, and a
 * sentence saying only "Understanding the SSE endpoint" would leave a reader
 * who cancels or waits looking for a pass under that name that does not exist.
 * The two cases are told apart by the node's own name differing from the
 * running pass's, so no caller has to pass a fourth argument to say which it is.
 *
 * All three say "understood", the word the button says — one event, one
 * vocabulary.
 */
export function inFlightSentence(
  mark: InFlightMark,
  runningName: string,
  nodeName: string,
): string {
  if (mark === 'self') {
    if (nodeName !== runningName) {
      return `Understanding ${nodeName} — part of the ${runningName} pass running now, this takes several minutes`
    }
    return `Understanding ${runningName} — running now, this takes several minutes`
  }
  return `Something inside ${nodeName} is being understood — ${runningName}`
}

/**
 * The learn-dot class a node's dot must carry, given its stored understanding
 * and whether its own pass is running.
 *
 * TRUTHFULNESS LIVES HERE. While a pass runs, the node reads `learning` — never
 * `learned`, and never the `learned` it had BEFORE the re-run started. A
 * re-drawn feature that kept reporting `learned` throughout would be claiming
 * the new read had already landed, which is exactly the class of lie
 * `d5ae3b83` was written to remove. The stored value comes back, unchanged, the
 * moment the pass settles.
 */
export function learnDotClass(
  understanding: string | null,
  mark: InFlightMark | undefined,
): string {
  if (mark === 'self') return 'fb-learn-learning'
  return `fb-learn-${understanding ?? 'none'}`
}

/**
 * The brain query — state, anchoring and the highlight — PURE, no DOM.
 *
 * `brain:query` has existed since #52 and had ZERO renderer callers; the board
 * is the first. So everything about calling it is treated as new integration:
 * an empty query, a thrown call and a zero-result answer each have an explicit,
 * named state here rather than an implicit fall-through in the board.
 *
 * WHY THE QUERY IS ROOT-ONLY (Task 7.5, decided)
 * ==============================================
 * The two candidates were "root-only" and "moves to the header once you dive".
 * Root-only won, because the affordance's meaning comes from WHERE it is drawn:
 *
 *   - The centre means "where you are". At the root, where you are is the whole
 *     project — and the project's memory of itself IS the brain, so the brain is
 *     the root centre and the query is part of that organ.
 *   - Dive, and the centre becomes the thing you are inside. A query affordance
 *     that survived that move would have to mean something else — either "search
 *     within this feature" (which `brain:query` does not do; it searches the
 *     whole store) or "search everything" while sitting inside a scoped view,
 *     which is a lie about scope told by position.
 *   - The highlight is the RESULT. It lights ring nodes, and the ring at depth
 *     shows one parent's children — most hits would resolve to nothing visible,
 *     so the answer would look like a failure rather than an out-of-scope query.
 *   - A header field would be a THIRD navigation surface next to the crumbs and
 *     the title block, and it would separate the question from the organ that
 *     answers it, which is the one thing this centre exists to make legible.
 *
 * Coming back out restores it — `queryAvailableAtDepth` is depth, not a mode, so
 * there is no state to remember and nothing to get out of sync.
 *
 * FAIL-SOFT: every state renders something honest. There is no state in which
 * the board shows nothing and no state in which it throws.
 */

import type { BrainHit } from '../../shared/ipc-contract'
import { domainId, toFocusGraph, UNASSIGNED_DOMAIN, type FeatureGraphInput } from './feature-view-model'
import { focusPathTo, type FocusNode } from './focus-stack'

/**
 * Whether the brain query is available at `depth`.
 *
 * ROOT-ONLY — see the module header. Depth, not a mode: nothing to toggle,
 * nothing to remember, and diving/popping can never leave it in a wrong state.
 */
export function queryAvailableAtDepth(depth: number): boolean {
  return depth === 0
}

/* ── State ─────────────────────────────────────────────────────────────────
 *
 * Five phases, because five things can happen and each needs its own words.
 * `empty` and `error` exist so that "you typed nothing" and "the call failed"
 * are never rendered as "no results", which is a different and much more
 * misleading answer.
 */
export type BrainQueryPhase = 'idle' | 'empty' | 'searching' | 'results' | 'error'

export interface BrainQueryState {
  phase: BrainQueryPhase
  /** The query as asked (trimmed). Empty in `idle`/`empty`. */
  query: string
  hits: BrainHit[]
  /** Present only in `error`. */
  error: string | null
}

/** The opening state: field open, nothing asked yet. */
export function idleQuery(): BrainQueryState {
  return { phase: 'idle', query: '', hits: [], error: null }
}

/**
 * Classify a raw input string into the state the board should move to BEFORE
 * calling anything. An all-whitespace query never reaches IPC — asking the
 * brain for nothing is not a search, and rendering its (empty) answer as "no
 * results" would blame the store for the reader's empty field.
 */
export function submitQuery(raw: string): BrainQueryState {
  const query = raw.trim()
  if (query.length === 0) return { phase: 'empty', query: '', hits: [], error: null }
  return { phase: 'searching', query, hits: [], error: null }
}

/** The answer arrived. Zero hits is a RESULT, not an error — see `statusLine`. */
export function resolveQuery(query: string, hits: readonly BrainHit[]): BrainQueryState {
  return { phase: 'results', query, hits: [...hits], error: null }
}

/**
 * The call threw. The reason is kept and shown: a brain that is unavailable
 * (no index, unknown root, a broken store) is a different situation from a
 * query that found nothing, and the reader is the one who has to tell them
 * apart.
 */
export function failQuery(query: string, error: unknown): BrainQueryState {
  const message =
    error instanceof Error && error.message.length > 0 ? error.message : 'the brain did not answer'
  return { phase: 'error', query, hits: [], error: message }
}

/* ── Anchoring the field (Task 7.2) ────────────────────────────────────────
 *
 * The field opens under the AFFORDANCE, at its real screen position.
 *
 * This is not a detail. The figure is fitted into whatever the chrome leaves
 * free, and the fit translates AND scales depending on how many nodes are on
 * screen and how long their labels are — so the brain's screen position moves
 * between levels and between window sizes. A field placed at the viewport
 * centre lands visibly off the brain in most of those states, and the reader
 * has to work out which thing they are typing into.
 */

export interface FieldBox {
  width: number
  height: number
}

export interface StageBox {
  width: number
  height: number
}

export interface FieldPosition {
  left: number
  top: number
  /** True when the field had to flip above the anchor to stay on the stage. */
  flipped: boolean
}

/** Gap between the affordance and the field, and the margin kept off the edges. */
export const FIELD_GAP = 14
export const FIELD_MARGIN = 10

/**
 * The field's own box. The board MEASURES the panel it built and only falls
 * back to these when the measurement is zero (a stage with no layout yet).
 */
export const QUERY_PANEL_WIDTH = 268
export const QUERY_PANEL_MIN_HEIGHT = 96

/**
 * How many hits to ask for.
 *
 * Small on purpose: this is a HIGHLIGHT, not a search-results page. Twelve is
 * more than enough to light every node a real question touches, and the count
 * line discloses anything that landed off the ring.
 */
export const BRAIN_QUERY_LIMIT = 12

/**
 * Place `field` under `anchor` (both in STAGE coordinates), flipping above when
 * there is no room below, and clamping so the field never leaves the stage.
 *
 * Horizontal centring is on the ANCHOR, never on the stage — that is the whole
 * point. The clamp can move it off-centre at the edges; nothing can move it to
 * the middle of a viewport the brain is not in.
 */
export function anchorQueryField(
  anchor: { x: number; y: number },
  field: FieldBox,
  stage: StageBox,
  gap: number = FIELD_GAP,
): FieldPosition {
  const below = anchor.y + gap
  const above = anchor.y - gap - field.height
  const fitsBelow = below + field.height <= stage.height - FIELD_MARGIN
  // Flip only when below does not fit AND above does — a stage too short for
  // either keeps the field below and lets the clamp deal with it, rather than
  // flipping it into an equally bad place.
  const flipped = !fitsBelow && above >= FIELD_MARGIN
  const top = clampToStage(flipped ? above : below, field.height, stage.height)
  const left = clampToStage(anchor.x - field.width / 2, field.width, stage.width)
  return { left, top, flipped }
}

function clampToStage(want: number, size: number, extent: number): number {
  const lo = FIELD_MARGIN
  const hi = extent - FIELD_MARGIN - size
  // Inverted range: the stage cannot hold the field on this axis at all. Centre
  // it rather than jamming it against an arbitrary edge.
  if (lo > hi) return (lo + hi) / 2
  return Math.min(hi, Math.max(lo, want))
}

/* ── The highlight (Task 7.4) ──────────────────────────────────────────────
 *
 * THE MAP LIGHTING UP IS THE RESULT. Hits keep full contrast and reveal their
 * full names; everything else dims. There is NO SCRIM: a scrim would hide the
 * exact thing the query produces, turning a map that answered into a modal that
 * happens to be over one.
 */

/** Class the board puts on a lit cell (and on the country holding one). */
export const LIT_CLASS = 'fb-terr-lit'
/** Class the board puts on every cell the answer did not name. */
export const DIM_CLASS = 'fb-terr-dim'

export interface HighlightNodeInput {
  id: string
}

export interface BrainHighlight {
  /** Ring node ids that a hit resolved onto — full contrast, names revealed. */
  lit: string[]
  /** Every other ring node id — dimmed, never hidden. */
  dimmed: string[]
  /** Hits the brain returned, in total. */
  hitCount: number
  /** Hits that resolved onto a node on THIS ring. */
  onMap: number
  /**
   * Hits that resolved onto nothing here — a decision, an error note, a
   * feature this ring does not show. Counted and reported: no cap in this
   * board hides what it hid.
   */
  offMap: number
}

/** `flow/brain/features/<slug>.md` → `<slug>`, or null for any other path. */
export function featureSlugOfHit(hit: BrainHit): string | null {
  if (hit.kind !== 'feature') return null
  const normalised = hit.path.replace(/\\/g, '/')
  const match = /(?:^|\/)features\/([^/]+)\.md$/.exec(normalised)
  return match === null ? null : match[1]
}

/**
 * The ring node a feature slug lights, or null when this ring shows it nowhere.
 *
 * The root ring is domains when any feature carries one and features otherwise
 * (`toFocusGraph`), so resolution walks the same path the grouping took: the
 * feature itself, then its parent chain, then the domain bucket its core
 * ancestor belongs to — including the explicit `Unassigned` bucket, which is a
 * real node and must light like any other.
 */
export function ringNodeForSlug(
  graph: FeatureGraphInput,
  slug: string,
  ringIds: ReadonlySet<string>,
): string | null {
  const bySlug = new Map(graph.nodes.map((node) => [node.slug, node]))
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  let node = bySlug.get(slug)
  if (node === undefined) return null
  if (ringIds.has(node.id)) return node.id

  // Walk up to the core ancestor, guarding against a cyclic `parent` chain in
  // a hand-edited store — the store is human-owned, so a cycle is possible and
  // must not hang the board.
  const seen = new Set<string>([node.id])
  while (node.parent !== undefined) {
    const parent = byId.get(node.parent)
    if (parent === undefined || seen.has(parent.id)) break
    seen.add(parent.id)
    node = parent
    if (ringIds.has(node.id)) return node.id
  }

  const domain =
    node.domain !== undefined && node.domain.trim().length > 0 ? node.domain : UNASSIGNED_DOMAIN
  const id = domainId(domain)
  return ringIds.has(id) ? id : null
}

/**
 * Which ring nodes the hits light, and what the counts are.
 *
 * Deterministic: `lit` and `dimmed` keep the ring's own order, so the same
 * hits always produce the same lists.
 */
export function buildBrainHighlight(
  graph: FeatureGraphInput,
  nodes: readonly HighlightNodeInput[],
  hits: readonly BrainHit[],
): BrainHighlight {
  const ringIds = new Set(nodes.map((node) => node.id))
  const lit = new Set<string>()
  let offMap = 0
  for (const hit of hits) {
    const slug = featureSlugOfHit(hit)
    const target = slug === null ? null : ringNodeForSlug(graph, slug, ringIds)
    if (target === null) {
      offMap += 1
      continue
    }
    lit.add(target)
  }
  return {
    lit: nodes.filter((node) => lit.has(node.id)).map((node) => node.id),
    dimmed: nodes.filter((node) => !lit.has(node.id)).map((node) => node.id),
    hitCount: hits.length,
    onMap: hits.length - offMap,
    offMap,
  }
}

/* ── WHAT A RESULT ROW DOES ────────────────────────────────────────────────
 *
 * The list used to be display-only: it rendered a kind chip, a title and an
 * honest counter, and clicking a row did nothing at all. That is worst for the
 * majority case — most hits land OFF the current ring ("7 not on this ring"),
 * so the list is the only way to reach them, and it went nowhere.
 *
 * Every row is now an action, and WHICH action is decided here, from the hit's
 * own kind — never from what happens to be convenient:
 *
 *   focus     the hit is a feature this ring already shows → light it, in place
 *   navigate  the hit is a feature living elsewhere → change depth to where it
 *             lives (through `depthGoTo`, the same algebra the arrows use),
 *             then light it
 *   peek      anything that is not a feature — a decision, an error note — →
 *             open its document in the board's existing read-only drawer
 *   none      nothing to open, and the row SAYS so rather than swallowing the
 *             click
 *
 * THE CHIP IS A PROMISE. A row chipped `DECISION` opens a decision document; it
 * must never quietly focus some feature that happens to mention it. That is why
 * the kind is the first thing this function branches on.
 */

export type BrainHitActionKind = 'focus' | 'navigate' | 'peek' | 'none'

export interface BrainHitAction {
  kind: BrainHitActionKind
  /** The ring node to light — `focus` and `navigate` only. */
  nodeId: string | null
  /** The depth to land on before lighting — `navigate` only. */
  stack: FocusNode[] | null
  /** Root-relative document to open — `peek` only. */
  path: string | null
  /**
   * One sentence naming what activating this row will do, or why it cannot.
   * It is both the tooltip and the accessible name: a row that is a button has
   * to say what pressing it does.
   */
  label: string
}

/**
 * What activating `hit` should do, given the graph and the ring on screen.
 *
 * Pure and total — every hit gets an action, including the ones that cannot be
 * opened. `none` is a real answer with real words in it, not a fall-through.
 */
export function hitAction(
  hit: BrainHit,
  graph: FeatureGraphInput | null,
  ringIds: ReadonlySet<string>,
): BrainHitAction {
  const path = hit.path.trim().length > 0 ? hit.path : null

  if (hit.kind === 'feature' && graph !== null) {
    const slug = featureSlugOfHit(hit)
    const node = slug === null ? undefined : graph.nodes.find((n) => n.slug === slug)
    if (slug !== null && node !== undefined) {
      // THE HIT'S OWN NODE, NOT AN ANCESTOR OF IT.
      //
      // `ringNodeForSlug` walks UP to whatever this ring does show — which is
      // exactly right for the highlight (a dozen hits, light what is visible)
      // and exactly wrong for the action (one hit, take me to IT). Measured
      // live: on a domain-grouped root every feature hit resolved to its domain
      // hub, so "Show X on the map" lit a group of seven and left the reader to
      // find X inside it — half an answer, and it made the navigate branch
      // unreachable. So the action asks a stricter question.
      if (ringIds.has(node.id)) {
        return {
          kind: 'focus',
          nodeId: node.id,
          stack: null,
          path,
          label: `Show ${hit.title} on the map`,
        }
      }
      const found = focusPathTo(toFocusGraph(graph), node.id)
      if (found !== null) {
        const where = found.stack.at(-1)?.name
        return {
          kind: 'navigate',
          nodeId: found.nodeId,
          stack: found.stack,
          path,
          // NAMES THE DESTINATION AND THE MOVE. "Go to X" alone hides the fact
          // that the board is about to change depth under the reader.
          label:
            where === undefined
              ? `Go to ${hit.title} on the map`
              : `Go to ${hit.title} — inside ${where}`,
        }
      }
    }
    // A feature markdown the graph does not carry (a working set, a stale
    // index). The FILE still exists, so the row opens it rather than dying.
    if (path !== null) {
      return {
        kind: 'peek',
        nodeId: null,
        stack: null,
        path,
        label: `Open ${path} — the map does not show this feature`,
      }
    }
  }

  if (path !== null) {
    return { kind: 'peek', nodeId: null, stack: null, path, label: `Open ${path}` }
  }

  return {
    kind: 'none',
    nodeId: null,
    stack: null,
    path: null,
    // NO SILENT NO-OPS. The reader is told which of the two things is wrong.
    label: `${hit.title} has no file to open — this match came from the index only`,
  }
}

/** `plural(1, 'match', 'matches')` — the plural is given, never guessed. A
 *  naive `+ 's'` rule renders "1 matchs" for exactly the word this line uses. */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The live count line — INCLUDING the zero case, which is the one a search UI
 * usually swallows. "no matches" is an answer; a blank line is not.
 */
export function statusLine(state: BrainQueryState, highlight: BrainHighlight | null): string {
  switch (state.phase) {
    case 'idle':
      return 'Ask the brain — matches light up on the map.'
    case 'empty':
      return 'Type something to ask the brain.'
    case 'searching':
      return `Asking the brain about “${state.query}”…`
    case 'error':
      return `The brain could not answer: ${state.error ?? 'unknown error'}`
    case 'results': {
      if (state.hits.length === 0) return `No matches for “${state.query}”.`
      const parts = [plural(state.hits.length, 'match', 'matches')]
      if (highlight !== null) {
        parts.push(`${plural(highlight.lit.length, 'node', 'nodes')} lit`)
        // Never silently drop a hit that lights nothing here.
        if (highlight.offMap > 0) parts.push(`${highlight.offMap} not on this ring`)
      }
      // THE ASK IS A CAP, AND IT WAS NOT DISCLOSED (Task 8.4). The brain is
      // asked for twelve and answers with at most twelve; it never says how
      // many matched. An answer that comes back FULL is therefore the only
      // observable evidence that more may exist — and a top-twelve printed as
      // "12 matches" reads as the complete count. How many more is unknowable
      // from here, so the line says that rather than inventing a number.
      if (state.hits.length >= BRAIN_QUERY_LIMIT) parts.push('there may be more')
      return `${parts.join(' · ')}.`
    }
  }
}

// Shared vocabulary for the command palette (⌘P). DOM-free on purpose: the
// pure core (fuzzy scorer, query parse, ranking) and its node-env jest tests
// import only these plain shapes, never the DOM-coupled view. The VIEW builds
// each candidate's `run` closure and is the ONLY caller of it — the pure core
// treats `run` as opaque and never invokes it.

/** Which source a candidate came from — drives the row icon and its rank tier. */
export type PaletteKind = 'file' | 'thread' | 'command'

/**
 * One row in the blended palette list, produced by a source provider and
 * consumed by the pure ranker/view.
 *
 * `score` and `recencyAt` are ranking signals filled by the pipeline, not the
 * provider contract; `run` is the default action the view fires on activate.
 */
export interface PaletteCandidate {
  kind: PaletteKind
  /** Stable identity within a kind (file rel-path, thread id, command id). */
  id: string
  /** Primary text shown in the row (filename, thread title, command label). */
  label: string
  /** Optional secondary text (dir path, thread snippet, command hint). */
  sublabel?: string
  /** Optional fl-icon name overriding the per-kind default (commands set their
   *  own — e.g. Open Board → checklist — rather than a blanket command glyph). */
  icon?: string
  /** Fuzzy match score against the current term; higher = better. */
  score?: number
  /** ISO timestamp used as a recency ranking signal (e.g. thread updatedAt). */
  recencyAt?: string
  /** The default action; built and invoked by the VIEW only, never the core. */
  run: () => void
}

/**
 * Query mode. Plain typing searches content; a leading `>` flips to command
 * mode. The mode switch is unambiguous — a `>` term can never name a file.
 */
export type PaletteMode = 'content' | 'command'

/**
 * Ranking weights — a plain data shape, no logic. Per-kind base weights encode
 * the tier priority (exact/prefix filename › recent thread › fuzzy path › body
 * hit), and `recency` scales the recency signal into the blended score. Values
 * live in one exported constant so the tiers can't quietly drift.
 */
export interface RankWeights {
  /** Per-kind base weight added to a candidate's fuzzy score. */
  base: Record<PaletteKind, number>
  /** Multiplier applied to the recency signal when blending the score. */
  recency: number
}

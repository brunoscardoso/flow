/**
 * Pure, DOM-free model of the discovery card's UI drafts button and of when a
 * finished canvas opens by itself (plan `ui_drafts`, Phase 3).
 *
 * Three questions, each answered once here so the card, the pane and the tests
 * cannot disagree (allowed-pattern #14):
 *   - which canvas is this discovery's (`uiDraftsCanvasFor`),
 *   - what the button says (`deriveUiDraftsState`), and
 *   - whether a canvas that just changed opens in the browser (`UiDraftsAsks`).
 *
 * The canvas slug is the discovery's feature name, lowercased with every other
 * run of characters turned into one dash. `.claude/resources/skills/ui-draft-skill.md`
 * tells the agent to use the same slug, so the card finds the canvas it asked for.
 */
import type { FlowArtifactKind } from '../../shared/ipc-contract'
import { isDraftSlug, type DraftCanvasSummary } from '../../shared/ui-drafts'
import { WALKTHROUGH_WRITING_WINDOW_MS } from '../../shared/walkthrough-page'

/** Words on the button while the agent writes: "Writing UI drafts… 3 of 5 screens". */
export const UI_DRAFTS_WRITING_LABEL = 'Writing UI drafts…'

/** How long a half-written canvas still counts as being written — the artifact's own window. */
export const UI_DRAFTS_WRITING_WINDOW_MS = WALKTHROUGH_WRITING_WINDOW_MS

/**
 * The canvas slug for a discovery's feature name, or null when the doc is not a
 * discovery or the name leaves no usable slug.
 */
export function uiDraftsCanvasFor(kind: FlowArtifactKind, feature: string | null): string | null {
  if (kind !== 'discovery' || feature === null) return null
  const slug = feature
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return isDraftSlug(slug) ? slug : null
}

/** What the button is: ask for drafts, wait for them, or open them. */
export type UiDraftsState =
  | { state: 'generate' }
  | { state: 'writing'; written: number; total: number }
  | { state: 'open' }

/** What the pane knows about the canvas, as `drafts:list` answers it. */
export type UiDraftsCanvasInfo = Pick<DraftCanvasSummary, 'screenCount' | 'screensWritten' | 'updatedAt' | 'problem'>

/** Whether a canvas is complete: a readable layout naming screens, and every one of them a file. */
export function isCanvasComplete(canvas: UiDraftsCanvasInfo | null | undefined): boolean {
  if (canvas === null || canvas === undefined || canvas.problem !== undefined) return false
  return canvas.screenCount > 0 && (canvas.screensWritten ?? 0) >= canvas.screenCount
}

/**
 * The button's state.
 *   - complete canvas                         -> open
 *   - layout names screens, not all written, and a file changed inside the
 *     writing window (or this thread just asked) -> writing N of M
 *   - asked, nothing readable yet, inside the window -> writing, no count yet
 *   - a half-written canvas nobody touched for the window -> open (an
 *     interrupted run keeps what it wrote reachable)
 *   - otherwise                                -> generate
 */
export function deriveUiDraftsState(
  canvas: UiDraftsCanvasInfo | null | undefined,
  askedAt: number | null,
  now: number,
): UiDraftsState {
  const asking = askedAt !== null && now - askedAt < UI_DRAFTS_WRITING_WINDOW_MS
  if (canvas === null || canvas === undefined || canvas.problem !== undefined || canvas.screenCount === 0) {
    return asking ? { state: 'writing', written: 0, total: 0 } : { state: 'generate' }
  }
  if (isCanvasComplete(canvas)) return { state: 'open' }
  const written = canvas.screensWritten ?? 0
  const recent = canvas.updatedAt !== undefined && now - canvas.updatedAt < UI_DRAFTS_WRITING_WINDOW_MS
  if (recent || asking) return { state: 'writing', written, total: canvas.screenCount }
  return written > 0 ? { state: 'open' } : { state: 'generate' }
}

/** The label the writing button prints. */
export function uiDraftsWritingText(state: Extract<UiDraftsState, { state: 'writing' }>): string {
  if (state.total <= 0) return UI_DRAFTS_WRITING_LABEL
  return `${UI_DRAFTS_WRITING_LABEL} ${state.written} of ${state.total} ${state.total === 1 ? 'screen' : 'screens'}`
}

/**
 * Which canvases a thread asked for, and which it has already opened.
 *
 * A canvas opens by itself once per thread and canvas: when this thread asked
 * (the Generate button was pressed in it) and the canvas is complete. A second
 * press after it opened asks again, so the next completion opens it again.
 * Canvases written by a prompt typed in a chat are NOT attributed here — an
 * agent's own file writes cannot be tied to one thread reliably (a second
 * thread of the same project may be writing at the same time).
 */
export class UiDraftsAsks {
  readonly #asked = new Map<string, number>()
  readonly #opened = new Set<string>()

  #key(threadId: string, canvas: string): string {
    return `${threadId}\u0000${canvas}`
  }

  /** The Generate button sent its message. */
  record(threadId: string, canvas: string, now: number): void {
    const key = this.#key(threadId, canvas)
    this.#asked.set(key, now)
    this.#opened.delete(key)
  }

  /** When this thread asked for this canvas, or null. */
  askedAt(threadId: string | null, canvas: string): number | null {
    if (threadId === null) return null
    return this.#asked.get(this.#key(threadId, canvas)) ?? null
  }

  /** Whether this thread asked for this canvas and it has not opened yet. */
  pending(threadId: string | null, canvas: string): boolean {
    if (threadId === null) return false
    const key = this.#key(threadId, canvas)
    return this.#asked.has(key) && !this.#opened.has(key)
  }

  /**
   * Whether the canvas opens now. True at most once per ask, and only for a
   * complete canvas; the answer is final the moment it is true.
   */
  takeOpen(threadId: string | null, canvas: string, info: UiDraftsCanvasInfo | null | undefined): boolean {
    if (threadId === null || !this.pending(threadId, canvas) || !isCanvasComplete(info)) return false
    this.#opened.add(this.#key(threadId, canvas))
    return true
  }
}

/**
 * Pure, DOM-free model of the chat's canvas card: a UI drafts canvas the agent
 * wrote during a request, shown under that request's work row with an Open
 * canvas button, and opened in the browser once when the turn ends.
 *
 * The discovery card has its own UI drafts button (`ui-drafts-card-model.ts`),
 * which only knows a canvas it asked for. This one knows a canvas by what the
 * turn wrote: any file under `<project>/flow/drafts/<canvas>/`, so a canvas
 * asked for in a person's own words is tied to the conversation that wrote it.
 */
import { DRAFTS_DIR, isDraftSlug } from '../../shared/ui-drafts'
import { isCanvasComplete, type UiDraftsCanvasInfo } from './ui-drafts-card-model'

/** One canvas a request wrote: the project it lives in and its slug. */
export interface WrittenCanvas {
  root: string
  canvas: string
}

const MARKER = `/${DRAFTS_DIR}/`

/**
 * The canvases among `paths` (absolute file paths a request changed), in the
 * order first seen, each once. A path outside a drafts folder, a file sitting
 * directly in `flow/drafts/`, or a slug the drafts code would refuse is not a
 * canvas.
 */
export function canvasesInPaths(paths: readonly string[]): WrittenCanvas[] {
  const out: WrittenCanvas[] = []
  for (const raw of paths) {
    const path = raw.replace(/\\/g, '/')
    const at = path.lastIndexOf(MARKER)
    if (at <= 0) continue
    const rest = path.slice(at + MARKER.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) continue
    const canvas = rest.slice(0, slash)
    if (!isDraftSlug(canvas)) continue
    const root = path.slice(0, at)
    if (!out.some((seen) => seen.root === root && seen.canvas === canvas)) out.push({ root, canvas })
  }
  return out
}

/** What the card shows. */
export interface CanvasCardView {
  title: string
  detail: string
  /** The button opens the canvas only when there is something to open. */
  canOpen: boolean
}

/** Info as `drafts:list` answers it, plus the layout's name. */
export type CanvasCardInfo = UiDraftsCanvasInfo & { name?: string }

const screens = (n: number): string => (n === 1 ? '1 screen' : `${String(n)} screens`)

/**
 * The card's words.
 *   - info not read yet         -> the slug, "Canvas"
 *   - the layout cannot be read -> its problem, still openable (the canvas page
 *                                  shows what is wrong better than a card can)
 *   - the request still running and screens missing -> "Writing the canvas… N of M screens"
 *   - otherwise                 -> "Canvas · M screens"
 */
export function canvasCardView(
  canvas: string,
  info: CanvasCardInfo | null | undefined,
  live: boolean,
): CanvasCardView {
  if (info === null || info === undefined) {
    return { title: canvas, detail: live ? 'Writing the canvas…' : 'Canvas', canOpen: !live }
  }
  const title = info.name !== undefined && info.name.trim() !== '' ? info.name : canvas
  if (info.problem !== undefined) return { title, detail: info.problem, canOpen: true }
  if (live && !isCanvasComplete(info)) {
    const written = info.screensWritten ?? 0
    const detail =
      info.screenCount > 0
        ? `Writing the canvas… ${String(written)} of ${screens(info.screenCount)}`
        : 'Writing the canvas…'
    return { title, detail, canOpen: false }
  }
  return { title, detail: info.screenCount > 0 ? `Canvas · ${screens(info.screenCount)}` : 'Canvas', canOpen: true }
}

/**
 * Remembers which turns already opened their canvases, so a canvas opens once
 * per turn: a rebuild of the same request, a reconcile, or coming back to the
 * conversation never opens it again.
 */
export class CanvasOpenLedger {
  #pending = new Map<string, string>()
  #opened = new Set<string>()

  /** The turn that ended with `messageId` in `threadId` may open its canvases. */
  turnEnded(threadId: string, messageId: string): void {
    this.#pending.set(threadId, messageId)
  }

  /**
   * True once for each canvas of the request that ended the turn: the request
   * whose message ids include the pending one. Clears nothing else.
   */
  take(threadId: string | null, messageIds: readonly string[], written: WrittenCanvas): boolean {
    if (threadId === null) return false
    const pending = this.#pending.get(threadId)
    if (pending === undefined || !messageIds.includes(pending)) return false
    const key = `${threadId}\u0000${pending}\u0000${written.root}\u0000${written.canvas}`
    if (this.#opened.has(key)) return false
    this.#opened.add(key)
    return true
  }
}

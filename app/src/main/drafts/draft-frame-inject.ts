/**
 * THE CANVAS'S FRAME PICKER, injected from main.
 *
 * A draft canvas shows each screen in a sandboxed, out-of-process frame. The
 * guest preload does not run in those frames (measured in the phase 1 spike),
 * so the stock picker cannot see inside them. Main can: it reaches every frame
 * of the guest and runs the picker in each screen frame of a canvas page. The
 * picker is inert until the canvas turns inspect on, and it talks only to its
 * parent (the canvas page) — see `draft-pick.ts` for the relay.
 *
 * Re-injected on every frame load, because an edit, a tokens change or a
 * version switch reloads a frame and its document starts over; the canvas
 * re-sends its inspect state and selection when the new picker reports ready.
 * Bounded: a frame that never answers cannot hold anything up (#19).
 */
import { draftFramePickerSource } from '../../shared/draft-pick'
import { DRAFT_ID_ATTRIBUTE, parseDraftPageUrl } from '../../shared/ui-drafts'

/** The slice of a `WebFrameMain` this module uses. */
export interface InjectableFrame {
  url: string
  parent: InjectableFrame | null
  executeJavaScript(code: string): Promise<unknown>
}

/** The slice of a guest `WebContents` this module uses. */
export interface InjectableGuest {
  on(
    event: 'did-frame-finish-load',
    listener: (event: unknown, isMainFrame: boolean, frameProcessId: number, frameRoutingId: number) => void,
  ): unknown
  isDestroyed(): boolean
}

/** How long one injection may take before it is given up. */
export const FRAME_INJECT_TIMEOUT_MS = 3000

const PICKER_SOURCE = draftFramePickerSource(DRAFT_ID_ATTRIBUTE)

/** Whether `frame` is a screen framed by a canvas page — the only frames that get the picker. */
export function isCanvasScreenFrame(frame: Pick<InjectableFrame, 'url' | 'parent'>): boolean {
  const own = parseDraftPageUrl(frame.url)
  if (own === null || own.kind !== 'screen' || own.mode !== 'framed') return false
  const parent = frame.parent === null ? null : parseDraftPageUrl(frame.parent.url)
  return parent !== null && parent.kind === 'canvas' && parent.root === own.root && parent.canvas === own.canvas
}

/** Run the picker in one frame, bounded; a failure is logged and dropped. */
export async function injectFramePicker(frame: InjectableFrame, timeoutMs = FRAME_INJECT_TIMEOUT_MS): Promise<boolean> {
  if (!isCanvasScreenFrame(frame)) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      frame.executeJavaScript(PICKER_SOURCE),
      new Promise((settle) => {
        timer = setTimeout(settle, timeoutMs)
      }),
    ])
    return true
  } catch (error) {
    console.warn('[Drafts] could not start the picker in a screen frame', { url: frame.url, error })
    return false
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Inject the picker into every screen frame of a canvas the guest loads, on
 * each frame load. `frameById` resolves a frame from its process and routing
 * ids (Electron's `webFrameMain.fromId`).
 */
export function attachDraftFramePicker(
  guest: InjectableGuest,
  frameById: (processId: number, routingId: number) => InjectableFrame | null | undefined,
): void {
  guest.on('did-frame-finish-load', (_event, isMainFrame, processId, routingId) => {
    if (isMainFrame || guest.isDestroyed()) return
    let frame: InjectableFrame | null | undefined
    try {
      frame = frameById(processId, routingId)
    } catch {
      return
    }
    if (frame === null || frame === undefined) return
    void injectFramePicker(frame)
  })
}

// Screenshot of the embedded <webview> browser as a pending image attachment.
//
// Uses the guest webContents' `capturePage()` — cross-platform, no shelling out
// to `screencapture` (that path is macOS-only interactive region capture; see
// attachments/capture.ts). Returns null when no guest is attached or the page
// is blank, mirroring `attachments:captureScreen`'s null-on-nothing shape and
// the same MessageAttachmentInput fields (id, mediaType, fileName, byteSize,
// width/height, dataBase64).

import { randomUUID } from 'node:crypto'
import type { Rectangle, WebContents } from 'electron'

import type { MessageAttachmentInput } from '../../shared/ipc-contract'

const CAPTURE_MEDIA_TYPE = 'image/png'

/** What a screenshot request may narrow: a box of the page and the picture's name. */
export interface ScreenshotOptions {
  rect?: Rectangle
  fileName?: string
}

const FILE_NAME_MAX = 120

/**
 * The options of a `browser:captureScreenshot` request, validated at the
 * boundary: a box with finite, positive size (whole pixels, never above the
 * page's top-left), and a short one-line name. Anything else is dropped, so a
 * bad box is the whole page and a bad name is the default one.
 */
export function screenshotOptions(request: unknown): ScreenshotOptions {
  if (request === null || typeof request !== 'object') return {}
  const raw = request as { rect?: unknown; fileName?: unknown }
  const options: ScreenshotOptions = {}
  if (raw.rect !== null && typeof raw.rect === 'object') {
    const box = raw.rect as Record<string, unknown>
    const values = [box.x, box.y, box.width, box.height]
    if (values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      const [x, y, width, height] = values as number[]
      const left = Math.max(0, Math.floor(x))
      const top = Math.max(0, Math.floor(y))
      const right = Math.ceil(x + width)
      const bottom = Math.ceil(y + height)
      if (right - left > 0 && bottom - top > 0) options.rect = { x: left, y: top, width: right - left, height: bottom - top }
    }
  }
  if (typeof raw.fileName === 'string') {
    const name = raw.fileName.replace(/[\r\n\t]+/g, ' ').trim()
    if (name.length > 0 && name.length <= FILE_NAME_MAX) options.fileName = name
  }
  return options
}

/**
 * Capture the guest page as a pending PNG attachment, or null when there is no
 * live guest or the capture came back empty. Never throws for the missing-guest
 * case — a screenshot with nothing to shoot is "nothing", not an error.
 */
export async function captureScreenshot(
  guest: WebContents | null,
  options: ScreenshotOptions = {},
): Promise<MessageAttachmentInput | null> {
  if (!guest || guest.isDestroyed()) return null

  // A box partly off the page captures what is on it; a box wholly off it
  // comes back empty, and the whole page is the better picture than none.
  let image = options.rect === undefined ? await guest.capturePage() : await guest.capturePage(options.rect)
  if (image.isEmpty() && options.rect !== undefined) image = await guest.capturePage()
  if (image.isEmpty()) return null

  const bytes = image.toPNG()
  if (bytes.byteLength === 0) return null

  const { width, height } = image.getSize()
  return {
    // A captured shot is always unique — a UUID id is fine (no dedup concern).
    id: `img:browser:${randomUUID()}`,
    mediaType: CAPTURE_MEDIA_TYPE,
    fileName: options.fileName ?? 'browser.png',
    byteSize: bytes.byteLength,
    width,
    height,
    dataBase64: bytes.toString('base64'),
  }
}

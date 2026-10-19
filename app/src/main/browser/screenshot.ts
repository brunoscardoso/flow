// Screenshot of the embedded <webview> browser as a pending image attachment.
//
// Uses the guest webContents' `capturePage()` — cross-platform, no shelling out
// to `screencapture` (that path is macOS-only interactive region capture; see
// attachments/capture.ts). Returns null when no guest is attached or the page
// is blank, mirroring `attachments:captureScreen`'s null-on-nothing shape and
// the same MessageAttachmentInput fields (id, mediaType, fileName, byteSize,
// width/height, dataBase64).

import { randomUUID } from 'node:crypto'
import type { WebContents } from 'electron'

import type { MessageAttachmentInput } from '../../shared/ipc-contract'

const CAPTURE_MEDIA_TYPE = 'image/png'

/**
 * Capture the guest page as a pending PNG attachment, or null when there is no
 * live guest or the capture came back empty. Never throws for the missing-guest
 * case — a screenshot with nothing to shoot is "nothing", not an error.
 */
export async function captureScreenshot(
  guest: WebContents | null,
): Promise<MessageAttachmentInput | null> {
  if (!guest || guest.isDestroyed()) return null

  const image = await guest.capturePage()
  if (image.isEmpty()) return null

  const bytes = image.toPNG()
  if (bytes.byteLength === 0) return null

  const { width, height } = image.getSize()
  return {
    // A captured shot is always unique — a UUID id is fine (no dedup concern).
    id: `img:browser:${randomUUID()}`,
    mediaType: CAPTURE_MEDIA_TYPE,
    fileName: 'browser.png',
    byteSize: bytes.byteLength,
    width,
    height,
    dataBase64: bytes.toString('base64'),
  }
}

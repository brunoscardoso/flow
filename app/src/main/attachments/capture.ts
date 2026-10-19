// Native macOS screenshot region capture (#456). Shells out to `screencapture -i`
// (the same interactive region select as ⌘⇧4) writing a PNG to a temp file, then
// reads it into a pending attachment and cleans up. Returns null on a cancelled
// capture (the user pressed Esc) or off-platform. macOS-only — gated by
// isCaptureSupported at the IPC boundary.
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { MessageAttachmentInput } from '../../shared/ipc-contract'

const CAPTURE_MEDIA_TYPE = 'image/png'

/**
 * Run interactive region capture and return a pending PNG attachment, or null if the
 * user cancelled (no file written). Rejects only on an unexpected spawn failure.
 */
export async function captureScreenRegion(): Promise<MessageAttachmentInput | null> {
  const tmpPath = join(tmpdir(), `flow-capture-${randomUUID()}.png`)
  const exitCode = await new Promise<number>((resolve, reject) => {
    // -i interactive region select, -x no capture sound, -t png.
    const child = spawn('screencapture', ['-i', '-x', '-t', 'png', tmpPath])
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 0))
  })

  if (exitCode !== 0) {
    return null
  }

  let bytes: Buffer
  try {
    bytes = await readFile(tmpPath)
  } catch {
    // No file written → the user cancelled the selection (Esc).
    return null
  } finally {
    void rm(tmpPath, { force: true }).catch(() => {})
  }

  if (bytes.byteLength === 0) {
    return null
  }

  const dataBase64 = bytes.toString('base64')
  return {
    // A captured shot is always unique — a UUID id is fine (no dedup concern).
    id: `img:capture:${randomUUID()}`,
    mediaType: CAPTURE_MEDIA_TYPE,
    fileName: 'screenshot.png',
    byteSize: bytes.byteLength,
    dataBase64,
  }
}

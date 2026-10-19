// Image attachment model (#456). Pure, DOM-free validation + identity for images
// the user attaches to a composer message (paste / drag-drop / file picker / native
// capture). Images are sent to the agent as vision blocks and persist with the
// thread. Kept side-effect-free so every rule is unit-testable under the node env;
// the composer owns the DOM (thumbnail chips), the store owns the bytes.

/** Media types Claude accepts as vision input; v1 is images-only. */
export const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const

export type AllowedImageType = (typeof ALLOWED_IMAGE_TYPES)[number]

/** Per-image byte ceiling (5 MB) — bounds SDK payload + on-disk footprint. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/** Max images per message — bounds a single turn's vision payload. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8

export function isAllowedImageType(mediaType: string): mediaType is AllowedImageType {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(mediaType)
}

/**
 * Deterministic id from media type + byte size + a content fingerprint, so
 * attaching the identical image twice dedups (mirrors context-chip id).
 */
export function attachmentId(mediaType: string, byteSize: number, fingerprint: string): string {
  return `img:${mediaType}:${byteSize}:${fingerprint}`
}

export type AttachmentValidation = { ok: true } | { ok: false; reason: string }

/**
 * Validate an image attachment's media type + size. Rejections carry a
 * user-facing reason (no silent failure); the caller surfaces it as a notice and
 * drops the file.
 */
export function validateAttachment(input: {
  mediaType: string
  byteSize: number
}): AttachmentValidation {
  if (!isAllowedImageType(input.mediaType)) {
    return { ok: false, reason: `Unsupported file type (${input.mediaType || 'unknown'}) — images only` }
  }
  if (input.byteSize <= 0) {
    return { ok: false, reason: 'Empty image' }
  }
  if (input.byteSize > MAX_IMAGE_BYTES) {
    const mb = (MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0)
    return { ok: false, reason: `Image is too large (max ${mb} MB)` }
  }
  return { ok: true }
}

/** Whether another attachment can be added given the current count. */
export function canAddAttachment(currentCount: number): boolean {
  return currentCount < MAX_ATTACHMENTS_PER_MESSAGE
}

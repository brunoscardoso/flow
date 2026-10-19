// On-disk layout for message attachments (#456). Image bytes live on disk (under
// the app's userData), NOT inlined in SQLite — the store keeps only metadata + this
// relative path. Pure/DOM-free so the layout + extension mapping is unit-testable;
// the store joins `rel_path` onto the attachments root.

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** File extension for an image media type (default 'bin' for anything unexpected). */
export function extensionForMediaType(mediaType: string): string {
  return EXTENSION_BY_MEDIA_TYPE[mediaType] ?? 'bin'
}

/**
 * Filesystem-safe form of an attachment id. IDs are content-derived
 * (`img:<mediaType>:<byteSize>:<fingerprint>`, see image-attachment.ts) and embed
 * `:` and `/` from the media type — both illegal inside a Windows path segment
 * (`:` anywhere but after a drive letter) or meaningful as a separator on every
 * platform. Swap them for `_` so the id stays a single path component everywhere.
 */
function sanitizeForPath(id: string): string {
  return id.replace(/[:/\\]/g, '_')
}

/**
 * Repo-relative path for an attachment's bytes: `<threadId>/<id>.<ext>`. Kept
 * relative (joined onto the attachments root at read/write time) so the DB rows are
 * portable and never embed an absolute machine path.
 */
export function attachmentRelPath(threadId: string, attachmentId: string, mediaType: string): string {
  return `${threadId}/${sanitizeForPath(attachmentId)}.${extensionForMediaType(mediaType)}`
}

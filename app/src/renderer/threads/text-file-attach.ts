/**
 * Text-file attachments (#772): attaching an .md (or any text) file folds its
 * CONTENT into the message as a context chip — the exact mechanism terminal
 * selections use (#152) — so nothing changes in the IPC/agent pipeline, and
 * the file renders as a compact labeled badge instead of raw bytes. Pure and
 * DOM-free so the classification unit-tests under node-env jest; the composer
 * owns File reading + chip state.
 */

/** Extensions accepted as text attachments (lowercase, with dot). */
const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.log',
  '.json',
  '.jsonl',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.xml',
  '.html',
  '.css',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.java',
  '.sh',
  '.sql',
])

/** Cap so a dropped log/dataset can't balloon the message the agent reads. */
export const TEXT_ATTACH_MAX_BYTES = 512 * 1024

/**
 * A network recording, which is read rather than pasted.
 *
 * `.har` fell between the two existing answers and was refused by both: the
 * extension is not on the text list, and a real capture (1–22 MB on the machine
 * this was written against) is far past the text cap anyway. But a HAR is not a
 * document that happens to be long — it is a few hundred structured records, and
 * `har-summary.ts` turns 22 MB into ~4 KB of exactly the facts somebody opens
 * one to read. So the text cap does not apply to it, and this ceiling exists for
 * a different reason: the file is JSON.parse'd in the renderer, and a parse is
 * bounded by memory rather than by message size.
 */
export const HAR_MAX_BYTES = 64 * 1024 * 1024

export type AttachClass =
  | 'image'
  | 'text'
  | 'har'
  | 'har-too-large'
  | 'text-too-large'
  | 'text-empty'
  | 'unsupported'

/** Why a refused attachment was refused — every reason maps to a LOUD notice
 *  (#772/#1086). 'unreadable' only surfaces at read time (file.text() threw),
 *  so it is a reject reason without being a classification. */
export type AttachRejectReason =
  | Exclude<AttachClass, 'image' | 'text' | 'har'>
  | 'unreadable'
  | 'har-unreadable'

/**
 * Classify a would-be attachment by media type, name, and size. Images keep
 * their existing vision-block pipeline (#456); recognized text files become
 * context chips; oversized text is refused with feedback (never silently);
 * a 0-byte text file is refused as empty (#1086 — the whitespace-only case is
 * caught post-read in the composer); everything else is unsupported.
 */
export function classifyAttachment(name: string, mediaType: string, byteSize: number): AttachClass {
  if (mediaType.startsWith('image/')) return 'image'
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : ''
  // BY NAME, NOT BY MEDIA TYPE. A `.har` is JSON, and browsers hand it over as
  // `application/json` or as an empty string depending on the OS — so the type
  // decides nothing here and the extension decides everything. Checked before
  // the text branch, which would otherwise claim it as JSON and refuse it for
  // being over a cap that does not apply.
  if (ext === '.har') {
    if (byteSize <= 0) return 'text-empty'
    return byteSize > HAR_MAX_BYTES ? 'har-too-large' : 'har'
  }
  const textual = mediaType.startsWith('text/') || mediaType === 'application/json' || TEXT_EXTENSIONS.has(ext)
  if (!textual) return 'unsupported'
  if (byteSize <= 0) return 'text-empty'
  return byteSize > TEXT_ATTACH_MAX_BYTES ? 'text-too-large' : 'text'
}

/** The user-facing body for a refused attachment — one message per reason so
 *  every silent-drop path shares the same loud vocabulary (#1086). */
export function rejectReasonMessage(name: string, reason: AttachRejectReason): string {
  switch (reason) {
    case 'text-too-large':
      return `${name} is too large to attach as text (limit ${Math.round(TEXT_ATTACH_MAX_BYTES / 1024)} KB).`
    case 'text-empty':
      return `${name} is empty (nothing to attach).`
    case 'unreadable':
      return `${name} could not be read.`
    case 'har-too-large':
      return `${name} is too large to read (limit ${Math.round(HAR_MAX_BYTES / 1024 / 1024)} MB).`
    case 'har-unreadable':
      return `${name} isn't a HAR network recording Flow can read.`
    case 'unsupported':
      return `${name} isn't a supported attachment (images, text files and .har recordings).`
  }
}

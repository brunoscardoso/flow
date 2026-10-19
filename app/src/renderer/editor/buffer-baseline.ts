/**
 * ONE BUFFER PER FILE, AND KNOWING WHAT IT WAS TYPED OVER — the pure half of
 * keeping unsaved work honest across conversation switches.
 *
 * Every conversation has its own tab set, but a file has ONE buffer (as in VS
 * Code): a dirty model stays alive in the host when its conversation is
 * switched away from, and a set that opens the same file again gets that live
 * buffer — never a second, diverging copy. A persisted buffer (what a set
 * remembers across a restart, or after its model was let go) is a snapshot,
 * and the disk may have moved on since it was taken; its BASELINE — a hash of
 * the disk content it was typed over — is what tells the two apart.
 *
 * DOM-free and Monaco-free (allowed-pattern #14): `index.ts` and
 * `monaco-host.ts` ask these questions; nothing else answers them.
 */

/**
 * A short fingerprint of a buffer's text: FNV-1a over UTF-16 code units, plus
 * the length. Not cryptographic — it only has to say "this is not the content
 * the buffer was typed over", and a collision costs no more than the guard
 * that existed before it.
 */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${text.length.toString(36)}-${hash.toString(36)}`
}

/** What to do with a persisted unsaved buffer when its set is rebuilt. */
export type DirtyRestoreDecision =
  /** The snapshot was taken FROM the model still alive: that model is the
   *  buffer, newer than the snapshot. Applying it would revert whatever
   *  happened since (a save from another conversation, more typing). */
  | 'keep-live'
  /** Put the typed text back over the disk content, dirty. */
  | 'restore'
  /** Put it back, but the disk changed since it was captured: flag it so a
   *  save asks before overwriting the newer version. */
  | 'restore-changed-on-disk'

export function decideDirtyRestore(input: {
  /** The snapshot was captured from the very model instance alive now. A
   *  model that merely exists for the same path (opened fresh this session)
   *  is NOT this — its snapshot from a previous session is still owed. */
  wasLive: boolean
  /** Hash of the disk content the buffer was typed over, when captured. */
  capturedBaseline: string | undefined
  /** Hash of the disk content just read for the reopened file. */
  diskBaseline: string | undefined
}): DirtyRestoreDecision {
  if (input.wasLive) return 'keep-live'
  // Buffers persisted before baselines existed carry none — nothing to compare.
  if (input.capturedBaseline === undefined || input.diskBaseline === undefined) return 'restore'
  return input.capturedBaseline === input.diskBaseline ? 'restore' : 'restore-changed-on-disk'
}

/** What to do with a LIVE model when its file is opened again (a set brings
 *  it back, or a press opens it) and the disk has just been read. */
export type LiveReopenDecision =
  /** Disk and buffer agree about the baseline — nothing to do. */
  | 'keep'
  /** A clean buffer behind the disk: reload it (undoably). */
  | 'reload'
  /** A dirty buffer whose file changed under it: keep the typing, flag it. */
  | 'flag-changed-on-disk'

export function decideLiveReopen(input: {
  dirty: boolean
  /** Hash of the disk content the live buffer was last in sync with. */
  baseline: string | undefined
  /** Hash of the disk content just read. */
  disk: string
}): LiveReopenDecision {
  if (input.baseline === input.disk) return 'keep'
  return input.dirty ? 'flag-changed-on-disk' : 'reload'
}

/**
 * Which live models a rebuilt set lets go of: every model no tab holds, except
 * a dirty one for a real file — that one is the file's only buffer, and the
 * set it was typed in will want it back. A scratch note is never kept: it
 * belongs to one set and is restored from its own snapshot.
 */
export function modelsToRelease(input: {
  live: Iterable<string>
  open: ReadonlySet<string>
  isDirty: (path: string) => boolean
  isUntitled: (path: string) => boolean
}): string[] {
  const release: string[] = []
  for (const path of input.live) {
    if (input.open.has(path)) continue
    if (input.isDirty(path) && !input.isUntitled(path)) continue
    release.push(path)
  }
  return release
}

/**
 * Monaco's cancellation rejection. Swapping or disposing a model cancels the
 * editor's in-flight async features (WordHighlighter, hovers, code lens), and
 * some of those cancellations surface as unhandled rejections whose reason is a
 * `CancellationError` — named and messaged exactly 'Canceled'. VS Code's own
 * `onUnexpectedError` ignores it; this is the test the renderer uses to do the
 * same, and nothing wider.
 */
export function isMonacoCancellation(reason: unknown): boolean {
  if (reason === null || typeof reason !== 'object') return false
  const error = reason as { name?: unknown; message?: unknown }
  return error.name === 'Canceled' && error.message === 'Canceled'
}

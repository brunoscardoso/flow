// One hunk of one file, picked out of git's own diff — the pure half of
// stage / unstage / revert hunk (Source Control, diff tab).
//
// WHY MAIN OWNS THE HUNK LIST. The diff tab draws a "Stage hunk" button over
// each change, and the button sends back WHICH hunk it meant. If the renderer
// computed hunks itself (Monaco's line changes) and main computed them again
// from `git diff`, two different diff algorithms would be asked to agree on an
// index — and a disagreement would stage the wrong lines. So main parses git's
// diff once, hands the renderer the list (index, header, digest), and on the
// press parses it AGAIN and refuses unless the hunk at that index still has the
// header and the digest the renderer saw. A file edited in between is refused
// in words, never patched blindly.
//
// `-U0` hunks: every change region is its own hunk (no context merging two
// nearby edits into one), which is what a person pointing at one change means.
// Applying them needs `git apply --unidiff-zero`, which the caller passes.
//
// Pure and DOM-free (allowed-pattern #14: one parser, used by the diff read
// AND the apply, so the two can never disagree about what hunk 3 is).

import { createHash } from 'crypto'

export interface ParsedHunk {
  /** Position in the file's hunk list, 0-based. */
  index: number
  /** The `@@ -a,b +c,d @@` line, verbatim (any trailing section text dropped). */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The hunk's lines after the header, verbatim, newline-terminated. */
  body: string
  /** sha1 of header + body — what the renderer echoes back to prove it saw THIS hunk. */
  digest: string
}

export interface ParsedFileDiff {
  /** Everything before the first hunk (`diff --git`, index, ---/+++ lines). */
  fileHeader: string
  hunks: ParsedHunk[]
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** Digest of one hunk's header + body. Exported for tests. */
export function hunkDigest(header: string, body: string): string {
  return createHash('sha1').update(header).update('\n').update(body).digest('hex').slice(0, 16)
}

/**
 * Parse `git diff` output for ONE file. Returns null when there is nothing to
 * parse (no change) or when the output describes more than one file — a hunk
 * index is only meaningful within a single file, so an ambiguous diff is not
 * guessed at.
 */
export function parseSingleFileDiff(raw: string): ParsedFileDiff | null {
  if (raw.trim().length === 0) return null
  const lines = raw.split('\n')
  // A trailing newline yields one empty last element; it is not a diff line.
  if (lines[lines.length - 1] === '') lines.pop()
  const fileStarts = lines.filter((line) => line.startsWith('diff --git ')).length
  if (fileStarts > 1) return null
  const headerLines: string[] = []
  const hunks: ParsedHunk[] = []
  let current: { header: string; nums: number[]; body: string[] } | null = null
  const flush = (): void => {
    if (current === null) return
    const body = current.body.length > 0 ? `${current.body.join('\n')}\n` : ''
    const [oldStart = 0, oldLines = 1, newStart = 0, newLines = 1] = current.nums
    hunks.push({
      index: hunks.length,
      header: current.header,
      oldStart,
      oldLines,
      newStart,
      newLines,
      body,
      digest: hunkDigest(current.header, body),
    })
    current = null
  }
  for (const line of lines) {
    const match = HUNK_HEADER.exec(line)
    if (match !== null) {
      flush()
      current = {
        header: match[0],
        nums: [
          Number(match[1]),
          match[2] === undefined ? 1 : Number(match[2]),
          Number(match[3]),
          match[4] === undefined ? 1 : Number(match[4]),
        ],
        body: [],
      }
      continue
    }
    if (current === null) headerLines.push(line)
    else current.body.push(line)
  }
  flush()
  if (hunks.length === 0) return null
  return { fileHeader: headerLines.length > 0 ? `${headerLines.join('\n')}\n` : '', hunks }
}

export type HunkSelection =
  | { ok: true; hunk: ParsedHunk; patch: string }
  | { ok: false; reason: 'gone' | 'moved' | 'binary'; detail: string }

/**
 * Pick hunk `index` and prove it is the one the caller saw.
 *
 * Refuses — with a sentence about the file, never a command (forbidden #12) —
 * when the diff has no such hunk any more, or when the hunk at that index has a
 * different header or body than the caller's. The patch returned is the file
 * header plus that one hunk, ready for `git apply --unidiff-zero`.
 */
export function selectHunk(
  diff: ParsedFileDiff | null,
  index: number,
  expectedHeader: string,
  expectedDigest?: string,
): HunkSelection {
  if (diff === null) {
    return {
      ok: false,
      reason: 'gone',
      detail: 'This file has no changes there any more. The diff was refreshed.',
    }
  }
  if (/^Binary files /m.test(diff.fileHeader) || /^GIT binary patch/m.test(diff.fileHeader)) {
    return { ok: false, reason: 'binary', detail: 'A binary file has no hunks to take one at a time.' }
  }
  const hunk = Number.isInteger(index) && index >= 0 ? diff.hunks[index] : undefined
  if (hunk === undefined) {
    return {
      ok: false,
      reason: 'gone',
      detail: 'That change is no longer in this file. The diff was refreshed.',
    }
  }
  if (hunk.header !== expectedHeader || (expectedDigest !== undefined && hunk.digest !== expectedDigest)) {
    return {
      ok: false,
      reason: 'moved',
      detail: 'This file changed since the diff was shown, so nothing was applied. The diff was refreshed.',
    }
  }
  return { ok: true, hunk, patch: `${diff.fileHeader}${hunk.header}\n${hunk.body}` }
}

/** The renderer's view of a hunk: what it needs to place a button and echo back. */
export function publicHunks(
  diff: ParsedFileDiff | null,
  cap: number,
): { hunks: Array<Omit<ParsedHunk, 'body'>>; truncated: boolean } {
  if (diff === null) return { hunks: [], truncated: false }
  const all = diff.hunks.map(({ body: _body, ...rest }) => rest)
  return { hunks: all.slice(0, cap), truncated: all.length > cap }
}

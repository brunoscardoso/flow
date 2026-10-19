// Invariants contract parser (#898 Phase B input).
//
// Learned module docs (flow/brain/modules/<m>.md) carry a `## Invariants`
// section — bulleted, one testable invariant per bullet, each optionally
// naming the file(s) it was verified against in backticks. This module is the
// ONE reader of that contract (allowed-pattern #14): the invariant checker and
// any UI surface parse through here, never with ad-hoc regexes.
//
// Tolerance is the point — legacy docs written before the contract have no
// section; the parser reports `present: false` and the checker surfaces
// "no invariants learned yet" instead of erroring. A `- (none observed)`
// sentinel parses as present-but-empty (the doc DID consider invariants).

export interface ParsedInvariant {
  /** The invariant text with file references stripped of backticks. */
  text: string
  /** Repo/module-relative file paths named in the bullet (backtick-quoted). */
  files: string[]
}

export interface ParsedInvariants {
  invariants: ParsedInvariant[]
  /** True when the doc carries a `## Invariants` heading at all. */
  present: boolean
}

/** Matches a `## Invariants` heading line (any trailing text ignored). */
const HEADING = /^##\s+Invariants\s*$/i

/** Matches the explicit "nothing to assert" sentinel bullet. */
const NONE_SENTINEL = /^\(?none observed\)?\.?$/i

/** Backtick-quoted spans that look like file paths (have a dot or slash). */
const FILE_REF = /`([^`\n]+)`/g

const looksLikeFile = (span: string): boolean =>
  !span.includes(' ') && (span.includes('/') || span.includes('.'))

/**
 * Parse a learned doc's `## Invariants` section. Absent section (legacy docs,
 * empty input) → `{invariants: [], present: false}`; a section holding only
 * `- (none observed)` → `{invariants: [], present: true}`.
 */
export function parseInvariants(docText: string): ParsedInvariants {
  const lines = docText.split('\n')
  const start = lines.findIndex((line) => HEADING.test(line.trim()))
  if (start === -1) return { invariants: [], present: false }

  const invariants: ParsedInvariant[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (/^#{1,6}\s/.test(line)) break // next heading ends the section
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet === null) continue
    const text = bullet[1].trim()
    if (text === '' || NONE_SENTINEL.test(text)) continue

    const files: string[] = []
    for (const match of text.matchAll(FILE_REF)) {
      const span = match[1].trim()
      if (looksLikeFile(span) && !files.includes(span)) files.push(span)
    }
    invariants.push({ text: text.replaceAll('`', ''), files })
  }
  return { invariants, present: true }
}

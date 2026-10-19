// Bare-URL autolinking for the conversation's markdown renderer (#1127).
//
// The renderer only ever linkified the bracketed `[text](url)` form, so the way
// a URL ACTUALLY reaches the transcript — written bare in prose ("Opened the
// PR: https://github.com/acme/widgets/pull/42") — rendered as inert grey text:
// nothing to click, no context menu, hand-select-and-copy only. GFM autolinks
// these, so the transcript was also non-conformant with the flavour users
// expect from an agent.
//
// DOM-free so the hard part — where a URL *ends* — unit-tests directly. Two
// forms are recognized:
//   * bare:  `see https://docs.example.com/guide.` → the trailing `.` is prose
//   * angle: `<https://docs.example.com/guide>`    → the brackets are markup
//
// The renderer runs this AFTER its own rules and only accepts a hit that starts
// strictly earlier than every rule match, so a code span (`` `https://x` ``)
// and a bracketed link ([text](https://x)) still win at the same position.

/** A URL found in prose, plus the source span the caller must consume. */
export interface AutolinkHit {
  /** Index in the scanned text where the consumed span starts. */
  index: number
  /** Length of the consumed span — includes the `<>` of the angle form. */
  length: number
  /** The URL itself (href and link text). */
  url: string
}

/** `<https://…>` — the whole span, brackets included, is markup. */
const ANGLE_RE = /<(https?:\/\/[^\s<>]+)>/

/**
 * A bare URL. The lookbehind keeps `xhttps://…`, `mailto:foo@https://…`-style
 * junk and the `](https://…)` tail of a bracketed link from starting a match;
 * the character class stops at whitespace, angle brackets, backticks and quotes
 * — everything else is trimmed structurally below, because `)` and `.` are both
 * legitimately *inside* URLs and legitimately prose right after one.
 */
const BARE_RE = /(?<![\w@`])(https?:\/\/[^\s<>`"]+)/g

/** Sentence punctuation that is never the last character of a linked URL. */
const TRAILING_PUNCTUATION = new Set([
  '.', ',', ';', ':', '!', '?', "'", '*', '_', '~', '“', '”', '‘', '’', '»',
])

function occurrences(text: string, character: string): number {
  let count = 0
  for (const char of text) {
    if (char === character) count += 1
  }
  return count
}

/**
 * Drop the prose that the greedy scan swallowed off the end of a URL.
 *
 * Sentence punctuation always goes. A closing bracket goes only when it is
 * UNBALANCED — `…/wiki/Foo_(bar)` keeps its paren, `(see https://x)` does not.
 * Iterated, because a URL can end in both ("…(bar).").
 */
export function trimUrlTail(raw: string): string {
  let url = raw
  for (;;) {
    const last = url[url.length - 1]
    if (last === undefined) return url
    if (TRAILING_PUNCTUATION.has(last)) {
      url = url.slice(0, -1)
      continue
    }
    if (last === ')' && occurrences(url, ')') > occurrences(url, '(')) {
      url = url.slice(0, -1)
      continue
    }
    if (last === ']' && occurrences(url, ']') > occurrences(url, '[')) {
      url = url.slice(0, -1)
      continue
    }
    return url
  }
}

/** A URL is linkable only once it has a scheme AND at least one host character. */
function hasHost(url: string): boolean {
  return /^https?:\/\/[^\s/?#]/.test(url)
}

/** The earliest bare URL in `text`, or null. Skips scheme-only fragments. */
function findBare(text: string): AutolinkHit | null {
  BARE_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = BARE_RE.exec(text)) !== null) {
    const url = trimUrlTail(match[1] ?? '')
    // The lookbehind is zero-width, so the group starts at the match index.
    if (hasHost(url)) return { index: match.index, length: url.length, url }
  }
  return null
}

/**
 * The earliest autolinkable URL in `text`, in either supported form, or null.
 * The angle form wins ties because its `<` sits one character earlier.
 */
export function findAutolink(text: string): AutolinkHit | null {
  const bare = findBare(text)
  const angle = ANGLE_RE.exec(text)
  if (angle !== null && (bare === null || angle.index <= bare.index)) {
    const url = angle[1] ?? ''
    if (hasHost(url)) return { index: angle.index, length: angle[0].length, url }
  }
  return bare
}

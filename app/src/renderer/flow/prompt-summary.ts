/**
 * The one-line summary of a notification body (#1404) — pure, DOM-free.
 *
 * The inbox is the app's DURABLE record of what a blocked task asked, and it
 * stored the prompt as raw markdown source while the toast beside it rendered
 * the same string. Two consequences on the daemon's real prompt template:
 *
 *  1. Every blocked-prompt entry's line was the identical constant
 *     `# Heartbeat Prompt` — the template's first line — so a list of them
 *     said nothing about any of them.
 *  2. Expanded, the entry showed `##`, `**`, list markers and fences verbatim.
 *
 * Taking the FIRST MEANINGFUL line — skipping headings, blank lines and
 * horizontal rules, and stripping inline markup — makes each entry name its
 * own question. The prompt's actual question is what the reader is scanning
 * for; the template's title is noise repeated on every row.
 */

/** Markdown constructs that are never the substance of a prompt. */
const SKIPPABLE = /^\s*(#{1,6}\s|[-*_]{3,}\s*$|>\s*$)/
/** Leading list/quote/heading markers to strip from the chosen line. A heading
 *  only reaches `clean` as the FALLBACK (everything else was skipped), and
 *  "Heartbeat Prompt" reads better there than "# Heartbeat Prompt". */
const LEADING_MARKER = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/
/** Inline emphasis/code markers, removed for a plain-text summary. */
const INLINE_MARKUP = /(\*\*|__|[*_`~])/g

/**
 * The first line worth showing. Falls back to the first non-empty line, and
 * then to '' — a body that is nothing but headings still gets a stable
 * (if empty) summary rather than throwing.
 */
export function promptSummary(body: string): string {
  const lines = body.split('\n')
  let firstNonEmpty = ''
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    if (firstNonEmpty === '') firstNonEmpty = clean(line)
    if (SKIPPABLE.test(line)) continue
    const cleaned = clean(line)
    if (cleaned !== '') return cleaned
  }
  return firstNonEmpty
}

function clean(line: string): string {
  return line.replace(LEADING_MARKER, '').replace(INLINE_MARKUP, '').trim()
}

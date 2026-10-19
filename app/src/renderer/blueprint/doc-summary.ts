// Pure extraction of a one-glance summary from a learned module doc
// (flow/brain/modules/<slug>.md). The Understanding popover shows "Learned" + a
// doc link but no prose, so a user can't tell what a module IS without opening
// the file (#understanding-summary). When the module has no investigation-note
// summary, the board reads its doc and shows the first prose paragraph here.
//
// The doc's shape is `# <title>` / `## Overview` / a prose paragraph (see the
// learn-session writer). We skip headings, HR rules, and blanks, then take the
// first paragraph and flatten it to a single capped line.

const DEFAULT_MAX = 280

/**
 * First prose paragraph of a markdown doc, flattened to one line and capped.
 * Skips the leading `# title`, any `## heading`, `---` rules, and blank lines;
 * stops at the next blank line or heading. Inline emphasis/code markers are
 * stripped for a clean chip. Returns '' when the doc has no prose. Pure.
 */
export function extractDocSummary(markdown: string, maxLen = DEFAULT_MAX): string {
  const paragraph: string[] = []
  let started = false
  for (const rawLine of markdown.split('\n')) {
    const line = rawLine.trim()
    if (!started) {
      // Skip everything before the first prose line: headings, HR, blanks.
      if (line === '' || line.startsWith('#') || /^([-*_])\1{2,}$/.test(line)) continue
      started = true
      paragraph.push(line)
    } else {
      if (line === '' || line.startsWith('#')) break // paragraph / section ended
      paragraph.push(line)
    }
  }
  const flattened = paragraph.join(' ').replace(/\s+/g, ' ').trim()
  const clean = flattened.replace(/[*_`]/g, '') // drop simple md emphasis / code ticks
  if (clean.length <= maxLen) return clean
  return `${clean.slice(0, maxLen - 1).trimEnd()}…`
}

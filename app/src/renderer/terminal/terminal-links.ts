/**
 * Making what a command PRINTS clickable (#1190).
 *
 * The terminal was constructed with no `linkHandler` and no link provider, so:
 *   - an OSC 8 hyperlink (what `gh`, `vitest`, `ls --hyperlink`, `cargo` and
 *     modern test runners emit) rendered underlined WITH a hand cursor and did
 *     nothing on click — xterm's fallback activation goes through
 *     `window.open()`, and this window's setWindowOpenHandler denies it after
 *     handing the URL to shell.openExternal, so the link was dropped silently.
 *     An affordance that says "clickable" and isn't is worse than none;
 *   - a bare URL (`Local: http://localhost:5173/`) got no treatment at all.
 *
 * Every terminal a user comes from makes at least the dev-server URL clickable.
 * The plumbing already exists and is already proven by the chat transcript,
 * which turns the identical string into a real external anchor (#1127).
 *
 * The detector is pure and unit-tested here; terminal-panel wires it to xterm.
 */

/** Where a link sits on one rendered row (1-based columns, xterm's convention). */
export interface TerminalLinkSpan {
  url: string
  /** 1-based inclusive start column. */
  startColumn: number
  /** 1-based EXCLUSIVE end column. */
  endColumn: number
}

/**
 * http(s) only — the same restriction the chat's external anchors carry, so a
 * printed `file://` or `javascript:` can never become a clickable affordance.
 */
const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g

/** Trailing punctuation that is almost always prose, not part of the URL. */
const TRAILING_NOISE = /[.,;:!?)\]}>'"]+$/

/**
 * Find the http(s) URLs in one rendered terminal row.
 *
 * Columns are 1-based and the end is exclusive, matching xterm's link-provider
 * contract, so the caller can hand these straight back without arithmetic.
 */
export function detectTerminalLinks(line: string): TerminalLinkSpan[] {
  const spans: TerminalLinkSpan[] = []
  URL_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = URL_PATTERN.exec(line)) !== null) {
    const raw = match[0]
    // A URL at the end of a sentence shouldn't swallow the full stop, but a
    // path that legitimately ends in a bracket (…/Foo_(bar)) should keep it —
    // so only strip when the brackets don't balance.
    const trimmed = trimTrailingNoise(raw)
    if (trimmed.length === 0) continue
    spans.push({
      url: trimmed,
      startColumn: match.index + 1,
      endColumn: match.index + 1 + trimmed.length,
    })
  }
  return spans
}

function trimTrailingNoise(url: string): string {
  const stripped = url.replace(TRAILING_NOISE, '')
  // Keep a closing bracket that has a matching opener inside the URL.
  const opens = (stripped.match(/\(/g) ?? []).length
  const closes = (stripped.match(/\)/g) ?? []).length
  if (opens > closes && url.length > stripped.length && url[stripped.length] === ')') {
    return `${stripped})`
  }
  return stripped
}

/**
 * Is this URL safe to hand to the OS browser? http(s) only, mirroring the
 * chat's contract — an OSC 8 escape can name ANY scheme, and a terminal is a
 * place where untrusted output routinely lands.
 */
export function isOpenableTerminalUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

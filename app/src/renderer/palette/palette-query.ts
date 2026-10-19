// Query/mode parse for the command palette. DOM-free and pure so it's
// unit-testable under node-env jest. Plain typing searches content; a leading
// `>` (after trimming) flips to command mode. The switch is unambiguous — a
// `>` term can never name a file — so parsing is a single deterministic split.

import type { PaletteMode } from './palette-types.js'

/** Marker prefix that flips the palette into command mode. */
const COMMAND_PREFIX = '>'

export interface ParsedQuery {
  /** 'command' when the trimmed input starts with `>`, else 'content'. */
  mode: PaletteMode
  /** The search term with any mode prefix and surrounding whitespace removed. */
  term: string
  /** True when `term` is empty — drives the recents / empty-state path. */
  isEmpty: boolean
}

/**
 * Parse a raw palette input into its mode and search term.
 *
 * A leading `>` (after trim) selects command mode with the remainder trimmed as
 * the term; otherwise content mode with the trimmed input as the term. `isEmpty`
 * reflects the resulting term, so `">"` alone is empty command mode (show all
 * commands) just as `""` is empty content mode (show recents).
 */
export function parseQuery(raw: string): ParsedQuery {
  const trimmed = raw.trim()

  if (trimmed.startsWith(COMMAND_PREFIX)) {
    const term = trimmed.slice(COMMAND_PREFIX.length).trim()
    return { mode: 'command', term, isEmpty: term.length === 0 }
  }

  return { mode: 'content', term: trimmed, isEmpty: trimmed.length === 0 }
}

/**
 * What to tell the person when a debug session ends.
 *
 * DOM-FREE AND SEPARATE FROM THE CONTROL, so it can be tested at all: this
 * app's jest runs under a node environment, and a module that touches
 * `document` cannot be imported by a test. The wording is the part worth
 * pinning — the button that shows it is not.
 */

import type { DebugStopResult } from '../../shared/debug-session-ipc'

/**
 * NAMES WHAT HAPPENED TO THE RECORD, not where the file went: a path in UI text
 * is an internal detail the reader cannot act on (forbidden-pattern #12). The
 * summary itself is in the conversation, and it carries the path for the agent.
 */
export function outcomeOf(result: DebugStopResult): string {
  if (result.records === 0) {
    return 'The debug session recorded nothing — nothing happened in the browser or the terminals while it ran.'
  }
  const what = `${result.records} record${result.records === 1 ? '' : 's'}`
  if (result.timelinePath === null) {
    // The record could not be written — usually no project is open, so there is
    // nowhere in a working tree to put it.
    return `The debug session captured ${what}, but the record could not be saved.`
  }
  return `The debug session captured ${what} — it is open, and attached to your next message.`
}

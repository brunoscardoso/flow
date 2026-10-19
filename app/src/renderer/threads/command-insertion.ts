// Pure slash-command insertion for the composer (#391). DOM-free so it's
// unit-testable under the node-env jest that can't import the DOM-coupled
// composer.

export interface CommandInsertion {
  /** The full textarea value after inserting the command. */
  text: string
  /** Where the caret should sit afterwards (just past the trailing space). */
  caret: number
}

/**
 * Replace the composer's leading `/token` with `/<commandName> ` (command +
 * trailing space).
 *
 * Computes the span to replace from the CURRENT value's leading `/\S*` token
 * rather than a stored range. `#updateCommand` resolves its command list
 * asynchronously (IPC), and a cold-cache burst of keystrokes can resolve
 * out of order and leave `#commandRange.end` pointing at a stale caret — which
 * stranded the last-typed char after the inserted command (e.g. `/brainstorm r`,
 * #391). Deriving the span from the value at accept time is immune to that race,
 * since the slash command always occupies the leading token.
 */
export function computeCommandInsertion(value: string, commandName: string): CommandInsertion {
  const token = /^\/\S*/.exec(value)
  const end = token ? token[0].length : 0
  const insertion = `/${commandName} `
  return {
    text: insertion + value.slice(end),
    caret: insertion.length,
  }
}

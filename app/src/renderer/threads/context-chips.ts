/**
 * Context reference chips — pure state + serialization for the "add selection to
 * chat" bridge (#152). The user selects lines in the terminal (cmd+L) and, instead
 * of the raw text landing in the input, a compact BADGE is attached to the composer
 * showing a preview; on send the FULL selected text folds into the message content
 * (a labeled fenced block), like Cursor's context chips. Distinct from the blueprint
 * chips (composer-chips.ts): those are one-line node references, these carry verbatim
 * multi-line text. Pure (no DOM) so it's unit-testable under the node test env; the
 * Composer owns the badge rendering.
 */

export interface ContextChipRef {
  /** Stable id (source + content) so re-attaching the identical selection dedups. */
  id: string
  /**
   * Where the context came from — drives the badge label + serialized header.
   *
   * `task` IS A CARD FROM THE BOARD, added by the same event and folded into the
   * message the same way. It is not a selection somebody made with a mouse, but
   * it is the same KIND of thing: something on screen the agent should read
   * before being asked about it.
   */
  source: 'terminal' | 'file' | 'task' | 'browser'
  /** Human label for the badge/header (e.g. "Terminal" or a file path). */
  label: string
  /** The full selected text — sent verbatim on send, previewed in the badge. */
  text: string
}

/** Deterministic id from source + text, so attaching the same selection twice dedups. */
export function contextChipId(source: string, text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return `${source}:${hash}:${text.length}`
}

/** Add a chip, deduping by id (returns the ORIGINAL array when unchanged). */
export function addContextChip(
  chips: readonly ContextChipRef[],
  chip: ContextChipRef,
): readonly ContextChipRef[] {
  if (chips.some((existing) => existing.id === chip.id)) return chips
  return [...chips, chip]
}

/** Remove the chip with the given id (missing id → original array). */
export function dismissContextChip(
  chips: readonly ContextChipRef[],
  id: string,
): readonly ContextChipRef[] {
  if (!chips.some((existing) => existing.id === id)) return chips
  return chips.filter((existing) => existing.id !== id)
}

/** Short single-line preview for the badge (first line, ellipsized). */
export function contextChipPreview(chip: ContextChipRef, max = 32): string {
  const firstLine = chip.text.split('\n', 1)[0] ?? ''
  const multiline = firstLine.length < chip.text.length
  const base = firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine
  // A trailing ellipsis if there are more lines and we didn't already add one.
  return multiline && !base.endsWith('…') ? `${base}…` : base
}

/**
 * The fence for a chip's text: at least three backticks, but always MORE than the
 * longest backtick run inside the text — otherwise a ``` in the content (common in
 * markdown files / code samples / terminal output) closes the block early and the
 * rest of the selection leaks out of it, corrupting the message the agent parses
 * (CommonMark: a fence is closed only by a run of ≥ its own length).
 */
function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.matchAll(/`+/g)) longest = Math.max(longest, run[0].length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/**
 * Fold context chips into the outgoing message content: one labeled fenced block
 * per chip (insertion order), a blank line, then the user's text.
 *   - no chips → userText unchanged
 *   - empty userText → just the blocks (no dangling separator)
 */
export function serializeContextChips(
  chips: readonly ContextChipRef[],
  userText: string,
): string {
  if (chips.length === 0) return userText
  const blocks = chips
    .map((chip) => {
      const fence = fenceFor(chip.text)
      return `Context from ${chip.label}:\n${fence}\n${chip.text}\n${fence}`
    })
    .join('\n\n')
  return userText.length === 0 ? blocks : `${blocks}\n\n${userText}`
}

// AskQuestion carousel shortcuts + auto-advance (#465). Pure decisions behind two
// UX asks: clicking (or key-pressing) a single-select answer advances to the next
// question, and each option gets a 1..9 keyboard shortcut that selects it. DOM-free
// so the mapping/advance rules are unit-testable; question-card owns the wiring.

/** Options beyond the 9th have no digit shortcut (single-digit keys only). */
const MAX_SHORTCUT_OPTIONS = 9

/** The visible shortcut label for the option at `index` (0-based), or null. */
export function optionShortcutKey(index: number): string | null {
  return index >= 0 && index < MAX_SHORTCUT_OPTIONS ? String(index + 1) : null
}

/**
 * The 0-based option index a keydown selects, or null when the key isn't a digit
 * shortcut or is out of range for this question's options.
 */
export function optionIndexForKey(key: string, optionCount: number): number | null {
  if (!/^[1-9]$/.test(key)) return null
  const index = Number(key) - 1
  return index < optionCount ? index : null
}

/**
 * Whether picking an answer should auto-advance to the next question. Single-select
 * advances (the pick is the whole answer); multi-select does not (the user may add
 * more), and the last question never advances (Submit is next).
 */
export function shouldAdvanceAfterPick(multiSelect: boolean, atEnd: boolean): boolean {
  return !multiSelect && !atEnd
}

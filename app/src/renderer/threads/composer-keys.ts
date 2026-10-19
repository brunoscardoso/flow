// Composer Enter-key intent (#139): Enter sends, Shift/Alt+Enter inserts a
// newline. Pure so the inversion is unit-testable without a DOM.

export type EnterIntent = 'send' | 'newline' | 'none'

/**
 * What a bare Enter keypress should do given its modifiers:
 * - IME composing (`isComposing`) → 'none' (Enter is confirming a character).
 * - Shift or Alt held → 'newline'.
 * - otherwise → 'send'.
 * (⌘/Ctrl+Enter also sends — neither Shift nor Alt — for muscle-memory.)
 */
export function enterKeyIntent(mods: {
  shiftKey: boolean
  altKey: boolean
  isComposing: boolean
}): EnterIntent {
  if (mods.isComposing) return 'none'
  if (mods.shiftKey || mods.altKey) return 'newline'
  return 'send'
}

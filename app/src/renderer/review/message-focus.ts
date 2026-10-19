// Preserve commit-message input focus across a Review-panel rebuild (#282). The
// panel rebuilds its whole DOM on every setGroups(), and the #182 refresh gate
// only defers rebuilds for reject/discard prompts — not the plain commit-message
// inputs. So a background file change (git:changed / project:fileChanged, or a
// heartbeat/brain write) while the user is typing a message recreates the input
// and drops focus + caret. Gating the inputs is unsafe (blurring to click Commit
// would race a flush-rebuild and eat the click), so instead we capture which
// message input is focused + its selection before the rebuild and restore it
// after. This pure helper is the capture decision; the panel reads/writes DOM.

export interface MessageFocus {
  /** data-msg-key of the focused input (a phase group's label). */
  key: string
  start: number
  end: number
}

/**
 * A focus snapshot to restore after the rebuild, or null when no message input
 * is focused. `key` is the focused input's data-msg-key (undefined when the
 * active element isn't a tagged message input or is outside the panel); `start`
 * / `end` are its selection (nullish → 0).
 */
export function captureMessageFocus(
  key: string | undefined,
  inside: boolean,
  start: number | null | undefined,
  end: number | null | undefined,
): MessageFocus | null {
  if (!inside || key === undefined) return null
  return { key, start: start ?? 0, end: end ?? 0 }
}

// Pure "is there anything to send?" check for the composer (#430). The Send
// button must disable (and #send() must no-op) when the composer holds no
// sendable content — empty/whitespace text AND no chips — so Send isn't a dead
// click. DOM-free → unit-testable; the composer is DOM-coupled.

/**
 * Whether the composer has something to send: non-whitespace text, at least one
 * blueprint/context chip, OR at least one image attachment (an image-only message
 * is valid, #456). Counting attachments here keeps the Send button's enabled state
 * (#syncEnabled) in lockstep with what #send() actually accepts (#541).
 */
export function hasSendableContent(
  text: string,
  chipCount: number,
  contextChipCount: number,
  attachmentCount = 0,
): boolean {
  return (
    text.trim().length > 0 || chipCount > 0 || contextChipCount > 0 || attachmentCount > 0
  )
}

/**
 * A message a SURFACE composed for a thread — a card's button, such as a
 * discovery card's "Generate artifact" — rides `flow:send-prompt` with
 * `{ threadId, text }`. The text it carries, or null when the event is not for
 * the thread this composer shows (or carries nothing to send): a press from a
 * card of another thread never lands in this one.
 */
export function composedPromptFor(detail: unknown, threadId: string | null): string | null {
  if (threadId === null || typeof detail !== 'object' || detail === null) return null
  const { threadId: target, text } = detail as { threadId?: unknown; text?: unknown }
  if (typeof target !== 'string' || target !== threadId) return null
  if (typeof text !== 'string' || text.trim().length === 0) return null
  return text
}

/**
 * Whether a composed message goes now or waits in the prompt queue — the rule
 * a typed message follows (#472, #1470): a turn that is running, or parked on
 * a decision, or a send still in flight means the queue.
 */
export function composedSendRoute(free: boolean, sending: boolean): 'send' | 'queue' {
  return free && !sending ? 'send' : 'queue'
}

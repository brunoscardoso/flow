// Pure "is there anything to send?" check for the composer (#430). The Send
// button must disable (and #send() must no-op) when the composer holds no
// sendable content — empty/whitespace text AND no chips — so Send isn't a dead
// click. DOM-free → unit-testable; the composer is DOM-coupled.
import type { ThreadStatus } from '../../shared/ipc-contract'
import { isComposerFreeStatus } from './prompt-queue'

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
 * Where a message goes when the person sends it — the ONE rule both the typed
 * send and a surface-composed send follow (#472, #1470, plan mid-run-subtasks
 * note 1):
 *
 * - `'send'` — the composer is free (idle / done / failed) and no send is in
 *   flight: a new turn starts.
 * - `'inject'` — a Claude thread whose turn is `working`: the message goes into
 *   the LIVE turn at once. The Claude session reads its input as a stream, so
 *   main pushes it at the next tool boundary of the same turn (SDK priority
 *   `'next'` — `'now'` was probed and ends the turn instead, see
 *   flow/resources/sdk-mid-turn-probe.md). Nothing about it is a new turn.
 * - `'queue'` — everything else waits in the prompt queue: a turn parked on a
 *   decision (`needs-decision`, `blocked` — #1470: a live send there un-parks
 *   the ask and delivers a STOP as a follow-up), a send still in flight, and a
 *   working Copilot or Codex thread (one-shot-per-turn runtimes; their queue
 *   row and Send now are unchanged).
 *
 * `provider` is the runtime the thread's project resolves to, or null while it
 * is not known yet — an unknown runtime never injects (fail closed to the
 * queue, which is exactly what every thread did before this existed).
 */
export function composedSendRoute(input: {
  status: ThreadStatus
  sending: boolean
  provider: string | null
}): 'send' | 'inject' | 'queue' {
  if (input.sending) return 'queue'
  if (isComposerFreeStatus(input.status)) return 'send'
  if (input.status === 'working' && input.provider === 'claude') return 'inject'
  return 'queue'
}

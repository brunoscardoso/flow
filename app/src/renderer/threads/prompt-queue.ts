// Prompt queue (#472). While the agent is working a new turn can't be sent (one
// turn at a time), so instead of refusing, the composer QUEUES the message and
// auto-sends the next one when the turn finishes. The user can remove a queued
// prompt or "send now" (jump it to the front). Content is already serialized (chips
// folded in) at queue time, so a queued item is just its content string + a preview.
// Pure/DOM-free → unit-testable; the composer owns the input, dispatch, and pills.
import type { MessageAttachmentInput, ThreadStatus } from '../../shared/ipc-contract'

export interface QueuedPrompt {
  id: string
  /** Fully-serialized message content (chips already folded in). */
  content: string
  /** Image attachments queued with the prompt — sent as vision blocks on drain (#456). */
  attachments: readonly MessageAttachmentInput[]
  /** Short single-line preview for the pill. */
  preview: string
}

/**
 * Whether a status transition should auto-send the next queued prompt (#472).
 *
 * A queued prompt drains ONLY when the turn completed *naturally* — the backend
 * emits `done` on success. Every other exit from `working` must NOT drain (#490):
 *   - `idle`   → the user clicked Interrupt (agent-manager emits `working → idle`);
 *               Interrupt is the stop button, so launching a queued turn against it
 *               violates least-surprise and spends a turn the user was preventing.
 *   - `failed` → the turn errored; silently firing the next prompt hides the failure.
 *   - `needs-decision` / `blocked` → the turn is paused awaiting input, not finished.
 *
 * Draining also requires the previous status to have been `working`, so a later
 * `done → idle` reset never double-drains.
 */
export function shouldAutoDrainOnStatus(
  prevStatus: ThreadStatus,
  nextStatus: ThreadStatus,
): boolean {
  return prevStatus === 'working' && nextStatus === 'done'
}

/**
 * Whether a status is a "free" state where the composer can launch a new turn —
 * no turn is running and none is paused awaiting input. `needs-decision`/`blocked`
 * are NOT free (a turn is parked mid-flight); `working` obviously isn't.
 */
export function isComposerFreeStatus(status: ThreadStatus): boolean {
  return status === 'idle' || status === 'done' || status === 'failed'
}

/**
 * Whether a status transition should drain the queue after a "Send now" interrupt
 * (#524). "Send now" while the agent is working can't literally send — a turn can't
 * be interrupted to start another — so it INTERRUPTS the running turn and lets the
 * jumped-to-front prompt fire on the resulting exit from `working` (normally → idle).
 *
 * Unlike the natural-completion drain (`shouldAutoDrainOnStatus`, `done`-only, which
 * must never fire against the user's stop button), this drains on ANY exit from
 * `working` into a free state: the interrupt here was the user's explicit request to
 * send now, not a stop. Guarded by the composer's `#pendingSendNow` flag so an
 * ordinary interrupt (the stop button) still never drains.
 */
export function shouldDrainAfterSendNow(
  prevStatus: ThreadStatus,
  nextStatus: ThreadStatus,
): boolean {
  return prevStatus === 'working' && isComposerFreeStatus(nextStatus)
}

/**
 * The `#pendingSendNow` flag's lifecycle for a single status transition (#594).
 *
 * A Send-now interrupt is armed for EXACTLY ONE exit from `working`. The flag must
 * be CLEARED on ANY `working → non-working` transition — otherwise a natural `done`
 * (or a `needs-decision`/`blocked` pause) that pre-empts the interrupt leaves it
 * latched, and a LATER genuine Stop (`working → idle`) would drain the queue against
 * the user's stop button (the #490 surprise). `drainViaSendNow` is only true when the
 * flag was set AND this transition is a Send-now free-exit (and the natural-completion
 * drain didn't already handle it — the caller checks `shouldAutoDrainOnStatus` first).
 */
export function sendNowFlagTransition(
  prevStatus: ThreadStatus,
  nextStatus: ThreadStatus,
  pending: boolean,
): { clear: boolean; drainViaSendNow: boolean } {
  return {
    clear: prevStatus === 'working' && nextStatus !== 'working',
    drainViaSendNow: pending && shouldDrainAfterSendNow(prevStatus, nextStatus),
  }
}

/**
 * A short one-line preview of queued content (first line, ellipsized), naming any
 * attachments riding along (#1046). Deriving the preview from the text alone left
 * an attachment-only prompt rendering as "(empty)" — the queued screenshot was
 * invisible, and two queued screenshots were pixel-identical pills, so Remove /
 * "Send now" became a coin flip. A single attachment is named by its fileName
 * (the one thing that tells two queued screenshots apart — pastes/captures get a
 * synthesized name upstream); several collapse to a count.
 */
export function queuePreview(
  content: string,
  attachments: readonly Pick<MessageAttachmentInput, 'fileName'>[] = [],
  max = 48,
): string {
  const firstLine = (content.split('\n', 1)[0] ?? '').trim()
  const text = firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine
  let tag = ''
  if (attachments.length === 1) {
    tag = `📎 ${attachments[0]?.fileName ?? '1 image'}`
  } else if (attachments.length > 1) {
    tag = `📎 ${attachments.length} images`
  }
  return [text, tag].filter(Boolean).join(' · ')
}

/** Append a prompt to the back of the queue. */
export function enqueuePrompt(
  queue: readonly QueuedPrompt[],
  item: QueuedPrompt,
): readonly QueuedPrompt[] {
  return [...queue, item]
}

/** Remove the prompt with the given id (missing id → original array). */
export function removeQueued(
  queue: readonly QueuedPrompt[],
  id: string,
): readonly QueuedPrompt[] {
  if (!queue.some((item) => item.id === id)) return queue
  return queue.filter((item) => item.id !== id)
}

/** Move a prompt to the FRONT so it sends next ("send now"). No-op for a missing id. */
export function moveToFront(
  queue: readonly QueuedPrompt[],
  id: string,
): readonly QueuedPrompt[] {
  const target = queue.find((item) => item.id === id)
  if (!target) return queue
  return [target, ...queue.filter((item) => item.id !== id)]
}

/**
 * What a FAILED queued send should restore into the composer (#491).
 *
 * The live `#send` failure path restores both text AND attachments; the queue-drain
 * path historically restored only the text, silently dropping a queued image (#456)
 * on a transient failure. This mirrors the live path so a queued prompt-with-image is
 * recoverable — but only into an EMPTY composer, so a fresh draft the user typed while
 * the previous turn ran isn't clobbered:
 *   - text: restored unless the user has already typed something
 *   - attachments: restored unless the user has already typed OR picked attachments
 *
 * A `null` field means "leave the composer as-is" (don't restore that part).
 */
export function queuedRestore(
  item: Pick<QueuedPrompt, 'content' | 'attachments'>,
  composer: { hasText: boolean; hasAttachments: boolean },
): { text: string | null; attachments: readonly MessageAttachmentInput[] | null } {
  const restoreText = !composer.hasText
  const restoreAttachments = !composer.hasText && !composer.hasAttachments
  return {
    text: restoreText ? item.content : null,
    attachments: restoreAttachments ? item.attachments : null,
  }
}

/** Pop the front prompt: the next to send + the remaining queue. */
export function dequeue(
  queue: readonly QueuedPrompt[],
): { next: QueuedPrompt | null; rest: readonly QueuedPrompt[] } {
  if (queue.length === 0) return { next: null, rest: queue }
  const [next, ...rest] = queue
  return { next: next ?? null, rest }
}

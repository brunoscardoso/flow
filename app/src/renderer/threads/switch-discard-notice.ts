/**
 * What a thread switch DROPPED, said out loud (#1327, #1328).
 *
 * Two things the composer discards on a switch, both deliberately and both
 * correctly: attachments composed for the thread you are leaving (#688 — one
 * Enter from misrouting into another thread), and a queued prompt (#472 —
 * same reason). Neither said anything.
 *
 * The silence is what makes them bugs:
 *
 *  - The attachment drop restores the TEXT that described the attachment
 *    (#1067's per-thread drafts) while the attachment itself is gone. The
 *    composer comes back looking intact, and the next ⏎ sends "compare the
 *    attached screenshot" with nothing attached.
 *  - The queue drop cancels a message the user already committed — the input
 *    cleared, the draft zeroed, a pill promising auto-send — and leaves them
 *    waiting for something that will never fire.
 *
 * Every sibling drop in this composer is announced (the 8-image cap #649, an
 * unsupported paste #1085, an empty text file #1086). These two now are too.
 *
 * Pure and DOM-free: the composer dispatches whatever this returns.
 */

export interface SwitchDiscardNotice {
  title: string
  body: string
  level: 'info'
}

export interface SwitchDiscardCounts {
  /** Attachments that were staged on the thread being left. */
  attachments: number
  /** Prompts queued for the thread being left. */
  queued: number
}

const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`

/**
 * The notice for what a switch away from `threadTitle` discarded, or null when
 * it discarded nothing — a switch that costs the user nothing must stay
 * silent, or the notice becomes noise and stops being read.
 */
export function switchDiscardNotice(
  counts: SwitchDiscardCounts,
  threadTitle: string,
): SwitchDiscardNotice | null {
  const attachments = Math.max(0, Math.trunc(counts.attachments))
  const queued = Math.max(0, Math.trunc(counts.queued))
  if (attachments === 0 && queued === 0) return null

  const where = threadTitle.trim() === '' ? 'the previous thread' : `“${threadTitle.trim()}”`
  const parts: string[] = []
  if (queued > 0) parts.push(`${plural(queued, 'queued prompt', 'queued prompts')} cancelled`)
  if (attachments > 0) {
    parts.push(`${plural(attachments, 'attachment', 'attachments')} removed`)
  }

  // Say WHY, because the behaviour is deliberate: they belong to the thread
  // they were composed for, and following the user would risk misrouting them.
  return {
    title: queued > 0 ? 'Queued prompt cancelled' : 'Attachment removed',
    body: `${parts.join(' · ')} — they belonged to ${where} and don’t follow you between threads.`,
    level: 'info',
  }
}

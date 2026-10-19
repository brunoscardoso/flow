// What a ticket's picture strip SAYS — the DOM-free half.
//
// The gallery has four states per tile and one heading, and every one of them
// is a sentence somebody reads when a screenshot does not appear. Keeping them
// here means they can be tested without a window, and means the DOM layer has
// no opinions of its own about wording.

/** Where one picture has got to. */
export type TicketImageState =
  | { kind: 'loading' }
  | { kind: 'ready'; dataUri: string; bytes: number }
  | { kind: 'failed'; reason: string }

/** The section heading — "Images", with the count when there is more than one. */
export function imagesSectionLabel(count: number): string {
  return count === 1 ? 'Image' : `Images (${String(count)})`
}

/**
 * The tile's caption while it is working, or the reason it stopped.
 *
 * A FAILED TILE KEEPS ITS NAME. "crash.png — the attachment is gone" says which
 * screenshot is missing; a bare error sentence says only that something is,
 * which on a ticket with six pictures is not an answer.
 */
export function imageTileCaption(name: string, state: TicketImageState): string {
  if (state.kind === 'loading') return `Loading ${name}…`
  if (state.kind === 'ready') return name
  return `${name} — ${state.reason}`
}

/**
 * The accessible name of the tile's control.
 *
 * A READY TILE OPENS; the other two do nothing, and say so rather than offering
 * a press that cannot act (forbidden-pattern #12).
 */
export function imageTileAction(name: string, state: TicketImageState): string {
  if (state.kind === 'ready') return `Open ${name} full size`
  if (state.kind === 'loading') return `${name} is still loading`
  return `${name} could not be loaded`
}

/**
 * How many pictures are fetched at once.
 *
 * THREE, not one and not all of them. One at a time makes a six-screenshot
 * ticket wait six round trips before the last tile appears; all at once puts
 * twelve authenticated requests on the tracker the moment a card opens, which
 * is the kind of thing rate limits are for.
 */
export const IMAGE_FETCH_CONCURRENCY = 3

/**
 * Run `work` over `items`, at most `limit` at a time, in order of completion.
 *
 * Exported and pure so the pacing above is a tested fact rather than a comment:
 * the failure it guards against — a burst of twelve — is invisible in a UI that
 * looks fine either way.
 */
export async function inBatches<T>(
  items: readonly T[],
  limit: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next
      next += 1
      const item = items[index]
      if (item === undefined) return
      await work(item, index)
    }
  })
  await Promise.all(runners)
}

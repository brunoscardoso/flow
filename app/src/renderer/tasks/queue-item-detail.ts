// What a card on the shared list opens into.
//
// UNTIL NOW: NOTHING. A queue item's card carried a title, a chip and a drag
// handle. It could not be opened, so the finding a loop had just written — the
// body, the file it names, the reproduction — was in the app and unreadable
// from it; and it could not be thrown away, so a person who disagreed with a
// finding had no answer but a terminal. "Todo is a window" was taken to mean the
// window is also sealed.
//
// It is a window with a handle now. Two acts, and they are the queue's own:
//
//   * CLAIM — already the drag, given a button so it is reachable from the
//     thing you opened to decide with.
//   * DISMISS — `loop close --reason wontfix`, which is not a delete. Nothing is
//     erased: the item is settled with a written reason, and that reason is
//     PERMANENT MEMORY the producers read, so a hunt that files the same idea
//     tomorrow finds the refusal and does not file it again. Which is why the
//     reason is required rather than optional, and why the button does not say
//     "Delete".
//
// This module decides all of it, DOM-free. If an `if` about an item's state
// appears in the render layer, it belongs here.

import type { LoopQueueItem } from '../../shared/ipc-contract'
import type { BoardCard, BoardQueueGroup } from './board-model'

/** One thing the modal offers, in the shape the render layer appends. */
export interface QueueItemAction {
  label: string
  actionable: boolean
  /** What pressing it does, in full — never a command or a path. */
  title: string
  /** Why it cannot be pressed, or null. */
  blockedReason: string | null
}

/** The whole ticket view of one item on a shared list. */
export interface QueueItemDetail {
  title: string
  /** Which list it is on and what it is called there — `This project · #3`. */
  subtitle: string
  /** The item's own text, markers stripped, or null when it has none. */
  body: string | null
  /** The line under the body when the item carries no text at all. */
  emptyBody: string
  labels: string[]
  /** The item in its own tracker, when the list gave a link. */
  url: string | null
  claim: QueueItemAction
  dismiss: QueueItemAction
  /** The label over the box a dismissal's reason is typed into. */
  dismissReasonLabel: string
  dismissReasonPlaceholder: string
  /** Said beside that box — what a dismissal actually costs. */
  dismissHint: string
}

/**
 * The machine's own writing, removed for a reader.
 *
 * A filed item's body carries HTML comments the loops write and read —
 * `<!-- loop: fix -->`, the dedup fingerprint, the plan marker. They are load
 * bearing in the store and noise on screen; a reader opening a finding wants the
 * finding. Stripped for DISPLAY only: nothing here writes the body back.
 */
export function readableBody(body: string | undefined | null): string | null {
  if (body === undefined || body === null) return null
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return stripped.length === 0 ? null : stripped
}

/** The labels worth showing: the loop's own bookkeeping is not one of them. */
export function readableLabels(labels: readonly string[] | undefined): string[] {
  if (labels === undefined) return []
  return labels.filter((label) => {
    const trimmed = label.trim()
    if (trimmed.length === 0) return false
    // `loop-fix` / `loop-find` say which loop filed it, which the card's own
    // chip already says, and `claimed` is a state the modal states in words.
    return !/^(loop-[\w-]+|claimed|approved)$/i.test(trimmed)
  })
}

const NO_LOOP_REASON =
  "Flow can't tell which list this item belongs to, so it can't act on it from here."

/** Somebody else's run is holding it — neither act is ours to perform. */
function heldReason(heldBy: string): string {
  return `Another run (${heldBy}) is working on this. It has to let go before anyone else can take it.`
}

/**
 * The ticket view, from a card and the item behind it.
 *
 * THE CARD IS NOT ENOUGH ON ITS OWN and deliberately so: `BoardCard` carries
 * what a CARD draws, and a body, its labels and its state are what a TICKET
 * draws. Both come from the same read — the item is the row the card was built
 * from — so nothing here can disagree with the board it was opened from.
 */
export function buildQueueItemDetail(
  card: BoardCard,
  item: LoopQueueItem | null,
  group: BoardQueueGroup | null,
): QueueItemDetail {
  const loop = (card.loop ?? '').trim()
  const held = card.heldBy
  const claimable = card.lane === 'todo' && held === null && loop.length > 0
  const dismissable = held === null && loop.length > 0 && card.itemId !== null

  /** The first true reason, in the order a reader would ask them. */
  const blocked = (): string | null => {
    if (held !== null) return heldReason(held)
    if (loop.length === 0) return NO_LOOP_REASON
    return null
  }

  return {
    title: card.title.length > 0 ? card.title : 'Untitled item',
    subtitle: subtitleFor(card, group),
    body: readableBody(item?.body),
    emptyBody: 'Whoever filed this left no description.',
    labels: readableLabels(item?.labels),
    url: card.url,
    claim: {
      label: 'Start work',
      actionable: claimable,
      title: 'Take this item, so nothing else picks it up while you work on it',
      blockedReason: claimable
        ? null
        : (blocked() ?? 'This is already started — it is not waiting to be picked up.'),
    },
    dismiss: {
      label: 'Dismiss',
      actionable: dismissable,
      title: 'Settle this item with a reason, so the loops stop offering it',
      blockedReason: dismissable ? null : blocked(),
    },
    dismissReasonLabel: 'Why?',
    dismissReasonPlaceholder: 'not worth doing — say why in a sentence',
    // THE COST, SAID OUT LOUD. A dismissal is remembered on purpose, and a
    // person who thought they were tidying their board should know that the
    // producers will read it back.
    dismissHint: 'The loops remember this and stop filing it. Everyone on the list sees it.',
  }
}

// ── The same acts, on the gesture people actually tried ──────────────────
//
// A card Flow owns answers a right-click with a menu; an item from the shared
// list answered with nothing at all. That is exactly the drift #1153 was written
// against, wearing a new costume: the reader learns a gesture on one card and it
// silently does nothing on the card beside it. The menu offers the ticket's own
// acts — no new verbs, no second way to perform them.

/** One entry in a list item's right-click menu. */
export interface QueueItemMenuEntry {
  id: 'open' | 'chat' | 'claim' | 'dismiss'
  label: string
  enabled: boolean
  /** Why it cannot be pressed, or null — shown on the item, never swallowed. */
  blockedReason: string | null
  /** Rendered as the destructive item. */
  danger: boolean
}

/**
 * The menu, from the ticket the card would open.
 *
 * DISMISS KEEPS ITS ELLIPSIS because it still goes through the reason box: the
 * store keeps that sentence forever and a menu cannot take one. Pressing it
 * opens the ticket on its dismissal form rather than settling anything, which is
 * the honest reading of a label ending in "…".
 */
export function queueItemMenuEntries(detail: QueueItemDetail): QueueItemMenuEntry[] {
  return [
    { id: 'open', label: 'Open', enabled: true, blockedReason: null, danger: false },
    { id: 'chat', label: 'Add to chat', enabled: true, blockedReason: null, danger: false },
    {
      id: 'claim',
      label: detail.claim.label,
      enabled: detail.claim.actionable,
      blockedReason: detail.claim.blockedReason,
      danger: false,
    },
    {
      id: 'dismiss',
      label: `${detail.dismiss.label}…`,
      enabled: detail.dismiss.actionable,
      blockedReason: detail.dismiss.blockedReason,
      danger: true,
    },
  ]
}

/** `This project · #3` — the list it is on, and what it is called there. */
function subtitleFor(card: BoardCard, group: BoardQueueGroup | null): string {
  const id = card.itemId === null ? null : `#${card.itemId}`
  const list = group?.label ?? null
  if (list === null) return id ?? ''
  return id === null ? list : `${list} · ${id}`
}

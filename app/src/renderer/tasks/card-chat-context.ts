// A card, as context for the conversation.
//
// THE MECHANISM ALREADY EXISTED AND THE BOARD WAS NOT ON IT. Selecting terminal
// output (⌘L) or a block of a file attaches a BADGE to the composer and folds the
// full text into the message on send — `flow:add-to-chat`, one event, one shape.
// A ticket is the same kind of thing: something on screen you want the agent to
// read before you ask about it. So a card dispatches the same event with the same
// shape, attaches beside a terminal selection, and accumulates — three cards is
// three badges and one message.
//
// WHAT GOES IN IS WHAT SOMEBODY WOULD PASTE: the name, which list it is on, its
// state, the link if it has one, and the body verbatim. Not our rendering of it,
// and not a summary — an agent asked to act on a finding needs the finding.

import type { LoopQueueItem, TaskSummary } from '../../shared/ipc-contract'
import type { BoardCard, BoardQueueGroup } from './board-model'
import { readableBody } from './queue-item-detail'

/** The `flow:add-to-chat` payload — the terminal's own shape, verbatim. */
export interface CardChatContext {
  source: 'task'
  /** What the badge says, and the header the message content carries. */
  label: string
  /** The full text folded into the message on send. */
  text: string
}

/** `#3`, `PRJ-14`, or nothing — whatever this card is actually called. */
function nameOf(card: BoardCard, task: TaskSummary | null): string | null {
  const external = task?.externalKey?.trim()
  if (external !== undefined && external.length > 0) return external
  if (card.itemId !== null) return `#${card.itemId}`
  return null
}

/**
 * The badge's words.
 *
 * SHORT ENOUGH TO SIT IN A ROW OF THEM, and specific enough to tell two apart:
 * a person attaching three tickets needs to know which three. The list's name
 * plus the item's own — `This project · #3` — is what the ticket view above it
 * already calls this card, so the two never disagree.
 */
export function chatContextLabel(
  card: BoardCard,
  task: TaskSummary | null,
  group: BoardQueueGroup | null,
): string {
  const name = nameOf(card, task)
  const list = group?.label ?? null
  if (name === null) return list ?? 'Task'
  return list === null ? name : `${list} · ${name}`
}

/**
 * The text an agent receives.
 *
 * A HEADING, THE FACTS, THEN THE BODY. The heading is the title because that is
 * what a person would have pasted; the facts are the ones that change what the
 * agent should do (which list, what state, where to look); the body is verbatim
 * with the loops' own markers stripped, exactly as the ticket view shows it.
 * Nothing is invented for a field the read did not carry.
 */
export function chatContextText(
  card: BoardCard,
  item: LoopQueueItem | null,
  task: TaskSummary | null,
  group: BoardQueueGroup | null,
): string {
  const lines: string[] = []
  lines.push(`# ${card.title.length > 0 ? card.title : 'Untitled item'}`)

  const facts: string[] = []
  const name = nameOf(card, task)
  if (name !== null) facts.push(`id: ${name}`)
  if (group?.label !== undefined && group.label !== null) facts.push(`list: ${group.label}`)
  if (card.loop !== null && card.loop.trim().length > 0) facts.push(`loop: ${card.loop.trim()}`)
  facts.push(`state: ${card.lane}`)
  if (card.blockedReason !== null) facts.push(`blocked: ${card.blockedReason}`)
  if (card.heldBy !== null) facts.push(`held by: ${card.heldBy}`)
  if (card.url !== null) facts.push(`link: ${card.url}`)
  if (facts.length > 0) lines.push(facts.join('\n'))

  // The queue item's body, else the local record's description — one of the two
  // exists for almost every card, and neither is summarized.
  const body = readableBody(item?.body) ?? readableBody(task?.description)
  if (body !== null) lines.push(body)
  return lines.join('\n\n')
}

/** The whole payload, or null when there is nothing worth attaching. */
export function cardChatContext(
  card: BoardCard,
  item: LoopQueueItem | null,
  task: TaskSummary | null,
  group: BoardQueueGroup | null,
): CardChatContext | null {
  const text = chatContextText(card, item, task, group)
  if (text.trim().length === 0) return null
  return { source: 'task', label: chatContextLabel(card, task, group), text }
}

/** The control's words. Says what pressing it does — not where the text goes. */
export const ADD_TO_CHAT_LABEL = 'Add to chat'
export const ADD_TO_CHAT_TITLE =
  'Attach this ticket to the conversation, so you can ask about it'

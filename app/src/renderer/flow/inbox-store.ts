/**
 * Persistence for the notification inbox (#1459).
 *
 * The inbox is the app's DURABLE record — that is its stated job: the toast
 * holding a full failure reason auto-dismisses in 6s, so the whole body is
 * retained here (#1075), and renderer-raised notifications (a failed save
 * #195, a failed git diff #192, a failed terminal spawn #209, a review commit
 * outcome #73) exist nowhere else at all. It was nevertheless plain DOM built
 * at `initFlowUi` time, so View ▸ Reload (⌘R) emptied it and reset the unread
 * badge with no marker and no way back.
 *
 * This module is the storage half, kept free of the DOM so it can be tested
 * directly: read a bounded, validated log back, and write it. Every entry that
 * reaches the inbox goes through here, so the reload replays exactly what the
 * session raised — heartbeat and renderer notifications alike. Seeding from
 * `flow/.heartbeat-events.jsonl` instead would lose all of the latter, and
 * #376 deliberately keeps that backlog out of the inbox.
 */
import type { FlowNotification, FlowNotificationLevel } from '../../shared/ipc-contract'

/** Versioned so a shape change retires the old log instead of misreading it. */
export const INBOX_STORAGE_KEY = 'flow.notification-inbox.v1'

/** The persisted log: entries OLDEST-first, plus the unread counter. */
export interface PersistedInbox {
  entries: FlowNotification[]
  unread: number
}

/** The slice of `Storage` this needs — injectable, so tests need no DOM. */
export interface InboxStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const LEVELS: readonly FlowNotificationLevel[] = ['info', 'warn', 'error']

const EMPTY: PersistedInbox = { entries: [], unread: 0 }

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/**
 * A stored record is only replayed when it still matches the contract — a
 * half-written or hand-edited entry must not take the whole inbox (or the boot
 * that rehydrates it) down with it. Unknown extra fields are dropped rather
 * than carried, so a record written by a newer build stays renderable here.
 */
function parseEntry(value: unknown): FlowNotification | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  if (!isString(raw.kind) || !isString(raw.title) || !isString(raw.timestamp)) return null
  if (!isString(raw.rootId) || !isString(raw.body)) return null
  if (!isString(raw.level) || !LEVELS.includes(raw.level as FlowNotificationLevel)) return null
  const entry: FlowNotification = {
    kind: raw.kind as FlowNotification['kind'],
    rootId: raw.rootId,
    title: raw.title,
    body: raw.body,
    timestamp: raw.timestamp,
    level: raw.level as FlowNotificationLevel,
  }
  if (isString(raw.promptId)) entry.promptId = raw.promptId
  return entry
}

/**
 * Read the persisted log, bounded to `max` newest entries.
 *
 * Never throws: unreadable storage (quota-disabled, private mode), malformed
 * JSON and bad records all degrade to an empty inbox, because a lost log must
 * not cost the user a working notification surface on top of it.
 */
export function readInbox(storage: InboxStorage, max: number): PersistedInbox {
  let raw: string | null
  try {
    raw = storage.getItem(INBOX_STORAGE_KEY)
  } catch {
    return EMPTY
  }
  if (!raw) return EMPTY
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return EMPTY
  }
  if (typeof parsed !== 'object' || parsed === null) return EMPTY
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.entries)) return EMPTY
  const entries: FlowNotification[] = []
  for (const candidate of record.entries) {
    const entry = parseEntry(candidate)
    if (entry) entries.push(entry)
  }
  // Oldest-first eviction, matching the live list's own cap.
  const bounded = entries.slice(Math.max(0, entries.length - max))
  const unread =
    typeof record.unread === 'number' && Number.isFinite(record.unread) && record.unread >= 0
      ? Math.min(Math.floor(record.unread), bounded.length)
      : 0
  return { entries: bounded, unread }
}

/**
 * Write the log back, bounded the same way.
 *
 * Also never throws. A quota failure means this notification is not in the
 * durable record — bad, but not a reason to break the notification the user is
 * being shown right now, so it is reported and swallowed.
 */
export function writeInbox(storage: InboxStorage, inbox: PersistedInbox, max: number): void {
  const bounded: PersistedInbox = {
    entries: inbox.entries.slice(Math.max(0, inbox.entries.length - max)),
    unread: Math.max(0, Math.floor(inbox.unread)),
  }
  try {
    storage.setItem(INBOX_STORAGE_KEY, JSON.stringify(bounded))
  } catch (error) {
    console.warn('flow: could not persist the notification inbox', error)
  }
}

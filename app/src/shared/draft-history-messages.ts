/**
 * UNDO AND VERSIONS IN THE CANVAS PAGE — the messages between the page and the
 * host, and the one pure helper the page inlines. DOM-free, so main, the
 * renderer, the guest preload and the page compile it unchanged.
 *
 * The canvas page has no IPC and no storage. It asks the host to act by
 * posting to ITSELF (the guest preload relays the message with `sendToHost`,
 * as for a pick), and the host answers by calling `window.flowCanvas.history`.
 * Every hop re-validates: `parseDraftHistoryRequest` runs in the guest preload
 * and again in the host, and the host never trusts a page for the project or
 * the canvas — the page address decides those.
 */
import { isDraftSlug, type DraftVersionInfo } from './ui-drafts'

/** canvas → itself (relayed to the host): one history request. */
export const DRAFT_CANVAS_HISTORY = 'flow-draft-history'

/** The longest version name a person may type. */
export const DRAFT_VERSION_NAME_MAX = 200

/** What the page can ask for. */
export type DraftHistoryRequest =
  | { op: 'undo' }
  | { op: 'list' }
  | { op: 'save'; name: string }
  | { op: 'restore'; version: string }

/** A relayed history request, or null when it is not one. */
export function parseDraftHistoryRequest(raw: unknown): DraftHistoryRequest | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const message = raw as Record<string, unknown>
  if (message.type !== DRAFT_CANVAS_HISTORY) return null
  if (message.op === 'undo') return { op: 'undo' }
  if (message.op === 'list') return { op: 'list' }
  if (message.op === 'save') {
    if (typeof message.name !== 'string') return null
    const name = message.name.trim()
    return name.length > 0 && name.length <= DRAFT_VERSION_NAME_MAX ? { op: 'save', name } : null
  }
  if (message.op === 'restore') return isDraftSlug(message.version) ? { op: 'restore', version: message.version } : null
  return null
}

/** What the host tells the page, through `window.flowCanvas.history(state)`. */
export interface DraftHistoryState {
  /** How many times Undo can step back; the button is disabled at 0. */
  undoCount?: number
  /** The saved versions, newest first. */
  versions?: DraftVersionInfo[]
  /** A short sentence for a person; never a path or a command. */
  error?: string
  /** The request that just finished. */
  done?: 'undo' | 'save' | 'restore'
  /** The side panel is open on an element: ask the picked frame for its facts again. */
  refresh?: boolean
}

/**
 * The time a version shows beside its name: HH:MM when it was saved today,
 * else a short date ("Nov 3"). Pure and self-contained — the page inlines it
 * from its own source (`toString()`), so it names nothing outside itself.
 */
export function draftVersionTimeText(savedAt: string, now: number): string {
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const at = new Date(savedAt)
  if (savedAt === '' || Number.isNaN(at.getTime())) return ''
  const today = new Date(now)
  if (
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()
  ) {
    const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
    return `${pad(at.getHours())}:${pad(at.getMinutes())}`
  }
  return `${MONTHS[at.getMonth()]} ${at.getDate()}`
}

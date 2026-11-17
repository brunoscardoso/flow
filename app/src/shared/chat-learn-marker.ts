/**
 * Chat-learn marker rows — the durable trace of Flow learning the area a
 * conversation worked in (user decision 2026-11-17).
 *
 * Learning from chat used to ASK, with a card in the corner ("Learn what you
 * just worked on?"). Now it happens by itself after the turn, and the
 * conversation that did the work says so: main writes one row when learning
 * starts and one when it ends, and the renderer draws ONE card per area from
 * the newest row. The rows are the record, so a reload shows the same state.
 *
 * Writer (main) and reader (renderer) share this ONE classification so the two
 * cannot drift — the same shape as folder-behind-marker.ts and
 * artifact-marker.ts.
 */

/** Machine-parseable prefix of a persisted chat-learn system row. */
export const CHAT_LEARN_MARKER_PREFIX = '[chat-learn]'

export type ChatLearnPhase = 'learning' | 'learned' | 'failed'

export interface ChatLearnMarker {
  /** The project root the area belongs to (absolute). */
  root: string
  /** The area (depth-1 module path) that was learned. */
  module: string
  /** How many files the conversation touched in it. */
  files: number
  phase: ChatLearnPhase
}

const PHASES: readonly ChatLearnPhase[] = ['learning', 'learned', 'failed']

/** Serialize a row's content: `[chat-learn] {json}`. */
export function formatChatLearnMarker(marker: ChatLearnMarker): string {
  const { root, module, files, phase } = marker
  return `${CHAT_LEARN_MARKER_PREFIX} ${JSON.stringify({ root, module, files, phase })}`
}

/** Parse a row; null for anything that is not a well-formed marker. */
export function parseChatLearnMarker(content: string): ChatLearnMarker | null {
  if (!content.startsWith(`${CHAT_LEARN_MARKER_PREFIX} `)) return null
  let raw: unknown
  try {
    raw = JSON.parse(content.slice(CHAT_LEARN_MARKER_PREFIX.length + 1))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const { root, module, files, phase } = raw as Record<string, unknown>
  if (typeof root !== 'string' || root === '' || typeof module !== 'string' || module === '') return null
  if (typeof files !== 'number' || !Number.isFinite(files) || files < 0) return null
  if (typeof phase !== 'string' || !PHASES.includes(phase as ChatLearnPhase)) return null
  return { root, module, files: Math.round(files), phase: phase as ChatLearnPhase }
}

/** One card per area: the key two rows about the same area share. */
export function chatLearnKey(marker: Pick<ChatLearnMarker, 'root' | 'module'>): string {
  // One area however its path is spelled: a trailing slash is not a second area.
  return `${marker.root.replace(/\/+$/, '')}\x00${marker.module.replace(/\/+$/, '')}`
}

/** The area's name as a person reads it — the last segment of its path. */
export function chatLearnAreaName(module: string): string {
  const parts = module.split('/').filter((part) => part !== '')
  return parts[parts.length - 1] ?? module
}

export interface ChatLearnCopy {
  title: string
  /** The short tail after the title — how much it learned from. */
  detail: string
  /** Only a failed run offers something to do: try again. A learned area is
   *  a status, not a door (user, 2026-11-17: "don't need that show on the
   *  board action, this is just a component to indicate the learning"). */
  action: { kind: 'retry'; label: string } | null
}

/** What the row says in each phase. Plain words, no paths (forbidden-pattern #12). */
export function chatLearnCopy(marker: ChatLearnMarker): ChatLearnCopy {
  const area = chatLearnAreaName(marker.module)
  const files = `${String(marker.files)} file${marker.files === 1 ? '' : 's'}`
  switch (marker.phase) {
    case 'learning':
      return { title: `Learning ${area}`, detail: `from ${files}`, action: null }
    case 'learned':
      return { title: `Learned ${area}`, detail: `from ${files}`, action: null }
    case 'failed':
      return {
        title: `Could not learn ${area}`,
        detail: 'nothing was added',
        action: { kind: 'retry', label: 'Try again' },
      }
  }
}

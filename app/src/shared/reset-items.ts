/**
 * THE KINDS OF DATA "RESET FLOW" CAN DELETE — the one list both sides share.
 *
 * Settings shows one checkbox per item; main deletes exactly the items it is
 * handed. The list is closed: an unknown key is refused at the boundary
 * (`parseResetItems`), never ignored, so a renderer and a main process of
 * different builds cannot disagree silently about what "everything" means.
 *
 * Order is the order Settings draws them in.
 */
export const RESET_ITEMS = [
  'app-settings',
  'file-defaults',
  'permissions',
  'conversations',
  'launchpad',
  'tasks',
  'personal-brain',
  'agent-accounts',
  'connectors',
  'integrations',
  'browser-data',
  'projects',
  'workspace-knowledge',
  'project-files',
  'logs-caches',
] as const

export type ResetItem = (typeof RESET_ITEMS)[number]

/** What one item holds right now, as Settings shows it beside the checkbox. */
export interface ResetInventoryRow {
  item: ResetItem
  /** A short count ("214 conversations · 412 MB"), or null when it could not be read. */
  size: string | null
  /** True when nothing of this kind exists — the row is shown, with "Nothing stored". */
  empty: boolean
  /** A sentence the person must see before deleting (unsynced Workspace changes). */
  warning: string | null
}

export interface ResetInventory {
  rows: ResetInventoryRow[]
  /** Something is still running that a reset would stop (an agent turn, a terminal). */
  busy: string | null
}

/** The outcome of the last reset, read once on the next launch. */
export interface ResetOutcome {
  at: string
  done: ResetItem[]
  failed: Array<{ item: ResetItem; detail: string }>
}

const KNOWN = new Set<string>(RESET_ITEMS)

export function isResetItem(value: unknown): value is ResetItem {
  return typeof value === 'string' && KNOWN.has(value)
}

/**
 * The items a request names, in canonical order, without duplicates — or null
 * when the request is not a non-empty list of known items. Null is a refusal:
 * the caller deletes nothing.
 */
export function parseResetItems(value: unknown): ResetItem[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  if (!value.every(isResetItem)) return null
  const wanted = new Set<string>(value)
  return RESET_ITEMS.filter((item) => wanted.has(item))
}

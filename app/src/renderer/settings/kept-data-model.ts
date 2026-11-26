/**
 * "DATA KEPT FROM DELETED THREADS" ON THE STORAGE PAGE, DECIDED — every
 * sentence and every row, with no DOM near it (the page's own rule, see
 * `storage-page-model.ts`).
 *
 * NO ID, PATH OR COMMAND CROSSES THIS FILE'S OUTPUT (forbidden-pattern #12):
 * a row carries a key for the press to address and the words a person reads.
 * The key is never rendered.
 *
 * THE SECTION HIDES WHEN THERE IS NOTHING: the page's own empty line already
 * says what it says about files, and a second "nothing here" under it would be
 * noise. Docker closed is the one case that speaks, because a hidden section
 * would read as "nothing is kept" when the truth is "Flow could not look".
 */

import type { RunKeptData, RunKeptDataItem } from '../../shared/run-setup'
import { volumeKind } from '../terminal/compose-panel-model'
import { humanSize } from '../threads/thread-sidebar-delete-notice'

export const KEPT_DATA_STRINGS = {
  heading: 'Data kept from deleted threads',
  explanation: 'These threads were deleted and their Docker data was kept. Nothing uses it any more.',
  dockerClosed: 'Docker is not running, so Flow cannot see what is kept. Open Docker to look.',
  noTitle: 'A thread that no longer exists',
  delete: 'Delete…',
  cancel: 'Cancel',
  confirm: 'Delete data',
  untouched: 'The project and other threads are not touched.',
  gone: "It can't be brought back.",
  failed: "Flow couldn't delete that data. Nothing was changed.",
  unknownSize: 'size unknown',
} as const

export interface KeptRowView {
  /** Addresses the press. Never rendered. */
  key: string
  title: string
  /** "<project> · <data words> · <size>". */
  sub: string
}

export interface KeptConfirmView {
  title: string
  body: string
  cancel: string
  confirm: string
}

export interface KeptClosedView {
  kind: 'closed'
  heading: string
  closed: string
}

export interface KeptSectionView {
  kind: 'list'
  heading: string
  /** "2.1 GB in all"; null when nothing can be added up. */
  total: string | null
  explanation: string
  rows: KeptRowView[]
}

/** "Database", "Database and cache", "Database, cache and files" — "Data" when no volume says what it is. */
export function dataWords(volumes: ReadonlyArray<{ volume: string }>): string {
  const kinds: string[] = []
  let unknown = false
  for (const entry of volumes) {
    const kind = volumeKind(entry.volume)
    if (kind === null) unknown = true
    else if (!kinds.includes(kind.toLowerCase())) kinds.push(kind.toLowerCase())
  }
  if (kinds.length === 0) return 'Data'
  const words = unknown ? [...kinds, 'other data'] : kinds
  const joined = words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
  return joined.charAt(0).toUpperCase() + joined.slice(1)
}

function sizeOf(bytes: number | null): string {
  return bytes === null ? KEPT_DATA_STRINGS.unknownSize : humanSize(bytes)
}

export const keptKey = (item: Pick<RunKeptDataItem, 'threadId' | 'projectRoot'>): string => `${item.projectRoot}::${item.threadId}`

export function keptRow(item: RunKeptDataItem): KeptRowView {
  const title = item.title !== null && item.title.trim() !== '' ? item.title.trim() : KEPT_DATA_STRINGS.noTitle
  return { key: keptKey(item), title, sub: `${item.projectName} · ${dataWords(item.volumes)} · ${sizeOf(item.totalBytes)}` }
}

/** The section's face; null when it is hidden (Docker answered and nothing is kept). */
export function keptSection(data: RunKeptData | null): KeptSectionView | KeptClosedView | null {
  if (data === null) return null
  if (!data.dockerAvailable) return { kind: 'closed', heading: KEPT_DATA_STRINGS.heading, closed: KEPT_DATA_STRINGS.dockerClosed }
  if (data.items.length === 0) return null
  let sum: number | null = 0
  for (const item of data.items) sum = sum === null || item.totalBytes === null ? null : sum + item.totalBytes
  return {
    kind: 'list',
    heading: KEPT_DATA_STRINGS.heading,
    total: sum === null ? null : `${humanSize(sum)} in all`,
    explanation: KEPT_DATA_STRINGS.explanation,
    rows: data.items.map(keptRow),
  }
}

/** The confirm: names the data and its size, and says what is not touched. */
export function keptConfirm(item: RunKeptDataItem): KeptConfirmView {
  const title = keptRow(item).title
  const words = dataWords(item.volumes).toLowerCase()
  const size = item.totalBytes === null ? '' : `, ${humanSize(item.totalBytes)}`
  return {
    title: `Delete the data of “${title}”?`,
    body: `This deletes its ${words}${size}. ${KEPT_DATA_STRINGS.gone} ${KEPT_DATA_STRINGS.untouched}`,
    cancel: KEPT_DATA_STRINGS.cancel,
    confirm: KEPT_DATA_STRINGS.confirm,
  }
}

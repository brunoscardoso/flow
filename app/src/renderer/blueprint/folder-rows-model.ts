/**
 * Folder rows (plan feature-home-folders, Phase 3) — PURE, no DOM.
 *
 * WHAT A FEATURE CARD SAYS ABOUT WHERE THE FEATURE LIVES, in the file
 * explorer's own words: its top folders as file-tree rows, each with its share
 * of the feature's lines. The CLI computes the rows (allowed-pattern #14); this
 * module only decides how they READ — the shortened path a row prints, the full
 * sentence its tooltip and accessible name carry, the one-line form a smaller
 * cell prints, and the "N more folders" count.
 *
 * The folder paths are the USER'S project's paths — content, not Flow's
 * internals — so printing them is fine. Nothing here names a command, a config
 * key or a file of Flow's own.
 *
 * DISPLAY PATH, two rules and nothing clever:
 *  1. a leading source root (`SOURCE_ROOTS`) is dropped — `src/components/x`
 *     reads `components/x`. Only ONE, only at the start, and never when the
 *     path IS the root (a feature living in `src` itself reads `src`);
 *  2. more than `MAX_SEGMENTS` remaining segments collapse their middle:
 *     `components/admin/…/DomainModels`.
 *  The repository root (`.`) reads as the project's own name, or
 *  "project root" when the name is not known.
 */

import type { BlueprintFeatureFolders, BlueprintFolderRow } from '../../shared/ipc-contract'

/**
 * Source roots dropped from the front of a displayed path, longest first so
 * `app/src/x` loses `app/src/` rather than nothing. Deliberately a short fixed
 * list: a guess at a project's layout beyond these would hide a folder name
 * the reader needs.
 */
export const SOURCE_ROOTS = ['app/src', 'src', 'lib', 'source', 'sources'] as const

/** Segments a displayed path keeps before its middle collapses. */
export const MAX_SEGMENTS = 3

/** What the repository root reads as when the project's name is unknown. */
export const PROJECT_ROOT_LABEL = 'project root'

/** The collapse mark — one character, so a row's width is spent on names. */
export const ELLIPSIS = '…'

/** One folder row, ready to print. */
export interface FolderRowView {
  /** The full repo-relative path, as the CLI sent it (`.` for the root). */
  path: string
  /** The shortened path the row prints. */
  display: string
  /** `Math.round(share * 100)`. */
  percent: number
  share: number
  files: number
  lines: number
  /** A person chose this folder as the home — the row shows a pin mark. */
  pinned: boolean
  /** The first row: the home, printed in ink rather than ink-2. */
  home: boolean
  /** Tooltip AND accessible name — the full path and what it holds. */
  title: string
}

/** The one-line form: the home, or the plain fact that there is none. */
export type FolderLine =
  | {
      kind: 'home'
      /** The shortened path. */
      path: string
      fullPath: string
      percent: number
      pinned: boolean
      /** `components/automations 72%`. */
      text: string
      title: string
    }
  | {
      kind: 'spread'
      /** `spread over N folders`. */
      text: string
      title: string
    }

/** Everything a cell can print about where its feature lives, at any size. */
export interface FolderSlice {
  /** Every row the CLI sent (at most four), home first. */
  rows: FolderRowView[]
  line: FolderLine
  folderCount: number
  spread: boolean
  pinned: boolean
}

/** A percentage as the rows print it. */
export function percentOf(share: number): number {
  if (!Number.isFinite(share)) return 0
  return Math.round(Math.min(1, Math.max(0, share)) * 100)
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/** `Automations'` / `Chat's`. */
function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`
}

function isRoot(path: string): boolean {
  return path === '.' || path === '' || path === './'
}

function rootLabel(projectName: string | undefined): string {
  const name = projectName?.trim() ?? ''
  return name.length > 0 ? name : PROJECT_ROOT_LABEL
}

/** The path as the tooltip names it — whole, the root by name. */
export function fullPathText(path: string, projectName?: string): string {
  return isRoot(path) ? rootLabel(projectName) : path.replace(/\/+$/, '')
}

/** The shortened path a row prints (see the module header for the rules). */
export function displayPath(path: string, projectName?: string): string {
  if (isRoot(path)) return rootLabel(projectName)
  let rest = path.replace(/^\.\//, '').replace(/\/+$/, '')
  for (const root of SOURCE_ROOTS) {
    if (rest.startsWith(`${root}/`)) {
      rest = rest.slice(root.length + 1)
      break
    }
  }
  const segments = rest.split('/').filter((segment) => segment.length > 0)
  if (segments.length <= MAX_SEGMENTS) return segments.join('/')
  return `${segments[0]}/${segments[1]}/${ELLIPSIS}/${segments[segments.length - 1]}`
}

/** `src/components/automations — 72% of Automations' code, 60 files`. */
export function rowTitle(row: BlueprintFolderRow, ownerName: string, projectName?: string): string {
  const base = `${fullPathText(row.path, projectName)} — ${percentOf(row.share)}% of ${possessive(ownerName)} code, ${plural(row.files, 'file')}`
  return row.pinned === true ? `${base} · chosen as the home` : base
}

/** The rows as they print. */
export function rowViews(folders: BlueprintFeatureFolders, ownerName: string, projectName?: string): FolderRowView[] {
  return folders.rows.map((row, index) => ({
    path: row.path,
    display: displayPath(row.path, projectName),
    percent: percentOf(row.share),
    share: row.share,
    files: row.files,
    lines: row.lines,
    pinned: row.pinned === true,
    home: index === 0,
    title: rowTitle(row, ownerName, projectName),
  }))
}

/**
 * The one-line form, or null when there are no rows.
 *
 * A SPREAD feature names no home — "spread over N folders" — because printing
 * its biggest folder alone would claim a home it does not have. A home a
 * person CHOSE wins over spread: it is their word, not a computed guess.
 */
export function oneLine(folders: BlueprintFeatureFolders, ownerName: string, projectName?: string): FolderLine | null {
  const first = folders.rows[0]
  if (first === undefined) return null
  const pinned = folders.pinned && first.pinned === true
  if (folders.spread && !pinned) {
    const count = Math.max(folders.folderCount, folders.rows.length)
    return {
      kind: 'spread',
      text: `spread over ${plural(count, 'folder')}`,
      title: `No one folder holds most of ${possessive(ownerName)} code — it is spread over ${plural(count, 'folder')}`,
    }
  }
  const display = displayPath(first.path, projectName)
  const percent = percentOf(first.share)
  return {
    kind: 'home',
    path: display,
    fullPath: first.path,
    percent,
    pinned,
    text: `${display} ${percent}%`,
    title: rowTitle(first, ownerName, projectName),
  }
}

/**
 * `N more folders` beside `shown` rows, or null when none are left out.
 * Counted from `folderCount` (the folders the node's files fall in), so it
 * says how much of the explorer the rows did not list.
 */
export function moreText(folders: Pick<BlueprintFeatureFolders, 'folderCount'>, shown: number): string | null {
  const hidden = folders.folderCount - Math.max(0, shown)
  return hidden > 0 ? plural(hidden, 'more folder') : null
}

/** Everything a cell can print, or null when the node has no rows. */
export function folderSlice(
  folders: BlueprintFeatureFolders | undefined,
  ownerName: string,
  projectName?: string,
): FolderSlice | null {
  if (folders === undefined || folders.rows.length === 0) return null
  const line = oneLine(folders, ownerName, projectName)
  if (line === null) return null
  return {
    rows: rowViews(folders, ownerName, projectName),
    line,
    folderCount: folders.folderCount,
    spread: folders.spread,
    pinned: folders.pinned,
  }
}

/** How much of the slice a cell prints at its size. */
export type FolderTier = 'rows' | 'line'

/** A cell's folders: the whole slice (what the grown cell prints) and what its own size prints. */
export interface CellFolders extends FolderSlice {
  /** `rows` — file-tree rows; `line` — the one-line form; null — nothing (the name alone). */
  tier: FolderTier | null
  /** The rows printed at this tier — empty unless `tier === 'rows'`. */
  shown: FolderRowView[]
  /** `N more folders` beside `shown`, at the rows tier. */
  more: string | null
  /** `N more folders` beside every row — what the grown cell prints. */
  moreAll: string | null
}

/** Combine a slice with what a rectangle has room for. */
export function cellFolders(slice: FolderSlice | null, tier: FolderTier | null, rowsFit: number): CellFolders | null {
  if (slice === null) return null
  const shown = tier === 'rows' ? slice.rows.slice(0, Math.max(0, rowsFit)) : []
  return {
    ...slice,
    tier,
    shown,
    more: tier === 'rows' ? moreText(slice, shown.length) : null,
    moreAll: moreText(slice, slice.rows.length),
  }
}

/** The most rows a hover's details print — the opened card prints them all. */
export const DETAILS_ROWS = 3

/**
 * THE ROWS A DETAILS CELL PRINTS (the user, 2026-10-08: "calm, details on
 * hover"): the top `max` rows, home first, and "N more folders" counted from
 * every folder the feature's files fall in — so a fourth row the CLI did send
 * is counted, not dropped silently.
 */
export function detailsRows(
  slice: Pick<FolderSlice, 'rows' | 'folderCount'>,
  max: number = DETAILS_ROWS,
): { rows: FolderRowView[]; more: string | null } {
  const rows = slice.rows.slice(0, Math.max(0, max))
  return { rows, more: moreText(slice, rows.length) }
}

// ── What the board does with a row (plan feature-home-folders, Phase 4) ──────

/** One entry of a row's own small menu. */
export interface FolderRowMenuItem {
  id: 'reveal' | 'home' | 'unhome'
  label: string
}

/**
 * A row's menu: always "Open in file tree"; "Make this the home" when the
 * project can be written here (its checkout is open in Flow) — or, on the row
 * a person already chose, "Stop using this as the home". The project root is
 * never offered as a home: it holds everything, so it explains nothing (the
 * writer refuses it too).
 */
export function folderRowMenu(row: Pick<FolderRowView, 'path' | 'pinned'>, canPin: boolean): FolderRowMenuItem[] {
  const items: FolderRowMenuItem[] = [{ id: 'reveal', label: 'Open in file tree' }]
  if (!canPin) return items
  if (row.pinned) items.push({ id: 'unhome', label: 'Stop using this as the home' })
  else if (!isRoot(row.path)) items.push({ id: 'home', label: 'Make this the home' })
  return items
}

/** A row's height, the "N more folders" line's, and the air above the rows — the CSS's own numbers. */
export const FOLDER_ROW_PX = 16
export const FOLDER_MORE_PX = 14
export const FOLDER_ROWS_GAP_PX = 4
/** The rest of a resting cell: 12px padding, the 16px name plus 2px, the 12px foot row, 4px above the description. */
const CELL_CHROME_PX = 12 + 18 + 12 + 4
const SUMMARY_LINE_PX = 14
const SUMMARY_MAX_LINES = 4

/**
 * ROWS WIN OVER THE DESCRIPTION. A cell tall enough for both prints both; one
 * that is not keeps its rows whole and gives the description only the lines
 * left (0 → no description). Never a clipped half-line: the answer is a
 * whole number of lines, which the board hands the paragraph's clamp.
 */
export function summaryLinesBeside(height: number, rows: number, hasMore: boolean): number {
  if (!Number.isFinite(height) || height <= 0) return 0
  const block = rows > 0 ? FOLDER_ROWS_GAP_PX + rows * FOLDER_ROW_PX + (hasMore ? FOLDER_MORE_PX : 0) : 0
  const room = height - CELL_CHROME_PX - block
  return Math.max(0, Math.min(SUMMARY_MAX_LINES, Math.floor(room / SUMMARY_LINE_PX)))
}

/**
 * What the board says when the home could not be saved — in the terms of the
 * row on screen, never the writer's own wording (which names its flags).
 */
export function homeRefusalText(reason: string, folder: string | null): string {
  const named = folder === null || isRoot(folder) ? 'That folder' : folder
  switch (reason) {
    case 'missing-folder':
      return `${named} is no longer a folder of this project.`
    case 'not-a-folder':
      return `${named} is a file, not a folder.`
    case 'outside-project':
      return folder !== null && isRoot(folder)
        ? 'The project itself cannot be a home — choose one of its folders.'
        : `${named} is not a folder inside this project.`
    case 'unknown-feature':
      return "Flow couldn't find this feature in the project, so nothing was saved."
    case 'unknown root':
      return 'This project is not open in Flow, so its home cannot be changed from here.'
    case 'timed out':
      return 'Saving the home took too long and was stopped. Nothing was changed.'
    default:
      return "Flow couldn't save the home. Nothing was changed."
  }
}

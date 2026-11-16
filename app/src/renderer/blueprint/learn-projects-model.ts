/**
 * LEARNING, ONE PROJECT AT A TIME (user, 2026-10-06: "we need something to
 * show it per project, more organized … the user may want to learn one project,
 * not all"). PURE — no DOM, no IPC.
 *
 * The Learning panel lists the Workspace's projects, each a row with its own
 * progress, state and actions; the project the reader is in is open, the
 * others folded. Inside a project, modules are GROUPED instead of one flat
 * list of hundreds: learning now, drifted, not learned (folded by folder, each
 * folder learnable on its own), and learned (folded).
 *
 * The live state comes from the one orchestrator that serves every project
 * (`learn:status`), which reports which project its pass belongs to, how much
 * each project has queued, and which projects are paused on their own.
 */
import type { LearnLogLine, LearnModuleRow, LearnProgress } from './learn-progress-model'

/** One project as the panel is handed it. */
export interface ProjectLearnInput {
  slug: string
  name: string
  /** This computer's checkout as Flow knows it, or null. */
  root: string | null
  /** Its palette slot (colour). */
  slot: number
  /** The project the reader is in. */
  here: boolean
  /** Its learning progress, or null while it is being read (or cannot be). */
  progress: LearnProgress | null
  /** Its features understood, when known. */
  features: { done: number; total: number } | null
}

/** The orchestrator's live answer, as the panel needs it. */
export interface LearnLiveInput {
  running: boolean
  /** The whole learner paused (Pause all, or after failures in a row). */
  paused: boolean
  activeRoot?: string | null
  activeModule: string | null
  queuedByRoot?: Record<string, number>
  pausedRoots?: readonly string[]
}

export type ProjectLearnState = 'learning' | 'queued' | 'paused' | 'idle' | 'done' | 'empty' | 'loading' | 'remote'

export interface ProjectLearnRow {
  slug: string
  name: string
  root: string | null
  slot: number
  here: boolean
  state: ProjectLearnState
  /** "Learning src/app · 12 queued", "Paused", "Not on this computer"… */
  stateText: string
  learned: number
  total: number
  percent: number
  /** "24 / 410 modules · 3 of 24 features", or '' while unknown. */
  countsText: string
  /** Modules still to learn (none or drifted), shallow first. */
  remaining: string[]
  /** "Learn 386" / "Update 3" — null when there is nothing to learn or no way to. */
  learnLabel: string | null
  /** Pause or Resume for this project, or null when there is nothing to pause. */
  pauseAction: 'pause' | 'resume' | null
}

function plural(count: number, word: string): string {
  return `${String(count)} ${word}${count === 1 ? '' : 's'}`
}

/** Modules still to learn — never-learned and drifted — shallow first. */
export function remainingModules(progress: LearnProgress): string[] {
  return progress.rows
    .filter((row) => row.status === 'none' || row.status === 'stale')
    .map((row) => row.module)
    .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}

/** Every project's row, in the order given. */
export function projectLearnRows(projects: readonly ProjectLearnInput[], live: LearnLiveInput): ProjectLearnRow[] {
  const pausedRoots = new Set(live.pausedRoots ?? [])
  return projects.map((project) => {
    const base = {
      slug: project.slug,
      name: project.name,
      root: project.root,
      slot: project.slot,
      here: project.here,
    }
    if (project.root === null) {
      return { ...base, state: 'remote', stateText: 'Not on this computer', learned: 0, total: 0, percent: 0, countsText: '', remaining: [], learnLabel: null, pauseAction: null }
    }
    const progress = project.progress
    if (progress === null) {
      return { ...base, state: 'loading', stateText: 'Reading…', learned: 0, total: 0, percent: 0, countsText: '', remaining: [], learnLabel: null, pauseAction: null }
    }
    const remaining = remainingModules(progress)
    const queued = live.queuedByRoot?.[project.root] ?? 0
    const active = live.running && live.activeRoot === project.root
    const paused = pausedRoots.has(project.root)
    let state: ProjectLearnState = 'idle'
    let stateText = 'Idle'
    if (progress.total === 0) {
      state = 'empty'
      stateText = 'Nothing to learn yet'
    } else if (remaining.length === 0) {
      state = 'done'
      stateText = 'Learned'
    }
    if (paused && (queued > 0 || active)) {
      state = 'paused'
      stateText = queued > 0 ? `Paused · ${String(queued)} queued` : 'Paused'
    } else if (active) {
      state = 'learning'
      stateText = `Learning ${live.activeModule ?? ''}`.trim() + (queued > 0 ? ` · ${String(queued)} queued` : '')
    } else if (queued > 0) {
      state = 'queued'
      stateText = live.paused ? `Waiting · ${String(queued)} queued (learning is paused)` : `${String(queued)} queued`
    }
    const stale = progress.rows.filter((row) => row.status === 'stale').length
    let learnLabel: string | null = null
    if (remaining.length > 0 && state !== 'learning' && state !== 'queued' && state !== 'paused') {
      learnLabel = remaining.length === stale ? `Update ${String(stale)}` : `Learn ${String(remaining.length)}`
    }
    const features = project.features === null ? '' : ` · ${String(project.features.done)} of ${plural(project.features.total, 'feature')}`
    return {
      ...base,
      state,
      stateText,
      learned: progress.learned,
      total: progress.total,
      percent: progress.percent,
      countsText: `${String(progress.learned)} / ${plural(progress.total, 'module')}${features}`,
      remaining,
      learnLabel,
      pauseAction: paused ? 'resume' : active || queued > 0 ? 'pause' : null,
    }
  })
}

/** The panel's top line: what the Workspace is doing, and how far it has got. */
export function workspaceLearnLine(rows: readonly ProjectLearnRow[], live: LearnLiveInput): { headline: string; facts: string; percent: number } {
  const learned = rows.reduce((sum, row) => sum + row.learned, 0)
  const total = rows.reduce((sum, row) => sum + row.total, 0)
  const percent = total === 0 ? 0 : (learned / total) * 100
  const facts = total === 0 ? '' : `${String(learned)} of ${plural(total, 'module')} · ${String(Math.floor(percent))}%`
  const learning = rows.find((row) => row.state === 'learning')
  let headline = 'Idle'
  if (live.paused) headline = 'Learning is paused'
  else if (learning !== undefined) headline = `Learning ${learning.name}`
  else if (rows.some((row) => row.state === 'queued')) headline = 'Waiting to learn'
  return { headline, facts, percent }
}

// ─── Inside a project ───────────────────────────────────────────────────────

/** The folder a module is grouped under: its first two segments, or itself. */
export function folderOf(module: string): string {
  const parts = module.split('/').filter((part) => part !== '')
  return parts.length >= 3 ? parts.slice(0, 2).join('/') : module
}

export interface ModuleFolder {
  folder: string
  modules: string[]
}

export type ModuleGroupKey = 'updating' | 'now' | 'drift' | 'todo' | 'done' | 'ignored'

export interface ModuleGroup {
  key: ModuleGroupKey
  title: string
  count: number
  /** Rows for the groups that list modules (now, drift, done). */
  rows: LearnModuleRow[]
  /** Folders for the not-learned group, largest first. */
  folders: ModuleFolder[]
}

const GROUP_TITLES: Record<ModuleGroupKey, string> = {
  updating: 'Updating',
  now: 'Learning now',
  drift: 'Drifted',
  todo: 'Not learned',
  done: 'Learned',
  ignored: 'Ignored',
}

/**
 * A project's modules, grouped. Empty groups are left out; `filter` keeps the
 * modules whose path contains it (case-insensitive).
 *
 * IGNORED MODULES ARE NOT PART OF THE WORK, BUT A PERSON'S OWN IGNORE IS LISTED
 * (#1450). The redesign dropped every ignored row, so a module ignored from this
 * panel vanished with the only Unignore there was. A module the person ignored
 * (`userIgnored`) gets its own last, folded group — `Ignored` — where its
 * Unignore lives; a built-in ignore (scaffolding, tests, dot-dirs) stays out:
 * nobody chose it here, and there is nothing to undo on it.
 */
export function moduleGroups(
  progress: LearnProgress,
  filter = '',
  userIgnored: (module: string) => boolean = () => false,
  /** Modules of a drifted batch being updated: they form their own first
   *  group (`Updating`) and leave every other group while it runs. */
  updating: readonly string[] = [],
): ModuleGroup[] {
  const needle = filter.trim().toLowerCase()
  const matching = progress.rows.filter((row) => needle === '' || row.module.toLowerCase().includes(needle))
  const batch = new Set(updating)
  const batchRows = updating
    .map((module) => matching.find((row) => row.module === module))
    .filter((row): row is LearnModuleRow => row !== undefined && row.status !== 'ignored')
  const rows = matching.filter((row) => row.status !== 'ignored' && !batch.has(row.module))
  const ignored = matching
    .filter((row) => row.status === 'ignored' && userIgnored(row.module))
    .sort((a, b) => a.module.localeCompare(b.module))
  const pick = (test: (row: LearnModuleRow) => boolean): LearnModuleRow[] => rows.filter(test).sort((a, b) => a.module.localeCompare(b.module))
  // The pass being read first, then what is queued behind it.
  const now = pick((row) => row.status === 'learning').concat(pick((row) => row.status === 'queued'))
  const drift = pick((row) => row.status === 'stale')
  const done = pick((row) => row.status === 'learned').sort((a, b) => (b.notedAt ?? '').localeCompare(a.notedAt ?? ''))
  const byFolder = new Map<string, string[]>()
  for (const row of pick((candidate) => candidate.status === 'none')) {
    const key = folderOf(row.module)
    byFolder.set(key, [...(byFolder.get(key) ?? []), row.module])
  }
  const folders = [...byFolder.entries()]
    .map(([folder, modules]) => ({ folder, modules }))
    .sort((a, b) => b.modules.length - a.modules.length || a.folder.localeCompare(b.folder))
  const groups: ModuleGroup[] = []
  const add = (key: ModuleGroupKey, list: LearnModuleRow[], fold: ModuleFolder[] = []): void => {
    const count = key === 'todo' ? fold.reduce((sum, entry) => sum + entry.modules.length, 0) : list.length
    if (count > 0) groups.push({ key, title: GROUP_TITLES[key], count, rows: list, folders: fold })
  }
  add('updating', batchRows)
  add('now', now)
  add('drift', drift)
  add('todo', [], folders)
  add('done', done)
  add('ignored', ignored)
  return groups
}

/** Whether a group starts open: the work in hand is shown, what is done is folded. */
export function groupOpenByDefault(key: ModuleGroupKey): boolean {
  return key !== 'done' && key !== 'ignored'
}

// ─── The Drifted group (mockup "Drifted, easier to update", 2026-11-16) ─────
//
// A summary with Update all, folders each with their own Update, checkboxes
// for a selection, the reason on every row and a sort. Once a batch starts,
// it becomes a progress line over the batch's rows. Reasons come from the
// project's staleness check (main's `learn:driftReasons`): a module with no
// known count shows no reason, never a guess.

export type DriftSort = 'folder' | 'changed' | 'oldest'

export const DRIFT_SORTS: ReadonlyArray<{ key: DriftSort; label: string }> = [
  { key: 'folder', label: 'Folder' },
  { key: 'changed', label: 'Most changed' },
  { key: 'oldest', label: 'Oldest' },
]

export function isDriftSort(value: unknown): value is DriftSort {
  return value === 'folder' || value === 'changed' || value === 'oldest'
}

/** Changed files per module, as main answered (module → repo-relative files). */
export type DriftFiles = Readonly<Record<string, readonly string[]>>

/** How many files changed under a module, or null when nobody knows. */
export function driftCount(files: DriftFiles | null, module: string): number | null {
  const list = files?.[module]
  return list === undefined ? null : list.length
}

/** "24 files changed" — or null, so a row without a known count says nothing. */
export function driftReason(count: number | null): string | null {
  if (count === null || count <= 0) return null
  return `${plural(count, 'file')} changed`
}

/** Distinct files across some modules (a parent and its child share files). */
export function distinctFiles(files: DriftFiles | null, modules: readonly string[]): number | null {
  if (files === null) return null
  const set = new Set<string>()
  let known = false
  for (const module of modules) {
    const list = files[module]
    if (list === undefined) continue
    known = true
    for (const file of list) set.add(file)
  }
  return known ? set.size : null
}

/** The drifted rows in the chosen order. */
export function sortDriftRows(rows: readonly LearnModuleRow[], files: DriftFiles | null, sort: DriftSort): LearnModuleRow[] {
  const byName = (a: LearnModuleRow, b: LearnModuleRow): number => a.module.localeCompare(b.module)
  const list = [...rows]
  if (sort === 'changed') {
    return list.sort((a, b) => (driftCount(files, b.module) ?? -1) - (driftCount(files, a.module) ?? -1) || byName(a, b))
  }
  if (sort === 'oldest') {
    // A row with no time sorts last: nothing says it is old.
    return list.sort((a, b) => {
      if (a.notedAt === undefined || b.notedAt === undefined) {
        return (a.notedAt === undefined ? 1 : 0) - (b.notedAt === undefined ? 1 : 0) || byName(a, b)
      }
      return a.notedAt.localeCompare(b.notedAt) || byName(a, b)
    })
  }
  return list.sort(byName)
}

export interface DriftFolderView {
  folder: string
  rows: LearnModuleRow[]
  modules: string[]
  files: number | null
  /** "11 modules · 96 files" — files left out when unknown. */
  facts: string
}

/** The drifted rows by folder: largest first, rows inside by name. */
export function driftFolders(rows: readonly LearnModuleRow[], files: DriftFiles | null): DriftFolderView[] {
  const byFolder = new Map<string, LearnModuleRow[]>()
  for (const row of sortDriftRows(rows, files, 'folder')) {
    const key = folderOf(row.module)
    byFolder.set(key, [...(byFolder.get(key) ?? []), row])
  }
  return [...byFolder.entries()]
    .map(([folder, list]) => {
      const modules = list.map((row) => row.module)
      const count = distinctFiles(files, modules)
      const facts = plural(modules.length, 'module') + (count === null || count === 0 ? '' : ` · ${plural(count, 'file')}`)
      return { folder, rows: list, modules, files: count, facts }
    })
    .sort((a, b) => b.modules.length - a.modules.length || a.folder.localeCompare(b.folder))
}

/** The summary bar: "31 modules changed since Flow last read them · 214 files changed". */
export function driftSummary(rows: readonly LearnModuleRow[], files: DriftFiles | null): { modules: number; files: number | null; text: string } {
  const modules = rows.map((row) => row.module)
  const count = distinctFiles(files, modules)
  const lead = `${plural(modules.length, 'module')} changed since Flow last read ${modules.length === 1 ? 'it' : 'them'}`
  return { modules: modules.length, files: count, text: count === null || count === 0 ? lead : `${lead} · ${plural(count, 'file')} changed` }
}

export type TriState = 'none' | 'some' | 'all'

/** A checkbox over some modules: none, some or all of them selected. */
export function selectionState(modules: readonly string[], selected: ReadonlySet<string>): TriState {
  if (modules.length === 0) return 'none'
  const picked = modules.filter((module) => selected.has(module)).length
  if (picked === 0) return 'none'
  return picked === modules.length ? 'all' : 'some'
}

/** Pressing a group checkbox: all selected → clear them; otherwise select all. */
export function toggleSelection(modules: readonly string[], selected: ReadonlySet<string>): Set<string> {
  const next = new Set(selected)
  if (selectionState(modules, selected) === 'all') for (const module of modules) next.delete(module)
  else for (const module of modules) next.add(module)
  return next
}

/** Keep only what can still be selected (a module that stopped drifting drops out). */
export function pruneSelection(selected: ReadonlySet<string>, modules: readonly string[]): Set<string> {
  const live = new Set(modules)
  return new Set([...selected].filter((module) => live.has(module)))
}

/**
 * How long finished passes took this session, from the learner's own log: a
 * `start` followed by `learned` for the same module. The only duration source
 * there is — with no finished pass yet, there is no estimate.
 */
export function passDurations(log: readonly LearnLogLine[]): number[] {
  const started = new Map<string, number>()
  const out: number[] = []
  for (const entry of log) {
    if (entry.kind === 'start') started.set(entry.module, entry.at)
    else if (entry.kind === 'learned') {
      const at = started.get(entry.module)
      if (at !== undefined && entry.at >= at) out.push(entry.at - at)
      started.delete(entry.module)
    } else if (entry.kind === 'failed' || entry.kind === 'stopped') started.delete(entry.module)
  }
  return out
}

/** Minutes for `count` passes at the observed mean (passes run one at a time), or null. */
export function estimateMinutes(durations: readonly number[], count: number): number | null {
  if (durations.length === 0 || count <= 0) return null
  const mean = durations.reduce((sum, ms) => sum + ms, 0) / durations.length
  return Math.max(1, Math.round((mean * count) / 60_000))
}

export function aboutMinutes(minutes: number): string {
  return minutes < 60 ? `about ${String(minutes)} min` : `about ${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)} h`
}

/** "11 selected · about 15 min" — the estimate only when there is data for it. */
export function selectionLine(count: number, durations: readonly number[]): string {
  const minutes = estimateMinutes(durations, count)
  return `${String(count)} selected` + (minutes === null ? '' : ` · ${aboutMinutes(minutes)}`)
}

/** A drifted batch the reader started from the panel (kept in memory only). */
export interface DriftBatch {
  root: string
  modules: string[]
  startedAt: number
}

export type DriftBatchState = 'reading' | 'next' | 'waiting' | 'updated' | 'not-updated'

export interface DriftBatchItem {
  module: string
  state: DriftBatchState
  /** "reading now", "next", "waiting · 3rd", "updated", "not updated". */
  label: string
  notedAt?: string
}

export interface DriftBatchView {
  total: number
  done: number
  outstanding: number
  /** Nothing of the batch is reading or waiting any more. */
  finished: boolean
  /** "10 of 31 updated · about 25 min left". */
  line: string
  percent: number
  items: DriftBatchItem[]
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${String(n)}th`
  const suffix = n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'
  return `${String(n)}${suffix}`
}

/**
 * Where a batch stands, from the learning-state rows and whether the learner
 * still has work for the project (`busy`). A module still marked drifted
 * while the learner is busy is waiting (its queued mark may not be written
 * yet); once the learner is idle it was not updated (failed or stopped).
 * Waiting order is the order the batch was queued in — the learner runs one
 * pass at a time, first in first out.
 */
export function driftBatchView(batch: DriftBatch, rows: readonly LearnModuleRow[], busy: boolean, durations: readonly number[] = []): DriftBatchView {
  const status = new Map(rows.map((row) => [row.module, row]))
  const reading: DriftBatchItem[] = []
  const waiting: string[] = []
  const updated: DriftBatchItem[] = []
  const missed: DriftBatchItem[] = []
  for (const module of batch.modules) {
    const row = status.get(module)
    const state = row?.status
    if (state === 'learning') reading.push({ module, state: 'reading', label: 'reading now' })
    else if (state === 'queued' || ((state === 'stale' || state === 'none') && busy)) waiting.push(module)
    else if (state === 'learned') updated.push({ module, state: 'updated', label: 'updated', notedAt: row?.notedAt })
    else missed.push({ module, state: 'not-updated', label: 'not updated', notedAt: row?.notedAt })
  }
  const waitingItems = waiting.map((module, index): DriftBatchItem => {
    const place = reading.length + index + 1
    if (index === 0) return { module, state: 'next', label: 'next' }
    return { module, state: 'waiting', label: `waiting · ${ordinal(place)}` }
  })
  updated.sort((a, b) => (b.notedAt ?? '').localeCompare(a.notedAt ?? ''))
  const total = batch.modules.length
  const done = updated.length
  const outstanding = reading.length + waiting.length
  const minutes = estimateMinutes(durations, outstanding)
  const line = `${String(done)} of ${String(total)} updated` + (outstanding > 0 && minutes !== null ? ` · ${aboutMinutes(minutes)} left` : '')
  return {
    total,
    done,
    outstanding,
    finished: outstanding === 0,
    line,
    percent: total === 0 ? 0 : (done / total) * 100,
    items: [...reading, ...waitingItems, ...updated, ...missed],
  }
}

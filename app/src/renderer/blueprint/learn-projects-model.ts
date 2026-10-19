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
import type { LearnModuleRow, LearnProgress } from './learn-progress-model'

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

export type ModuleGroupKey = 'now' | 'drift' | 'todo' | 'done' | 'ignored'

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
): ModuleGroup[] {
  const needle = filter.trim().toLowerCase()
  const matching = progress.rows.filter((row) => needle === '' || row.module.toLowerCase().includes(needle))
  const rows = matching.filter((row) => row.status !== 'ignored')
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

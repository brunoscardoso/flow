/**
 * THE RUN MENU'S "NEW TERMINAL" SECTION (user decision 2026-11-24): the
 * terminal header's + button is gone, and opening a terminal is the first
 * thing the Run menu offers.
 *
 * - Several projects in reach: one row per project, one click each, AT MOST
 *   three of them — the conversation's own project, then the projects a
 *   terminal was opened in most recently, then scope order. The rest sit
 *   behind "More projects", which swaps the menu for the whole list with a
 *   filter box.
 * - One project (or none known yet): "New terminal" and "Split terminal".
 * - Split always names the project it opens in: the focused terminal's.
 *
 * Pure: the panel supplies what it knows, the view draws what this returns.
 */

/** The most projects the menu lists before "More projects". */
export const RUN_MENU_MAX_PROJECTS = 3

export const RUN_MENU_TERMINAL_STRINGS = {
  heading: 'New terminal',
  newTerminal: 'New terminal',
  splitTerminal: 'Split terminal',
  more: 'More projects',
  thisConversation: 'this conversation',
  allHeading: 'New terminal in',
  back: 'Back',
  filter: 'Find a project',
  noMatch: 'No project matches',
} as const

export interface RunMenuProject {
  rootPath: string
  name: string
}

export interface RunMenuSplit {
  /** "Split beside api-core", or "Split terminal" with one project. */
  label: string
  /** Why it cannot split now; null when it can. */
  disabledReason: string | null
}

export type RunMenuTerminals =
  | {
      mode: 'single'
      split: RunMenuSplit | null
    }
  | {
      mode: 'projects'
      /** The rows shown in the menu itself, at most RUN_MENU_MAX_PROJECTS. */
      shown: RunMenuProject[]
      /** How many more sit behind "More projects" (0: no such row). */
      more: number
      /** Every project, for the "More projects" view: the shown ones first, then by name. */
      all: RunMenuProject[]
      /** The conversation's own project — marked "this conversation". */
      conversationRoot: string | null
      split: RunMenuSplit | null
    }

export interface RunMenuTerminalsInput {
  /** The projects a terminal can open in, conversation's own first; null or fewer than two → single. */
  projects: readonly RunMenuProject[] | null
  /** Roots a terminal was opened in, most recent first. */
  recent: readonly string[]
  /** The focused terminal's project, null when no terminal is focused. */
  focusedRoot: string | null
  /** The focused terminal's project name, for the split label. */
  focusedName: string | null
  /** True when a terminal is focused at all (a split needs one). */
  hasFocused: boolean
  /** Why the focused terminal cannot be split (no room), or null. */
  splitBlocked: string | null
}

function splitRow(input: RunMenuTerminalsInput, named: boolean): RunMenuSplit | null {
  if (!input.hasFocused) return null
  const label =
    named && input.focusedName !== null && input.focusedName !== ''
      ? `Split beside ${input.focusedName}`
      : RUN_MENU_TERMINAL_STRINGS.splitTerminal
  return { label, disabledReason: input.splitBlocked }
}

export function runMenuTerminals(input: RunMenuTerminalsInput): RunMenuTerminals {
  const projects = dedupe(input.projects ?? [])
  if (projects.length < 2) return { mode: 'single', split: splitRow(input, false) }

  const conversation = projects[0]!
  const byRoot = new Map(projects.map((project) => [project.rootPath, project]))
  const shown: RunMenuProject[] = [conversation]
  const take = (rootPath: string): void => {
    if (shown.length >= RUN_MENU_MAX_PROJECTS) return
    const project = byRoot.get(rootPath)
    if (project !== undefined && !shown.includes(project)) shown.push(project)
  }
  for (const rootPath of input.recent) take(rootPath)
  for (const project of projects) take(project.rootPath)

  const rest = projects
    .filter((project) => !shown.includes(project))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return {
    mode: 'projects',
    shown,
    more: rest.length,
    all: [...shown, ...rest],
    conversationRoot: conversation.rootPath,
    split: splitRow(input, true),
  }
}

/** The "More projects" filter: every word typed must appear in the name (any case). */
export function filterRunMenuProjects(all: readonly RunMenuProject[], query: string): RunMenuProject[] {
  const words = query.toLowerCase().split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return [...all]
  return all.filter((project) => {
    const name = project.name.toLowerCase()
    return words.every((word) => name.includes(word))
  })
}

/** Remember a root a terminal was opened in: most recent first, each once, bounded. */
export function rememberRecentRoot(recent: readonly string[], rootPath: string, limit = 20): string[] {
  return [rootPath, ...recent.filter((entry) => entry !== rootPath)].slice(0, limit)
}

function dedupe(projects: readonly RunMenuProject[]): RunMenuProject[] {
  const seen = new Set<string>()
  const out: RunMenuProject[] = []
  for (const project of projects) {
    if (seen.has(project.rootPath)) continue
    seen.add(project.rootPath)
    out.push(project)
  }
  return out
}

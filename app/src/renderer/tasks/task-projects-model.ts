/**
 * WHICH PROJECTS A TASK IS ABOUT — the picker a remote ticket asks, and a
 * card's "Change". DOM-free (node jest tests it; task-projects-picker.ts draws it).
 *
 * A ticket from the remote column was written outside Flow and says nothing
 * about which code it touches, so NOTHING IS TICKED FOR YOU: the list starts
 * empty and the add buttons stay off until a person ticks one. The FIRST
 * ticked project is where the task's chat runs ("starts here"); the others
 * join it as context. Only a project with a checkout open in Flow can be
 * ticked — the others are listed with the reason they cannot.
 */

import type { WorkspaceListing } from '../../shared/workspaces-contract'

/** One row of the picker. `root` is null for a project with no checkout here. */
export interface PickerProject {
  /** The app's own root for the project (what a task and a thread name), or null. */
  root: string | null
  name: string
  /** Why it cannot be ticked, or null when it can. */
  unavailableReason: string | null
}

export interface PickerRow {
  /** The project's root when tickable; the row's key is its name otherwise. */
  root: string | null
  name: string
  checked: boolean
  disabled: boolean
  /** "starts here" on the first ticked; the reason on an unavailable one; '' otherwise. */
  note: string
}

export const PROJECTS_SECTION_LABEL = 'Projects for this task'
export const PROJECTS_HINT = 'Pick the projects this ticket is about. Nothing is ticked for you.'
export const NEED_A_PROJECT = 'Tick at least one project'
export const STARTS_HERE = 'starts here'
export const NOT_ON_THIS_COMPUTER = 'Not on this computer'
export const NOT_OPEN_IN_FLOW = 'Not open in Flow'

/**
 * The picker's projects: the Workspace's, in the Workspace's order, each with
 * its open root (or why it has none). Outside a Workspace, the board's own
 * projects. A root open in Flow that the listing does not name is kept too —
 * the board draws its cards, so it must be choosable.
 */
export function pickerProjects(input: {
  workspace: WorkspaceListing | null
  /** The app's root for a Workspace project, when Flow has it open. */
  registeredRoot: (workspaceSlug: string, projectId: string) => string | null
  /** The board's roots (the Workspace's open projects, or the active one). */
  boardRoots: readonly string[]
  nameOf: (root: string) => string
}): PickerProject[] {
  const projects: PickerProject[] = []
  const seen = new Set<string>()
  if (input.workspace !== null) {
    for (const project of input.workspace.projects) {
      const root = input.registeredRoot(input.workspace.slug, project.id)
      if (root !== null) seen.add(root)
      projects.push({
        root,
        name: project.name,
        unavailableReason: root !== null ? null : project.localPath === null ? NOT_ON_THIS_COMPUTER : NOT_OPEN_IN_FLOW,
      })
    }
  }
  for (const root of input.boardRoots) {
    if (seen.has(root)) continue
    seen.add(root)
    projects.push({ root, name: input.nameOf(root), unavailableReason: null })
  }
  return projects
}

/** Tick or untick one project. Order is the order ticked: the first one starts the chat. */
export function togglePicked(picked: readonly string[], root: string): string[] {
  return picked.includes(root) ? picked.filter((entry) => entry !== root) : [...picked, root]
}

/** Keep only what can still be ticked (a project closed since, for instance). */
export function pickableOnly(projects: readonly PickerProject[], picked: readonly string[]): string[] {
  const pickable = new Set(projects.filter((p) => p.root !== null && p.unavailableReason === null).map((p) => p.root))
  return picked.filter((root, index) => pickable.has(root) && picked.indexOf(root) === index)
}

export function pickerRows(projects: readonly PickerProject[], picked: readonly string[]): PickerRow[] {
  const first = picked[0] ?? null
  return projects.map((project) => {
    const tickable = project.root !== null && project.unavailableReason === null
    const checked = tickable && project.root !== null && picked.includes(project.root)
    let note = ''
    if (!tickable) note = project.unavailableReason ?? NOT_OPEN_IN_FLOW
    else if (project.root === first) note = STARTS_HERE
    return { root: project.root, name: project.name, checked, disabled: !tickable, note }
  })
}

/** "2 of 4 in this Workspace" — or "of the projects here" outside one. */
export function pickerCount(projects: readonly PickerProject[], picked: readonly string[], inWorkspace: boolean): string {
  const total = projects.length
  return inWorkspace ? `${picked.length} of ${total} in this Workspace` : `${picked.length} of ${total} here`
}

export function canSubmitProjects(picked: readonly string[]): boolean {
  return picked.length > 0
}

/** The line under the buttons: what is missing, or nothing. */
export function submitNeed(picked: readonly string[]): string {
  return canSubmitProjects(picked) ? '' : NEED_A_PROJECT
}

/** The create request's halves: where the chat runs, and the context. */
export function splitPicked(picked: readonly string[]): { projectRoot: string; additionalRoots: string[] } | null {
  const [projectRoot, ...additionalRoots] = picked
  if (projectRoot === undefined) return null
  return { projectRoot, additionalRoots }
}

/**
 * Whether a card may still change its task's projects: its chat exists and has
 * not started. After that the chat's own chips are where its projects change.
 */
export function projectsEditable(thread: { sdkSessionId: string | null; status: string } | null): boolean {
  if (thread === null) return false
  return thread.sdkSessionId === null && thread.status === 'idle'
}

/** What a card draws for its task's projects. */
export type CardProjectsView =
  | { kind: 'chips'; chips: Array<{ root: string; name: string }>; change: boolean }
  | { kind: 'add' }
  | { kind: 'none' }

export const CHANGE_LABEL = 'Change'
export const ADD_PROJECTS_LABEL = 'Add projects'

/**
 * A card's projects: chips (with "Change" until its chat starts) for a task
 * whose projects a person chose; "Add projects" on a tracker ticket nobody has
 * chosen any for yet, while it can still change; nothing otherwise (the card's
 * project line says where it is).
 */
export function cardProjectsView(input: {
  projectRoot: string
  extraRoots: readonly string[]
  chosen: boolean
  fromTracker: boolean
  editable: boolean
  nameOf: (root: string) => string
}): CardProjectsView {
  if (input.chosen) {
    const roots = [...new Set([input.projectRoot, ...input.extraRoots])]
    return {
      kind: 'chips',
      chips: roots.map((root) => ({ root, name: input.nameOf(root) })),
      change: input.editable,
    }
  }
  if (input.fromTracker && input.editable) return { kind: 'add' }
  return { kind: 'none' }
}

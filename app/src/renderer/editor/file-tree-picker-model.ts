/**
 * THE FILES PANEL IN A WORKSPACE — tree or picker. DOM-free.
 *
 * A thread selected → its projects' trees (the thread scope already says
 * which). No thread selected, in a Workspace → there is no single project the
 * panel can honestly claim to be "the" one, so it asks: an empty state listing
 * the Workspace's projects, one press away from a tree. The press is a choice
 * the panel keeps until a thread is selected again.
 *
 * Outside a Workspace, or with Workspaces off, nothing changes: the panel shows
 * the active project's tree as it always has.
 */

import { UNAVAILABLE_TAG } from '../threads/workspace-switcher-model'

export interface PickerProject {
  root: string
  name: string
  available: boolean
}

export type FilesPanelMode = { kind: 'tree' } | { kind: 'picker'; projects: PickerProject[] }

export function filesPanelMode(input: {
  inWorkspace: boolean
  /** The thread the scope belongs to, or null when no thread is selected. */
  scopeThreadId: string | null
  /** The roots the scope would show. */
  scopeRoots: readonly string[]
  /** The project the person picked from this panel, if any. */
  picked: string | null
  projects: readonly PickerProject[]
}): FilesPanelMode {
  if (!input.inWorkspace || input.scopeThreadId !== null) return { kind: 'tree' }
  if (input.picked !== null && input.scopeRoots.includes(input.picked)) return { kind: 'tree' }
  return { kind: 'picker', projects: [...input.projects] }
}

export const PICKER_TITLE = 'Choose a project to browse'
export const PICKER_EMPTY = 'None of this Workspace’s projects are open in Flow yet'
export const PICKER_UNAVAILABLE = UNAVAILABLE_TAG

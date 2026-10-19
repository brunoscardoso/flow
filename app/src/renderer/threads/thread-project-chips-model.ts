/**
 * A THREAD'S PROJECTS, AS CHIPS — the decisions, without a DOM.
 *
 * Above the composer of a thread in a Workspace sits one chip per project the
 * conversation can read: its own project first (it is where the thread lives,
 * so it cannot be taken off), then every project it carries beyond that —
 * added by its first message (the context gate) or by the person. Those can
 * be removed at any time and others added with "+": a thread's projects are
 * never fixed (plan Intent).
 *
 * An OFFER is a later message's suggestion that another Workspace project is
 * needed. It is drawn as a suggestion chip ("Add Backend?") with its reason,
 * and nothing is attached until the person accepts.
 *
 * Named `thread-project-chips` rather than `context-chips`: that name already
 * belongs to the composer's pasted-selection badges.
 */

import type { ThreadContextOfferEvent, WorkspaceListing, WorkspaceProject } from '../../shared/workspaces-contract'
import { comparablePath } from './workspace-switcher-model'
import {
  LEARNING_CHIP_LABEL,
  LEARNING_FAILED_CHIP_LABEL,
  isLearningStatus,
  learningChipTitle,
  type BasicDiscoveryStatus,
} from '../../shared/basic-discovery'

export type ProjectChipSource = 'primary' | 'gate' | 'manual'

export interface ProjectChip {
  root: string
  name: string
  source: ProjectChipSource
  removable: boolean
  /** Hover text — what the chip is and what pressing its × does. */
  title: string
  /**
   * The project is still being learned (its basic discovery is queued,
   * running or failed): it is in the conversation's list but not yet in what
   * the agent reads — the chip says "Learning…" until it is.
   */
  learning: string | null
}

export interface ThreadProjectsInput {
  projectRoot: string
  additionalRoots: readonly string[]
}

function uniqueAdditional(thread: ThreadProjectsInput): string[] {
  const seen = new Set<string>([comparablePath(thread.projectRoot)])
  const out: string[] = []
  for (const root of thread.additionalRoots) {
    const key = comparablePath(root)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(root)
  }
  return out
}

/** What a learning chip says: still learning, or that it could not. */
function chipLabel(status: BasicDiscoveryStatus | null): string | null {
  if (status === null) return null
  return status === 'failed' ? LEARNING_FAILED_CHIP_LABEL : LEARNING_CHIP_LABEL
}

/** The chips for one thread: its own project, then the ones it carries. */
export function threadProjectChips(input: {
  thread: ThreadProjectsInput
  /** Roots the context gate added (from `threads:contextChosen`). */
  gateAdded: ReadonlySet<string>
  name: (root: string) => string
  /** Each project's basic-discovery status, when known. */
  status?: (root: string) => BasicDiscoveryStatus | null
}): ProjectChip[] {
  const learningOf = (root: string): BasicDiscoveryStatus | null => {
    const status = input.status?.(root) ?? null
    return isLearningStatus(status) ? status : null
  }
  const primaryName = input.name(input.thread.projectRoot)
  const primaryLearning = learningOf(input.thread.projectRoot)
  const chips: ProjectChip[] = [
    {
      root: input.thread.projectRoot,
      name: primaryName,
      source: 'primary',
      removable: false,
      title:
        primaryLearning === null
          ? `${primaryName} — this conversation's own project`
          : learningChipTitle(primaryName, primaryLearning === 'failed'),
      learning: chipLabel(primaryLearning),
    },
  ]
  const gate = new Set([...input.gateAdded].map(comparablePath))
  for (const root of uniqueAdditional(input.thread)) {
    const name = input.name(root)
    const fromGate = gate.has(comparablePath(root))
    const learning = learningOf(root)
    chips.push({
      root,
      name,
      source: fromGate ? 'gate' : 'manual',
      removable: true,
      title: additionalChipTitle(name, fromGate, learning),
      learning: chipLabel(learning),
    })
  }
  return chips
}

/** The hover text of a project the thread carries beyond its own. */
function additionalChipTitle(name: string, fromGate: boolean, learning: BasicDiscoveryStatus | null): string {
  if (learning !== null) return learningChipTitle(name, learning === 'failed')
  if (fromGate) return `${name} — added from your first message. Remove it to stop sharing it with this conversation.`
  return `${name} — remove it to stop sharing it with this conversation.`
}

/** A project the "+" can add: a Workspace project with a checkout here, not already in. */
export interface AddableProject {
  root: string
  name: string
}

export function addableProjects(input: {
  workspace: WorkspaceListing | null
  thread: ThreadProjectsInput
  /**
   * The app's own root for a Workspace project, when the app has it OPEN — the
   * registry's membership answer. A project with none is not offered: a thread
   * may only carry a project Flow has open (the attach is refused otherwise).
   */
  registeredRoot: (project: WorkspaceProject) => string | null
}): AddableProject[] {
  if (input.workspace === null) return []
  const inContext = new Set(
    [input.thread.projectRoot, ...input.thread.additionalRoots].map(comparablePath),
  )
  const out: AddableProject[] = []
  for (const project of input.workspace.projects) {
    const root = input.registeredRoot(project)
    if (root === null) continue
    if (inContext.has(comparablePath(root))) continue
    inContext.add(comparablePath(root))
    out.push({ root, name: project.name })
  }
  return out
}

/** The thread's new additional set after adding `root` (the primary is never included). */
export function rootsAfterAdd(thread: ThreadProjectsInput, root: string): string[] {
  return uniqueAdditional({ ...thread, additionalRoots: [...thread.additionalRoots, root] })
}

/** The thread's new additional set after removing `root`. */
export function rootsAfterRemove(thread: ThreadProjectsInput, root: string): string[] {
  const gone = comparablePath(root)
  return uniqueAdditional(thread).filter((candidate) => comparablePath(candidate) !== gone)
}

export interface OfferChip {
  root: string
  label: string
  reason: string
  /** Accept / dismiss — named for what they do. */
  acceptLabel: string
  dismissLabel: string
}

/**
 * The suggestion chip for a pending offer, or null when there is none to show
 * (no offer, an offer for another thread, or a project already in).
 */
export function offerChip(
  offer: ThreadContextOfferEvent | null,
  threadId: string,
  thread: ThreadProjectsInput,
): OfferChip | null {
  if (offer === null || offer.threadId !== threadId) return null
  const inContext = new Set(
    [thread.projectRoot, ...thread.additionalRoots].map(comparablePath),
  )
  if (inContext.has(comparablePath(offer.project.root))) return null
  return {
    root: offer.project.root,
    label: `Add ${offer.project.name}?`,
    reason: offer.reason,
    acceptLabel: `Add ${offer.project.name} to this conversation`,
    dismissLabel: 'Not now',
  }
}

/** Whether the chips show at all: a thread whose project is in a Workspace. */
export function chipsVisible(input: { inWorkspace: boolean; hasThread: boolean }): boolean {
  return input.inWorkspace && input.hasThread
}

/**
 * Whether the next send tells main the person hand-picked this thread's
 * projects, so the first message does not ask the fast model again. Only
 * before the thread's first turn — after it the gate never runs anyway.
 */
export function skipGateOnSend(input: { handPicked: boolean; hasStarted: boolean }): boolean {
  return input.handPicked && !input.hasStarted
}

export const ADD_PROJECT_LABEL = 'Add a project to this conversation'
export const NOTHING_TO_ADD = 'Every project of this Workspace is already here'

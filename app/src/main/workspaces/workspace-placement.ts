/**
 * EVERY PROJECT LIVES IN A WORKSPACE — the first launch's migration and the
 * placing of every project added after it (decision 2026-10-06,
 * workspaces-hard-migration).
 *
 *   · FIRST LAUNCH (and every later one, for whatever is still outside): once
 *     every registered project's provisioning has settled, ONE `workspace
 *     migrate` moves every project that is in no Workspace into the Default
 *     one, copying its knowledge in and keeping the old copy as a backup. One
 *     plain notification says so. Idempotent: a launch with nothing outside
 *     (and a Default Workspace already here) asks the CLI nothing further.
 *   · A PROJECT ADDED LATER joins the Workspace the person chose, or the
 *     current one: `workspace link --import` right after provisioning.
 *   · A COMMITTED knowledge folder is the one exception: moving it in renames
 *     it in one commit of the project's own history, so it waits — a card per
 *     project shows the commit message and offers "Move it in"; only that
 *     press passes `--confirm-commit` (forbidden-pattern #15).
 *   · A project that could not move stays where it was, is listed under
 *     "Needs attention" in the switcher, and is named in ONE notification.
 *
 * NEVER BLOCKS THE WINDOW. Everything here is async, spawned through the
 * registry (allowed-pattern #19); the caller never awaits it on a path a
 * person is waiting on.
 *
 * WHAT A PERSON READS. Project names (a folder's own name) and Workspace
 * names are data; every sentence around them lives here and names no path,
 * command or setting (forbidden-pattern #12). The CLI's own `detail` is for a
 * terminal and stays in the log.
 */

import { basename } from 'node:path'

import type { FlowNotification } from '../../shared/ipc-contract'
import { WORKSPACE_REFUSAL_SENTENCES } from '../../shared/workspace-refusals'
import type {
  WorkspaceAnswer,
  WorkspaceLinkResult,
  WorkspacePendingCommit,
  WorkspacePlacementIssue,
  WorkspacePlacementState,
  WorkspaceRefusalReason,
} from '../../shared/workspaces-contract'
import type { WorkspaceRegistry } from './workspace-registry'

/** The renderer event a pending project's "Move it in" dispatches (detail: `{ root }`). */
export const WORKSPACE_MOVE_IN_EVENT = 'flow:workspace-move-in'

/** The notifications' chip when no project or Workspace is the subject. */
const WORKSPACES_LABEL = 'Workspaces'

export const MIGRATED_TITLE = 'Your projects are in a Workspace'
export const MOVE_IN_LABEL = 'Move it in'
export const FAILED_TITLE = "Some projects couldn't move into a Workspace"
export const UNREADY_TITLE = "Flow couldn't set up your Workspace"
export const UNREADY_BODY =
  'Your projects keep working as they are. Flow tries again the next time it starts.'
const GENERIC_FAILURE = "Flow couldn't move its knowledge in."

export function migratedBody(workspaceName: string): string {
  return `Your projects now live in the ${workspaceName} Workspace. Their knowledge came along; the old copies are kept as backups.`
}

export function pendingTitle(projectName: string, workspaceName: string): string {
  return `Move ${projectName} into ${workspaceName}?`
}

/** The body of a pending project's card: why it waits, and the commit it would take. */
export function pendingBody(commit: WorkspacePendingCommit): string {
  const count = commit.files === 1 ? '1 file' : `${commit.files} files`
  // eslint-disable-next-line no-control-regex -- control characters never reach a screen
  const message = commit.message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
  const base = `Its knowledge is part of the project's own history, so moving it in sets the old folder aside in one commit of ${count}. Nothing is deleted.`
  return message === '' ? base : `${base} The commit will say: “${message}”`
}

/** A plain reason for a project that could not move — never the CLI's own sentence. */
export function failureReason(reason: string): string {
  return (WORKSPACE_REFUSAL_SENTENCES as Record<string, string | undefined>)[reason] ?? GENERIC_FAILURE
}

/**
 * Why ONE project did not move in, in a sentence that names it — each refusal
 * its own words (the generic "try again" said nothing a person could act on).
 * No paths, commands or setting names (forbidden-pattern #12).
 */
export function placementProblem(reason: string, name: string): string {
  switch (reason) {
    case 'dirty-code':
      return `Some knowledge files in ${name} have changes that aren't committed yet. Commit them first, then move it in.`
    case 'committed-flow':
      return `${name} keeps its knowledge in its own history, so moving it in takes one commit — it needs your go-ahead.`
    case 'commit-failed':
      return `Flow couldn't make the commit that sets ${name}'s old knowledge aside, so nothing changed. Try again in a moment.`
    case 'sync-busy':
      return `${name}'s Workspace was syncing. Try again in a moment.`
    case 'failed':
    case 'unavailable':
      return `Flow couldn't move ${name}'s knowledge in. Try again in a moment.`
    default: {
      const sentence = (WORKSPACE_REFUSAL_SENTENCES as Record<string, string | undefined>)[reason]
      return sentence === undefined ? `Flow couldn't move ${name}'s knowledge in. Try again in a moment.` : `${name}: ${sentence}`
    }
  }
}

export function failedBody(issues: ReadonlyArray<{ name: string; reason: string }>): string {
  return issues.map((issue) => issue.reason).join(' ')
}

/** A folder's own name — what a project is called before a Workspace names it. */
export function projectName(root: string): string {
  return basename(root.replace(/[\\/]+$/, '')) || root
}

export interface WorkspacePlacementDeps {
  registry: Pick<WorkspaceRegistry, 'list' | 'membershipOf' | 'migrate' | 'link' | 'current' | 'invalidate'>
  /** The registered project roots reachable on this computer, in sidebar order. */
  roots: () => string[]
  /** Raise one notification (a toast; an actionable one stays). */
  notify: (notification: FlowNotification) => void
  /** Something about which projects need attention changed (broadcast `workspaces:changed`). */
  onChanged: () => void
  log?: (message: string, details: Record<string, unknown>) => void
  now?: () => string
}

export interface WorkspacePlacement {
  /**
   * The launch's migration: move every project outside a Workspace in. Call
   * once every root's provisioning has settled; later calls share the first run.
   */
  start(): Promise<void>
  /**
   * A project was added or opened: put it in `workspace` (or the current one)
   * when it is in none. Waits for the launch's migration first.
   */
  place(root: string, workspace?: string): Promise<void>
  /** A person pressed "Move it in" on a pending project: the one confirmed commit. */
  moveIn(root: string): Promise<WorkspaceAnswer<WorkspaceLinkResult>>
  /** Try a project that could not move again. */
  retry(root: string): Promise<void>
  /** What the switcher's "Needs attention" rows draw. */
  state(): WorkspacePlacementState
  /** A project left the app. */
  forget(root: string): void
}

export function createWorkspacePlacement(deps: WorkspacePlacementDeps): WorkspacePlacement {
  const log = deps.log ?? ((message: string, details: Record<string, unknown>) => console.warn(`[Workspaces] ${message}`, details))
  const now = deps.now ?? (() => new Date().toISOString())
  const issues = new Map<string, WorkspacePlacementIssue>()
  /** Pending cards already raised this session — one card per project, not one per launch step. */
  const announced = new Set<string>()
  let migrating = true
  let started: Promise<void> | null = null
  /** Placements run one at a time: two links racing would both rewrite one Workspace file. */
  let queue: Promise<unknown> = Promise.resolve()

  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }

  function setIssue(issue: WorkspacePlacementIssue): void {
    issues.set(issue.root, issue)
  }

  function clearIssue(root: string): boolean {
    return issues.delete(root)
  }

  function pendingCard(issue: Extract<WorkspacePlacementIssue, { kind: 'pending' }>): void {
    if (announced.has(issue.root)) return
    announced.add(issue.root)
    deps.notify({
      kind: 'state-change',
      rootId: issue.root,
      label: issue.name,
      title: pendingTitle(issue.name, issue.workspaceName),
      body: pendingBody(issue.commit),
      timestamp: now(),
      level: 'info',
      action: { label: MOVE_IN_LABEL, event: WORKSPACE_MOVE_IN_EVENT, detail: { root: issue.root } },
    })
  }

  function failedNotice(failed: ReadonlyArray<{ name: string; reason: string }>): void {
    if (failed.length === 0) return
    deps.notify({
      kind: 'state-change',
      rootId: 'workspaces',
      label: WORKSPACES_LABEL,
      title: FAILED_TITLE,
      body: failedBody(failed),
      timestamp: now(),
      level: 'warn',
    })
  }

  async function workspaceName(slug: string): Promise<string> {
    const listed = await deps.registry.list()
    if (!listed.ok) return slug
    return listed.workspaces.find((workspace) => workspace.slug === slug)?.name ?? slug
  }

  /** The roots in no Workspace (an unanswered membership read counts as none known — nothing to do). */
  async function outsideOf(roots: readonly string[]): Promise<string[] | null> {
    if (roots.length === 0) return []
    const answer = await deps.registry.membershipOf(roots)
    if (!answer.ok) return null
    return answer.roots.filter((entry) => entry.workspace === null).map((entry) => entry.root)
  }

  async function migrateNow(): Promise<void> {
    const roots = deps.roots()
    const listed = await deps.registry.list()
    if (!listed.ok) {
      log('the launch migration could not read the Workspaces', { reason: listed.reason })
      if (roots.length > 0) {
        deps.notify({
          kind: 'state-change',
          rootId: 'workspaces',
          label: WORKSPACES_LABEL,
          title: UNREADY_TITLE,
          body: UNREADY_BODY,
          timestamp: now(),
          level: 'warn',
        })
      }
      return
    }
    const outside = await outsideOf(roots)
    if (outside === null) return
    const hasDefault = listed.workspaces.some((workspace) => workspace.isDefault)
    if (outside.length === 0 && hasDefault) return
    const answer = await deps.registry.migrate({ roots: outside })
    if (!answer.ok) {
      log('the launch migration was refused', { reason: answer.reason })
      const failed = outside.map((root) => ({ root, name: projectName(root), reason: placementProblem(answer.reason, projectName(root)) }))
      for (const entry of failed) setIssue({ kind: 'failed', ...entry })
      failedNotice(failed)
      return
    }
    const workspace = answer.workspace
    if (answer.migrated.length > 0) {
      deps.notify({
        kind: 'state-change',
        rootId: `workspace:${workspace.slug}`,
        label: workspace.name,
        title: MIGRATED_TITLE,
        body: migratedBody(workspace.name),
        timestamp: now(),
        level: 'info',
      })
    }
    for (const entry of [...answer.migrated.map((moved) => moved.root), ...answer.unchanged]) clearIssue(entry)
    for (const pending of answer.pending) {
      const issue = {
        kind: 'pending' as const,
        root: pending.root,
        name: projectName(pending.root),
        workspace: workspace.slug,
        workspaceName: workspace.name,
        commit: pending.commit,
        problem: null,
      }
      setIssue(issue)
      pendingCard(issue)
    }
    const failed = answer.failed.map((entry) => {
      // The CLI's detail is for a terminal (and can carry paths) — it stays in the log.
      log('a project could not move into the Workspace', { root: entry.root, reason: entry.reason, detail: entry.detail })
      return { root: entry.root, name: projectName(entry.root), reason: placementProblem(entry.reason, projectName(entry.root)) }
    })
    for (const entry of failed) setIssue({ kind: 'failed', ...entry })
    failedNotice(failed)
  }

  function start(): Promise<void> {
    if (started !== null) return started
    started = serial(async () => {
      try {
        await migrateNow()
      } catch (error) {
        log('the launch migration failed', { error: String(error) })
      } finally {
        migrating = false
        deps.registry.invalidate()
        deps.onChanged()
      }
    })
    return started
  }

  /** Link one root with its knowledge (the add flow, a retry, a confirmed move). */
  async function linkRoot(root: string, workspace: string, confirmCommit: boolean): Promise<WorkspaceAnswer<WorkspaceLinkResult>> {
    const answer = await deps.registry.link({
      repoPath: root,
      workspace,
      importKnowledge: true,
      ...(confirmCommit ? { confirmCommit: true } : {}),
    })
    if (answer.ok) {
      clearIssue(root)
      return answer
    }
    if (answer.reason === 'committed-flow' && !confirmCommit) {
      const raw = answer.payload['commit']
      const commit = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
      const files = commit['files']
      const issue = {
        kind: 'pending' as const,
        root,
        name: projectName(root),
        workspace,
        workspaceName: await workspaceName(workspace),
        commit: {
          message: typeof commit['message'] === 'string' ? commit['message'] : '',
          files: typeof files === 'number' && Number.isFinite(files) && files >= 0 ? files : 0,
          from: typeof commit['from'] === 'string' ? commit['from'] : '',
          to: typeof commit['to'] === 'string' ? commit['to'] : '',
        },
        problem: null,
      }
      setIssue(issue)
      pendingCard(issue)
      return answer
    }
    // A confirmed "Move it in" that did not finish keeps the project WAITING —
    // the row still offers "Move it in", now saying why the last try stopped.
    const waiting = issues.get(root)
    if (confirmCommit && waiting?.kind === 'pending') {
      setIssue({ ...waiting, problem: placementProblem(answer.reason, waiting.name) })
      return answer
    }
    const failed = { root, name: projectName(root), reason: placementProblem(answer.reason, projectName(root)) }
    setIssue({ kind: 'failed', ...failed })
    failedNotice([failed])
    return answer
  }

  async function placeNow(root: string, preferred: string | undefined): Promise<void> {
    const outside = await outsideOf([root])
    if (outside === null) return
    if (outside.length === 0) {
      if (clearIssue(root)) deps.onChanged()
      return
    }
    // A project already waiting on a person's go-ahead is not asked again on every open.
    if (issues.get(root)?.kind === 'pending') return
    let target = preferred ?? null
    if (target === null) {
      const current = await deps.registry.current()
      target = current.ok ? current.slug : null
    }
    if (target === null) {
      // No Workspace here at all: the migration makes the Default one with this project in it.
      const answer = await deps.registry.migrate({ roots: [root] })
      if (!answer.ok) {
        const failed = { root, name: projectName(root), reason: placementProblem(answer.reason, projectName(root)) }
        setIssue({ kind: 'failed', ...failed })
        failedNotice([failed])
      } else {
        clearIssue(root)
        for (const pending of answer.pending) {
          const issue = {
            kind: 'pending' as const,
            root: pending.root,
            name: projectName(pending.root),
            workspace: answer.workspace.slug,
            workspaceName: answer.workspace.name,
            commit: pending.commit,
            problem: null,
          }
          setIssue(issue)
          pendingCard(issue)
        }
      }
      deps.onChanged()
      return
    }
    await linkRoot(root, target, false)
    deps.onChanged()
  }

  function place(root: string, workspace?: string): Promise<void> {
    const before = started ?? Promise.resolve()
    return before.then(() =>
      serial(async () => {
        try {
          await placeNow(root, workspace)
        } catch (error) {
          log('placing a project in a Workspace failed', { root, error: String(error) })
        }
      }),
    )
  }

  function moveIn(root: string): Promise<WorkspaceAnswer<WorkspaceLinkResult>> {
    return serial(async () => {
      const issue = issues.get(root)
      let workspace = issue?.kind === 'pending' ? issue.workspace : null
      if (workspace === null) {
        const current = await deps.registry.current()
        workspace = current.ok ? current.slug : null
      }
      if (workspace === null) {
        return { ok: false as const, reason: 'no-workspace' as WorkspaceRefusalReason, detail: failureReason('no-workspace'), payload: {} }
      }
      const answer = await linkRoot(root, workspace, true)
      deps.onChanged()
      return answer
    })
  }

  function retry(root: string): Promise<void> {
    const issue = issues.get(root)
    if (issue?.kind === 'failed') clearIssue(root)
    return place(root)
  }

  function state(): WorkspacePlacementState {
    const live = new Set(deps.roots())
    return {
      migrating,
      issues: [...issues.values()].filter((issue) => live.has(issue.root)),
    }
  }

  function forget(root: string): void {
    if (clearIssue(root)) deps.onChanged()
    announced.delete(root)
  }

  return { start, place, moveIn, retry, state, forget }
}

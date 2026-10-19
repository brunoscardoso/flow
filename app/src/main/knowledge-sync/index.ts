/**
 * KNOWLEDGE SYNC, ASSEMBLED — the Workspace sync engine and the helpers main
 * wires it with. Every project lives in a Workspace (decision 2026-10-06), so
 * the Workspace's sync is the only one: the per-project engine, its setup
 * flow and its host tools were removed with the hard migration.
 *
 * Flow holds no credential for knowledge sync: git, run by the CLI's
 * `workspace sync`, uses the access this machine already has.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import type { EngineTimers } from './sync-timing'
import {
  createWorkspaceSyncEngine,
  type LastSyncedStore,
  type TempText,
  type WorkspaceSyncCliRunner,
  type WorkspaceSyncEngine,
} from './workspace-sync-engine'
import type { WorkspaceSyncStatus } from '../../shared/workspaces-contract'

/** Node's timers, unref'd: a pending sync never holds the process open. */
export const realEngineTimers: EngineTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

// ── Workspace sync ──────────────────────────────────────────────────────────

/**
 * A merged text the person settled on, handed to the CLI as `file:<path>`:
 * written into a private temp folder of its own and removed afterwards. The
 * renderer never names a file — it sends the text.
 */
export async function writeTempText(text: string): Promise<TempText> {
  const folder = await mkdtemp(join(tmpdir(), 'flow-workspace-decision-'))
  const path = join(folder, 'merged.md')
  await writeFile(path, text, { encoding: 'utf8', mode: 0o600 })
  return { path, dispose: () => rm(folder, { recursive: true, force: true }) }
}

export interface WorkspaceSyncWiringDeps {
  /** The bundled CLI (`workspace sync`). */
  runCli: WorkspaceSyncCliRunner
  /** Where the verb runs — the person's home folder. */
  cwd: string
  /** Each Workspace's last complete sync time, kept across restarts (app settings rows). */
  lastSynced: LastSyncedStore
  /** The Workspace's display name for its slug (null when unknown). */
  nameOf: (slug: string) => Promise<string | null>
  /** A Workspace's status changed (broadcast it; raise the one notification a pause deserves). */
  onStatus: (slug: string, name: string | null, status: WorkspaceSyncStatus) => void
}

export function createWorkspaceSync(deps: WorkspaceSyncWiringDeps): WorkspaceSyncEngine {
  return createWorkspaceSyncEngine({
    runCli: deps.runCli,
    cwd: deps.cwd,
    lastSynced: deps.lastSynced,
    writeTempText,
    now: () => Date.now(),
    timers: realEngineTimers,
    nameOf: deps.nameOf,
    onStatus: deps.onStatus,
    log: (message, detail) => console.warn(`[WorkspaceSync] ${message}`, detail ?? {}),
  })
}

export { createKnowledgeRouter, createWorkspaceRoute, type KnowledgeRouter } from './router'

// ── Which project a conversation's work lands in ───────────────────────────

/**
 * The project a thread's knowledge belongs to. A thread's own checkout links
 * `flow/` to its project's (worktree.ts), so a turn there writes the PROJECT's
 * knowledge repo — committed and pushed from the project root, never from the
 * checkout, and never cloned a second time.
 */
export function projectRootOfThread(thread: { projectRoot: string; worktreePath?: string | null } | null): string | null {
  if (thread === null) return null
  return thread.projectRoot === '' ? null : thread.projectRoot
}

/** A skill invocation at the start of a message: `/execute-plan …` → `/execute-plan`. */
const SKILL_INVOCATION = /^\/([a-z][a-z0-9-]{0,63})(?=\s|$)/i

/**
 * The label a knowledge commit carries: the skill that ran, or "turn", and the
 * project's folder name. NEVER the thread title and never the message text —
 * a title can be private, and a commit message is published.
 */
export function commitLabelFor(projectRoot: string, lastUserMessage: string | null): string {
  const project = basename(projectRoot) || 'this project'
  const skill = lastUserMessage === null ? null : SKILL_INVOCATION.exec(lastUserMessage.trim())
  return skill === null ? `turn in ${project}` : `/${skill[1].toLowerCase()} in ${project}`
}

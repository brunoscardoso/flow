/**
 * THE SHARED MERGE REASONS — the Workspace's record of merge decisions and
 * why, for the review card's "Shared merge reasons" list.
 *
 * The CLI's `workspace merge-decision` is the ONE writer of that record
 * (allowed-pattern #14): `list` reads the live decisions, `remove` appends a
 * removal line (nothing is ever rewritten). This module only runs those two
 * verbs through the async CLI runner — never a synchronous spawn on main
 * (allowed-pattern #19) — and rebuilds the answer field by field into the
 * shared contract's shape. The CLI's own sentences go to the log; the
 * renderer only ever gets a plain sentence of ours.
 */
import type {
  WorkspaceMergeItemKind,
  WorkspaceMergeReason,
  WorkspaceMergeReasonsResult,
} from '../../shared/workspaces-contract'
import { lastJsonLine } from './cli-json'
import type { WorkspaceCliRunner } from './workspace-registry'

/** A list is one small file read; a removal one appended line. */
const LIST_TIMEOUT_MS = 20_000
const REMOVE_TIMEOUT_MS = 20_000

export const MERGE_REASONS_UNREADABLE = 'Flow could not read the shared merge reasons right now.'
export const MERGE_REASON_NOT_REMOVED = 'Flow could not remove that reason right now. Try again in a moment.'

const KINDS: readonly WorkspaceMergeItemKind[] = [
  'decision',
  'same-feature',
  'overlapping-anchors',
  'same-discovery',
  'conflict',
  'add-add',
  'modify-delete',
]

export interface MergeReasonsDeps {
  /** REQUIRED (allowed-pattern #26): the bundled CLI, async, never rejects. */
  runCli: WorkspaceCliRunner
  /** Where the verb runs (it names its Workspace) — the person's home folder. */
  cwd: string
  log?: (message: string, details: Record<string, unknown>) => void
}

export interface MergeReasons {
  list(slug: string): Promise<WorkspaceMergeReasonsResult>
  remove(slug: string, id: string): Promise<WorkspaceMergeReasonsResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One decision of the CLI's `list` answer, rebuilt — or null when it is not one. */
export function readMergeReason(entry: unknown): WorkspaceMergeReason | null {
  if (!isRecord(entry)) return null
  const { id, kind, project, path, take, summary, reason, outcome, author, ts } = entry
  if (typeof id !== 'string' || id === '' || typeof project !== 'string' || typeof path !== 'string') return null
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return null
  return {
    id,
    kind: kind as WorkspaceMergeItemKind,
    project,
    path,
    take: typeof take === 'string' ? take : '',
    summary: typeof summary === 'string' ? summary : '',
    reason: typeof reason === 'string' ? reason : '',
    outcome: outcome === 'disagreed' ? 'disagreed' : 'agreed',
    author: typeof author === 'string' && author.trim() !== '' ? author : null,
    ts: typeof ts === 'string' ? ts : '',
  }
}

export function createMergeReasons(deps: MergeReasonsDeps): MergeReasons {
  const log = deps.log ?? (() => {})

  async function list(slug: string): Promise<WorkspaceMergeReasonsResult> {
    const run = await deps.runCli(deps.cwd, ['workspace', 'merge-decision', 'list', '--workspace', slug, '--json'], {
      timeoutMs: LIST_TIMEOUT_MS,
    })
    const payload = lastJsonLine(run.stdout)
    const listed = payload?.['decisions']
    if (!run.ok || payload === null || payload['action'] !== 'merge-decision' || !Array.isArray(listed)) {
      log('the shared merge reasons could not be read', { slug, error: run.error, stderr: run.stderr?.slice(-500) })
      return { ok: false, detail: MERGE_REASONS_UNREADABLE }
    }
    const reasons = listed.flatMap((entry) => {
      const read = readMergeReason(entry)
      return read === null ? [] : [read]
    })
    // Newest first: what a person just recorded is what they look for.
    reasons.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
    return { ok: true, reasons }
  }

  async function remove(slug: string, id: string): Promise<WorkspaceMergeReasonsResult> {
    const run = await deps.runCli(deps.cwd, ['workspace', 'merge-decision', 'remove', '--id', id, '--workspace', slug, '--json'], {
      timeoutMs: REMOVE_TIMEOUT_MS,
    })
    const payload = lastJsonLine(run.stdout)
    if (!run.ok || payload === null || payload['action'] !== 'merge-decision' || payload['op'] !== 'remove') {
      log('a shared merge reason could not be removed', { slug, id, error: run.error, stderr: run.stderr?.slice(-500) })
      return { ok: false, detail: MERGE_REASON_NOT_REMOVED }
    }
    return list(slug)
  }

  return { list, remove }
}

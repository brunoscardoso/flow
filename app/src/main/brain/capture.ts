// Working-set capture (#52, Phase 2) — aggregate the files a thread touched into
// a raw record under flow/brain/.raw/. Reuses the tool_calls the app already
// persists (tool_name + input_json), so there is no new instrumentation.
//
// SAFETY (NFR5): we extract ONLY known path fields from a whitelist of file
// tools and store ONLY the root-relative path — never tool input content
// (`content`/`old_string`/…), never Bash commands, never absolute system paths.
// So no credential VALUE can ever land in .raw/. Obvious secret files (.env,
// keys) are additionally excluded from the working set as a path-level guard.

import { promises as fsPromises } from 'fs'
import { isAbsolute, join, relative, dirname } from 'path'

import type { BrainCaptureResult } from '../../shared/ipc-contract'
import { sessionRootFor } from '../project/session-root'
import { runCompaction } from './compaction'
import { BRAIN_SUBDIRS } from './store'
import type { RawWorkingSet, WorkingSetFile, WorkingSetRole } from './types'

/** Tools that mean "the agent changed this file". */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/** Tools that mean "the agent read this file". */
const READ_TOOLS = new Set(['Read'])

/** Files whose PATH we refuse to record, defence-in-depth for NFR5. */
const SECRET_PATH_PATTERN =
  /(^|\/)(\.env(\.[\w-]+)?|\.npmrc|id_[a-z]+|.*\.pem|.*\.key|.*credentials.*|.*secret.*)$/i

export interface ParsedToolCall {
  toolName: string
  input: Record<string, unknown>
}

/** A minimal view of a persisted tool call (what ThreadStore.listToolCallInputs returns). */
export interface RawToolCall {
  toolName: string
  inputJson: string | null
}

/** Parse persisted tool calls, dropping any with malformed/empty input JSON. */
export function parseToolCalls(records: readonly RawToolCall[]): ParsedToolCall[] {
  const parsed: ParsedToolCall[] = []
  for (const record of records) {
    if (!record.inputJson) continue
    try {
      const input = JSON.parse(record.inputJson) as unknown
      if (input && typeof input === 'object') {
        parsed.push({ toolName: record.toolName, input: input as Record<string, unknown> })
      }
    } catch {
      // Unparseable input — skip; a working set is best-effort, never a hard fail.
    }
  }
  return parsed
}

/** The path a file tool acted on, or null for non-file tools. */
function pathField(input: Record<string, unknown>): string | null {
  const candidate = input.file_path ?? input.notebook_path
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

function roleFor(toolName: string): WorkingSetRole | null {
  if (EDIT_TOOLS.has(toolName)) return 'edited'
  if (READ_TOOLS.has(toolName)) return 'read'
  return null
}

/** Root-relative POSIX path, or null when the file is outside the root. */
function toRootRelative(rootPath: string, filePath: string): string | null {
  const abs = isAbsolute(filePath) ? filePath : join(rootPath, filePath)
  const rel = relative(rootPath, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split('\\').join('/')
}

/**
 * Derive the deduped working set from a thread's tool calls. Pure and
 * DB-free: `edited` wins over `read` for the same file; files outside the root
 * or matching a secret pattern are dropped; the result is sorted for
 * determinism.
 */
export function deriveWorkingSet(
  rootPath: string,
  calls: readonly ParsedToolCall[],
): WorkingSetFile[] {
  const roles = new Map<string, WorkingSetRole>()
  for (const call of calls) {
    const role = roleFor(call.toolName)
    if (!role) continue
    const raw = pathField(call.input)
    if (!raw) continue
    const rel = toRootRelative(rootPath, raw)
    if (!rel || SECRET_PATH_PATTERN.test(rel)) continue
    // `edited` is stickier than `read`.
    if (roles.get(rel) === 'edited') continue
    roles.set(rel, role)
  }
  return [...roles.entries()]
    .map(([path, role]) => ({ path, role }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * A thread's working set, derived against the root its tool calls wrote in.
 * This is the ONE function both brain capture and the chat-learn prompt call,
 * because a thread has two roots with different jobs: its absolute paths live
 * under the WORK root (`sessionRootFor` — its own worktree when it has one),
 * while the brain belongs to the PROJECT root. Deriving against the project
 * root drops every path of a worktree thread; repo-relative paths are the same
 * in both checkouts, so this result is valid for the project's brain.
 * `toolCallPaths` is ThreadStore.listToolCallPaths — the projection, not the
 * inputs: a Write's input is the whole file it wrote.
 */
export function threadWorkingSet(
  thread: { projectRoot: string; worktreePath: string | null },
  toolCallPaths: ReadonlyArray<{ toolName: string; filePath: string | null }>,
): WorkingSetFile[] {
  return deriveWorkingSet(
    sessionRootFor(thread),
    toolCallPaths.map(({ toolName, filePath }) => ({
      toolName,
      input: filePath === null ? {} : { file_path: filePath },
    })),
  )
}

export interface CaptureDeps {
  /** Thread title, used as the feature title on promotion. */
  threadTitle: (threadId: string) => string
  /** ISO-8601 timestamp — injected so the store never reads the clock itself. */
  now: () => string
}

/** The slice of ThreadStore brain capture needs (structural — ThreadStore
 *  fits). PERF: capture derives the working set from tool NAMES + INPUTS only,
 *  so it reads the input-only projection — never the output blobs. */
export interface BrainThreadSource {
  getThread(
    id: string,
  ): { projectRoot: string; worktreePath: string | null; title: string } | null
  listToolCallPaths(id: string): Array<{ toolName: string; filePath: string | null }>
}

/**
 * Build an `onTurnComplete(threadId, success)` handler that captures the
 * thread's working set on a successful turn, then runs the compaction pass to
 * promote it into a queryable feature memory. Best-effort: neither step ever
 * propagates into the turn. `compactRoot` is injectable for tests.
 */
export function makeBrainCaptureOnTurnComplete(
  threads: BrainThreadSource,
  now: () => string = () => new Date().toISOString(),
  compactRoot: (rootPath: string) => Promise<unknown> = (rootPath) => runCompaction(rootPath),
  /** Test seam: receives the in-flight capture→compaction promise so a test can
   *  await it deterministically instead of polling (production omits it). */
  onWork?: (work: Promise<unknown>) => void,
): (threadId: string, success: boolean) => void {
  return (threadId, success) => {
    if (!success) return
    const thread = threads.getThread(threadId)
    if (!thread) return
    // Paths are read against the WORK root; the record and its compaction go
    // to the PROJECT root, whose brain the board and every query read.
    const work = captureThreadWorkingSet(
      { threadTitle: () => thread.title, now },
      thread.projectRoot,
      threadId,
      threadWorkingSet(thread, threads.listToolCallPaths(threadId)),
    )
      .then((result) => (result.captured ? compactRoot(thread.projectRoot) : undefined))
      .catch(() => undefined)
    onWork?.(work)
  }
}

/**
 * Capture a thread's working set to `<projectRoot>/flow/brain/.raw/<threadId>.json`.
 * `files` is already root-relative, derived against the WORK root
 * (`threadWorkingSet`); `projectRoot` only names whose brain receives it, so
 * one root never does both jobs. Writes nothing (and reports
 * `captured: false`) when the thread touched no files.
 */
export async function captureThreadWorkingSet(
  deps: CaptureDeps,
  projectRoot: string,
  threadId: string,
  files: WorkingSetFile[],
): Promise<BrainCaptureResult> {
  if (files.length === 0) {
    return { captured: false, fileCount: 0 }
  }
  const record: RawWorkingSet = {
    threadId,
    title: deps.threadTitle(threadId),
    files,
    capturedAt: deps.now(),
  }
  const rawRelPath = `${BRAIN_SUBDIRS.raw}/${threadId}.json`
  const absPath = join(projectRoot, rawRelPath)
  await fsPromises.mkdir(dirname(absPath), { recursive: true })
  await fsPromises.writeFile(absPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  return { captured: true, rawPath: rawRelPath, fileCount: files.length }
}

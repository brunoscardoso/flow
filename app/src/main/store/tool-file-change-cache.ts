/**
 * `toolCallFileChanges`, memoized for the main process.
 *
 * A list read that withholds a call's output or summarizes its input attaches
 * what the call did to files (`ToolCallRecord.fileChanges`), so the chat can
 * still say "+156 −34" about an edit whose strings it was never sent. That
 * read runs on every thread open and every turn's reconcile, on the process
 * every window waits behind (allowed-pattern #19) — and a finished call never
 * changes its input or its status again. So each finished call is counted
 * once per session and then read back from here.
 *
 * MEASURED on a synthetic 1,800-call thread (720 edits and ~16 KB writes,
 * `outputLimit: 60`): the bounded read went 8.0 → 60.9 ms the first time a
 * thread is opened in a session (parsing every edit's input once), and
 * 5.3 → 6.6 ms on every read after that, when it is all cache hits.
 *
 * Bounded: past `MAX_ENTRIES` the oldest entries are dropped (a Map iterates
 * in insertion order). A running call is never cached — its result is not in.
 */
import type { ToolCallRecord, ToolFileChange } from '../../shared/ipc-contract'
import { isFileChangeTool, toolCallFileChanges } from '../../shared/tool-file-changes'

const MAX_ENTRIES = 20_000
const cache = new Map<string, ToolFileChange[]>()

const FINISHED: ReadonlySet<ToolCallRecord['status']> = new Set(['success', 'error', 'denied', 'interrupted'])

/**
 * What `call` did to files, or undefined for a call that touches none. `call`
 * must carry its WHOLE input; `outputJson` may be just the head of the result
 * (enough to tell a created file from an overwritten one).
 */
export function cachedFileChanges(
  call: Pick<ToolCallRecord, 'id' | 'toolName' | 'inputJson' | 'outputJson' | 'status'>,
): ToolFileChange[] | undefined {
  if (!isFileChangeTool(call.toolName)) return undefined
  const finished = FINISHED.has(call.status)
  const key = `${call.id}\u0000${call.status}`
  if (finished) {
    const hit = cache.get(key)
    if (hit !== undefined) return hit
  }
  const changes = toolCallFileChanges({ toolName: call.toolName, inputJson: call.inputJson, outputJson: call.outputJson })
  if (finished) {
    if (cache.size >= MAX_ENTRIES) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, changes)
  }
  return changes
}

/** Test-only: forget everything counted. */
export function clearFileChangeCache(): void {
  cache.clear()
}

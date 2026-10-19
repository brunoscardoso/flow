/**
 * Pure, DOM-free turn logic for the conversation feed.
 *
 * `tool-group-model.ts` beside this file folds a *run* — a contiguous streak of
 * the same tool on the same file. That grouping shipped and the feed still reads
 * the way the screenshot that motivated this work reads: sixteen `Bash grep -n …`
 * rows around four sentences of the agent's own words, five of them failed
 * commits indistinguishable from the successes. Grouping did not move the number
 * because it folds runs and a reader reads TURNS. The scaffolding outnumbered the
 * signal four to one, and the row that most deserved attention was the hardest
 * to find.
 *
 * So this module folds on the other axis: an assistant message plus everything
 * the agent did before saying the next thing. That set is already computable
 * from data the feed holds — every `ToolCallRecord` carries the `messageId` of
 * the assistant message it belongs to — so there is no new main-process state,
 * no new IPC and no additional payload.
 *
 * Two disciplines are inherited from `planToolGroups` verbatim:
 *   - Order is NEVER reordered. The feed's chronology is the record.
 *   - The model owns no DOM and imports no view types, so it runs under the
 *     app's node-env jest and the view can change without touching it.
 *
 * And one that is specific to this axis: the fold must never SWALLOW a card the
 * reader has to act on. A permission request or a question card inside a turn is
 * the one thing that must stay visible at every density, so those entries break
 * the turn and pass through untouched.
 */
import type { ToolCallRecord, ToolCallStatus } from '../../shared/ipc-contract'
import { FILE_GROUPING_TOOLS, groupStatus, toolFilePath } from './tool-group-model'

/**
 * What an entry is, as far as the turn fold cares. Injected by the caller
 * (`classify`) so this model never imports `HistoryEntry` or any other view
 * type — the same generic discipline `planToolGroups` follows.
 *
 * - `assistant` opens a turn and is its head.
 * - `tool` belongs to the turn named by `messageId`. The field is genuinely
 *   nullable in the store, which is the interesting case; see `planTurns`.
 * - `break` is anything that must never be folded away: a user message, a
 *   permission card, a question card. It ends the current turn and passes
 *   through as itself.
 */
export type TurnRole =
  | { kind: 'assistant'; messageId: string }
  | { kind: 'tool'; messageId: string | null }
  | { kind: 'break' }

/**
 * A render unit for the feed at the turn level: either a single entry rendered
 * as-is (a break, or a tool call with no turn to belong to) or a turn — the
 * assistant message plus the tool entries that happened under it.
 * Generic over the caller's entry type so the model never imports view types.
 */
export type TurnUnit<T> =
  | { turn: false; entry: T }
  | { turn: true; messageId: string; head: T; tools: T[] }

/**
 * Fold a sorted entry list into turn units.
 *
 * A tool entry keys to a turn by its `messageId`. A tool entry whose
 * `messageId` is null joins the turn IN PROGRESS by contiguity and never opens
 * one of its own: a nullable key that started turns would fragment one turn
 * into a row of singletons, which is precisely the noise this fold exists to
 * remove. (A null-id tool with no turn open has nothing to join and passes
 * through as a single, rather than inventing a headless turn.)
 *
 * A tool entry naming a DIFFERENT message than the open turn also passes
 * through as a single: a turn is an assistant message plus its tools, so
 * without a head there is nothing to fold into.
 *
 * Order is preserved and every input entry appears exactly once in the output.
 */
export function planTurns<T>(
  entries: readonly T[],
  classify: (entry: T) => TurnRole,
): Array<TurnUnit<T>> {
  const units: Array<TurnUnit<T>> = []
  let open: { messageId: string; head: T; tools: T[] } | null = null

  const flush = (): void => {
    if (open !== null) {
      units.push({ turn: true, messageId: open.messageId, head: open.head, tools: open.tools })
      open = null
    }
  }

  for (const entry of entries) {
    const role = classify(entry)
    if (role.kind === 'assistant') {
      flush()
      open = { messageId: role.messageId, head: entry, tools: [] }
      continue
    }
    if (role.kind === 'tool') {
      if (open !== null && (role.messageId === null || role.messageId === open.messageId)) {
        open.tools.push(entry)
      } else {
        flush()
        units.push({ turn: false, entry })
      }
      continue
    }
    // break — a user message, a permission card, a question card. Never folded.
    flush()
    units.push({ turn: false, entry })
  }
  flush()
  return units
}

/**
 * Statuses that a summary row reports as a FAILURE.
 *
 * `interrupted` is deliberately absent. It means "stopped by you" (#1217), and
 * folding it into the failure count would say "this crashed" about an action the
 * reader themselves took — the exact confusion `groupStatus` already keeps out
 * of the group glyph, restated here as a count.
 */
export const FAILED_STATUSES: ReadonlySet<ToolCallStatus> = new Set<ToolCallStatus>([
  'error',
  'denied',
])

/** The facts a collapsed turn's one row states. */
export interface TurnSummary {
  /** How many tool calls the turn made. */
  tools: number
  /** How many of them failed (error or denied — never interrupted). */
  failed: number
  /** How many DISTINCT files the turn wrote to. */
  filesEdited: number
  /** The turn's aggregate status, worst-first, for the row's one glyph. */
  status: ToolCallStatus
}

/**
 * Reduce a turn's tool calls to the facts its summary row states.
 *
 * `filesEdited` counts DISTINCT `file_path` values, not calls: a turn that
 * edited one file three times changed one file, and saying "3 files edited"
 * would be a wrong fact stated confidently — worse than no fact at all.
 * The file-tool set and the path extraction are reused from
 * `tool-group-model.ts` rather than re-derived, so there is one answer to
 * "which tools touch a file" (allowed-pattern #14).
 *
 * `status` is `groupStatus` for the same reason: the worst-first precedence
 * (running > error > denied > interrupted > success), and its careful
 * separation of `interrupted` from `error`, lives in one code path.
 */
export function turnSummary(records: readonly ToolCallRecord[]): TurnSummary {
  let failed = 0
  const files = new Set<string>()

  for (const record of records) {
    if (FAILED_STATUSES.has(record.status)) failed += 1
    if (!FILE_GROUPING_TOOLS.has(record.toolName.toLowerCase())) continue
    const filePath = toolFilePath(record)
    if (filePath !== null) files.add(filePath)
  }

  return {
    tools: records.length,
    failed,
    filesEdited: files.size,
    status: groupStatus(records.map((record) => record.status)),
  }
}

/** The middle-dot separator, built the way `contextGroupHeaderLabel` builds it. */
const SEPARATOR = ' ' + String.fromCharCode(183) + ' '

const plural = (count: number, noun: string): string =>
  count + ' ' + noun + (count === 1 ? '' : 's')

/**
 * The collapsed turn's one line, e.g. `Ran 12 tools · 2 failed · 3 files edited`.
 *
 * A segment whose count is zero is OMITTED. `· 0 failed` is a fact nobody asked
 * for, occupying the space the counts that matter need — and a row padded with
 * zeroes trains the reader to stop reading the row, which would undo the whole
 * point of collapsing behind it. A turn with no tool calls yields an empty
 * string; the caller renders no row rather than an empty one.
 */
export function turnSummaryLabel(summary: TurnSummary): string {
  const segments: string[] = []
  if (summary.tools > 0) segments.push('Ran ' + plural(summary.tools, 'tool'))
  if (summary.failed > 0) segments.push(summary.failed + ' failed')
  if (summary.filesEdited > 0) segments.push(plural(summary.filesEdited, 'file') + ' edited')
  return segments.join(SEPARATOR)
}

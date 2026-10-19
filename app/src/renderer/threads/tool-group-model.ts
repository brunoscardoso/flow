/**
 * Pure, DOM-free grouping logic for the conversation feed's tool cards.
 *
 * A turn that edits one file N times renders as N identical `Edit <path>`
 * lines today — one ToolCard per call, and an Edit's summary is only its
 * file_path (#17). This module partitions the already-sorted history entries
 * into render units so a CONTIGUOUS run of the same tool on the same file
 * collapses under one header. It owns no DOM (like `tool-card-model.ts`) so it
 * runs under the app's node-env jest; the view (`tool-group-card.ts`) and the
 * pane wiring (`conversation-pane.ts`) consume it.
 *
 * Grouping is deliberately CONTIGUOUS-ONLY: a message, or a differing tool or
 * file, breaks the run. The feed's chronology is never reordered.
 */
import type { ToolCallRecord, ToolCallStatus } from '../../shared/ipc-contract'
import type { IconName } from '../components'
import { brainSearchPresentation, toolIcon } from './tool-card-model'

/**
 * Tools whose collapsed summary is a file path, so repeats of them stack as
 * identical lines. Lowercased — the record's toolName is matched case-insensitively.
 *
 * `multiedit` belongs here for the same reason `edit` does: one call, one file,
 * the same `file_path` input key — the project's own tool-argument map
 * (`main/claude-history.ts`) is the record of that. Its absence was not merely
 * a missed group. `turnSummary` reuses THIS set to count files, so a turn made
 * entirely of MultiEdits reported that it had touched no files at all.
 */
export const FILE_GROUPING_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit'])

export const CONTEXT_GROUPING_TOOLS = new Set(['read', 'grep', 'glob', 'websearch', 'webfetch'])

/**
 * `bash` groups on its OWN key rather than joining the context run: a command
 * and a file read are different activities, and a reader scanning an expanded
 * turn has to tell them apart. Until this existed `bash` was in neither set —
 * the one tool nothing grouped, and the single named cause of the sixteen
 * `Bash grep -n ...` rows around four sentences of prose in the chat-feed-signal
 * report (plan_chat-feed-signal_v1, Phase 3 / FR-2).
 */
export const COMMAND_GROUPING_TOOLS = new Set(['bash'])

export const CONTEXT_GROUP_KEY = 'context'

export const COMMAND_GROUP_KEY = 'command'

/** Minimum run length that collapses into a group; a lone call stays a card. */
export const GROUP_THRESHOLD = 2

/**
 * A render unit for the feed: either a single entry rendered as-is (a message,
 * or a lone tool call) or a group of >=2 contiguous tool entries sharing a key.
 * Generic over the caller's entry type so the model never imports view types.
 */
export type GroupedUnit<T> =
  | { grouped: false; entry: T }
  | { grouped: true; key: string; entries: T[] }

/**
 * Partition a sorted entry list into render units. `keyOf` returns a stable
 * group key for a groupable tool entry, or null for anything that must never
 * group (messages, non-file tools, a tool call with no file path). A run of
 * >= GROUP_THRESHOLD entries sharing one non-null key becomes a group; shorter
 * runs and null-key entries pass through as singles. Order is preserved.
 */
export function planToolGroups<T>(
  entries: readonly T[],
  keyOf: (entry: T) => string | null,
): Array<GroupedUnit<T>> {
  const units: Array<GroupedUnit<T>> = []
  let run: T[] = []
  let runKey: string | null = null

  const flush = (): void => {
    if (run.length >= GROUP_THRESHOLD && runKey !== null) {
      units.push({ grouped: true, key: runKey, entries: run })
    } else {
      for (const entry of run) units.push({ grouped: false, entry })
    }
    run = []
    runKey = null
  }

  for (const entry of entries) {
    const key = keyOf(entry)
    if (key === null) {
      flush()
      units.push({ grouped: false, entry })
      continue
    }
    if (key === runKey) {
      run.push(entry)
    } else {
      flush()
      run = [entry]
      runKey = key
    }
  }
  flush()
  return units
}

/**
 * The input keys a file-oriented tool names its target under, in preference
 * order.
 *
 * NotebookEdit is the one that does not say `file_path` — its key is
 * `notebook_path` — so reading only the first key made every notebook edit look
 * like a call that touched nothing: no group, and zero files in the turn
 * summary. The pair is what the rest of the app already agrees on
 * (`main/claude-history.ts`'s argument map, and `path-containment.ts`'s
 * `file_path ?? notebook_path`), asked in one place rather than re-derived.
 */
const FILE_PATH_KEYS = ['file_path', 'notebook_path'] as const

/** Extract a tool call's target file path, or null when it has none. */
export function toolFilePath(record: ToolCallRecord): string | null {
  if (!record.inputJson) return null
  try {
    const parsed = JSON.parse(record.inputJson) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const input = parsed as Record<string, unknown>
      for (const key of FILE_PATH_KEYS) {
        const value = input[key]
        if (typeof value === 'string' && value.trim() !== '') return value
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * The separator inside a file-group key. A newline appears in neither a
 * lowercased tool name nor a path this app groups on, which is what lets the
 * key be read BACK — see `parseFileGroupKey`.
 */
const FILE_KEY_SEPARATOR = '\n'

/**
 * The group key for a tool call, or null when it must never group: a composite
 * of the lowercased tool name and its file path for file-oriented tools
 * (edit/write/multiedit/notebookedit), or the shared CONTEXT_GROUP_KEY for a read-only
 * exploratory tool (read/grep/glob/websearch/webfetch), or COMMAND_GROUP_KEY
 * for a shell command — the last two group by RUN, not by what each call
 * touched.
 *
 * The command key is decided by the TOOL, never by reading the command string:
 * classifying a bash call as read-only or mutating by pattern-matching its argv
 * is explicitly ruled out in the plan's Intent — a guess over another program's
 * arguments would decide what a person sees.
 *
 * The one bash call that stays out of the run is a `planflow-ai brain search`:
 * `tool-card-model.ts` already presents it as its own "Knowledge search" card,
 * and swallowing it into `Ran N commands` would erase a deliberate distinction.
 * The exclusion asks that module's own matcher rather than repeating it, so the
 * card and the group can never disagree about what a brain search is
 * (allowed-pattern #14).
 */
export function toolCallGroupKey(record: ToolCallRecord): string | null {
  const tool = record.toolName.toLowerCase()
  if (CONTEXT_GROUPING_TOOLS.has(tool)) return CONTEXT_GROUP_KEY
  if (COMMAND_GROUPING_TOOLS.has(tool)) {
    if (brainSearchPresentation(record.toolName, record.inputJson) !== null) return null
    return COMMAND_GROUP_KEY
  }
  if (!FILE_GROUPING_TOOLS.has(tool)) return null
  const filePath = toolFilePath(record)
  if (filePath === null) return null
  return `${tool}${FILE_KEY_SEPARATOR}${filePath}`
}

/**
 * Read a file-group key back into the two facts that built it, or null when the
 * key is not one.
 *
 * This is what makes `groupPresentation` able to RECOGNISE a file group rather
 * than assume one: the file arm is now reached by a key that says it is a file
 * key, not by having fallen past every other test.
 */
export function parseFileGroupKey(key: string): { toolName: string; filePath: string } | null {
  const at = key.indexOf(FILE_KEY_SEPARATOR)
  if (at <= 0) return null
  const filePath = key.slice(at + 1)
  if (filePath === '') return null
  return { toolName: key.slice(0, at), filePath }
}

/** Past-tense verb for a grouped tool run (used in the header). */
export function toolVerb(toolName: string): string {
  switch (toolName.toLowerCase()) {
    case 'edit':
    case 'multiedit':
    case 'notebookedit':
      return 'Edited'
    case 'write':
      return 'Wrote'
    case 'read':
      return 'Read'
    default:
      return toolName
  }
}

/** Count noun for a grouped tool run (used in the header). */
function toolCountNoun(toolName: string): string {
  switch (toolName.toLowerCase()) {
    case 'read':
      return 'reads'
    case 'write':
      return 'writes'
    default:
      return 'changes'
  }
}

/**
 * Header text for a collapsed group, e.g. `Edited src/foo.ts | 3 changes`.
 * The path is shown as-is (the header lane ellipsizes on overflow, matching the
 * one-line summary); the full per-call detail lives on the expanded rows.
 */
export function groupHeaderLabel(toolName: string, filePath: string, count: number): string {
  return `${toolVerb(toolName)} ${filePath} · ${count} ${toolCountNoun(toolName)}`
}

/** Header text for a collapsed context run, e.g. 'Gathered context - 3 steps'. */
export function contextGroupHeaderLabel(count: number): string {
  const noun = count === 1 ? 'step' : 'steps'
  return 'Gathered context ' + String.fromCharCode(183) + ' ' + count + ' ' + noun
}

/**
 * Header text for a collapsed command run, e.g. 'Ran 6 commands'. Separate
 * wording from the context header on purpose: the reader must be able to tell
 * a run of shell commands from a run of file reads without expanding either.
 */
export function commandGroupHeaderLabel(count: number, names: readonly string[] = []): string {
  const noun = count === 1 ? 'command' : 'commands'
  const head = 'Ran ' + count + ' ' + noun
  if (names.length === 0) return head
  return head + ' ' + String.fromCharCode(183) + ' ' + names.join(', ')
}

/** How many distinct command names a collapsed row names before it elides. */
export const MAX_NAMED_COMMANDS = 3

/**
 * The names of the commands a run actually invoked, in order, deduplicated.
 *
 * WHY THE ROW NAMES THEM (user call 2026-09-08). "Ran 3 commands" is the same
 * row whether those were three greps or `rm -rf`, `git push --force` and a
 * migration: the summary reported how many and whether any FAILED, never how
 * much they could break. A reader deciding whether to expand had nothing to
 * decide on.
 *
 * IT REPORTS, IT DOES NOT JUDGE. Nothing here asks whether a command looks
 * dangerous — that would be a heuristic over another program's argv deciding
 * what a person sees, which this feature ruled out on purpose. It shows what
 * ran and lets the reader recognise it. `git push` is alarming to someone who
 * did not expect a push and unremarkable to someone who asked for one, and
 * only they can tell which.
 *
 * This is NOT forbidden-pattern #12. That rule bans handing a reader a command
 * to go and RUN — an invocation wearing a button's clothes. This is a report of
 * what already happened, which is exactly what the expanded card shows; the
 * fold is not a reason to stop saying it.
 *
 * A driver plus its subcommand (`git push`, `npm run`) reads as one command,
 * so those keep two words; everything else keeps one. Deduplicated because a
 * run of three greps should say `grep`, not `grep, grep, grep` — the count is
 * already on the row.
 */
export function commandNames(records: readonly ToolCallRecord[]): string[] {
  const names: string[] = []
  for (const record of records) {
    const name = commandName(record)
    if (name !== null && !names.includes(name)) names.push(name)
    if (names.length > MAX_NAMED_COMMANDS) {
      return [...names.slice(0, MAX_NAMED_COMMANDS), String.fromCharCode(8230)]
    }
  }
  return names
}

/** Drivers whose subcommand is part of the command's identity. */
const SUBCOMMAND_DRIVERS = new Set([
  'git',
  'npm',
  'npx',
  'yarn',
  'pnpm',
  'cargo',
  'docker',
  'kubectl',
  'brew',
  'uv',
  'pip',
  'go',
])

/** One bash call's short name — `git push`, `grep` — or null when unreadable. */
function commandName(record: ToolCallRecord): string | null {
  if (!record.inputJson) return null
  try {
    const parsed = JSON.parse(record.inputJson) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const command = (parsed as Record<string, unknown>)['command']
    if (typeof command !== 'string') return null
    // The first tokens of the line as typed. No shell parsing: a pipeline or a
    // subshell is reported by whatever opens it, which is what a reader scanning
    // for `git` or `rm` is looking for anyway.
    const tokens = command.trim().split(/\s+/).filter((token) => token.length > 0)
    const head = tokens[0]
    if (head === undefined) return null
    const second = tokens[1]
    if (SUBCOMMAND_DRIVERS.has(head) && second !== undefined && !second.startsWith('-')) {
      return head + ' ' + second
    }
    return head
  } catch {
    return null
  }
}

/**
 * Header text for a group whose key this module does not recognise, e.g.
 * `TodoWrite · 3 steps`.
 *
 * It names the tool and counts the calls and claims nothing else — no verb it
 * has not been taught, no noun ("changes") that asserts what the calls did, and
 * above all no file path, because the reason the key is unrecognised may well
 * be that there is no file. That is the whole difference between this and
 * falling into the file arm, which rendered `Bash  · 3 changes`.
 */
export function unknownGroupHeaderLabel(toolName: string, count: number): string {
  const noun = count === 1 ? 'step' : 'steps'
  return `${toolName} ${String.fromCharCode(183)} ${count} ${noun}`
}

/**
 * Aggregate status for a group's one header glyph, in worst-first precedence:
 * still-running beats a failure beats a denial beats an interruption beats
 * success. Each tier keeps its OWN glyph — `interrupted` in particular stays
 * neutral ("stopped by you", #1217) instead of being folded into the red error
 * glyph, so a user-stopped run of edits is not mislabelled as a failure.
 */
export function groupStatus(statuses: readonly ToolCallStatus[]): ToolCallStatus {
  if (statuses.some((s) => s === 'pending' || s === 'running')) return 'running'
  if (statuses.some((s) => s === 'error')) return 'error'
  if (statuses.some((s) => s === 'denied')) return 'denied'
  if (statuses.some((s) => s === 'interrupted')) return 'interrupted'
  return 'success'
}

/**
 * How a collapsed group presents itself: its header text and its icon.
 *
 * ONE DECISION, ONE PLACE. The pane chose both with a BINARY — `isContext ? …
 * : …` — duplicated at two call sites (the history build and the live
 * promotion). That shape has room for exactly two kinds of group, so the
 * moment a third arrived (command runs, #chat-feed-signal) a bash group fell
 * into the file-oriented arm and rendered as `Bash  · 3 changes`: the wrong
 * noun, and an empty file path where the path belongs.
 *
 * Nothing was red, because no test asserted the label for a kind that had not
 * existed yet. So the kinds live here, together, where adding a fourth means
 * answering this question once rather than finding both ternaries.
 *
 * AND EVERY ARM IS NOW REACHED BY RECOGNITION, not by elimination. Collapsing
 * the two ternaries into one function moved the bug rather than closing it: the
 * file arm was still the `else`, so a fourth kind would land there exactly as
 * bash had — the same wrong noun over the same empty path, and once again with
 * nothing red. A file group is now identified by a key that PARSES as one
 * (`parseFileGroupKey`), the path comes from the key that built the group
 * rather than from re-reading the first record, and a key this module has never
 * been taught gets an honest header of its own instead of a borrowed one.
 */
export function groupPresentation(
  key: string,
  records: readonly ToolCallRecord[],
  count = records.length,
): { label: string; icon: IconName } {
  const first = records[0]
  if (first === undefined) return { label: '', icon: 'dot' }
  if (key === CONTEXT_GROUP_KEY) {
    return { label: contextGroupHeaderLabel(count), icon: 'search' }
  }
  if (key === COMMAND_GROUP_KEY) {
    return { label: commandGroupHeaderLabel(count, commandNames(records)), icon: 'terminal' }
  }
  const file = parseFileGroupKey(key)
  if (file !== null) {
    return {
      label: groupHeaderLabel(file.toolName, file.filePath, count),
      icon: toolIcon(file.toolName),
    }
  }
  return {
    label: unknownGroupHeaderLabel(first.toolName, count),
    icon: toolIcon(first.toolName),
  }
}

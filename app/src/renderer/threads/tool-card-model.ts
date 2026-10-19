/**
 * Pure, DOM-free presentation logic for the tool-call card's special cases.
 * The ToolCard view (tool-card.ts) owns all DOM; this owns the derivation so
 * it can be unit tested under the app's node-env ts-jest (renderer components
 * can't import under that runtime).
 *
 * Currently one special case: a Bash call that runs `planflow-ai brain
 * search` renders as a "Knowledge search" card (brain icon + the query as
 * the summary) instead of a raw Bash command card. Recognition goes through
 * the ONE shared matcher (shared/brain-search-command.ts) that the
 * brain-usage counters also use — card and counters can never disagree
 * about what a brain search is (allowed-pattern #14).
 */
import type { IconName } from '../components'
import { matchBrainSearch } from '../../shared/brain-search-command'

/** Overridden collapsed-line presentation for a recognized special call. */
export interface ToolCardPresentation {
  /** fl-icon name (typed as string so this module stays component-free). */
  icon: string
  label: string
  summary: string
}

/**
 * Collapsed-line icon per tool, keyed by the lower-cased tool name. The point
 * is that a reader scanning a turn can tell operations apart at a glance, so
 * the map is grouped by WHAT an operation does, not by which tool did it:
 *
 *   - `pencil` — mutating file ops (write / edit / notebookedit / multiedit). This is the
 *     one that has to stand out: a destructive change must not read the same
 *     as an inspection.
 *   - `file`   — reading a file (read).
 *   - `search` — non-mutating lookups (glob / grep / websearch / webfetch).
 *
 * Before this split all four file ops shared `file` and a stack of them read
 * as one undifferentiated blur (#18). A type-only IconName import keeps this
 * module component-free at runtime (the import is erased at compile).
 */
const TOOL_ICONS: Record<string, IconName> = {
  bash: 'terminal',
  read: 'file',
  write: 'pencil',
  edit: 'pencil',
  notebookedit: 'pencil',
  // MultiEdit writes files like the three above it. It was missing here while
  // nothing grouped it, so the omission was invisible; once it joined
  // FILE_GROUPING_TOOLS its group drew the `dot` fallback beside pencils.
  multiedit: 'pencil',
  glob: 'search',
  grep: 'search',
  websearch: 'search',
  webfetch: 'search',
  todowrite: 'check',
  task: 'message',
  agent: 'message',
}

/** The collapsed-line icon for a tool call; `dot` for anything unmapped. */
export function toolIcon(toolName: string): IconName {
  return TOOL_ICONS[toolName.toLowerCase()] ?? 'dot'
}

/**
 * Knowledge-search presentation for a tool call, or null for every other
 * call (which renders with the default toolName + input summary). Matching
 * is on the INPUT only, so the card presents correctly from the running
 * state onward. Summary is the query text, plus ` · <scope>` when the
 * command passed `--scope`.
 */
export function brainSearchPresentation(
  toolName: string,
  inputJson: string | null,
): ToolCardPresentation | null {
  if (toolName !== 'Bash' || !inputJson) return null
  let command: string | null = null
  try {
    const parsed = JSON.parse(inputJson) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const value = (parsed as Record<string, unknown>)['command']
      if (typeof value === 'string') command = value
    }
  } catch {
    return null
  }
  if (command === null) return null
  const match = matchBrainSearch(command)
  if (!match) return null
  const summary = match.scope === undefined ? match.query : `${match.query} · ${match.scope}`
  return { icon: 'brain', label: 'Knowledge search', summary }
}

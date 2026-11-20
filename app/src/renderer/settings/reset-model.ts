/**
 * RESET FLOW — the words and the decisions behind Settings › App › Reset Flow.
 *
 * DOM-free, so node-env jest reads every sentence and every rule here.
 * `reset-section.ts` draws it; main (`main/reset/`) does the deleting.
 *
 * Three rules this file holds:
 *   1. Nothing is ticked when the section opens. Opening it is not a choice.
 *   2. The dialog's delete button is on only when the typed word matches.
 *   3. Every row names what it holds in the user's terms — never a path, a
 *      table or a config key (forbidden-pattern #12).
 */
import { RESET_ITEMS, type ResetInventoryRow, type ResetItem, type ResetOutcome } from '../../shared/reset-items'

export const RESET_TITLE = 'Reset Flow'
export const RESET_SUMMARY = 'Delete conversations, your brain, settings, sign-ins and more. You choose what.'
export const RESET_OPEN_LABEL = 'Choose what to delete…'
export const RESET_LEAD = 'Delete what Flow keeps for you. Nothing is sent anywhere, and nothing is pushed.'
export const RESET_SELECT_ALL = 'Select all'
export const RESET_CLEAR = 'Clear'
export const RESET_HIDE = 'Hide'
export const RESET_BUTTON = 'Reset selected…'
export const RESET_READING = 'Reading what Flow keeps…'
export const RESET_UNREADABLE = "Flow couldn't read what it keeps. You can still choose what to delete."
export const RESET_EMPTY_SIZE = 'Nothing stored'
export const RESET_CONFIRM_WORD = 'delete'
export const RESET_CANCEL = 'Cancel'
export const RESET_CONFIRM = 'Delete and restart'
export const RESET_WORKING = 'Restarting…'
export const RESET_FAILED = "Flow couldn't start the reset. Nothing was deleted."

export type ResetGroup = 'Preferences' | 'Your work' | 'Accounts' | 'Projects and Workspaces' | 'Other'

export interface ResetItemCopy {
  item: ResetItem
  group: ResetGroup
  label: string
  description: string
}

/** One entry per item, in RESET_ITEMS order. */
export const RESET_COPY: Record<ResetItem, ResetItemCopy> = {
  'app-settings': {
    item: 'app-settings',
    group: 'Preferences',
    label: 'App settings',
    description:
      'Default models and effort, agent runtime, autopilot and ask-first defaults, appearance, layout, window size and your usage-data choice. Flow starts as on first launch.',
  },
  'file-defaults': {
    item: 'file-defaults',
    group: 'Preferences',
    label: 'Conversation file defaults',
    description:
      "The app-wide defaults for worktrees, remote, branch naming and base branch. Each project's own choice goes with the project list.",
  },
  permissions: {
    item: 'permissions',
    group: 'Preferences',
    label: 'Permission answers',
    description: 'The tools and commands you chose to always allow. The agent asks again.',
  },
  conversations: {
    item: 'conversations',
    group: 'Your work',
    label: 'Conversations',
    description:
      "Every conversation with its messages, attachments, tool output and shared links. Work in a conversation's worktree stays on disk.",
  },
  launchpad: {
    item: 'launchpad',
    group: 'Your work',
    label: 'Launchpad scripts',
    description: 'Setup and one-time scripts, and the order your services start in.',
  },
  tasks: {
    item: 'tasks',
    group: 'Your work',
    label: 'Tasks',
    description: 'The task list and its subtasks. The issues in your trackers stay.',
  },
  'personal-brain': {
    item: 'personal-brain',
    group: 'Your work',
    label: 'Personal brain',
    description:
      'Your notes, learnings, patterns, ledger, memory, tasklist and scheduled tasks, kept outside any project.',
  },
  'agent-accounts': {
    item: 'agent-accounts',
    group: 'Accounts',
    label: 'Agent accounts',
    description:
      'Flow forgets your Claude, Copilot and Codex accounts and which project uses which, and deletes the sign-ins it made for them. Sign-ins you use in the terminal stay.',
  },
  connectors: {
    item: 'connectors',
    group: 'Accounts',
    label: 'Connectors',
    description:
      "The connectors on the accounts you added in Flow, and Flow's connector choices. Connectors your terminal's Claude Code uses stay.",
  },
  integrations: {
    item: 'integrations',
    group: 'Accounts',
    label: 'Integrations',
    description: 'The task sources you connected, such as Azure DevOps and GitHub, and their sign-ins.',
  },
  'browser-data': {
    item: 'browser-data',
    group: 'Accounts',
    label: 'Built-in browser data',
    description: 'Cookies and site storage. You are signed out of the sites you opened in Flow.',
  },
  projects: {
    item: 'projects',
    group: 'Projects and Workspaces',
    label: 'Project list',
    description: 'Flow forgets which projects it manages. Your repositories stay.',
  },
  'workspace-knowledge': {
    item: 'workspace-knowledge',
    group: 'Projects and Workspaces',
    label: 'Workspace knowledge on this computer',
    description: "The local copy of project knowledge: discoveries, plans, brain and archive. Your team's copy is never touched.",
  },
  'project-files': {
    item: 'project-files',
    group: 'Projects and Workspaces',
    label: 'Flow files in your projects',
    description:
      'The commands, resources and hooks Flow added, and the link to the knowledge folder. Your own rules and code stay.',
  },
  'logs-caches': {
    item: 'logs-caches',
    group: 'Other',
    label: 'Logs and caches',
    description: 'Diagnostic logs and caches. Flow rebuilds them as it runs.',
  },
}

export const RESET_GROUPS: readonly ResetGroup[] = [
  'Preferences',
  'Your work',
  'Accounts',
  'Projects and Workspaces',
  'Other',
]

/** The items of one group, in canonical order. */
export function itemsInGroup(group: ResetGroup): ResetItem[] {
  return RESET_ITEMS.filter((item) => RESET_COPY[item].group === group)
}

/** "11 of 15 selected" — or the prompt when nothing is. */
export function selectionLine(selected: ReadonlySet<ResetItem>): string {
  if (selected.size === 0) return 'Nothing selected'
  return `${String(selected.size)} of ${String(RESET_ITEMS.length)} selected`
}

/** The ticked items in canonical order — what is sent to main. */
export function orderedSelection(selected: ReadonlySet<ResetItem>): ResetItem[] {
  return RESET_ITEMS.filter((item) => selected.has(item))
}

/** The size text beside a checkbox. */
export function sizeText(row: ResetInventoryRow | undefined): string {
  if (row === undefined || row.size === null) return ''
  return row.empty ? RESET_EMPTY_SIZE : row.size
}

/** The confirmation word matches — trimmed, any case. */
export function confirmMatches(typed: string): boolean {
  return typed.trim().toLowerCase() === RESET_CONFIRM_WORD
}

export interface ResetDialogView {
  title: string
  lead: string
  lines: Array<{ label: string; size: string }>
  /** Sentences the person must read before confirming. */
  warnings: string[]
  /** Something is still running; shown above the confirm field. */
  busy: string | null
  typePrompt: string
}

export function dialogView(
  selected: ReadonlySet<ResetItem>,
  rows: readonly ResetInventoryRow[],
  busy: string | null,
): ResetDialogView {
  const items = orderedSelection(selected)
  const byItem = new Map(rows.map((row) => [row.item, row]))
  const kinds = items.length === 1 ? 'kind' : 'kinds'
  return {
    title: `Delete ${String(items.length)} ${kinds} of Flow data?`,
    lead: "This can't be undone. Flow quits, deletes what you selected, and opens again.",
    lines: items.map((item) => ({ label: RESET_COPY[item].label, size: sizeText(byItem.get(item)) })),
    warnings: items.flatMap((item) => {
      const warning = byItem.get(item)?.warning
      return warning === null || warning === undefined ? [] : [warning]
    }),
    busy,
    typePrompt: `Type ${RESET_CONFIRM_WORD} to confirm`,
  }
}

/**
 * The line shown once after a restart. Null when there is nothing to say.
 * A failure names its item; success names how many.
 */
export function outcomeLine(outcome: ResetOutcome | null): { text: string; failed: boolean } | null {
  if (outcome === null) return null
  if (outcome.failed.length === 0) {
    const n = outcome.done.length
    return { text: `Flow deleted ${String(n)} ${n === 1 ? 'kind' : 'kinds'} of data.`, failed: false }
  }
  const names = outcome.failed.map((failure) => RESET_COPY[failure.item].label).join(', ')
  return {
    text: `Flow deleted ${String(outcome.done.length)} of ${String(outcome.done.length + outcome.failed.length)} kinds of data. Not deleted: ${names}.`,
    failed: true,
  }
}

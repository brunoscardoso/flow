/**
 * THE BRANCH A WORKSPACE SYNCS ON — every word the branch picker and the
 * settings' branch row show, and the pure decisions behind them.
 *
 * Pure (no DOM, no `window`): the view (`workspace-branch-view.ts`) paints what
 * this returns. Every fixed string is listed in `BRANCH_FIXED_STRINGS` for the
 * forbidden-pattern #12 scan — no commands, paths or setting names.
 *
 * A branch is SUGGESTED, never picked silently (allowed-pattern #21): the
 * pre-selected option carries the reason it was chosen. A branch known not to
 * work — one this computer saw refuse a direct push, or one the check after a
 * choice proved unusable — is shown, labelled, and cannot be picked.
 */
import type {
  WorkspaceBranchMove,
  WorkspaceBranchesResult,
  WorkspaceBranchSuggestionSource,
  WorkspaceSyncCause,
} from '../../shared/workspaces-contract'

export const BRANCH_LABEL = 'Branch'
export const BRANCH_HELP =
  'Flow saves and shares knowledge on this branch. Pick one everyone can push to directly. A branch that only accepts pull requests can’t be used.'
export const NEW_BRANCH_OPTION = 'A new branch…'
export const NEW_BRANCH_LABEL = 'New branch name'
export const NEW_BRANCH_PLACEHOLDER = 'knowledge'
export const READING_BRANCHES = 'Reading the repository’s branches…'
export const BRANCHES_AFTER_ADDRESS = 'Enter the repository’s address to choose a branch.'
export const NO_BRANCHES_READ = 'Flow couldn’t read this repository’s branches. Type the branch to use, or leave it empty to let Flow choose.'
export const NEW_REPOSITORY_BRANCH = 'A new repository has no branches yet. Leave this empty to let Flow choose, or type one.'
export const INVALID_BRANCH_NAME = 'That isn’t a name a branch can have. Choose another.'
export const CHOOSE_BRANCH = 'Choose a branch, or type a new one.'
export const CHANGE_BRANCH_LABEL = 'Change…'
export const SAVE_BRANCH_LABEL = 'Use this branch'
export const CHECKING_BRANCH_LABEL = 'Checking the branch…'
export const NO_BRANCH_YET = 'Not chosen yet'
export const JOIN_BRANCH_LABEL = 'Branch (optional)'
export const JOIN_BRANCH_HELP = 'Leave it empty to use the branch your team already shares on.'

export function changeBranchTitle(workspaceName: string): string {
  return `Branch for ${workspaceName}`
}

export const CHANGE_BRANCH_BODY =
  'Flow checks the branch by syncing on it. If it can’t be used, the Workspace stays on the branch it has now.'

/** The value of the "A new branch…" option — never a branch name (git refuses a leading dash). */
export const NEW_BRANCH_VALUE = '-new'

const SOURCE_NOTES: Record<WorkspaceBranchSuggestionSource, string> = {
  current: 'this Workspace syncs here',
  'in-use': 'already used by this Workspace',
  default: 'the repository’s default',
  new: 'new',
}

const CAUSE_NOTES: Record<WorkspaceSyncCause, string> = {
  'pull-request-required': 'only accepts pull requests',
  declined: 'the repository declined changes',
  'unrelated-history': 'holds something else',
  'author-not-allowed': 'can’t be used',
  access: 'can’t be used',
}

export interface BranchOption {
  value: string
  label: string
  disabled: boolean
}

export interface BranchChoices {
  options: BranchOption[]
  /** The option selected first: the suggestion, or "a new branch" with `newName` filled in. */
  selected: string
  newName: string
  /** The line under the picker. */
  help: string
}

/**
 * The picker's options from a branches answer. `unusable` holds the branches
 * a check proved unusable in this dialog, with why — they stay listed, labelled,
 * so the person sees why they can't pick them.
 */
export function branchChoices(
  answer: WorkspaceBranchesResult | null,
  unusable: ReadonlyMap<string, WorkspaceSyncCause> = new Map(),
): BranchChoices {
  const newOption: BranchOption = { value: NEW_BRANCH_VALUE, label: NEW_BRANCH_OPTION, disabled: false }
  if (answer === null || !answer.ok) {
    return { options: [newOption], selected: NEW_BRANCH_VALUE, newName: '', help: answer === null ? BRANCH_HELP : NO_BRANCHES_READ }
  }
  const options: BranchOption[] = answer.branches.map((branch) => {
    const cause = unusable.get(branch.name) ?? (branch.pullRequestOnly ? 'pull-request-required' : undefined)
    const notes: string[] = []
    if (cause !== undefined) notes.push(CAUSE_NOTES[cause])
    else if (branch.name === answer.suggestion.name && answer.suggestion.source !== 'new') notes.push(SOURCE_NOTES[answer.suggestion.source])
    else if (branch.name === answer.defaultBranch) notes.push(SOURCE_NOTES.default)
    return {
      value: branch.name,
      label: notes.length === 0 ? branch.name : `${branch.name} — ${notes.join(', ')}`,
      disabled: cause !== undefined,
    }
  })
  options.push(newOption)
  const suggested = options.find((option) => option.value === answer.suggestion.name && !option.disabled)
  if (suggested !== undefined && answer.suggestion.source !== 'new') {
    return { options, selected: suggested.value, newName: '', help: BRANCH_HELP }
  }
  const firstUsable = options.find((option) => !option.disabled && option.value !== NEW_BRANCH_VALUE)
  if (firstUsable !== undefined && answer.suggestion.source !== 'new') {
    return { options, selected: firstUsable.value, newName: '', help: BRANCH_HELP }
  }
  const newName = unusable.has(answer.suggestion.name) ? '' : answer.suggestion.name
  return { options, selected: NEW_BRANCH_VALUE, newName, help: answer.branches.length === 0 ? NEW_REPOSITORY_BRANCH : BRANCH_HELP }
}

/**
 * A rough check of a typed name, so an obvious typo is caught before anything
 * is sent; the CLI checks git's full grammar and refuses the rest.
 */
export function looksLikeBranchName(raw: string): boolean {
  const name = raw.trim()
  if (name === '' || name.length > 200 || name.startsWith('-') || name.startsWith('/') || name.endsWith('/')) return false
  if (name.endsWith('.') || name.endsWith('.lock') || name.includes('..') || name.includes('//') || name.includes('@{')) return false
  return !/[\s~^:?*[\\\u0000-\u001f\u007f]/.test(name)
}

/**
 * The branch a person picked: `undefined` = no choice (Flow decides — the
 * picker had nothing to offer and nothing was typed), or a refusal sentence.
 */
export function pickedBranch(
  selected: string,
  typed: string,
  options: { required: boolean },
): { ok: true; branch: string | undefined } | { ok: false; message: string } {
  if (selected !== NEW_BRANCH_VALUE) return { ok: true, branch: selected }
  const name = typed.trim()
  if (name === '') return options.required ? { ok: false, message: CHOOSE_BRANCH } : { ok: true, branch: undefined }
  return looksLikeBranchName(name) ? { ok: true, branch: name } : { ok: false, message: INVALID_BRANCH_NAME }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "Moved from main on Nov 13: main only accepts pull requests." — null when the time can't be read. */
export function branchMoveLine(move: WorkspaceBranchMove | null): string | null {
  if (move === null) return null
  const at = new Date(move.at)
  if (Number.isNaN(at.getTime())) return null
  const day = `${MONTHS[at.getMonth()]} ${at.getDate()}`
  return move.reason === 'pull-request-required'
    ? `Moved from ${move.from} on ${day}: ${move.from} only accepts pull requests.`
    : `Moved from ${move.from} on ${day} to the branch your team already uses.`
}

export const BRANCH_FIXED_STRINGS: readonly string[] = [
  BRANCH_LABEL,
  BRANCH_HELP,
  NEW_BRANCH_OPTION,
  NEW_BRANCH_LABEL,
  READING_BRANCHES,
  BRANCHES_AFTER_ADDRESS,
  NO_BRANCHES_READ,
  NEW_REPOSITORY_BRANCH,
  INVALID_BRANCH_NAME,
  CHOOSE_BRANCH,
  CHANGE_BRANCH_LABEL,
  SAVE_BRANCH_LABEL,
  CHECKING_BRANCH_LABEL,
  NO_BRANCH_YET,
  JOIN_BRANCH_LABEL,
  JOIN_BRANCH_HELP,
  CHANGE_BRANCH_BODY,
  ...Object.values(SOURCE_NOTES),
  ...Object.values(CAUSE_NOTES),
]

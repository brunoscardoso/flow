// The Source Control commit button — what its main face says and does, and
// what its chevron menu offers. Pure and DOM-free (app jest is node-env): the
// panel renders exactly what this returns.
//
// VS Code's rules, Flow's words:
//   - something staged            → "Commit"      commits the index
//   - nothing staged, changes     → "Commit All"  stages everything (untracked
//                                                 included) and commits it
//   - a merge in progress         → "Commit Merge", off until every conflict
//                                                 is resolved
//   - clean, behind/ahead         → "Sync Changes N↓ M↑" (pull, then publish)
//   - clean, no upstream          → "Publish Branch"
//   - clean and in sync           → "Commit", off, saying there is nothing to commit
// Anything that commits needs a message; the reason it is off is a sentence a
// person can read, never a command (forbidden #12).

export type CommitMainAction = 'commit' | 'commit-all' | 'commit-merge' | 'sync' | 'publish'

export type CommitMenuAction =
  | 'commit'
  | 'amend'
  | 'commit-push'
  | 'commit-sync'
  | 'commit-staged'
  | 'commit-all'

export interface CommitButtonInput {
  /** Files in Staged Changes. */
  stagedCount: number
  /** Files in Changes (working tree, untracked included). */
  changesCount: number
  /** Files in Merge Changes (still conflicted). */
  conflictCount: number
  /** A merge (or rebase / cherry-pick) is in progress. */
  merging: boolean
  /** The commit message box has text. */
  hasMessage: boolean
  ahead: number
  behind: number
  /** The branch tracks an upstream. */
  hasUpstream: boolean
  /** HEAD is detached — there is no branch to publish. */
  detached: boolean
  /** An action from this box is running. */
  busy: CommitMainAction | CommitMenuAction | null
}

export interface CommitButtonModel {
  action: CommitMainAction
  label: string
  /** The `N↓ M↑` suffix of Sync Changes, rendered after the label. */
  counts: { behind: number; ahead: number } | null
  icon: 'check' | 'sync' | 'cloud-upload'
  disabled: boolean
  /** Why it is off — shown under the box and as the title. Null when on. */
  reason: string | null
  /** The busy label, while something from this box runs. */
  busyLabel: string | null
}

export interface CommitMenuItem {
  action: CommitMenuAction
  label: string
  shortcut?: string
  disabled: boolean
  /** A separator goes BEFORE this item. */
  separator?: boolean
}

const BUSY_LABELS: Record<CommitMainAction | CommitMenuAction, string> = {
  commit: 'Committing…',
  'commit-all': 'Committing…',
  'commit-merge': 'Committing…',
  'commit-staged': 'Committing…',
  amend: 'Amending…',
  'commit-push': 'Committing…',
  'commit-sync': 'Committing…',
  sync: 'Syncing…',
  publish: 'Publishing…',
}

export function commitButtonModel(input: CommitButtonInput): CommitButtonModel {
  const busyLabel = input.busy === null ? null : BUSY_LABELS[input.busy]
  const busy = input.busy !== null
  const base = { counts: null, busyLabel }

  if (input.merging) {
    const reason =
      input.conflictCount > 0
        ? input.conflictCount === 1
          ? 'Resolve the conflict first'
          : `Resolve the ${input.conflictCount} conflicts first`
        : null
    return { ...base, action: 'commit-merge', label: 'Commit Merge', icon: 'check', disabled: busy || reason !== null, reason }
  }

  const dirty = input.stagedCount > 0 || input.changesCount > 0
  if (!dirty) {
    if (!input.detached && !input.hasUpstream) {
      return { ...base, action: 'publish', label: 'Publish Branch', icon: 'cloud-upload', disabled: busy, reason: null }
    }
    if (input.hasUpstream && (input.ahead > 0 || input.behind > 0)) {
      return {
        ...base,
        action: 'sync',
        label: 'Sync Changes',
        counts: { behind: input.behind, ahead: input.ahead },
        icon: 'sync',
        disabled: busy,
        reason: null,
      }
    }
    return { ...base, action: 'commit', label: 'Commit', icon: 'check', disabled: true, reason: 'There is nothing to commit' }
  }

  const action: CommitMainAction = input.stagedCount > 0 ? 'commit' : 'commit-all'
  const reason = input.hasMessage ? null : 'Enter a commit message'
  return {
    ...base,
    action,
    label: action === 'commit' ? 'Commit' : 'Commit All',
    icon: 'check',
    disabled: busy || reason !== null,
    reason,
  }
}

/** The chevron menu. Items that cannot run right now are listed but off. */
export function commitMenuItems(input: CommitButtonInput, mac: boolean): CommitMenuItem[] {
  const busy = input.busy !== null
  const noMessage = !input.hasMessage
  const dirty = input.stagedCount > 0 || input.changesCount > 0
  const blocked = busy || noMessage || input.merging
  return [
    { action: 'commit', label: 'Commit', shortcut: mac ? '⌘↵' : 'Ctrl+Enter', disabled: blocked || !dirty },
    // Amend needs a message too (it replaces the old one); whether the last
    // commit may be amended at all is main's call, and it refuses in words.
    { action: 'amend', label: 'Commit (Amend)', disabled: blocked },
    { action: 'commit-push', label: 'Commit & Push', disabled: blocked || !dirty || input.detached, separator: true },
    { action: 'commit-sync', label: 'Commit & Sync', disabled: blocked || !dirty || input.detached },
    { action: 'commit-staged', label: 'Commit Staged', disabled: blocked || input.stagedCount === 0, separator: true },
    { action: 'commit-all', label: 'Commit All', disabled: blocked || !dirty },
  ]
}

/**
 * Which files a commit takes: the index as it is, or everything first.
 * `commit` on the main face follows the button (all when nothing is staged).
 */
export function commitScope(
  action: CommitMainAction | CommitMenuAction,
  stagedCount: number,
): 'index' | 'all' {
  if (action === 'commit-all') return 'all'
  if (action === 'commit-staged' || action === 'amend' || action === 'commit-merge') return 'index'
  return stagedCount > 0 ? 'index' : 'all'
}

/** What runs after the commit lands. */
export function afterCommit(action: CommitMainAction | CommitMenuAction): 'none' | 'push' | 'sync' {
  if (action === 'commit-push') return 'push'
  if (action === 'commit-sync') return 'sync'
  return 'none'
}

/** The message box placeholder: names the branch, the way VS Code does. */
export function commitPlaceholder(input: {
  branch: string
  detached: boolean
  mac: boolean
  mergeMessage?: string | null
}): string {
  if (input.mergeMessage) return input.mergeMessage
  const key = input.mac ? '⌘Enter' : 'Ctrl+Enter'
  const where = input.detached ? 'a detached HEAD' : `'${input.branch || 'this branch'}'`
  return `Message (${key} to commit on ${where})`
}

/** The steps a sync takes: pull only what is behind, publish only what is ahead. */
export function syncSteps(behind: number, ahead: number): Array<'pull' | 'publish'> {
  const steps: Array<'pull' | 'publish'> = []
  if (behind > 0) steps.push('pull')
  if (ahead > 0) steps.push('publish')
  return steps
}

// The Source Control diff as an editor tab — its identity, its title, and the
// hunk actions it offers. Pure and DOM-free.
//
// One diff tab at a time, like VS Code's preview tab: opening another diff
// replaces it rather than stacking a tab per click. Its title says WHICH
// comparison it is, in VS Code's words: "(Working Tree)", "(Index)", or the
// commit's short hash.

export type DiffTarget =
  /** `against: 'head'` — a conversation's diff, or an untracked path: the
   *  working tree vs HEAD, with no index in between and no hunk actions. */
  | { kind: 'worktree'; rootPath: string; filePath: string; against?: 'head' }
  | { kind: 'index'; rootPath: string; filePath: string }
  | { kind: 'commit'; rootPath: string; filePath: string; commit: string }
  /** A whole commit — every file it changed, concatenated. */
  | { kind: 'commit-all'; rootPath: string; commit: string; subject: string }

/** The one diff tab's id. A non-path id (`flow://…`), per the view-tab convention. */
export const DIFF_TAB_ID = 'flow://scm-diff'

function baseName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

export function diffTabTitle(target: DiffTarget): string {
  switch (target.kind) {
    case 'worktree':
      return `${baseName(target.filePath)} (Working Tree)`
    case 'index':
      return `${baseName(target.filePath)} (Index)`
    case 'commit':
      return `${baseName(target.filePath)} (${target.commit.slice(0, 7)})`
    case 'commit-all':
      return `${target.subject} (${target.commit.slice(0, 7)})`
  }
}

/** The line under the tab strip: what is being compared with what. */
export function diffSubtitle(target: DiffTarget): string {
  switch (target.kind) {
    case 'worktree':
      return target.against === 'head' ? 'Working tree vs HEAD' : 'Working tree vs index'
    case 'index':
      return 'Staged vs HEAD'
    case 'commit':
    case 'commit-all':
      return `${target.commit.slice(0, 7)} vs parent`
  }
}

/** The file a diff has behind it (for Open File), or null for a whole commit. */
export function diffFile(target: DiffTarget): string | null {
  return target.kind === 'commit-all' ? null : target.filePath
}

/** The hunk buttons a diff offers: stage + revert on the working tree, unstage on the index. */
export function hunkActions(target: DiffTarget): Array<'stage' | 'revert' | 'unstage'> {
  if (target.kind === 'worktree') return target.against === 'head' ? [] : ['stage', 'revert']
  if (target.kind === 'index') return ['unstage']
  return []
}

export const HUNK_ACTION_LABELS: Record<'stage' | 'revert' | 'unstage', string> = {
  stage: 'Stage hunk',
  revert: 'Revert hunk',
  unstage: 'Unstage hunk',
}

/** Whether a status refresh should re-read this diff (the file it shows may have moved). */
export function diffFollowsTree(target: DiffTarget): boolean {
  return target.kind === 'worktree' || target.kind === 'index'
}

/** Two targets name the same comparison. */
export function sameDiffTarget(a: DiffTarget | null, b: DiffTarget | null): boolean {
  if (a === null || b === null) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Where a hunk's button sits: above its first line on the modified side. A
 * pure deletion has no modified lines (`newLines` 0) and `newStart` is the line
 * it follows, so the button goes after that line; at the top of the file
 * (`newStart` 0) it goes before line 1.
 */
export function hunkAnchorLine(hunk: { newStart: number; newLines: number }): { afterLine: number } {
  if (hunk.newLines === 0) return { afterLine: Math.max(0, hunk.newStart) }
  return { afterLine: Math.max(0, hunk.newStart - 1) }
}

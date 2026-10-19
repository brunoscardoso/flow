// Expandable untracked-directory rows for Source Control (#615) — pure model.
//
// git rolls a brand-new untracked directory up into ONE `dir/` change, so its
// individual files are invisible in the panel. This model interleaves an
// EXPANDED dir's fetched children as their own rows right after it, so a user
// can see (and peek) each new file without losing the rollup's discard/commit
// affordances on the folder row. No DOM/IO here — the panel owns the fetch,
// the expand set, and rendering.

import type { GitFileChange } from '../../shared/ipc-contract'

/** A row to render: a normal change, a rolled-up untracked DIR (expandable), or
 *  a CHILD file revealed under an expanded dir (indented, peek-only). */
export interface UntrackedDisplayRow {
  change: GitFileChange
  kind: 'normal' | 'dir' | 'child'
  /** For a child row: the parent dir path it was revealed under (for keying). */
  parentDir?: string
}

/** A rolled-up untracked directory: an untracked change whose path is a folder
 *  (git reports it with a trailing slash). These are the only expandable rows. */
export function isUntrackedDir(change: GitFileChange): boolean {
  return change.state === 'untracked' && change.filePath.endsWith('/')
}

/** Order-sensitive equality for two sorted path lists — lets a children re-fetch
 *  skip a re-render when the untracked contents are unchanged (#647). */
export function sameStringList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Build the display rows for a section: each change passes through as a `normal`
 * (or `dir`) row, and every EXPANDED dir is immediately followed by its cached
 * children as `child` rows. A dir with no cached children yet (fetch pending)
 * simply renders alone until the fetch resolves and re-renders. Pure and
 * deterministic; children keep the caller-provided (already sorted) order.
 */
export function interleaveUntrackedChildren(
  changes: readonly GitFileChange[],
  expandedDirs: ReadonlySet<string>,
  childrenByDir: ReadonlyMap<string, readonly string[]>,
): UntrackedDisplayRow[] {
  const rows: UntrackedDisplayRow[] = []
  for (const change of changes) {
    if (!isUntrackedDir(change)) {
      rows.push({ change, kind: 'normal' })
      continue
    }
    rows.push({ change, kind: 'dir' })
    if (!expandedDirs.has(change.filePath)) continue
    for (const childPath of childrenByDir.get(change.filePath) ?? []) {
      rows.push({
        change: { filePath: childPath, state: 'untracked', staged: false },
        kind: 'child',
        parentDir: change.filePath,
      })
    }
  }
  return rows
}

/**
 * The words the rename box says — rescued from the ledger before it was
 * deleted (worktree-ui-removal Phase 5, task 5.2).
 *
 * `worktree-manage.ts` owned this wording and is gone. The sentences are
 * carried here UNCHANGED: the branch chip has been asking this question in
 * these words since Phase 3, and a deletion is not an occasion to reword a
 * warning a person has already learned to read.
 *
 * Pure and DOM-free: `branch-rename-popover.ts` renders whatever this returns.
 */

/** The rename question, in words rather than in branch grammar. */
export interface RenameQuestion {
  title: string
  body: string
  /** What the box starts with — the name it already has, minus Flow's own part. */
  initial: string
  placeholder: string
  confirmLabel: string
}

/**
 * The rename prompt.
 *
 * A PERSON TYPES THE WHOLE NAME NOW, and that is a reversal.
 *
 * This used to hide Flow's `thread/` prefix and hand back only the part after
 * it, because the prefix was forced on and retyping somebody else's spelling is
 * exactly what forbidden-pattern #12 is about. The prefix is no longer forced:
 * a typed name is taken as typed, so hiding half of it would show a name that
 * is not the branch's name and refuse edits to the half it hid.
 *
 * IT ASKS FOR A BRANCH, NOT A LEDGER ROW. The parameter is the one field it
 * reads — so the conversation header's branch chip asks this question with
 * these words rather than growing a second wording of it (allowed-pattern
 * #14). The ledger that used to pass its whole row here no longer exists; the
 * shape it narrowed to is what the parameter was always about.
 */
export function renameQuestion(row: { branch: string | null }): RenameQuestion {
  const current = row.branch ?? ''
  return {
    title: 'What should this work be called?',
    body: 'This is the name the branch carries — what you will look for when you come back to this work later. Renaming it here does not change the thread’s own name.',
    initial: current,
    placeholder: 'A short name for this work',
    confirmLabel: 'Rename',
  }
}

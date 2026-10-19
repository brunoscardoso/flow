// New-task modal draft (#442). renderBody() rebuilds the modal body on every
// source-tab click, destroying the title/description/ref <input> DOM — so
// switching tabs and back silently wiped what the user typed (unlike the
// out-of-body Start-with / Skip fields). The board caches typed values in this
// draft across renders and restores them. DOM-free → unit-testable.

export interface NewTaskDraft {
  /** Manual-tab task title. */
  title: string
  /** Manual-tab description. */
  description: string
  /** Import reference per source tab (jira / github / azure). */
  refs: Record<string, string>
}

/** A blank draft. */
export function emptyTaskDraft(): NewTaskDraft {
  return { title: '', description: '', refs: {} }
}

/** The saved import reference for a source tab, or '' when nothing was typed. */
export function draftRef(draft: NewTaskDraft, source: string): string {
  return draft.refs[source] ?? ''
}

/** A preserved New-task draft, keyed to the project it was typed in (#591). */
export interface PersistedNewTaskDraft {
  rootPath: string
  draft: NewTaskDraft
  selected: string
  start: string
  /** Checked "Context folders" (#695) — the extra roots the spawned thread
   *  inherits. Part of the draft so a dismiss+reopen restores the WHOLE form,
   *  not just the text: restoring the typed fields while silently dropping the
   *  picked folders reads as "your work came back" and the task is then created
   *  with `additionalRoots: []` (#996). Optional for drafts written before this
   *  field existed. */
  contextRoots?: string[]
}

/** The draft to restore for the CURRENT project — a preserved draft belongs to
 *  the project it was typed in, so it's returned only when the roots match, never
 *  leaking one project's draft into another's New-task modal (#591). */
export function restorableDraft(
  saved: PersistedNewTaskDraft | null,
  currentRoot: string,
): PersistedNewTaskDraft | null {
  return saved && saved.rootPath === currentRoot ? saved : null
}

/** Whether a draft (or the Start-with field / the picked context folders) holds
 *  anything worth preserving — so closing an untouched modal leaves no phantom
 *  draft to restore (#561). Ticking only a context folder is itself a deliberate
 *  choice, so it alone makes the draft worth keeping (#996). */
export function newTaskDraftHasContent(
  draft: NewTaskDraft,
  start: string,
  contextRoots: readonly string[] = [],
): boolean {
  return (
    draft.title.trim().length > 0 ||
    draft.description.trim().length > 0 ||
    start.trim().length > 0 ||
    contextRoots.length > 0 ||
    Object.values(draft.refs).some((ref) => ref.trim().length > 0)
  )
}

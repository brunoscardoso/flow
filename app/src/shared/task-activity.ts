/**
 * Does a task patch count as ACTIVITY — i.e. should it bump `updated_at`, which
 * every lane on the board sorts by (#1192)?
 *
 * The app mutates tasks by itself: a turn starting moves a task to `doing`, a
 * clean turn sets `suggestDone`. Main's own hooks say so explicitly
 * (`{ activity: false }`), but the SAME turn-complete signal also arrives over
 * `tasks:update`, so the boundary needs a rule.
 *
 * The rule is narrow on purpose: ONLY a patch whose single field is
 * `suggestDone: true` is treated as app-driven. That is the shape nothing in
 * the UI ever sends — the Done? chip sends `{lane:'done', suggestDone:false}`,
 * a drag sends `{lane, suggestDone:false}`, a rename sends `{title}`. Every
 * other patch stays activity, so a user action always surfaces its task.
 */
/** The patch shape, structurally — this module must not depend on the store. */
export interface TaskPatchLike {
  title?: string | undefined
  lane?: string | undefined
  suggestDone?: boolean | undefined
  archived?: boolean | undefined
}

export function isAppDrivenTaskPatch(patch: TaskPatchLike): boolean {
  const keys = Object.keys(patch).filter(
    (key) => patch[key as keyof TaskPatchLike] !== undefined,
  )
  return keys.length === 1 && keys[0] === 'suggestDone' && patch.suggestDone === true
}

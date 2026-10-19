// Reconcile open editor tabs against project file changes (#294). The editor
// owns the open-tab map + Monaco models but never subscribed to project file
// events, so when an open file was renamed or deleted (file-tree menu, agent edit,
// or externally) the tab kept its stale absolute path and content — and cmd/ctrl+S
// wrote back to the gone path, silently RESURRECTING the deleted/old file (and, on
// rename, leaving both old + new). A rename surfaces to the watcher as delete(old)
// + create(new), so acting on 'deleted' covers both cases. This pure planner decides
// what to do with each open tab; the editor applies the plan (close / flag / clear).
import type { FileChange } from '../../shared/ipc-contract'

export interface TabReconcileActions {
  /** Clean tabs whose backing file is gone → close (nothing to lose). */
  close: string[]
  /** Dirty tabs whose backing file is gone → flag "deleted on disk" so a plain
   *  save can't silently recreate it; the editor guards the save path on these. */
  markDeleted: string[]
  /** Previously-flagged paths whose file reappeared (created/changed) → clear flag. */
  clearDeleted: string[]
  /** Clean tabs whose file changed on disk → re-read + reload the buffer, so the
   *  agent's/external edit shows instead of stale content (#353). */
  reload: string[]
  /** Dirty tabs whose file changed on disk → flag "changed on disk" so a save can't
   *  silently clobber the external edit; the editor guards the save path on these. */
  markChangedOnDisk: string[]
}

/**
 * Plan tab reconciliation for a batch of file changes.
 *
 * @param changes   The watcher's change batch (absolute paths).
 * @param openPaths Absolute paths of currently-open file tabs.
 * @param isDirty   Whether an open tab has unsaved edits.
 */
export function reconcileOpenTabs(
  changes: ReadonlyArray<FileChange>,
  openPaths: ReadonlySet<string>,
  isDirty: (path: string) => boolean,
): TabReconcileActions {
  const close = new Set<string>()
  const markDeleted = new Set<string>()
  const clearDeleted = new Set<string>()
  const reload = new Set<string>()
  const markChangedOnDisk = new Set<string>()

  for (const change of changes) {
    if (change.type === 'deleted') {
      // Match the exact file, and any open file UNDER a deleted directory.
      for (const path of openPaths) {
        if (path === change.path || path.startsWith(`${change.path}/`)) {
          if (isDirty(path)) markDeleted.add(path)
          else close.add(path)
        }
      }
    } else if (openPaths.has(change.path)) {
      // The file exists again (recreated / modified) — a stale "deleted" flag is void,
      // and the on-disk content changed: reload a clean tab, flag a dirty one (#353).
      clearDeleted.add(change.path)
      if (isDirty(change.path)) markChangedOnDisk.add(change.path)
      else reload.add(change.path)
    }
  }

  // A path recreated/changed in the same batch it was deleted is present, not gone —
  // so it must not stay in the "deleted"/close sets (atomic saves = unlink + create).
  for (const path of clearDeleted) markDeleted.delete(path)
  for (const path of reload) close.delete(path)
  for (const path of markChangedOnDisk) close.delete(path)

  return {
    close: [...close],
    markDeleted: [...markDeleted],
    clearDeleted: [...clearDeleted],
    reload: [...reload],
    markChangedOnDisk: [...markChangedOnDisk],
  }
}

/**
 * Whether a queued reload should still APPLY after its async `readFile` resolved.
 * The clean-vs-dirty decision is made synchronously at reconcile time, but the read
 * is async — during it the tab may have closed or the user may have typed (going
 * dirty). Re-assert before overwriting the model, or an in-flight edit is silently
 * clobbered (#357). A now-dirty tab falls through to the changed-on-disk guard instead.
 */
export function shouldApplyReload(stillOpen: boolean, isBinary: boolean, isDirty: boolean): boolean {
  return stillOpen && !isBinary && !isDirty
}

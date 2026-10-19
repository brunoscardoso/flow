import { reconcileOpenTabs, shouldApplyReload } from './tab-reconcile'
import type { FileChange } from '../../shared/ipc-contract'

const del = (path: string): FileChange => ({ type: 'deleted', path })
const add = (path: string): FileChange => ({ type: 'created', path })
const chg = (path: string): FileChange => ({ type: 'changed', path })

const open = (...paths: string[]) => new Set(paths)
const clean = () => false
const allDirty = () => true

/** Full empty-actions object, so `toEqual` covers every field (#294 + #353). */
const NONE = { close: [], markDeleted: [], clearDeleted: [], reload: [], markChangedOnDisk: [] }

describe('reconcileOpenTabs (#294 delete/rename)', () => {
  it('closes a clean open tab whose file was deleted', () => {
    expect(reconcileOpenTabs([del('/r/foo.ts')], open('/r/foo.ts'), clean)).toEqual({
      ...NONE,
      close: ['/r/foo.ts'],
    })
  })

  it('flags (does NOT close) a DIRTY tab whose file was deleted', () => {
    expect(reconcileOpenTabs([del('/r/foo.ts')], open('/r/foo.ts'), allDirty)).toEqual({
      ...NONE,
      markDeleted: ['/r/foo.ts'],
    })
  })

  it('handles a rename (delete old + create new): closes the clean old tab, ignores the new path', () => {
    expect(
      reconcileOpenTabs([del('/r/foo.ts'), add('/r/bar.ts')], open('/r/foo.ts'), clean),
    ).toEqual({ ...NONE, close: ['/r/foo.ts'] })
  })

  it('reconciles open files under a deleted directory', () => {
    const a = reconcileOpenTabs([del('/r/src')], open('/r/src/foo.ts', '/r/other.ts'), clean)
    expect(a.close).toEqual(['/r/src/foo.ts'])
  })

  it('ignores changes to files that are not open', () => {
    expect(reconcileOpenTabs([del('/r/closed.ts')], open('/r/foo.ts'), clean)).toEqual(NONE)
  })
})

describe('reconcileOpenTabs (#353 external content change)', () => {
  it('reloads a CLEAN tab whose file changed on disk', () => {
    const a = reconcileOpenTabs([chg('/r/foo.ts')], open('/r/foo.ts'), clean)
    expect(a.reload).toEqual(['/r/foo.ts'])
    expect(a.markChangedOnDisk).toEqual([])
    expect(a.clearDeleted).toEqual(['/r/foo.ts']) // a stale delete-flag is void
  })

  it('flags a DIRTY tab whose file changed on disk (no silent reload/clobber)', () => {
    const a = reconcileOpenTabs([chg('/r/foo.ts')], open('/r/foo.ts'), allDirty)
    expect(a.markChangedOnDisk).toEqual(['/r/foo.ts'])
    expect(a.reload).toEqual([]) // dirty → never reloaded out from under the user
  })

  it('treats an atomic replace (delete+create same path) on a clean tab as a reload, not a close', () => {
    // Atomic writes surface as unlink + add; the file is present, so reload — never close.
    const a = reconcileOpenTabs([del('/r/foo.ts'), add('/r/foo.ts')], open('/r/foo.ts'), clean)
    expect(a.close).toEqual([])
    expect(a.reload).toEqual(['/r/foo.ts'])
  })

  it('a delete+recreate on a DIRTY tab flags changed-on-disk, not deleted', () => {
    const a = reconcileOpenTabs([del('/r/foo.ts'), add('/r/foo.ts')], open('/r/foo.ts'), allDirty)
    expect(a.markDeleted).toEqual([])
    expect(a.markChangedOnDisk).toEqual(['/r/foo.ts'])
  })

  it('ignores a content change to a file that is not open', () => {
    expect(reconcileOpenTabs([chg('/r/closed.ts')], open('/r/foo.ts'), clean)).toEqual(NONE)
  })
})

describe('shouldApplyReload (#357 async apply guard)', () => {
  it('applies a queued reload when the tab is still open, not binary, and CLEAN', () => {
    expect(shouldApplyReload(true, false, false)).toBe(true)
  })

  it('does NOT apply when the tab went DIRTY during the async read (no silent clobber)', () => {
    expect(shouldApplyReload(true, false, true)).toBe(false)
  })

  it('does NOT apply when the tab closed during the read', () => {
    expect(shouldApplyReload(false, false, false)).toBe(false)
  })

  it('does NOT apply to a binary file', () => {
    expect(shouldApplyReload(true, true, false)).toBe(false)
  })
})

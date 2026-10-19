import type { TabSet } from '../../shared/ipc-contract'
import { rescueOrphanedBuffers } from './orphaned-buffers'

const ROOT = '/repo/one'

function set(extra: Partial<TabSet> = {}): TabSet {
  return { openFiles: [], activeFile: null, dirtyBuffers: {}, openViews: [], ...extra }
}

describe('rescueOrphanedBuffers', () => {
  it('moves a deleted thread’s unsaved file into the project set, tab and text together', () => {
    const orphan = set({
      openFiles: [{ rootPath: ROOT, relPath: 'src/a.ts', active: true, dirtyBaseline: 'h1' }],
      dirtyBuffers: { [`${ROOT}/src/a.ts`]: 'typed in the thread' },
    })
    const project = set({ openFiles: [{ rootPath: ROOT, relPath: 'README.md' }] })
    const rescued = rescueOrphanedBuffers(ROOT, project, orphan)
    expect(rescued?.openFiles).toEqual([
      { rootPath: ROOT, relPath: 'README.md' },
      // Not made active — the project set's own active tab stays.
      { rootPath: ROOT, relPath: 'src/a.ts', dirtyBaseline: 'h1' },
    ])
    expect(rescued?.dirtyBuffers).toEqual({ [`${ROOT}/src/a.ts`]: 'typed in the thread' })
  })

  it('keeps BOTH texts when the project set has its own unsaved text for that file', () => {
    const key = `${ROOT}/src/a.ts`
    const orphan = set({ openFiles: [{ rootPath: ROOT, relPath: 'src/a.ts' }], dirtyBuffers: { [key]: 'thread text' } })
    const project = set({ openFiles: [{ rootPath: ROOT, relPath: 'src/a.ts' }], dirtyBuffers: { [key]: 'project text' } })
    const rescued = rescueOrphanedBuffers(ROOT, project, orphan)
    expect(rescued?.dirtyBuffers).toEqual({ [key]: 'project text', 'untitled:1': 'thread text' })
    expect(rescued?.openFiles.at(-1)).toEqual({ rootPath: ROOT, relPath: 'Untitled-1', untitled: true })
  })

  it('renumbers a scratch note past the project set’s own notes', () => {
    const orphan = set({
      openFiles: [{ rootPath: ROOT, relPath: 'Untitled-1', untitled: true }],
      dirtyBuffers: { 'untitled:1': 'a thought' },
    })
    const project = set({
      openFiles: [{ rootPath: ROOT, relPath: 'Untitled-4', untitled: true }],
      dirtyBuffers: { 'untitled:4': 'another' },
    })
    const rescued = rescueOrphanedBuffers(ROOT, project, orphan)
    expect(rescued?.dirtyBuffers['untitled:5']).toBe('a thought')
    expect(rescued?.dirtyBuffers['untitled:4']).toBe('another')
  })

  it('does not add the same text twice (a delete, then the refused late save)', () => {
    const orphan = set({
      openFiles: [{ rootPath: ROOT, relPath: 'Untitled-1', untitled: true }],
      dirtyBuffers: { 'untitled:1': 'a thought' },
    })
    const once = rescueOrphanedBuffers(ROOT, set(), orphan)
    expect(once).not.toBeNull()
    expect(rescueOrphanedBuffers(ROOT, once as TabSet, orphan)).toBeNull()
  })

  it('has nothing to do for a set with no unsaved text', () => {
    expect(rescueOrphanedBuffers(ROOT, set(), set({ openFiles: [{ rootPath: ROOT, relPath: 'a.ts' }] }))).toBeNull()
  })
})

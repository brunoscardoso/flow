import {
  contentHash,
  decideDirtyRestore,
  decideLiveReopen,
  isMonacoCancellation,
  modelsToRelease,
} from './buffer-baseline'

describe('contentHash', () => {
  it('is stable for the same text and differs for different text', () => {
    expect(contentHash('export const a = 1\n')).toBe(contentHash('export const a = 1\n'))
    expect(contentHash('export const a = 1\n')).not.toBe(contentHash('export const a = 2\n'))
    expect(contentHash('')).not.toBe(contentHash(' '))
  })
})

describe('decideDirtyRestore', () => {
  it('keeps a live buffer rather than applying an older snapshot over it', () => {
    // T1 typed in a.ts, T2 then saved a.ts: returning to T1 must not put T1's
    // snapshot back over the saved file and revert T2's change on the next save.
    expect(decideDirtyRestore({ wasLive: true, capturedBaseline: 'x', diskBaseline: 'y' })).toBe('keep-live')
  })

  it('restores a snapshot typed over the content still on disk', () => {
    expect(decideDirtyRestore({ wasLive: false, capturedBaseline: 'x', diskBaseline: 'x' })).toBe('restore')
  })

  it('flags a snapshot whose file changed on disk since it was captured', () => {
    expect(decideDirtyRestore({ wasLive: false, capturedBaseline: 'x', diskBaseline: 'y' })).toBe(
      'restore-changed-on-disk',
    )
  })

  it('restores a legacy snapshot that carries no baseline', () => {
    expect(decideDirtyRestore({ wasLive: false, capturedBaseline: undefined, diskBaseline: 'y' })).toBe('restore')
  })
})

describe('decideLiveReopen', () => {
  it('keeps a buffer that agrees with the disk', () => {
    expect(decideLiveReopen({ dirty: true, baseline: 'a', disk: 'a' })).toBe('keep')
    expect(decideLiveReopen({ dirty: false, baseline: 'a', disk: 'a' })).toBe('keep')
  })

  it('reloads a clean buffer the disk moved past, and flags a dirty one', () => {
    expect(decideLiveReopen({ dirty: false, baseline: 'a', disk: 'b' })).toBe('reload')
    expect(decideLiveReopen({ dirty: true, baseline: 'a', disk: 'b' })).toBe('flag-changed-on-disk')
  })
})

describe('modelsToRelease', () => {
  it('lets go of clean models no tab holds and keeps every dirty file buffer', () => {
    const dirty = new Set(['/r/dirty.ts', 'untitled:3'])
    const release = modelsToRelease({
      live: ['/r/open.ts', '/r/clean.ts', '/r/dirty.ts', 'untitled:3'],
      open: new Set(['/r/open.ts']),
      isDirty: (path) => dirty.has(path),
      isUntitled: (path) => path.startsWith('untitled:'),
    })
    expect(release).toEqual(['/r/clean.ts', 'untitled:3'])
  })
})

describe('isMonacoCancellation', () => {
  it('matches only the Canceled/Canceled error Monaco rejects with', () => {
    const canceled = new Error('Canceled')
    canceled.name = 'Canceled'
    expect(isMonacoCancellation(canceled)).toBe(true)
    expect(isMonacoCancellation({ name: 'Canceled', message: 'Canceled' })).toBe(true)
    expect(isMonacoCancellation(new Error('Canceled'))).toBe(false)
    const other = new Error('Request canceled by user')
    other.name = 'Canceled'
    expect(isMonacoCancellation(other)).toBe(false)
    expect(isMonacoCancellation('Canceled')).toBe(false)
    expect(isMonacoCancellation(null)).toBe(false)
  })
})

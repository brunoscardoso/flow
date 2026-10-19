import { resolveActiveRoot, isRootAvailable } from './root-selection'
import type { RegisteredProject } from './ipc-contract'

const root = (rootPath: string, available?: boolean): RegisteredProject => ({
  id: rootPath,
  windowId: 'w1',
  rootPath,
  position: 0,
  addedAt: '2026-07-29T00:00:00Z',
  ...(available === undefined ? {} : { available }),
})

describe('isRootAvailable', () => {
  it('treats an absent flag as available (a root never partitioned, #263)', () => {
    expect(isRootAvailable(root('/a'))).toBe(true)
    expect(isRootAvailable(root('/a', true))).toBe(true)
    expect(isRootAvailable(root('/a', false))).toBe(false)
  })
})

describe('resolveActiveRoot — the shared activation seam (#974/#975/#1080/#1118)', () => {
  it('honors a request for a known, reachable root', () => {
    const decision = resolveActiveRoot([root('/a'), root('/b')], '/b')
    expect(decision).toEqual({ rootPath: '/b', reason: 'requested', rejected: null })
  })

  it('#975: never activates a root whose folder is gone — falls back to a survivor', () => {
    const decision = resolveActiveRoot([root('/keep', true), root('/gone', false)], '/gone')
    expect(decision).toEqual({ rootPath: '/keep', reason: 'fallback', rejected: '/gone' })
  })

  it('#1080: a pointer at a path that is no longer a root still lands somewhere', () => {
    // The exact boot state removal used to leave behind: workspace_state's
    // newest row names a project that was removed, so it isn't in `roots`.
    const decision = resolveActiveRoot([root('/survivor')], '/removed')
    expect(decision).toEqual({ rootPath: '/survivor', reason: 'fallback', rejected: '/removed' })
  })

  it('picks the FIRST available root, skipping unavailable ones ahead of it', () => {
    const roots = [root('/gone1', false), root('/gone2', false), root('/live', true)]
    expect(resolveActiveRoot(roots, null).rootPath).toBe('/live')
  })

  it('reports `none` — with the rejected path — when nothing is reachable', () => {
    const decision = resolveActiveRoot([root('/gone', false)], '/gone')
    expect(decision).toEqual({ rootPath: null, reason: 'none', rejected: '/gone' })
  })

  it('reports `none` with no rejection when there are simply no roots at all', () => {
    expect(resolveActiveRoot([], null)).toEqual({
      rootPath: null,
      reason: 'none',
      rejected: null,
    })
  })

  it('a null request means "put me somewhere valid", not "activate nothing"', () => {
    const decision = resolveActiveRoot([root('/a'), root('/b')], null)
    expect(decision).toEqual({ rootPath: '/a', reason: 'fallback', rejected: null })
  })
})

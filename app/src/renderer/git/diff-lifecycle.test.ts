import { isDiffCurrent, resolveOpenDiffFate, shouldCloseDiff } from './diff-lifecycle'

const alive = (...roots: string[]): Set<string> => new Set(roots)

describe('shouldCloseDiff (#191)', () => {
  it('keeps an open diff that belongs to the focused, still-alive project', () => {
    expect(shouldCloseDiff('/repo/a', '/repo/a', alive('/repo/a', '/repo/b'))).toBe(false)
  })

  it('closes a diff when focus moves to another project', () => {
    // Diff was opened in A; the active project is now B → stale, close it.
    expect(shouldCloseDiff('/repo/a', '/repo/b', alive('/repo/a', '/repo/b'))).toBe(true)
  })

  it("closes a diff when the diff's own root was removed from the project list", () => {
    expect(shouldCloseDiff('/repo/a', '/repo/a', alive('/repo/b'))).toBe(true)
  })

  it('closes a diff when focus drops to no active project (early boot / all closed)', () => {
    expect(shouldCloseDiff('/repo/a', null, alive('/repo/a'))).toBe(true)
  })

  it('does nothing when no diff is open', () => {
    expect(shouldCloseDiff(null, '/repo/a', alive('/repo/a'))).toBe(false)
    expect(shouldCloseDiff(null, null, alive())).toBe(false)
  })

  // The same predicate gates a just-resolved in-flight diff: the coordinator
  // passes the diff's REQUESTED root and the CURRENT active root after show()
  // resolves, so a click-then-switch drops the diff instead of pinning A's
  // content over B (#288).
  it('drops an in-flight diff whose focus moved before it resolved (#288)', () => {
    // Clicked in A, switched to B during git:diff → requested A, focus now B.
    expect(shouldCloseDiff('/repo/a', '/repo/b', alive('/repo/a', '/repo/b'))).toBe(true)
    // No switch happened → the resolved diff is kept.
    expect(shouldCloseDiff('/repo/a', '/repo/a', alive('/repo/a', '/repo/b'))).toBe(false)
  })
})

describe('isDiffCurrent (#315)', () => {
  const both = alive('/repo/a', '/repo/b')

  it('lets the latest request paint when its project is still focused', () => {
    expect(isDiffCurrent(3, 3, '/repo/a', '/repo/a', both)).toBe(true)
  })

  it('suppresses a request superseded by a newer click — even for the same, focused project', () => {
    // Clicked X (gen 1) then Z (gen 2) in A; X resolves late → must not paint over Z.
    expect(isDiffCurrent(1, 2, '/repo/a', '/repo/a', both)).toBe(false)
  })

  it('suppresses the latest request when focus already left its root (no wrong-project flash)', () => {
    // Repro A: A's slow diff resolves after switching to B → never reaches show().
    expect(isDiffCurrent(2, 2, '/repo/a', '/repo/b', both)).toBe(false)
  })

  it('suppresses the latest request when its root was removed from the project list', () => {
    expect(isDiffCurrent(2, 2, '/repo/a', '/repo/a', alive('/repo/b'))).toBe(false)
  })
})

describe('resolveOpenDiffFate (#402)', () => {
  it('is idle when no working-tree file diff is open', () => {
    expect(resolveOpenDiffFate(null, alive('a.txt'))).toBe('idle')
  })

  it('refreshes when the diffed file is still in the changes list', () => {
    expect(resolveOpenDiffFate('alpha.txt', alive('alpha.txt', 'delta.txt'))).toBe('refresh')
  })

  it('closes when the diffed file left the changes list (committed/reverted away)', () => {
    expect(resolveOpenDiffFate('alpha.txt', alive('delta.txt'))).toBe('close')
    expect(resolveOpenDiffFate('alpha.txt', alive())).toBe('close')
  })

  it('matches a new-directory entry by its exact trailing-slash path', () => {
    expect(resolveOpenDiffFate('newdir/', alive('newdir/'))).toBe('refresh')
    expect(resolveOpenDiffFate('newdir/', alive('newdir'))).toBe('close')
  })
})

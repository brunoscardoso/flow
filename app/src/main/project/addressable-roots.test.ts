// The address gate's own edges (Phase 3.5). The gate decides what the app will
// READ AND WRITE through, so the cases that must never widen are the point of
// this file — an absent source, a thread with no checkout, a blank row.

import { createAddressableRoots } from './addressable-roots'

const PROJECT = '/repo/project'
const WORKTREE = '/repo/.project-threads/thread-a'

describe('createAddressableRoots', () => {
  it('answers registered roots without any thread source at all', () => {
    const gate = createAddressableRoots({ registeredRoots: () => [{ rootPath: PROJECT }] })
    expect(gate.isAddressable(PROJECT)).toBe(true)
    expect(gate.isAddressable(WORKTREE)).toBe(false)
    expect(gate.ownerCheckoutFor(PROJECT)).toBeNull()
  })

  it('normalizes both sides before comparing', () => {
    const gate = createAddressableRoots({
      registeredRoots: () => [{ rootPath: `${PROJECT}/` }],
      threadWorktrees: () => [{ worktreePath: `${WORKTREE}/`, projectRoot: PROJECT }],
    })
    expect(gate.isAddressable(`${PROJECT}/sub/..`)).toBe(true)
    expect(gate.isAddressable(WORKTREE)).toBe(true)
    expect(gate.ownerCheckoutFor(`${WORKTREE}/`)).toBe(PROJECT)
  })

  it('widens nothing for a thread that owns no checkout', () => {
    // The store's own reader excludes null `worktree_path` rows in SQL; this is
    // the belt on top of it, because a null here would read as "the root ''".
    const gate = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }],
      threadWorktrees: () =>
        [
          { worktreePath: null, projectRoot: PROJECT },
          { worktreePath: '', projectRoot: PROJECT },
          { worktreePath: WORKTREE, projectRoot: '' },
        ] as never,
    })
    expect(gate.isAddressable('')).toBe(false)
    expect(gate.isAddressable(WORKTREE)).toBe(false)
    expect(gate.ownerCheckoutFor(WORKTREE)).toBeNull()
  })

  it('widens nothing when there are no threads', () => {
    const gate = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }],
      threadWorktrees: () => [],
    })
    expect(gate.isAddressable(WORKTREE)).toBe(false)
  })

  it('gives a registered root no owner checkout — a project is not a checkout', () => {
    // Symlink containment must not be widened for the user's actual project,
    // whatever a stray row claims.
    const gate = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }],
      threadWorktrees: () => [{ worktreePath: PROJECT, projectRoot: '/repo/other' }],
    })
    expect(gate.isAddressable(PROJECT)).toBe(true)
    expect(gate.ownerCheckoutFor(PROJECT)).toBeNull()
  })

  it('reports no owner for a worktree recorded as its own checkout', () => {
    const gate = createAddressableRoots({
      registeredRoots: () => [],
      threadWorktrees: () => [{ worktreePath: WORKTREE, projectRoot: WORKTREE }],
    })
    expect(gate.isAddressable(WORKTREE)).toBe(true)
    expect(gate.ownerCheckoutFor(WORKTREE)).toBeNull()
  })

  it('refuses loudly when the thread source throws', () => {
    const gate = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }],
      threadWorktrees: () => {
        throw new Error('store locked')
      },
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(gate.isAddressable(WORKTREE)).toBe(false)
    expect(gate.ownerCheckoutFor(WORKTREE)).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('addressablePaths — the gate, enumerated (reveal-in-a-worktree)', () => {
  const PROJECT = '/Users/me/Projects/app'
  const WORKTREE = '/Users/me/Projects/.plan-flow-threads/abc123'

  it('lists a thread checkout beside the project — the bug: it sits OUTSIDE the project', () => {
    const roots = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }],
      threadWorktrees: () => [{ worktreePath: WORKTREE, projectRoot: PROJECT }],
    })
    // The checkout is a sibling, so no prefix of the project list contains it —
    // which is exactly why mapping a tab against `project:list` found nothing.
    expect(WORKTREE.startsWith(`${PROJECT}/`)).toBe(false)
    expect(roots.addressablePaths()).toContain(WORKTREE)
    expect(roots.addressablePaths()).toContain(PROJECT)
  })

  it('agrees with isAddressable — one question, asked both ways', () => {
    const roots = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }],
      threadWorktrees: () => [{ worktreePath: WORKTREE, projectRoot: PROJECT }],
    })
    for (const path of roots.addressablePaths()) {
      expect(roots.isAddressable(path)).toBe(true)
    }
  })

  it('returns the innermost root first, so a prefix match cannot pick the outer one', () => {
    const nested = `${PROJECT}/packages/inner`
    const roots = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }, { rootPath: nested }],
    })
    expect(roots.addressablePaths()[0]).toBe(nested)
  })

  it('omits a thread with no checkout, and one with no owning root', () => {
    const roots = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }],
      threadWorktrees: () => [
        { worktreePath: '', projectRoot: PROJECT },
        { worktreePath: '/Users/me/orphan', projectRoot: '' },
      ],
    })
    expect(roots.addressablePaths()).toEqual([PROJECT])
  })

  it('falls back to the registered roots when the store cannot be read — never wider', () => {
    const roots = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }],
      threadWorktrees: () => {
        throw new Error('store is down')
      },
    })
    expect(roots.addressablePaths()).toEqual([PROJECT])
  })

  it('says nothing twice', () => {
    const roots = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }, { rootPath: PROJECT }],
      threadWorktrees: () => [{ worktreePath: PROJECT, projectRoot: PROJECT }],
    })
    expect(roots.addressablePaths()).toEqual([PROJECT])
  })
})

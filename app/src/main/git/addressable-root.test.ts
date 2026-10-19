// The git write channels' root gate (Phase 3.5).
//
// git:resolveConflict / resolveConflictHunk / completeMerge / continueRebase /
// reconcileAgentClash all take `rootId` straight from the renderer and use it as
// a git working directory, so each one calls assertKnownRoot first. Once a
// thread owns a worktree the renderer addresses THAT — and a worktree is never a
// registered project root, so a conflict inside a thread's own checkout was
// refused rather than opened in the merge editor.

import { GitManager } from './git-manager'
import { assertKnownRoot } from './index'
import { createAddressableRoots } from '../project/addressable-roots'

const PROJECT = '/tmp/flow-gate/project'
const WORKTREE = '/tmp/flow-gate/.project-threads/thread-a'
const ELSEWHERE = '/tmp/flow-gate/elsewhere'

function managerWithRoots(roots: string[]): GitManager {
  return new GitManager({
    getRoots: () => roots.map((rootPath) => ({ rootPath })),
    onRootsChanged: () => () => undefined,
  })
}

describe('assertKnownRoot', () => {
  it('accepts a registered project root', () => {
    const gitManager = managerWithRoots([PROJECT])
    expect(() => assertKnownRoot(gitManager, PROJECT)).not.toThrow()
  })

  it('refuses an arbitrary path as a git working directory', () => {
    const gitManager = managerWithRoots([PROJECT])
    expect(() => assertKnownRoot(gitManager, ELSEWHERE)).toThrow(/Unknown repository root/)
  })

  it("accepts a thread's worktree when the shared gate is passed", () => {
    const gitManager = managerWithRoots([PROJECT])
    const gate = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }],
      threadWorktrees: () => [{ worktreePath: WORKTREE, projectRoot: PROJECT }],
    })
    expect(() => assertKnownRoot(gitManager, WORKTREE, gate)).not.toThrow()
    // The widening is the recorded worktrees and nothing else.
    expect(() => assertKnownRoot(gitManager, ELSEWHERE, gate)).toThrow(/Unknown repository root/)
  })

  it("refuses a thread's worktree without the gate — the pre-worktree rule", () => {
    const gitManager = managerWithRoots([PROJECT])
    expect(() => assertKnownRoot(gitManager, WORKTREE)).toThrow(/Unknown repository root/)
  })

  it('fails OPEN when the roots list itself cannot be read', () => {
    // A provider hiccup must never block a legitimate resolve — the behaviour
    // this gate has always had, preserved through the shared predicate.
    const gitManager = {
      knownRootPaths: () => {
        throw new Error('provider down')
      },
    } as unknown as GitManager
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() => assertKnownRoot(gitManager, ELSEWHERE)).not.toThrow()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('refuses — and says why — when the thread store cannot be read', () => {
    // Fail CLOSED on the widening half: an unreadable store must never GRANT a
    // root, and never do it silently either.
    const gitManager = managerWithRoots([PROJECT])
    const gate = createAddressableRoots({
      registeredRoots: () => [{ rootPath: PROJECT }],
      threadWorktrees: () => {
        throw new Error('store locked')
      },
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(() => assertKnownRoot(gitManager, WORKTREE, gate)).toThrow(/Unknown repository root/)
    expect(warn).toHaveBeenCalled()
    // A registered root is answered without ever touching the store.
    warn.mockClear()
    expect(() => assertKnownRoot(gitManager, PROJECT, gate)).not.toThrow()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

// sessionRootFor — the ONE answer to "where does this thread work". Autopilot's
// stage gates look for the run's artifacts there and brain capture resolves the
// thread's tool-call paths against it; if it answered the project root for a
// thread with its own worktree, both would see nothing the run wrote.

import { sessionRootFor } from './session-root'

describe('sessionRootFor', () => {
  it('answers the worktree for a thread that has its own worktree', () => {
    expect(
      sessionRootFor({ projectRoot: '/repo/project', worktreePath: '/repo/.worktrees/feat-x' }),
    ).toBe('/repo/.worktrees/feat-x')
  })

  it('answers the project root for a plain thread (no worktree) — unchanged behaviour', () => {
    expect(sessionRootFor({ projectRoot: '/repo/project', worktreePath: null })).toBe(
      '/repo/project',
    )
  })
})

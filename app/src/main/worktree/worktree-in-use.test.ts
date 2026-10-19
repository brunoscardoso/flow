// worktree-in-use — the rule that stops the disk cap deleting a checkout
// somebody is working in, or is one instant away from working in.

import { isWorktreeInUse, WORKTREE_CUT_GRACE_MS } from './worktree-in-use'

const OLD = WORKTREE_CUT_GRACE_MS * 10

describe('isWorktreeInUse', () => {
  it('protects a checkout whose thread has a live session', () => {
    // The session's cwd was fixed at spawn and cannot be moved. Removing the
    // directory does not redirect the agent — it strands it, and the agent then
    // recreates the path as an empty non-git shell.
    expect(isWorktreeInUse({ hasLiveSession: true, status: 'done', ageMs: OLD })).toBe(true)
  })

  it('protects a checkout younger than the grace window', () => {
    // THE ACTUAL INCIDENT. At sweep time the session that will use the new
    // checkout does not exist yet, so a live-session check alone cannot see the
    // thing being destroyed.
    expect(
      isWorktreeInUse({ hasLiveSession: false, status: 'idle', ageMs: WORKTREE_CUT_GRACE_MS - 1 }),
    ).toBe(true)
  })

  it('protects a thread that is working', () => {
    expect(isWorktreeInUse({ hasLiveSession: false, status: 'working', ageMs: OLD })).toBe(true)
  })

  it('protects a thread parked on a question or blocked', () => {
    // It resumes into this same checkout the moment it is answered.
    for (const status of ['needs-decision', 'blocked'] as const) {
      expect(isWorktreeInUse({ hasLiveSession: false, status, ageMs: OLD })).toBe(true)
    }
  })

  it('protects a checkout whose age cannot be read', () => {
    // A false answer here deletes a directory. Unreadable is not "safe".
    expect(isWorktreeInUse({ hasLiveSession: false, status: 'idle', ageMs: null })).toBe(true)
  })

  it('releases an old, resting checkout with nobody in it', () => {
    // The case the cap exists for: ten copies of a repository on disk, and this
    // one has been finished with.
    expect(isWorktreeInUse({ hasLiveSession: false, status: 'done', ageMs: OLD })).toBe(false)
    expect(isWorktreeInUse({ hasLiveSession: false, status: 'idle', ageMs: OLD })).toBe(false)
  })

  it('releases a checkout whose thread is gone', () => {
    // No thread, no session, old enough — nothing can be waiting on it.
    expect(isWorktreeInUse({ hasLiveSession: false, status: null, ageMs: OLD })).toBe(false)
  })

  it('takes the grace window as an override, for a caller that knows better', () => {
    const facts = { hasLiveSession: false, status: 'idle' as const, ageMs: 5_000 }
    expect(isWorktreeInUse({ ...facts, graceMs: 10_000 })).toBe(true)
    expect(isWorktreeInUse({ ...facts, graceMs: 1_000 })).toBe(false)
  })

  it('gives a fresh cut long enough for a session to spawn', () => {
    // Measured on the machine that hit this: threads:prepareWorktree took
    // 2.5–3.2 s, and the orphan appeared ~20 s after the cut.
    expect(WORKTREE_CUT_GRACE_MS).toBeGreaterThanOrEqual(30_000)
  })
})

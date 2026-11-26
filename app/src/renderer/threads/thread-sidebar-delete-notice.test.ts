import { humanSize, threadDeleteNotice, type ThreadDeleteSubject } from './thread-sidebar-delete-notice'

const subject = (over: Partial<ThreadDeleteSubject> = {}): ThreadDeleteSubject => ({
  threadTitle: 'Fix the sidebar flicker',
  hasWorktree: true,
  branch: 'thread/fix-the-sidebar-flicker',
  changedFiles: 12,
  ...over,
})

describe('threadDeleteNotice', () => {
  it('is exactly today’s confirm for a thread with no worktree', () => {
    const notice = threadDeleteNotice(subject({ hasWorktree: false }))
    expect(notice).toEqual({
      question: 'Delete this thread?',
      detail: null,
      confirmLabel: 'Delete',
      releaseWorktree: false,
    })
  })

  it('keeps the task-owned question shape (#1061)', () => {
    const notice = threadDeleteNotice(
      subject({ hasWorktree: false, owningTaskTitle: 'Ship the board' }),
    )
    expect(notice.question).toBe('This chat belongs to the task “Ship the board”. Delete it anyway?')
  })

  it('carries the task question through even when the thread has a worktree', () => {
    const notice = threadDeleteNotice(subject({ owningTaskTitle: 'Ship the board' }))
    expect(notice.question).toContain('Ship the board')
    expect(notice.detail).not.toBeNull()
  })

  it('reports the file count and the branch name', () => {
    const detail = threadDeleteNotice(subject()).detail ?? ''
    expect(detail).toContain('12 files changed')
    expect(detail).toContain('thread/fix-the-sidebar-flicker')
  })

  it('says the worktree and the branch survive — the whole point of the design', () => {
    const detail = threadDeleteNotice(subject()).detail ?? ''
    expect(detail).toContain('leaves its files and thread/fix-the-sidebar-flicker exactly where they are')
  })

  it('singularises one file', () => {
    expect(threadDeleteNotice(subject({ changedFiles: 1 })).detail).toContain('1 file changed')
  })

  it('names an untitled thread rather than leaving a gap', () => {
    expect(threadDeleteNotice(subject({ threadTitle: null })).detail).toContain('“Untitled thread”')
  })

  it('makes the destructive button say what it destroys', () => {
    expect(threadDeleteNotice(subject()).confirmLabel).toBe('Delete the conversation')
  })

  it('says the branch has no name yet rather than guessing one', () => {
    const detail = threadDeleteNotice(subject({ branch: null })).detail ?? ''
    expect(detail).toContain('on no branch yet')
    expect(detail).toContain('leaves its files and its changes exactly where they are')
  })

  it('does not invent a count it could not read', () => {
    const detail = threadDeleteNotice(subject({ changedFiles: null })).detail ?? ''
    expect(detail).toContain('files of its own')
    expect(detail).not.toMatch(/\d+ files?/)
  })

  // ── The copy holds work: it survives, and nothing releases it ─────────────

  describe('a worktree holding work that lives nowhere else', () => {
    it('never releases the copy when files are uncommitted', () => {
      expect(threadDeleteNotice(subject({ changedFiles: 12 })).releaseWorktree).toBe(false)
    })

    it('never releases the copy when commits have not reached the base', () => {
      const notice = threadDeleteNotice(subject({ changedFiles: 0, aheadCommits: 3 }))
      expect(notice.releaseWorktree).toBe(false)
      expect(notice.detail).toContain('3 saved changes')
      expect(notice.detail).toContain('haven’t landed anywhere else')
      expect(notice.detail).toContain(
        'leaves its files and thread/fix-the-sidebar-flicker exactly where they are',
      )
    })

    it('singularises one unlanded commit', () => {
      const detail = threadDeleteNotice(subject({ changedFiles: 0, aheadCommits: 1 })).detail ?? ''
      expect(detail).toContain('1 saved change that hasn’t landed anywhere else')
    })

    it('counts uncommitted files ahead of commits — the bigger loss is named first', () => {
      const detail = threadDeleteNotice(subject({ changedFiles: 4, aheadCommits: 2 })).detail ?? ''
      expect(detail).toContain('4 files changed')
    })
  })

  // ── The copy holds nothing: it goes with the conversation ────────────────

  describe('a worktree with nothing to lose', () => {
    it('frees a landed copy and says which record survives it', () => {
      const notice = threadDeleteNotice(subject({ changedFiles: 0, aheadCommits: 0 }))
      expect(notice.releaseWorktree).toBe(true)
      expect(notice.detail).toContain('Everything “Fix the sidebar flicker” did is on the branch')
      expect(notice.detail).toContain('frees its files')
      expect(notice.detail).toContain('thread/fix-the-sidebar-flicker keeps the record')
    })

    it('treats a missing base as nothing held — the same answer the release path gives', () => {
      const notice = threadDeleteNotice(subject({ changedFiles: 0, aheadCommits: null }))
      expect(notice.releaseWorktree).toBe(true)
    })

    it('frees an untouched copy that never got a branch', () => {
      const notice = threadDeleteNotice(subject({ changedFiles: 0, branch: null }))
      expect(notice.releaseWorktree).toBe(true)
      expect(notice.detail).toContain('files of its own with nothing in them')
      expect(notice.detail).toContain('frees the space they were taking')
    })

    it('never promises silently — a released copy is always said out loud', () => {
      for (const state of [
        subject({ changedFiles: 0 }),
        subject({ changedFiles: 0, branch: null }),
        subject({ changedFiles: null }),
      ]) {
        const notice = threadDeleteNotice(state)
        expect(notice.releaseWorktree).toBe(true)
        expect(notice.detail).toMatch(/frees/)
      }
    })
  })

  // ── The unread opening state ─────────────────────────────────────────────

  it('promises only what it can keep before the worktree has been read', () => {
    const notice = threadDeleteNotice(subject({ changedFiles: null }))
    // The press is safe either way — the release path keeps unlanded work — so
    // the copy IS released, and the sentence covers both outcomes rather than
    // claiming the one Flow cannot yet see.
    expect(notice.releaseWorktree).toBe(true)
    expect(notice.detail).toContain('unless they still hold work that is nowhere else')
    expect(notice.detail).toContain('they stay exactly where they are')
  })

  it('never offers to release a thread that has no worktree at all', () => {
    expect(threadDeleteNotice(subject({ hasWorktree: false })).releaseWorktree).toBe(false)
    expect(
      threadDeleteNotice(subject({ hasWorktree: false, changedFiles: null })).releaseWorktree,
    ).toBe(false)
  })

  it('never puts a path, a command or a config key on screen (forbidden-pattern #12)', () => {
    const states = [
      subject(),
      subject({ branch: null }),
      subject({ changedFiles: null }),
      subject({ changedFiles: 0 }),
      subject({ changedFiles: 0, branch: null }),
      subject({ changedFiles: 0, aheadCommits: 2 }),
      subject({ hasWorktree: false }),
    ]
    for (const state of states) {
      const notice = threadDeleteNotice(state)
      for (const text of [notice.question, notice.detail ?? '', notice.confirmLabel]) {
        expect(text).not.toMatch(/planflow-ai|git |\/Users\/|\.plan-flow-threads|worktree|`/)
      }
    }
  })
})

/**
 * A WORKTREE ON NO BRANCH IS NOT AN EMPTY ONE.
 *
 * A thread cut while the project sat on a detached HEAD (after a bisect, on a
 * tag) has commits that live on no ref at all — so `aheadCommits` comes back
 * null, because there is no base to count them against. Read as 0, the notice
 * said the conversation's files held nothing and offered to free them, and
 * freeing takes `.git/worktrees/<id>/` with its HEAD and reflog.
 */
describe('a null commit count is not zero', () => {
  it('never claims an uncountable worktree is empty', () => {
    // The wrong sentence was CASE 2's — the empty-and-safe one — printed over
    // commits reachable from nowhere else because a null count had been
    // coerced to 0 on the way in.
    const detail =
      threadDeleteNotice(subject({ branch: null, changedFiles: 0, aheadCommits: null })).detail ?? ''
    expect(detail).not.toContain('nothing in them')
    expect(detail).toContain('unless they still hold work that is nowhere else')
  })

  it('still says "empty" for a copy that is genuinely empty and countable', () => {
    // The regression guard for the fix: 0 must keep meaning zero.
    const detail =
      threadDeleteNotice(subject({ branch: null, changedFiles: 0, aheadCommits: 0 })).detail ?? ''
    expect(detail).toContain('nothing in them')
  })

  it('treats a count nobody supplied as before — not as a warning', () => {
    // `undefined` means this caller never computed it, which is not evidence of
    // anything; folding it in with null would have made every older surface
    // show the vague sentence instead of the one it has always shown.
    const detail = threadDeleteNotice(subject({ branch: null, changedFiles: 0 })).detail ?? ''
    expect(detail).toContain('nothing in them')
  })
})

describe('threadDeleteNotice — Docker data', () => {
  const GB = 1024 ** 3

  it('is byte-for-byte the same with no volumes, absent or null or empty', () => {
    const base = subject({ hasWorktree: false })
    const plain = threadDeleteNotice(base)
    expect(threadDeleteNotice({ ...base, dataVolumes: null })).toEqual(plain)
    expect(threadDeleteNotice({ ...base, dataVolumes: { count: 0, totalBytes: 0 } })).toEqual(plain)
    expect('volumesLine' in plain).toBe(false)
    expect('offerVolumes' in plain).toBe(false)
    expect('volumesLabel' in plain).toBe(false)
  })

  it('offers the volumes with their size, and leaves the rest of the notice alone', () => {
    const base = subject({ hasWorktree: false })
    const notice = threadDeleteNotice({ ...base, dataVolumes: { count: 1, totalBytes: 1.2 * GB } })
    expect(notice.offerVolumes).toBe(true)
    expect(notice.volumesLabel).toBe('Also delete its data')
    expect(notice.volumesLine).toBe('1 volume · 1.2 GB. Left unticked, the data stays and can be removed later from Storage.')
    expect({ ...notice, volumesLine: undefined, volumesLabel: undefined, offerVolumes: undefined }).toEqual({
      ...threadDeleteNotice(base),
      volumesLine: undefined,
      volumesLabel: undefined,
      offerVolumes: undefined,
    })
  })

  it('says plainly when the size is unknown, and counts several volumes', () => {
    const notice = threadDeleteNotice(subject({ dataVolumes: { count: 2, totalBytes: null } }))
    expect(notice.volumesLine).toBe('2 volumes · size unknown. Left unticked, the data stays and can be removed later from Storage.')
  })

  it('does not change the worktree answer when volumes are present', () => {
    const without = threadDeleteNotice(subject({ changedFiles: 0, aheadCommits: 0 }))
    const withVolumes = threadDeleteNotice(subject({ changedFiles: 0, aheadCommits: 0, dataVolumes: { count: 1, totalBytes: 5 } }))
    expect(withVolumes.releaseWorktree).toBe(without.releaseWorktree)
    expect(withVolumes.detail).toBe(without.detail)
  })

  it('writes sizes as a person reads them', () => {
    expect(humanSize(0)).toBe('0 B')
    expect(humanSize(340 * 1024 * 1024)).toBe('340 MB')
    expect(humanSize(1.2 * GB)).toBe('1.2 GB')
    expect(humanSize(2 * GB)).toBe('2 GB')
  })

  it('never puts a command, path or setting in the sentence', () => {
    const line = threadDeleteNotice(subject({ dataVolumes: { count: 3, totalBytes: 10 * GB } })).volumesLine ?? ''
    expect(line).not.toMatch(/docker (volume|compose)|\/|`|[a-z]+_[a-z_]+|flowconfig/i)
  })
})


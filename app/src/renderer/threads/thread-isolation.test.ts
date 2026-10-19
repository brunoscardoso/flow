import { isolationMark, type IsolationSubject } from './thread-isolation'

const thread = (over: Partial<IsolationSubject> = {}): IsolationSubject => ({
  worktreePath: null,
  worktreeBranch: null,
  originLoop: null,
  ...over,
})

/**
 * Every shape the mark can be handed, in one place, so the sweeps below cannot
 * quietly stop covering a case somebody adds later.
 */
const SHAPES: Array<Partial<IsolationSubject>> = [
  {},
  { worktreeBranch: 'thread/orphan' },
  { originLoop: 'board' },
  { worktreePath: '/w/t1' },
  { worktreePath: '/w/t1', worktreeBranch: 'thread/access-token-fix' },
  { worktreePath: '/w/t1', worktreeBranch: '   ' },
  { worktreePath: '/w/t1', originLoop: 'board' },
  { worktreePath: '/w/t1', originLoop: 'board', worktreeBranch: 'loop/find' },
  { worktreePath: '/w/t1', originLoop: '   ', worktreeBranch: 'thread/x' },
  { worktreePath: '   ' },
  { worktreePath: '   ', worktreeBranch: 'thread/x', originLoop: 'board' },
]

describe('the three cases', () => {
  // THE BLUE MARK IS GONE. It answered "why is this one apart when I never
  // asked" — a question the flipped default retired, since isolation is now
  // reached for rather than inherited. What remained lit a rail on every row a
  // person had deliberately set up (user, 2026-09-16).
  it('does NOT mark a conversation that simply has its own branch', () => {
    const mark = isolationMark(
      thread({ worktreePath: '/tmp/wt', worktreeBranch: 'flow/work', originLoop: null }),
    )
    expect(mark).toEqual({ tone: null, title: '' })
  })

  it('marks a LOOP’s conversation differently, because it is apart for a different reason', () => {
    // After the unattended gate there are two kinds of isolated thread on
    // screen: one a person asked for, and one a loop took while nobody was
    // watching. A mark that said only THAT a thread is apart would make the
    // split harder to follow, not easier — so the loop gets its own tone.
    const mark = isolationMark(
      thread({ worktreePath: '/w/t1', worktreeBranch: 'loop/find', originLoop: 'board' }),
    )
    expect(mark.tone).toBe('loop')
    expect(mark.title).toContain('loop/find')
  })

  it('reports the loop before it reports the isolation, when both are true', () => {
    // The order of the checks is the meaning: "why is this apart when I never
    // asked" is the question the gate created, and `loop` is the answer to it.
    expect(
      isolationMark(thread({ worktreePath: '/w/t1', originLoop: 'board' })).tone,
    ).toBe('loop')
  })

  it('marks nothing at all for a conversation working in the project’s own files', () => {
    // This is the ordinary case and needs no explanation of its own. The row
    // reserves the rule's width whether or not it is lit, so an absent mark
    // shifts nothing and is never mistaken for a missing one.
    expect(isolationMark(thread())).toEqual({ tone: null, title: '' })
  })
})

describe('what counts as apart', () => {
  it('reads a blank path as not apart — a blank is not a location', () => {
    expect(isolationMark(thread({ worktreePath: '   ' })).tone).toBeNull()
  })

  it('ignores a branch and a loop when nothing is apart in the first place', () => {
    // A thread can carry a stale branch name or a loop origin while working in
    // the project's files. Neither may light a mark on its own: `worktreePath`
    // is the field that answers "is this apart", exactly as it was for the
    // status segment this replaces.
    expect(
      isolationMark(thread({ worktreeBranch: 'thread/x', originLoop: 'board' })).tone,
    ).toBeNull()
  })

  it('reads a blank loop as no loop — which is now no mark at all', () => {
    for (const blank of ['', '   ']) {
      const mark = isolationMark(
        thread({ worktreePath: '/tmp/wt', worktreeBranch: 'flow/work', originLoop: blank }),
      )
      expect(mark.tone).toBeNull()
    }
  })

  it('says something in every marked state, and nothing in every unmarked one', () => {
    for (const shape of SHAPES) {
      const mark = isolationMark(thread(shape))
      if (mark.tone === null) expect(mark.title).toBe('')
      else expect(mark.title.trim()).not.toBe('')
    }
  })
})

describe('the words', () => {
  it('never names a container — the whole point of the change', () => {
    // THE ASSERTION THAT SURVIVES THE REST OF THIS PROJECT. Every surface being
    // replaced spoke about a thing the reader was never introduced to. This
    // module is one of the four that replace them, and the vocabulary leaving
    // the product is enforced here rather than by each renderer remembering to.
    for (const shape of SHAPES) {
      expect(isolationMark(thread(shape)).title).not.toMatch(/copy|workspace|worktree/i)
    }
  })

  it('names no path, command or config key (forbidden-pattern #12)', () => {
    const everything = SHAPES.map((shape) => isolationMark(thread(shape)).title).join(' ')
    expect(everything).not.toContain('/w/t1')
    expect(everything).not.toMatch(/planflow-ai|\.flowconfig|\.git|npm |git /)
  })
})

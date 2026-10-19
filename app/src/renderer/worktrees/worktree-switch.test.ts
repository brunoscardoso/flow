import type { ThreadSummary } from '../../shared/ipc-contract'
import { threadWorktreeState } from './thread-worktree-state'
import {
  switchView,
  SWITCH_NAME,
} from './worktree-switch'

const PROJECT = '/Users/me/orbit-app'
const thread = (over: Partial<ThreadSummary> = {}): ThreadSummary =>
  ({ id: 't1', worktreePath: null, worktreeBranch: null, ...over }) as ThreadSummary

const withWorktree = () =>
  threadWorktreeState(
    PROJECT,
    thread({ worktreePath: '/Users/me/wt/t1', worktreeBranch: 'flow/work' }),
    'main',
  )
const withoutWorktree = () => threadWorktreeState(PROJECT, thread(), 'main')

describe('the switch reports what is true', () => {
  it('is off, unlocked, with no way in when the conversation works in the project', () => {
    const view = switchView(withoutWorktree())
    expect(view).toEqual({
      on: false,
      armed: false,
      locked: false,
      stateLine: 'Off — works in your project folder',
    })
  })

  it('is on when the conversation has its own copy', () => {
    const view = switchView(withWorktree())
    expect(view.on).toBe(true)
    expect(view.locked).toBe(false)
  })

  // ARMED IS NOT ON. The panel has already shipped one lie ("Reading what's in
  // it…" while nothing read); a switch that flips optimistically and then
  // failed would be the same lie in a louder control.
  // THE ASK THAT SHOULD NEVER HAVE EXISTED. Turning the switch ON used to
  // demand a branch name. A worktree does not need one — `prepareWorktree`
  // with no branch cuts it detached and names it later from the title — and
  // demanding one blocked the plain case of three worktrees cut from the same
  // branch, which is most of why anybody wants them.
  it('has nothing to arm in the create direction', () => {
    const view = switchView(withoutWorktree())
    expect(view.armed).toBe(false)
    expect(view.on).toBe(false)
  })

  it('does not claim to be off while the remove question is open', () => {
    const view = switchView(withWorktree(), 'remove')
    expect(view.armed).toBe(true)
    // THE KNOB IS WHAT SAYS ON. It used to say so twice — the position, and a
    // sentence under the name spelling the position out — and the second one
    // was removed so the branch row could have the line (2026-09-18).
    expect(view.on).toBe(true)
    expect(view.stateLine).toBe('')
  })

  it('goes inert while a verb this panel started is running', () => {
    expect(switchView(withoutWorktree(), 'none', true)).toMatchObject({
      locked: true,
      stateLine: 'Setting it up…',
    })
    expect(switchView(withWorktree(), 'none', true)).toMatchObject({
      locked: true,
      stateLine: 'Removing it…',
    })
  })

  it('has nothing to say without a subject', () => {
    for (const state of [
      threadWorktreeState(null, null, null),
      threadWorktreeState(PROJECT, null, 'main'),
    ]) {
      const view = switchView(state)
      expect(view.locked).toBe(true)
      expect(view.stateLine).toBe('')
    }
  })
})

// THE THIRTY SECONDS AND THE WRONG NUMBER, PINNED TOGETHER. The switch used to
// be locked ahead of the press by reading every worktree in the project — a
// `git status`, a `rev-list` and a `du` each — which took over half a minute and
// then reported hundreds of unlanded commits that did not exist, because the
// count was taken against a local base 673 commits behind its remote.
// THE WORDS THEMSELVES, PINNED. "your files" drew the distinction in the wrong
// place — both folders are the reader's files — and said nothing while implying
// the copy belonged to someone else (user, 2026-09-17). The line is between the
// MAIN FOLDER and a copy of it, and that is what these strings have to say.
describe('what the switch says it is doing', () => {
  it('names the project folder, never "your files"', () => {
    // "your files" drew the distinction in the wrong place — both folders are
    // the reader's files — and said nothing while implying the copy belonged to
    // somebody else (user, 2026-09-17).
    const off = switchView(withoutWorktree()).stateLine
    expect(off).toContain('project folder')
    expect(off).not.toMatch(/your files/i)
    expect(off).toMatch(/^Off/)
  })

  it('is about the CHECKOUT, never the branch — the branch has its own row', () => {
    for (const line of [switchView(withoutWorktree()).stateLine, switchView(withWorktree()).stateLine]) {
      expect(line).not.toMatch(/branch/i)
    }
  })

  it('says nothing at all once the worktree is on — the branch row has the line', () => {
    const on = switchView(withWorktree())
    // THE POSITIVE FIRST: this IS the on state, so an empty line here is a
    // decision rather than a state that was never reached.
    expect(on.on).toBe(true)
    expect(on.stateLine).toBe('')
    // …and the line is still there for the one thing the knob cannot show: a
    // removal already in flight, with the knob deliberately not yet moved.
    expect(switchView(withWorktree(), 'none', true).stateLine).toBe('Removing it…')
  })
})

describe('the switch knows nothing about what is inside', () => {
  it('never locks for a reason it would have had to read the disk to learn', () => {
    // Free to move on a real worktree, with no inventory anywhere in sight.
    expect(switchView(withWorktree()).locked).toBe(false)
  })

  it('exposes no state, count or reason field at all', () => {
    const keys = Object.keys(switchView(withWorktree())).sort()
    // `showFiles` went with the button it drove: the files sit directly under
    // this panel now, so offering a way to them was a door onto the room you
    // are standing in (user, 2026-09-17: "remove the Show files, the files is
    // already there").
    expect(keys).toEqual(['armed', 'locked', 'on', 'stateLine'])
  })

  it('prints no number in anything it says', () => {
    const lines = [
      switchView(withoutWorktree()).stateLine,
      switchView(withWorktree()).stateLine,
      switchView(withWorktree(), 'none', true).stateLine,
    ]
    for (const line of lines) expect(line).not.toMatch(/\d/)
  })
})

// THE TYPED CONFIRMATION IS GONE, and its tests with it. It demanded the branch
// name typed out — the heaviest confirmation a UI has, guarding the wrong thing:
// a removal deletes the FOLDER, and the branch and its commits survive it. So
// the name being transcribed was the name of the part that was never at risk,
// while the part that is — whatever is in the folder and not committed — was
// protected by nothing but the typing exercise (user, 2026-09-17: "the user
// don't need to type the message, we need just to be clear that the worktree,
// the folder will be deleted").
//
// The safety rule that remains is the one that matters and it is unchanged:
// nothing is removed on a single click. The switch ARMS the question; the
// question's own button acts (forbidden-pattern #15). What the question SAYS is
// tested where it is written, in the panel.

describe('the switch is named in plain words', () => {
  it('is the word itself, now that no header says it', () => {
    // It read "Its own copy" BECAUSE a WORKTREE heading sat above it and two
    // labels for one thing is one too many. The heading is gone — it labelled
    // the whole file explorer as a worktree surface, which it is not — so the
    // word came down onto the control it describes.
    expect(SWITCH_NAME).toBe('Worktree')
  })
})

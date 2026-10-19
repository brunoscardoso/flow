/**
 * THE SWITCH — where it sits, and what it says.
 *
 * THE TWO DIRECTIONS ARE NOT THE SAME, and an earlier cut of this treated them
 * as if they were. Making a worktree creates a directory: it destroys nothing,
 * it is undone by the other half of this switch, and it needs no decision from
 * anybody — so turning it ON is one press. Removing one deletes a directory, so
 * it asks you to type the branch name.
 *
 * THE RULE, STATED PROPERLY: nothing in this panel DESTROYS anything on a single
 * click. That is what lets a control which removes a worktree be a toggle, and
 * it stops being true the moment somebody simplifies the removal confirm away.
 * If you are reading this while doing that, the toggle has to go too.
 *
 * ARMED IS NOT ON. While a question is open the knob has moved — the press
 * registered — but the state line still reports what is TRUE. This panel has
 * already shipped one lie (it said "Reading what's in it…" when nothing was
 * reading); a switch that flips optimistically and then fails would be the same
 * lie in a louder control.
 *
 * IT KNOWS NOTHING ABOUT WHAT IS INSIDE THE WORKTREE, on purpose. Two earlier
 * cuts of this file pre-computed that — whether it held unsaved files, whether
 * it had unlanded commits — so the switch could be locked before the press. It
 * cost an inventory read of every worktree in the project (a `git status`, a
 * `rev-list` and a `du` each): over thirty seconds on a real project, for an
 * answer that was WRONG, because the commit count is taken against a local base
 * branch which was 673 commits behind its remote.
 *
 * The check did not need to be here at all. `prune` refuses a worktree that
 * still holds work and returns the sentence saying so, at the moment it matters
 * and with the authority to be right (allowed-pattern #21). So this module
 * decides where the knob sits, and the refusal comes from the only place that
 * can actually know.
 *
 * Pure and DOM-free; no path, command or config key crosses it
 * (forbidden-pattern #12).
 */

import type { ThreadWorktreeState } from './thread-worktree-state'

/**
 * What the reader has asked for but not yet confirmed.
 *
 * There is no `create`: turning the switch on makes the worktree, because a new
 * directory is nothing to confirm.
 */
/**
 * What has been asked for and not yet confirmed.
 *
 * `'name'` is the switch on its way ON: a copy is about to be cut and the
 * person is naming it. `'remove'` is the switch on its way OFF, and `'discard'`
 * is the SECOND question it can lead to — the removal was refused because the
 * checkout holds work that lives nowhere else, and the person is being shown
 * what would go. All three mean the same thing to the knob — hollow and dashed,
 * nothing has happened yet.
 */
export type Armed = 'none' | 'name' | 'remove' | 'discard'

export interface SwitchView {
  /** Where the knob sits. */
  on: boolean
  /** Hollow and dashed: a question is open and NOTHING has happened yet. */
  armed: boolean
  /** Inert — a verb this panel started is still running. */
  locked: boolean
  /** The line under the name. Always reports what is true. */
  stateLine: string
}

/**
 * WHAT THE SWITCH IS CALLED — and the only place the word belongs.
 *
 * It read "Its own copy", and the panel carried a WORKTREE heading above it.
 * The heading labelled the whole file explorer as a worktree surface, which it
 * is not — it is the project's files (user, 2026-09-17: "seems that everything
 * is a worktree in that tab, but is not, is a file repo"). Removing the heading
 * left the switch named by a paraphrase of the thing, so the word came down
 * onto the control it actually describes: one switch, one subject, on or off.
 */
export const SWITCH_NAME = 'Worktree'

// THE DISTINCTION IS WHICH FOLDER, NOT WHOSE FILES.
//
// This read "works in your files", which draws the line in the wrong place:
// both folders are the reader's files, so the words said nothing and quietly
// implied the copy was somebody else's (user, 2026-09-17: "everything are my
// files"). The real difference is the MAIN FOLDER versus a copy of it.
const OFF_LINE = 'Off — works in your project folder'
// NOTHING WHEN THE SWITCH IS ON — the branch takes the line instead.
//
// It read "On — a checkout of its own", which is the knob's own position
// written out in words: the switch is called Worktree and it is visibly on, so
// the sentence carried no fact the reader did not already have (user,
// 2026-09-18: "this on a checkout of its own is not a good description, lets
// remove it, move the branch name instead"). The slot under the name now holds
// the branch row, which answers the one question the switch cannot: where this
// conversation's work is landing.
const MAKING_LINE = 'Setting it up…'
const REMOVING_LINE = 'Removing it…'

/**
 * The switch, for one panel state.
 *
 * `busy` is a verb in flight — a cut or a release this panel started. It locks
 * the switch without moving the knob, because a press being carried out has not
 * finished changing anything yet.
 */
export function switchView(
  state: ThreadWorktreeState,
  armed: Armed = 'none',
  busy = false,
): SwitchView {
  if (state.kind === 'no-project' || state.kind === 'no-thread') {
    return { on: false, armed: false, locked: true, stateLine: '' }
  }

  if (state.kind === 'in-project') {
    return {
      on: false,
      // A press opens the naming ask; the knob goes hollow until it is answered.
      armed: armed === 'name',
      locked: busy,
      stateLine: busy ? MAKING_LINE : OFF_LINE,
    }
  }

  return {
    on: true,
    // STILL ON, AND STILL ARMED, while the second question is open: nothing has
    // been deleted, and the knob must not report otherwise.
    armed: armed === 'remove' || armed === 'discard',
    locked: busy,
    // ONLY WHILE SOMETHING IS HAPPENING. A removal in flight is a fact the knob
    // cannot show — it has not moved yet, deliberately — so it gets the line.
    // At rest the line is empty and the branch row sits in its place; the panel
    // does not render an empty one, so nothing is left holding the gap.
    stateLine: busy ? REMOVING_LINE : '',
  }
}


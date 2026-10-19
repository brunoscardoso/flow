/**
 * Lane-change menu model for board cards (#1153) — DOM-free, so the item set is
 * unit-testable under the node jest env.
 *
 * The board offered exactly ONE way to change a task's lane: an HTML5 mouse
 * drag. Cards were unfocusable, right-click opened nothing, and the detail
 * modal — the board's ticket view — neither named the current lane nor offered
 * a control for it. The SAME task in the thread sidebar has all three. This is
 * the sidebar's vocabulary ("Move to Todo/Doing/Done", current lane marked),
 * reused so the two surfaces read identically.
 */
import type { TaskLane } from '../../shared/ipc-contract'

export interface LaneMenuItem {
  lane: TaskLane
  label: string
  /** The task's current lane — rendered marked, and moving to it is a no-op. */
  current: boolean
}

const LANE_LABEL: Record<TaskLane, string> = {
  todo: 'Move to Todo',
  doing: 'Move to Doing',
  blocked: 'Move to Blocked',
  review: 'Move to Review',
  done: 'Move to Done',
}

/** Lane order matches the board's columns, left to right. Blocked and Review are
 *  in the menu because they are drop targets on the board: every column accepts
 *  a drag, so a lane the mouse can reach the keyboard must be able to name
 *  (#1153). */
const LANE_ORDER: TaskLane[] = ['todo', 'doing', 'blocked', 'review', 'done']

/**
 * Every lane, in board order, with the task's current one marked. The current
 * lane is KEPT in the list (marked, not hidden) so the menu also answers "which
 * lane is this in?" — the question the detail modal couldn't answer at all —
 * and so the item positions don't shift between two cards.
 */
export function laneMenuItems(current: TaskLane): LaneMenuItem[] {
  return LANE_ORDER.map((lane) => ({
    lane,
    label: LANE_LABEL[lane],
    current: lane === current,
  }))
}

/** The plain lane name for a status readout ("Todo"), not the move verb. */
export function laneName(lane: TaskLane): string {
  return LANE_LABEL[lane].replace('Move to ', '')
}

// ── Getting a card OFF the board ─────────────────────────────────────────
//
// The board could move a task between four lanes and nothing else. A card you
// no longer wanted stayed on the board forever: no archive, no delete, no
// menu item, nothing in the ticket view — while the SAME task in the thread
// sidebar has had both since #1466. The two surfaces are meant to be one
// vocabulary (#1153); this is the half the board never got.
//
// TWO VERBS, AND THE DIFFERENCE IS THE POINT:
//
//   * ARCHIVE takes the card off the board and keeps everything — the record,
//     the chat, the brief, the external link. It is reversible from the
//     sidebar, which is why it is the plain item and not the red one.
//   * DELETE destroys the task AND its 1:1 conversation, with no undo. It is
//     the largest loss available on this surface, so it confirms first, names
//     what goes, and the safe answer takes focus.

/** What removing a card offers, beyond the lanes. */
export interface CardRemovalItem {
  id: 'archive' | 'delete'
  label: string
  /** Rendered as the destructive item, and confirmed before it runs. */
  danger: boolean
}

/**
 * The two exits, in escalating order.
 *
 * `archived` FLIPS THE FIRST ONE rather than hiding it: a board that only
 * archives and never unarchives is the one-way trip #1466 found in the sidebar,
 * where "Archive" sounded reversible and the only way back was a delete.
 */
export function cardRemovalItems(archived: boolean): CardRemovalItem[] {
  return [
    { id: 'archive', label: archived ? 'Unarchive' : 'Archive', danger: false },
    { id: 'delete', label: 'Delete task + thread', danger: true },
  ]
}

/** The worded confirm for a delete. Names the subject — never "Are you sure?". */
export function cardDeleteConfirm(title: string): {
  question: string
  confirm: string
  cancel: string
} {
  return {
    // Name it. An unnamed subject is how the wrong card gets deleted.
    question: `Delete “${title.length > 0 ? title : 'Untitled task'}” and its chat?`,
    confirm: 'Delete both',
    cancel: 'Cancel',
  }
}

// ── The hunt's card ──────────────────────────────────────────────────────
//
// The third kind of card in the same drift: a producer's standing hunt sits in
// Doing, and answered a right-click with nothing. It is not work and has no
// lane, so the lane menu is wrong for it — but "open the conversation this is
// happening in" and "show me what it filed" are both real, and both were
// reachable only by hitting a small chip exactly.

/** One entry in a hunt card's menu. */
export interface HuntMenuItem {
  id: 'open-run' | 'filter' | 'finish'
  label: string
  enabled: boolean
  /** Why it cannot be pressed, or null — carried, never hidden. */
  blockedReason: string | null
}

/**
 * What a hunt card offers.
 *
 * A HUNT HAS NO LANES. It is a standing sentence in a store the CLI owns, so
 * the four lanes are meaningless for it — but it does have an END, and that is
 * the one write offered here: `Finish` marks it stopped, which is the store's
 * own word for a person's decision. It keeps its count and its history, and the
 * card moves to Done.
 *
 * NOTHING HERE REWRITES WHAT A LOOP IS LOOKING FOR. Finishing a hunt is not
 * editing one, and there is deliberately no "change the sentence" item: that is
 * a committed instruction other machines read, and it does not move from a
 * right-click.
 */
export function huntMenuItems(
  hasRun: boolean,
  filterable: boolean,
  finished = false,
): HuntMenuItem[] {
  return [
    {
      id: 'open-run',
      label: 'Open the run',
      enabled: hasRun,
      blockedReason: hasRun ? null : 'Nothing has been run for this from here yet.',
    },
    {
      id: 'filter',
      label: 'Show what it filed',
      enabled: filterable,
      blockedReason: filterable ? null : 'It has not filed anything yet.',
    },
    {
      // THE PRESS THAT ENDS IT. A hunt could be watched and filtered and not
      // finished — the only ways to stop one were a whole-loop reset or a
      // terminal. Ending it moves the card to Done, where finished work goes,
      // and the count and the history go with it (`loop finish`, not `forget`).
      id: 'finish',
      label: 'Finish',
      enabled: !finished,
      blockedReason: finished ? 'This one is already finished.' : null,
    },
  ]
}

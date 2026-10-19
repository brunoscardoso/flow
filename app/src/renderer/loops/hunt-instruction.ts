// The ONE place a hunt instruction is built (loops-on-the-board, Phase 7, Task
// 7.5). DOM-free and IPC-free, like the two models beside it: given a hunt and
// the loops' status rows, it decides whether a person can act on it, which loop
// the write names, and exactly what the CLI will be asked to do.
//
// WHAT THE PLAN ASKED FOR, AND WHAT WAS ACTUALLY THERE. The task named three
// entry points to converge — a board composer, a card menu, and a thread
// `/loop`. None of the three exists. The board's "+ New task" modal creates a
// local task record and has never built a loop instruction; the card menu
// (lane-menu-model.ts) offers lanes and nothing else; and no `/loop` command
// exists in the composer at all — `.claude/commands/agent-loop.md` is a markdown
// skill the command list surfaces generically, which builds nothing. So there
// was nothing to converge, and three surfaces were NOT invented to have
// something to converge. What is here instead is the path itself, with the one
// caller that genuinely exists after Task 7.1: the hunt card in Doing.
//
// THE CLI HAS NO "START A HUNT" VERB, and that shapes everything below. The
// instruction store is written from exactly two places (src/cli/commands/
// loop.ts): `loop next --focus`, which starts or resumes a hunt as a side effect
// of opening a whole run, and `loop resume --loop <n> --focus <text>`, which the
// CLI documents as the person's "I looked, carry on" — it stops the instruction
// and starts it again, which is the one path that restarts a capped hunt at
// zero. Only the second is a thing a board can honestly offer, because the first
// runs a beat.
//
// AND IT DOES MORE THAN THE HUNT. `loop resume --loop <n>` also lifts that
// loop's pause — the same write deletes the pause record. A control labelled
// "Resume hunt" that quietly did that as well would be the panel's own sin in a
// new costume — a button that does not name the scope the CLI will act on. So
// the whole consequence is spelled out in the control's title, and the label
// promises only what the verb is.

import { MAX_HUNT_TEXT_LENGTH } from './hunt-limits'
import type { LoopStatusRow, LoopsSnapshot } from '../../shared/ipc-contract'
import type { BoardHunt } from '../tasks/board-model'

/**
 * The instruction's identity, exactly as the CLI computes it.
 *
 * `instructionKey` in src/cli/loop/instructions.ts collapses whitespace, trims
 * and lowercases, because a person retyping a sentence will not reproduce their
 * own spacing — and `startInstruction` normalizes the stored text the same way,
 * minus the lowercasing. Both halves live here so that every surface that ever
 * builds an instruction produces the SAME string for the same sentence. Two
 * surfaces normalizing differently is precisely how one hunt becomes two.
 */
export function normalizeHuntText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** The CLI call a resumed hunt becomes. Nothing here runs it. */
export interface HuntResumeIntent {
  /** The `--loop` the write carries. Never empty: an empty one is the GLOBAL
   *  scope, and a hunt is not a project-wide pause. */
  loop: string
  /** The `--focus`, normalized once, here. */
  focus: string
  /** The `--cap`, carried forward from the hunt so its guard rail survives. */
  cap: number
}

/** The control on a hunt card, or the reason there cannot be one. */
export interface HuntControl {
  label: string
  actionable: boolean
  /** What pressing it will actually do, in full. */
  title: string
  /** Why it cannot be pressed, or null. */
  blockedReason: string | null
  /** The write, or null when it cannot be named. */
  intent: HuntResumeIntent | null
}

/**
 * THE WHOLE CONSEQUENCE, in one sentence, on every control that offers it.
 *
 * Two things happen and the label can only name one, so the other is stated
 * rather than discovered: the loop's pause is lifted, and the hunt restarts its
 * count at zero. That second one is not a detail — a capped hunt resumed here
 * has filed 20 findings and will report 0/20
 * afterwards, which is the CLI's deliberate design (the cap already did its job
 * of making a person look) and would be alarming to meet unannounced.
 */
function consequence(loop: string): string {
  return `lifts ${loop}'s pause and restarts the count at 0`
}

function rowFor(loops: LoopsSnapshot | null, loop: string): LoopStatusRow | null {
  if (loops === null || !loops.available) return null
  return loops.loops.find((row) => row.loop === loop) ?? null
}

function dead(label: string, reason: string): HuntControl {
  // PRESENT-BUT-DEAD, CARRYING THE REASON — the panel's rule, unchanged. An
  // absent control reads as "this hunt has no controls"; a disabled one with a
  // sentence on it reads as what it is.
  return { label, actionable: false, title: reason, blockedReason: reason, intent: null }
}

/**
 * The control for one hunt, or null when there is nothing a person can do.
 *
 * NULL FOR AN ACTIVE HUNT, and that is not a gap. The CLI's `startInstruction`
 * returns a running hunt exactly as it stands — retyping its sentence is
 * documented as "carry on" and changes nothing — so a control here would be a
 * press with no effect. The three statuses that are NOT active are the ones a
 * person's decision can move, which is why they are the ones that get a button.
 */
export function huntControlFor(hunt: BoardHunt, loops: LoopsSnapshot | null): HuntControl | null {
  if (hunt.status === 'active') return null
  const label = 'Resume hunt'

  // THE STORE NAMES NO OWNER, so a hunt two producers both report cannot say
  // which `--loop` a resume should carry. Picking the first would be the board
  // inventing the one fact the CLI is explicit about not having.
  if (hunt.loops.length === 0) {
    return dead(label, 'no loop reported this hunt, so nothing can be resumed')
  }
  if (hunt.loops.length > 1) {
    return dead(
      label,
      // NO COMMAND IN A SENTENCE A PERSON READS: name the ambiguity, which is
      // the part the reader can act on, and leave the invocation out of it.
      `${hunt.loops.join(' and ')} both report this hunt and nothing records which one owns it, so Flow cannot tell which to resume.`,
    )
  }

  const loop = hunt.loops[0]!
  const focus = normalizeHuntText(hunt.text)
  if (focus.length === 0) return dead(label, 'this hunt has no text to resume')
  // REFUSED HERE RATHER THAN AT THE CLI. `normalizeFocus` throws over the limit,
  // which arrives as a one-line refusal after a spawn — the same answer, one
  // round trip and one scary toast later.
  if (focus.length > MAX_HUNT_TEXT_LENGTH) {
    return dead(
      label,
      // The limit, not the flag it belongs to: a reader can shorten a sentence
      // and cannot do anything at all with an argument name.
      `this hunt is ${String(focus.length)} characters, longer than the ${String(MAX_HUNT_TEXT_LENGTH)} a hunt can carry`,
    )
  }

  const row = rowFor(loops, loop)
  // A LOOP SWITCHED OFF IN ITS DIRECTIVE STILL HAS NO HUNT CONTROL, and the
  // reason has not changed: resuming the hunt would leave the loop that files
  // for it stopped, so the press would half-work — the worst of the three
  // possible outcomes. What HAS changed is that switching the loop back on is
  // now a real action (the board's strip and the Loops settings section both
  // offer it), so this names that rather than the file it used to send the
  // reader to open (forbidden pattern #12).
  if (row !== null && row.directivePaused === true && row.pause === null) {
    return dead(label, `${loop} is switched off, so resuming this hunt would not start it.`)
  }

  return {
    label,
    actionable: true,
    // The hover says what pressing it DOES, not what it runs — the intent below
    // is the write itself: data for the caller, never a sentence for the reader.
    title: consequence(loop),
    blockedReason: null,
    intent: { loop, focus, cap: hunt.cap },
  }
}

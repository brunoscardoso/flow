// The link between a loop and the conversation running it.
//
// PRESSING RUN USED TO LEAVE NO TRACE ON THE THING YOU PRESSED. A thread opened
// somewhere else, and the card you had just pressed went on saying `idle`,
// because the only evidence the run existed was a sentence at the bottom of the
// screen that the next render threw away. Meanwhile the board's card for the
// same hunt had no way to reach the conversation at all — clicking it did
// nothing, which is the complaint that produced this file.
//
// A run's thread now carries three fields (`originLoop` / `originAim` /
// `originKey`, threads schema v24). This module is the ONE place that reads them
// back into an answer, so the sidebar, the loops screen and the board agree
// about which conversation a run is — including when there have been several.

import type { ThreadSummary } from '../../shared/ipc-contract'

/** A run somebody started, as the surfaces that show it need it. */
export interface LoopRunLink {
  /** The run's name — `TOL-001`. */
  key: string
  threadId: string
  /** The thread's own title, already short (it was named from the key). */
  title: string
  /** What the run was pointed at, verbatim, or null. */
  aim: string | null
  /** The thread's status — `working` while the agent is mid-turn. */
  status: ThreadSummary['status']
  /** When it started, ISO — the newest run wins. */
  startedAt: string
}

/**
 * One comparable spelling of an aim.
 *
 * THE BOARD AND THE THREAD LEARNED THE SAME SENTENCE FROM DIFFERENT PLACES —
 * the board reads the hunt back out of the CLI's instruction store, the thread
 * kept what was typed into the box — so matching them on raw text would fail on
 * a stray double space. Case and inner whitespace only: anything cleverer starts
 * matching two hunts that a person deliberately worded differently.
 */
export function comparableAim(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Every thread that is a run, newest first. */
export function runsIn(threads: readonly ThreadSummary[]): LoopRunLink[] {
  return threads
    .filter((thread) => thread.originLoop !== null && thread.originKey !== null)
    .map((thread) => ({
      key: thread.originKey ?? '',
      threadId: thread.id,
      title: thread.title,
      aim: thread.originAim,
      status: thread.status,
      startedAt: thread.createdAt,
    }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

/** The newest run of one loop, or null when it has never been run from here. */
export function latestRunFor(loop: string, threads: readonly ThreadSummary[]): LoopRunLink | null {
  const match = threads
    .filter((thread) => thread.originLoop === loop && thread.originKey !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
  return match === undefined ? null : (runsIn([match])[0] ?? null)
}

/**
 * The run behind a hunt card: same loop, same sentence.
 *
 * BOTH HALVES MATTER. Matching on the loop alone would point yesterday's run at
 * today's hunt the moment somebody changed what they were looking for — a link
 * that opens the wrong conversation is worse than no link, because it is
 * believed. A hunt the CLI reports against several loops matches a run started
 * for any of them, which is the same fact the card already states.
 */
export function runForHunt(
  loops: readonly string[],
  text: string,
  threads: readonly ThreadSummary[],
): LoopRunLink | null {
  const wanted = comparableAim(text)
  const match = runsIn(threads).find(
    (run) =>
      run.aim !== null &&
      comparableAim(run.aim) === wanted &&
      loops.includes(threadLoopOf(run, threads) ?? ''),
  )
  return match ?? null
}

/** The loop a run belongs to, read back off its thread. */
function threadLoopOf(run: LoopRunLink, threads: readonly ThreadSummary[]): string | null {
  return threads.find((thread) => thread.id === run.threadId)?.originLoop ?? null
}

/**
 * What the chip beside a card says about its latest run.
 *
 * IT NAMES THE RUN, NOT ITS WEATHER — except while the agent is mid-turn, which
 * is the one moment the answer is genuinely "right now". A finished run still
 * gets a chip: "there is a conversation about this and here it is" stays true
 * after it ends, and a chip that vanished on completion would take the only way
 * back to the transcript with it.
 */
export function runChipText(run: LoopRunLink): string {
  return run.status === 'working' ? `${run.key} · running` : `${run.key} · last run`
}

/** What pressing the chip does. Never a file, never a command. */
export function runChipTitle(run: LoopRunLink): string {
  return `Open ${run.key} — the conversation this run is happening in`
}

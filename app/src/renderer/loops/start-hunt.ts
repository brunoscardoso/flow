// THE ONE PLACE A HUNT IS STARTED — write the standing instruction, mint the
// run's key, open a thread and send the loop's own command.
//
// WHY IT IS ONE PLACE. There are three surfaces that can start a hunt now: the
// Loops screen's Run, the board's New task, and the chat column's New thread.
// The procedure is five steps long, four of them are IPC, and every one of them
// has a failure a person has to be told about — a copy of it per surface is four
// chances for a hunt to be started without its cap, or a thread to be created
// and left empty. The invariants live in code, not in three prompts that happen
// to agree (allowed-pattern #14).
//
// IT PERFORMS, IT DOES NOT DECIDE. What to write and what to send is computed by
// loop-run.ts (from the Loops screen) or hunt-config.ts (from a create form);
// this takes a finished plan and carries it out, reporting what happened in
// enough detail for each caller to say it in its own words.

import { ipcErrorMessage } from '../ipc-error'
import { mintRunKey, runStartError, runWriteError } from './loop-run'
import { runTitle } from '../../shared/loop-run-key'
import { baseName } from '../project-label'
import type { LoopStopChoice, ThreadSummary } from '../../shared/ipc-contract'

/** The standing-instruction write a start performs first, when it has to. */
export interface HuntWrite {
  loop: string
  /** The `--focus` — the sentence this hunt is pointed at, already normalized. */
  focus: string
  /** The `--cap`, when the person's own rule is the number. */
  cap?: number
  /** How the hunt ends, when a rule was chosen. */
  stop?: LoopStopChoice
}

/** Everything one start performs, in the order it performs it. */
export interface StartHuntPlan {
  rootPath: string
  loop: string
  /** The instruction to write before the run opens, or null when it agrees already. */
  write: HuntWrite | null
  /** The thread's first message — the loop's own slash command, verbatim. */
  message: string
  /** The sentence this run was pointed at, normalized. '' when it has none. */
  aim: string
  /** What to call the thread when the aim is empty. Never a command. */
  threadTitle: string
  /** Threads already on screen, so a key is not minted over a stale list. */
  knownThreads: readonly ThreadSummary[]
}

/**
 * What happened.
 *
 * `ok: false` ALWAYS CARRIES A SENTENCE a caller can show verbatim. The three
 * ways this fails are different and are named as such — the write was refused,
 * the thread could not be made, or the first message did not send — because the
 * third leaves a real thread open on screen and the first leaves nothing at all.
 */
export type StartHuntOutcome =
  | { ok: true; key: string; title: string; threadId: string }
  | { ok: false; reason: string; threadId?: string }

/**
 * Start a hunt.
 *
 * Order matters and is the same order the Loops screen has always used: the
 * instruction is written BEFORE the run opens, because a run started against a
 * sentence the store has never heard of files at the CLI's default cap —
 * silently ignoring the rule the person just chose.
 */
export async function startHunt(plan: StartHuntPlan): Promise<StartHuntOutcome> {
  const loops = window.flow.loops
  if (plan.write !== null) {
    if (loops === undefined) {
      return { ok: false, reason: runWriteError(plan.loop, 'this build of Flow cannot write to loops') }
    }
    const result = await loops
      .setPaused({
        rootId: plan.rootPath,
        loop: plan.write.loop,
        paused: false,
        focus: plan.write.focus,
        ...(plan.write.cap === undefined ? {} : { cap: plan.write.cap }),
        ...(plan.write.stop === undefined ? {} : { stop: plan.write.stop }),
      })
      .catch((error: unknown) => ({ ok: false as const, reason: ipcErrorMessage(error) }))
    if (!result.ok) {
      if (result.reason !== null) console.error('flow: hunt write refused —', result.reason)
      return { ok: false, reason: runWriteError(plan.loop, result.reason) }
    }
  }

  // THE RUN GETS A NAME — minted from the archived-inclusive list, so archiving
  // the highest run's thread cannot hand its number to the next run (#1708).
  let threadId: string | undefined
  try {
    const key = await mintRunKey(
      baseName(plan.rootPath) || plan.rootPath,
      () => window.flow.threads.list({ projectRoot: plan.rootPath, includeArchived: true }),
      plan.knownThreads,
    )
    const title = plan.aim.length > 0 ? runTitle(key, plan.aim) : runTitle(key, plan.threadTitle)
    const thread = await window.flow.threads.create({
      projectRoot: plan.rootPath,
      title,
      originLoop: plan.loop,
      originAim: plan.aim,
      originKey: key,
    })
    threadId = thread.id
    document.dispatchEvent(new CustomEvent('flow:open-thread', { detail: { threadId: thread.id } }))
    await window.flow.threads.sendMessage({ threadId: thread.id, content: plan.message })
    return { ok: true, key, title, threadId: thread.id }
  } catch (error) {
    console.error('flow: failed to start a loop run', error)
    // The thread id rides along when there IS one: the run's chat is open and
    // empty, and a caller that knows which one can say so rather than leaving a
    // dead conversation the person has to work out for themselves.
    return {
      ok: false,
      reason: runStartError(plan.loop, ipcErrorMessage(error)),
      ...(threadId === undefined ? {} : { threadId }),
    }
  }
}

/**
 * The command that starts a run of `loop`, aimed at `aim`.
 *
 * VERBATIM FROM `.claude/commands/agent-loop.md`: the first argument is a
 * loop's name and everything after it is a focus for that one run. Written here
 * once so a create form and the Loops screen cannot spell it differently.
 */
export function agentLoopCommand(loop: string, aim: string): string {
  const focus = aim.trim()
  return focus.length === 0 ? `/agent-loop ${loop}` : `/agent-loop ${loop} ${focus}`
}

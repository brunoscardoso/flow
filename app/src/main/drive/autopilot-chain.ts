// THE AUTOPILOT CHAIN — the half that makes the right order automatic.
//
// Autopilot was a config key and 167 lines of instructions asking a model to
// run discovery → plan → execute → review → publish. Nothing ran it, so whether
// it happened was the model's choice. This runs it: when a turn ends, the next
// rung is issued by code, from state anybody can look at.
//
// IT SHIPS WITH ITS STOP, and that ordering is the whole design brief. The worst
// outcome here is not a chain that fails to run — it is one that runs when
// somebody wants it to stop. So:
//
//   · `end()` exists from the first line, is reachable from a surface, and
//     leaves the thread EXACTLY where it is. It stops the next issue, never the
//     turn in flight: interrupting an agent mid-sentence is its own gesture, on
//     the thread, where a person can see what they are interrupting.
//   · a thread waiting on a person (`needs-decision`, `blocked`) is held, not
//     re-issued. Talking over a question is precisely how a chain runs away
//     from somebody trying to stop it.
//   · a step that did not finish cleanly stops the chain rather than advancing
//     onto a foundation that is not there.
//   · a step that finished cleanly and left NOTHING BEHIND stops it too. Ending
//     without error is not the same as having done the work, and for most of
//     this feature's life it was treated as if it were: the refusal verb
//     (`flow stage <stage> --check`) shipped with no caller at all, so the
//     chain advanced on turn terminality alone and the four command files
//     described a gate nothing ran (#1915 C2). Every edge the chain steps
//     across is now asked about before it is crossed — see `stage-gate.ts`, and
//     `feature-slug.ts` for what the asking is ABOUT.
//
// ONE MECHANISM, TWO TRIGGERS. The advance shape is `TurnDriver`, shared with
// the board's own loop; the shared `ThreadClaims` registry makes it impossible
// for both to be driving one thread, which is the failure this phase was told
// to prevent. Neither driver decides anything — `chain-model.ts` does, purely,
// from observable state only (turn terminality and thread status). Nothing here
// reads a transcript for "I finished".

import type { ThreadStore, ThreadStatus } from '../store/thread-store'
import {
  type ChainStep,
  type WorkflowStage,
  nextChainStep,
  stageLabel,
  stagePrompt,
} from './chain-model'
import { type TailConfig, type TailDeps, type TailOutcome, runGitTail } from './chain-tail'
import { featureSlugFrom } from './feature-slug'
import { STAGE_UNCHECKED, type StageGateInput, type StageGateStep, edgeToProve } from './stage-gate'
import { TurnDriver, type DriveStatus, type ThreadClaims } from './turn-driver'

/** What one thread's chain is doing, as any surface asks it. */
export interface ChainRunStatus {
  threadId: string
  running: boolean
  /** The step it is on, in the words a person reads. Null when not running. */
  step: string | null
  /** True while it is holding because somebody is being asked something. */
  waitingOnYou: boolean
  /**
   * Why the work was not published, when it was not.
   *
   * A PAUSE HONOURED IS NOT A FAILURE. The gate withholds a publish that was
   * rated `high` risk or never rated, and the publish verb refuses a branch
   * nobody has bound — both leave the work built, reviewed and committed, and a
   * surface that showed them as an error would be telling a person something
   * broke when in fact it is waiting on them. Null whenever nothing was withheld.
   */
  notPublished: string | null
  /**
   * Why it stopped, when it stopped ITSELF. Null while running, and null after
   * a person ended it — their own gesture needs no explanation.
   */
  stoppedReason: string | null
  /** The pull request the tail opened, when it opened one. */
  prUrl: string | null
}

/** The work the chain hands its driver. */
type ChainWork = { type: 'stage'; stage: WorkflowStage } | { type: 'tail' }

export interface AutopilotChainDeps {
  threadStore: ThreadStore
  /** Start a turn on a thread. Rejects like the IPC verb does. */
  sendMessage: (threadId: string, content: string) => Promise<unknown>
  /**
   * The project's autopilot switch and publish settings, read together.
   *
   * ASYNC AND INJECTED, because this is main: a synchronous read of a project's
   * config on the process that answers every IPC call is a stall every window
   * waits behind (allowed-pattern #19).
   */
  readProjectSettings: (projectRoot: string) => Promise<{ autopilot: boolean; tail: TailConfig }>
  /** The publish verbs. Wired to the path the landing panel already uses. */
  tail: TailDeps
  /**
   * May this rung run — did the one below it leave proof for this run's feature?
   *
   * THE SEAM THAT DID NOT EXIST (#1915 C2). The refusal verb, its ladder and its
   * 122 tests shipped with no caller, so the chain advanced on `lastTurnSucceeded`
   * alone and a stage that ended cleanly having written nothing carried it on to
   * the next rung. This is the call that makes the refusal reachable, and the
   * four command files' claim true.
   *
   * ASYNC AND INJECTED, for the same reason `readProjectSettings` is: the answer
   * is a spawned CLI (`flow stage <stage> --check`), and a synchronous one on the
   * process that answers every IPC call is a stall every window waits behind
   * (allowed-pattern #19). One spawn per stage transition — bounded, and at most
   * three in a whole chain.
   *
   * REQUIRED, NOT OPTIONAL. An absent gate would mean "advance unchecked", which
   * is precisely the defect; a chain constructed without one must not compile.
   */
  checkStage: (input: StageGateInput) => Promise<StageGateStep>
  /** Tell every surface this thread's chain changed. */
  onChange: (status: ChainRunStatus) => void
  /**
   * A chain ended — finished, stopped itself, or was ended by a person.
   *
   * The hook the board's loop hangs on: a card whose thread is being chained is
   * not finished when one rung's turn ends, it is finished when the chain is,
   * and this is how the loop learns that without either driver reaching into
   * the other.
   */
  onChainEnd?: (threadId: string, success: boolean) => void
  /** The app-wide claims registry. Shared with every other driver. */
  claims?: ThreadClaims
  /** Injectable id minting, so a test can read what it asserts. */
  mintChainId?: () => string
  /** Injectable clock, so a test can read the instant it asserts. */
  now?: () => Date
}

/** Everything one live chain knows about itself. */
interface ChainRun {
  chainId: string
  aim: string
  /**
   * What this run's documents are named for — minted at `begin` (`feature-slug.ts`).
   *
   * THE DRIVER MINTS THE SUBJECT AS WELL AS THE IDENTITY. The chain drives a
   * conversation, not a plan slug, and the gate judges files named for a
   * feature; this is the name it gives each stage to write under and the name it
   * then asks the gate about. Resolving it from the files being judged instead
   * would be C1's defect one field over — the record nominating its own subject.
   */
  feature: string
  startAt: WorkflowStage
  stage: WorkflowStage | null
  /** Null until the first rung's turn has ended. */
  lastTurnSucceeded: boolean | null
  tailDone: boolean
  tail: TailOutcome | null
  /**
   * When this chain began, as an instant.
   *
   * THE SCOPE OF THE PUBLISH GATE'S READ. A chain drives a thread, not a plan
   * slug, so it cannot name the feature whose risk assessment it wants; the
   * instant bounds the record instead, and an older run's rating can neither
   * gate nor clear this one.
   */
  startedAt: string
  /** The project root, for project settings only — never where a run's files are (those are at the thread's worktree; see drive/chain-gates.ts). */
  projectRoot: string
  /** True while the thread is waiting on a person. */
  held: boolean
  /**
   * Why the gate refused the rung this run was about to issue. Null while the
   * ladder is clear.
   *
   * RECORDED RATHER THAN THROWN, so that the sentence a person reads is the
   * gate's own and not an error's `message` that happens to be readable. The
   * next decision reads this FIRST and stops on it — before the ordinary
   * `nextChainStep` reasoning, which would otherwise report the generic
   * "the last step did not finish" over a refusal that knows exactly what
   * happened.
   */
  gateRefusal: string | null
}

/** The name this driver claims threads under. Internal, never rendered. */
export const AUTOPILOT_CHAIN_DRIVER = 'autopilot-chain'

/** The reasons the chain itself authors, in the words a person reads. */
export const AUTOPILOT_OFF = 'Autopilot is off for this project, so nothing was started.'
export const THREAD_GONE = 'This conversation is no longer here.'
export const ALREADY_BUSY = 'Something else is already working this conversation.'

export class AutopilotChain {
  readonly #runs = new Map<string, ChainRun>()
  /**
   * Why the last attempt to start a chain here was refused.
   *
   * Kept so READING the status afterwards still says so. A refusal a surface
   * can only see in the reply to the press it made is a refusal that vanishes
   * on the next repaint, and the person is left looking at a control that did
   * nothing for no stated reason.
   */
  readonly #refusals = new Map<string, string>()
  /**
   * What the tail did, kept for the same reason `#refusals` is.
   *
   * THE RUN IS GONE BY THE TIME ANYBODY LOOKS. `#forget` drops the run's state
   * the instant the chain stops, so a tail outcome held only there is
   * unreadable exactly when it matters — after the chain has finished, which is
   * when a person opens the thread to see whether their work was published.
   * (That is not hypothetical: `prUrl` was read off the run and was therefore
   * always null on a finished chain, so the pull request the tail opened could
   * never be shown. Surfaced by Phase 4's pause tests.)
   */
  readonly #tails = new Map<string, TailOutcome>()
  readonly #driver: TurnDriver<ChainWork>

  constructor(private readonly deps: AutopilotChainDeps) {
    this.#driver = new TurnDriver<ChainWork>({
      name: AUTOPILOT_CHAIN_DRIVER,
      claims: deps.claims,
      decide: (threadId) => this.#decide(threadId),
      // A chain's run IS a conversation, so the claim can always be taken
      // before anything is sent — which is what makes "something else is
      // already working this conversation" a refusal rather than a message
      // that went out anyway.
      threadFor: (threadId) => threadId,
      dispatch: (threadId, work) => this.#dispatch(threadId, work),
      onEnd: (threadId) => this.#forget(threadId),
      onSettled: (threadId, _turnThreadId, success) => {
        const run = this.#runs.get(threadId)
        if (run !== undefined) run.lastTurnSucceeded = success
      },
      onChange: (threadId) => this.deps.onChange(this.status(threadId)),
    })
  }

  /** What this thread's chain is doing. Reading never starts anything. */
  status(threadId: string): ChainRunStatus {
    const drive: DriveStatus = this.#driver.status(threadId)
    const run = this.#runs.get(threadId)
    const tail = run?.tail ?? this.#tails.get(threadId) ?? null
    return {
      threadId,
      running: drive.running,
      step: run?.stage === undefined || run.stage === null ? null : stageLabel(run.stage),
      waitingOnYou: run?.held === true,
      stoppedReason: drive.stoppedReason ?? this.#refusals.get(threadId) ?? null,
      prUrl: tail?.url ?? null,
      notPublished: tail === null || tail.ok ? null : tail.detail,
    }
  }

  /** Is a chain driving this thread right now? */
  isRunning(threadId: string): boolean {
    return this.#driver.isRunning(threadId)
  }

  /**
   * Start a chain on a thread.
   *
   * REFUSED WHEN AUTOPILOT IS OFF. The project's switch is the consent; a chain
   * that could be started on a project which never asked for one would make the
   * switch decorative. Refused too when something else is already driving the
   * thread — one conversation, one driver, enforced in `ThreadClaims`.
   *
   * `autonomous` IS THE ONE EXEMPTION, and it is not a bypass of the consent —
   * it is a different consent. `autopilot` is a PROJECT-WIDE key, so a
   * conversation that exists only because somebody pressed play on a list of
   * cards they ticked cannot be gated on it: requiring the key would mean the
   * board's loop silently stopped chaining, and setting the key so that it
   * chains would change how the person's OWN conversations behave, which nobody
   * asked for. Exactly one caller passes it — `BoardLoop`, which documents the
   * asymmetry where it decides it — and nothing infers it from the thread.
   */
  async begin(
    threadId: string,
    options: { aim?: string; startAt?: WorkflowStage; autonomous?: boolean } = {},
  ): Promise<ChainRunStatus> {
    if (this.#driver.isRunning(threadId)) return this.status(threadId)
    this.#refusals.delete(threadId)
    // A NEW CHAIN CARRIES NONE OF THE LAST ONE'S ENDING. Leaving the previous
    // tail in place would show a fresh run as already published, or already
    // withheld, before it has done anything.
    this.#tails.delete(threadId)
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null) return this.#refuse(threadId, THREAD_GONE)
    const settings = await this.deps.readProjectSettings(thread.projectRoot)
    if (!settings.autopilot && options.autonomous !== true) {
      return this.#refuse(threadId, AUTOPILOT_OFF)
    }
    // THE GUARD AT THE TOP OF THIS METHOD IS NOT ENOUGH, and the await above is
    // why: reading the project's settings yields, so two calls that arrive
    // together — a double press of the chain control, or the board's loop
    // chaining a card's thread while somebody starts one by hand in it — both
    // pass that guard before either has a run. Without this second look the
    // later one overwrites the live run with a fresh `stage: null`, and the
    // moment the FIRST stage's turn ends the model is asked what comes after
    // "nothing yet" and issues that same first stage a second time, into a
    // conversation that has already done it.
    //
    // Re-reading the driver is what makes the window safe rather than smaller:
    // from here to `start()`, which records the run, nothing else yields, so
    // the check and the claim on the run are one indivisible step.
    if (this.#driver.isRunning(threadId)) return this.status(threadId)
    const chainId = (this.deps.mintChainId ?? defaultChainId)()
    const aim = (options.aim ?? '').trim()
    this.#runs.set(threadId, {
      chainId,
      aim,
      // SANITIZED, NEVER REFUSED (allowed-pattern #22). The aim is a sentence
      // somebody typed, or a ticket's own free text; a chain that could not
      // start because its subject did not slugify would be refusing a derived
      // value at the one moment it must not.
      feature: featureSlugFrom(aim, chainId),
      startAt: options.startAt ?? 'discovery',
      stage: null,
      lastTurnSucceeded: null,
      tailDone: false,
      tail: null,
      // STAMPED BEFORE THE FIRST RUNG, never after: the gate reads the record
      // from this instant forward, and a later stamp would exclude the very
      // entries this chain's own run wrote.
      startedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
      projectRoot: thread.projectRoot,
      held: false,
      gateRefusal: null,
    })
    await this.#driver.start(threadId)
    return this.status(threadId)
  }

  /**
   * End a chain, leaving the thread exactly where it is.
   *
   * NOTHING IS INTERRUPTED. If a turn is running it keeps running, finishes,
   * and is simply not followed by another. No message is sent, no file is
   * touched, nothing is rolled back — the only thing that changes is that the
   * next rung is never issued.
   */
  end(threadId: string, reason?: string): ChainRunStatus {
    if (!this.#driver.isRunning(threadId)) return this.status(threadId)
    this.#driver.stop(threadId, reason)
    return this.status(threadId)
  }

  /**
   * The conversation is gone — deleted, by whatever path deleted it.
   *
   * THE CHAIN CANNOT NOTICE THIS ON ITS OWN, and that is the whole reason this
   * method exists. `#decide` already refuses a thread that is no longer there,
   * but it only runs from a pump, and a pump only happens when a turn ends. A
   * chain HELD on a question (`needs-decision`, `blocked`) has no turn in
   * flight, so nothing will ever end and nothing will ever ask again: the run
   * sits alive for ever, holding its claim on a thread that does not exist.
   *
   * WHAT IS ACTUALLY AT STAKE IS THE BOARD'S LOOP, not this run's tidiness. A
   * card handed to a chain takes no claim of its own (`drivenElsewhere`) and is
   * woken by `onChainEnd` alone — so a stranded chain is a project whose loop
   * reports running for ever and dispatches no further cards, with nothing said
   * to anybody. Ending here is what lets the loop take its next card.
   *
   * THE RUN DID NOT SUCCEED, and it says so. `onChainEnd` is what moves a card
   * on, and a conversation somebody deleted is not work that finished — reading
   * the last turn's success would carry the card to Review on the strength of a
   * thread that is not there to show anyone.
   */
  forgetThread(threadId: string): void {
    const run = this.#runs.get(threadId)
    if (run !== undefined) run.lastTurnSucceeded = false
    // The chain stopped ITSELF, for a reason that is about the work, so the
    // reason is recorded — a person's own ending stays the absence of one.
    this.end(threadId, THREAD_GONE)
    // Nothing may outlive the conversation it was about: a refusal or a tail
    // kept here would answer for the next thread to be handed this id.
    this.#refusals.delete(threadId)
    this.#tails.delete(threadId)
  }

  /**
   * A turn ended. Routed through the shared driver, which advances only the run
   * that claimed the thread — so a board-loop card and a chain can never both
   * answer one finished turn.
   */
  onTurnComplete(threadId: string, success = true): void {
    this.#driver.onTurnComplete(threadId, success)
  }

  /**
   * The thread's status changed.
   *
   * A THREAD WAITING ON A PERSON IS HELD, NOT RE-ISSUED. This is not a hot
   * broadcast — it fires when an agent's status actually changes, not on the
   * ~50 ms batch clock — and it does nothing at all for a thread no chain is
   * driving, so it costs a map lookup for everybody else (allowed-pattern #17).
   */
  onThreadStatus(threadId: string, status: ThreadStatus): void {
    const run = this.#runs.get(threadId)
    if (run === undefined) return
    const held = status === 'needs-decision' || status === 'blocked'
    if (held === run.held) return
    run.held = held
    this.deps.onChange(this.status(threadId))
  }

  // ── The decision, and the two kinds of step it produces ──────────────────

  #decide(threadId: string): { kind: 'work'; work: ChainWork } | { kind: 'wait'; reason: string } | { kind: 'stop'; reason: string } {
    const run = this.#runs.get(threadId)
    if (run === undefined) return { kind: 'stop', reason: THREAD_GONE }
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null) return { kind: 'stop', reason: THREAD_GONE }
    // THE GATE'S ANSWER OUTRANKS THE LADDER'S. A refused edge is recorded by the
    // dispatch that was about to cross it and stops the chain here, with the
    // gate's own sentence — `nextChainStep` reads observable state and would
    // report the generic "the last step did not finish", which is both vaguer
    // and, for a turn that ended perfectly well, wrong.
    if (run.gateRefusal !== null) return { kind: 'stop', reason: run.gateRefusal }
    const step: ChainStep = nextChainStep({
      stage: run.stage,
      startAt: run.startAt,
      threadStatus: thread.status,
      lastTurnSucceeded: run.lastTurnSucceeded,
      tailDone: run.tailDone,
      tailPublished: run.tail === null ? null : run.tail.ok,
    })
    if (step.kind === 'issue') return { kind: 'work', work: { type: 'stage', stage: step.stage } }
    if (step.kind === 'tail') return { kind: 'work', work: { type: 'tail' } }
    return step
  }

  async #dispatch(
    threadId: string,
    work: ChainWork,
  ): Promise<{ threadId: string; detail: string } | null> {
    const run = this.#runs.get(threadId)
    if (run === undefined) return null
    if (work.type === 'tail') {
      // THE TAIL STARTS NO TURN, so the driver is told so with `null` and pumps
      // straight on to the finish. Recorded before the pump either way: a tail
      // that refused (an unbound branch is refused, never guessed) must not be
      // retried in a loop.
      run.tailDone = true
      const settings = await this.deps.readProjectSettings(run.projectRoot)
      run.tail = await runGitTail(this.deps.tail, {
        threadId,
        config: settings.tail,
        chainId: run.chainId,
        since: run.startedAt,
      })
      this.#tails.set(threadId, run.tail)
      this.deps.onChange(this.status(threadId))
      return null
    }
    // THE EDGE IS PROVED BEFORE IT IS CROSSED, and before ANYTHING is sent.
    // Nothing is issued, nothing is recorded on the thread, and the stage the
    // run is on does not move: a refused rung must be indistinguishable from a
    // rung that was never attempted, or a surface would show the chain sitting
    // in a step it declined to start.
    //
    // THE UN-GATED PATH DOES NOT EVEN YIELD. `edgeToProve` is pure and is asked
    // first, so the bottom rung reaches its send in the same tick it always
    // did — an `await` taken unconditionally would move the moment the run
    // records its stage one microtask later, which is observable to anything
    // reading the status in the window two `begin()` calls race in.
    const previous = edgeToProve(run.stage, work.stage)
    if (previous !== null && !(await this.#edgeProved(threadId, run, work.stage, previous))) {
      return null
    }
    run.stage = work.stage
    // WRITTEN BEFORE THE SEND. "Which stage is this thread in" must be
    // answerable from the record while the turn is running, not only after it
    // ends — and a send that throws is still a stage that was attempted.
    this.#record(threadId, run)
    await this.deps.sendMessage(
      threadId,
      stagePrompt({
        stage: work.stage,
        aim: run.aim,
        chainId: run.chainId,
        feature: run.feature,
      }),
    )
    return { threadId, detail: work.stage }
  }

  /**
   * May this rung run? False means the chain stops, having sent nothing.
   *
   * FAIL CLOSED ON EVERY PATH. A refusal, an answer that could not be read, a
   * verb that could not be run — all of them stop. The gate exists because a
   * chain that advances when it cannot tell is exactly the thing being fixed,
   * and "it could not check, so it carried on" is that thing with an apology
   * attached.
   *
   * THE RUN DID NOT SUCCEED, and it says so. `onChainEnd` is what moves a board
   * card on, and it reads the last turn's outcome — which here is `true`, the
   * previous rung having ended perfectly cleanly. Left alone, a chain stopped at
   * a missing artifact would carry its card to Review as finished work. Same
   * reasoning, same line, as `forgetThread`.
   */
  async #edgeProved(
    threadId: string,
    run: ChainRun,
    stage: WorkflowStage,
    previous: WorkflowStage,
  ): Promise<boolean> {
    const verdict = await this.deps
      .checkStage({
        threadId,
        chainId: run.chainId,
        feature: run.feature,
        stage,
        previous,
      })
      .catch((error: unknown) => {
        console.warn('[AutopilotChain] the stage gate could not be asked', { threadId, error })
        return { ok: false, detail: STAGE_UNCHECKED }
      })
    if (verdict.ok) return true
    run.gateRefusal = verdict.detail
    run.lastTurnSucceeded = false
    return false
  }

  #record(threadId: string, run: ChainRun): void {
    try {
      this.deps.threadStore.setThreadChain(threadId, { chainId: run.chainId, stage: run.stage })
    } catch (error) {
      console.warn('[AutopilotChain] could not record the chain on the thread', { threadId, error })
    }
  }

  /** Drop a finished run's state and clear its record on the thread. */
  #forget(threadId: string): void {
    const run = this.#runs.get(threadId)
    this.#runs.delete(threadId)
    // A CHAIN THAT NEVER ISSUED ANYTHING NEVER ENDED. `begin` can be refused at
    // the claim — something else is already working this conversation — and
    // reporting that as an ending would tell whoever is waiting that their work
    // was finished by a run which never sent a single message. Found by running
    // both drivers over one thread: the board's loop advanced to its next card
    // because a chain it had just refused announced that it was done.
    if (run === undefined || run.stage === null) return
    try {
      this.deps.threadStore.setThreadChain(threadId, null)
    } catch {
      // A thread deleted out from under a chain has no columns to clear.
    }
    // A WITHHELD PUBLISH IS NOT A SUCCESSFUL CHAIN. The board's loop moves its
    // card on when this says true, so reporting success over a publish the gate
    // or the verb refused would advance the work past a pause that was
    // deliberately honoured — the exact thing the pause exists to stop.
    const published = run.tail === null || run.tail.ok
    this.deps.onChainEnd?.(threadId, (run.lastTurnSucceeded ?? false) && published)
  }

  #refuse(threadId: string, reason: string): ChainRunStatus {
    this.#runs.delete(threadId)
    this.#refusals.set(threadId, reason)
    const status = this.status(threadId)
    this.deps.onChange(status)
    return status
  }
}

function defaultChainId(): string {
  return `chain-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// THE ADVANCE SHAPE, ONCE — the runner that issues the next thing when a turn
// ends, and the registry that guarantees only one of them is driving a thread.
//
// WHY THIS EXISTS. `BoardLoop` was already this machine: subscribe to turn
// completion, ask a pure module what to do next, hand the work to
// `AgentManager.sendMessage`, and do it again when that turn ends. The autopilot
// chain is the identical machine with a different question — "which stage of the
// flow comes next" instead of "which card comes next" — and writing it a second
// time beside the first is how two mechanisms that agree today stop agreeing
// tomorrow (allowed-pattern #14). So the shape lives here, once, and both the
// board's loop and the chain are configurations of it.
//
// THE PART THAT IS NOT A REFACTOR: `ThreadClaims`. Two advance paths that can
// both drive the same thread is the failure this phase was told to prevent, not
// a detail — a board-loop card whose thread is also being chained would get two
// messages for one finished turn, from two runners neither of which knows about
// the other. A claim is taken at dispatch and released at turn completion, in
// ONE shared registry both drivers hold, so the second claimant is refused in
// code rather than by everyone remembering.
//
// WHAT IS DELIBERATELY NOT HERE: anything that knows what the work IS. No task
// store, no thread store, no stages, no prompts. Every decision arrives through
// `decide`, which the caller implements with its own pure model module. That is
// what keeps this file the same size when a third driver appears.

/** What one run is doing, as any surface asks it. */
export interface DriveStatus {
  running: boolean
  /** The turn it is waiting on, or null between dispatches. */
  threadId: string | null
  /** What it is on — a card id, a stage name. Null when it holds nothing. */
  detail: string | null
  /**
   * Why it stopped, when it stopped ITSELF. Null while running, and null after
   * a person stopped it, which needs no explanation.
   */
  stoppedReason: string | null
}

/** The three answers a driver's model may give. Never two. */
export type DriveStep<W> =
  | { kind: 'work'; work: W }
  /** Something is in flight, or a person is being waited on. NOT a stop: the
   *  run is alive and will be pumped again. */
  | { kind: 'wait'; reason: string }
  | { kind: 'stop'; reason: string }

/** What a dispatch reports back: the turn it started, and what to call it. */
export interface Dispatched {
  threadId: string
  /** The run's `detail` from now until that turn ends. */
  detail: string
  /**
   * THE WORK WAS HANDED TO ANOTHER DRIVER, which now holds the conversation.
   *
   * A board card whose thread is put under an autopilot chain is the live case:
   * the chain issues every message in that conversation and the loop issues
   * none, so the CLAIM belongs to the chain — taking it here would refuse the
   * chain the very thread we just handed it. The run still holds the work
   * (`detail` is set, so its model answers `wait`) and is pumped again when
   * somebody tells it that thread is finished.
   *
   * The hand-off is only safe because of the guard in `onTurnComplete`: while
   * the other driver holds the claim, its own steps' turn completions are not
   * ours to advance on. What wakes this run is the other driver's ENDING — the
   * chain's `onChainEnd`, by which time the claim is released.
   */
  drivenElsewhere?: boolean
}

export interface TurnDriverDeps<W> {
  /**
   * A name for this driver, unique across the app. It is what `ThreadClaims`
   * records as the owner of a thread, so it appears in nothing a person reads.
   */
  name: string
  /** What to do now. Pure, and the caller's own module — never decided here. */
  decide: (key: string, state: { inFlight: string | null }) => DriveStep<W>
  /**
   * Hand the work over and report the turn it started. May throw.
   *
   * `null` means THE WORK WAS DONE HERE and no turn was started — the run has
   * nothing to wait on, so it is pumped again straight away. A model that
   * answers `work` forever while its dispatch always returns `null` would spin,
   * so the driver caps consecutive turnless steps (`MAX_TURNLESS_STEPS`) and
   * stops rather than looping; a model that makes progress never reaches it.
   */
  dispatch: (key: string, work: W) => Promise<Dispatched | null>
  /**
   * Which conversation this work would run in, when that is knowable BEFORE the
   * dispatch.
   *
   * THIS IS WHAT MAKES THE CLAIM A REFUSAL RATHER THAN AN APOLOGY. Without it
   * the driver can only claim once `dispatch` has already sent the message,
   * which is one message too late: the point of the registry is that a second
   * driver never talks into a conversation somebody else is working. Return
   * `null` (or omit the hook) when the thread does not exist yet — a board card
   * whose chat is created during the dispatch — and the claim is taken
   * afterwards, which is the best that case allows.
   */
  threadFor?: (key: string, work: W) => string | null
  /** Tell every surface this run changed. */
  onChange: (key: string, status: DriveStatus) => void
  /** A run was switched on. Somewhere to clear per-run bookkeeping. */
  onStart?: (key: string) => void
  /** A run ended — stopped, or finished. Symmetrical with `onStart`. */
  onEnd?: (key: string) => void
  /**
   * A turn this run was waiting on ended, BEFORE the next decision is asked
   * for. Where a caller reacts to the turn itself (the board's card moves to
   * Review here) without the reaction being able to change what comes next.
   */
  onSettled?: (key: string, threadId: string, success: boolean) => void
  /** The shared registry. Omitted → a private one, which is a test's business
   *  and never the app's: the app has exactly one. */
  claims?: ThreadClaims
}

/**
 * Who is driving which thread — one registry for the whole app.
 *
 * A thread may be claimed by at most one run, of any driver. The claim is taken
 * when a message is dispatched and released when that turn ends (or when the
 * run is stopped), so "is anything already driving this thread" is a question
 * with a single answer rather than a convention.
 */
export interface ThreadClaim {
  /** The driver holding it — `TurnDriverDeps.name`. */
  driver: string
  /** Which of that driver's runs. */
  key: string
}

export class ThreadClaims {
  readonly #owners = new Map<string, ThreadClaim>()

  /** Take the thread, or refuse because somebody else has it. */
  claim(threadId: string, owner: ThreadClaim): boolean {
    const held = this.#owners.get(threadId)
    if (held !== undefined && !sameOwner(held, owner)) return false
    this.#owners.set(threadId, owner)
    return true
  }

  /** Give it back. A release by anyone but the owner does nothing. */
  release(threadId: string, owner: ThreadClaim): void {
    const held = this.#owners.get(threadId)
    if (held !== undefined && sameOwner(held, owner)) this.#owners.delete(threadId)
  }

  /** Who is driving this thread, or null when nobody is. */
  ownerOf(threadId: string): ThreadClaim | null {
    return this.#owners.get(threadId) ?? null
  }
}

function sameOwner(left: ThreadClaim, right: ThreadClaim): boolean {
  return left.driver === right.driver && left.key === right.key
}

interface Run {
  /** The turn in flight, or null between dispatches. */
  inFlightThreadId: string | null
  /**
   * The conversation this run HOLDS — kept across a wait, released only when
   * the run moves to another conversation or stops.
   *
   * Not the same as the turn in flight, and the difference is the whole reason
   * both exist. A run whose model answered `wait` (a person is being asked
   * something) has no turn running, but it is still the thing driving that
   * conversation: releasing the claim there would mean the reply that resumes
   * it reaches nobody, and the run would sit alive and deaf for ever.
   */
  claimedThreadId: string | null
  /** What the run is on right now. Cleared when its turn ends. */
  detail: string | null
}

/**
 * One driver, many runs. A run is keyed by whatever the caller drives — a
 * project root for the board's loop, a thread id for the autopilot chain.
 *
 * HELD IN MAIN, NEVER IN A SURFACE. A run outlives the tab that started it:
 * closing a view must not abandon an agent mid-task.
 */
export class TurnDriver<W> {
  readonly #runs = new Map<string, Run>()
  readonly #stopped = new Map<string, string>()
  /**
   * The runs whose `dispatch` has been handed over and has not come back yet.
   *
   * A SEND IS NOT AN INSTANT, and treating it as one is how two live turns end
   * up in one conversation. `AgentManager.sendMessage` resolves when the turn
   * STARTS, not when it finishes, so between the claim this driver takes in
   * `pump` and the moment the dispatch returns there is a real window in which
   * a message is on its way out and nothing has been recorded about it yet.
   */
  readonly #sending = new Set<string>()
  /**
   * A claim a stop could not release, because a send was still going out.
   *
   * WHY A STOP MUST NOT RELEASE MID-SEND. `stop()` frees the conversation so
   * something else may take it — which is right once the driver knows what its
   * dispatch did, and wrong while it is still doing it: released there, another
   * driver claims a thread whose first message has not even arrived and speaks
   * into it, so one conversation gets two opening turns from two runners. The
   * release is therefore deferred to the moment the dispatch settles, which is
   * exactly the state the ordinary stop already documents (a turn in flight,
   * left alone, and the thread free again).
   */
  readonly #heldPastStop = new Map<string, string>()
  readonly #claims: ThreadClaims

  constructor(private readonly deps: TurnDriverDeps<W>) {
    this.#claims = deps.claims ?? new ThreadClaims()
  }

  status(key: string): DriveStatus {
    const run = this.#runs.get(key)
    if (run === undefined) {
      return {
        running: false,
        threadId: null,
        detail: null,
        stoppedReason: this.#stopped.get(key) ?? null,
      }
    }
    return {
      running: true,
      threadId: run.inFlightThreadId,
      detail: run.detail,
      stoppedReason: null,
    }
  }

  /** Is this run switched on? */
  isRunning(key: string): boolean {
    return this.#runs.has(key)
  }

  /** Switch a run on and take its first step. Idempotent. */
  async start(key: string): Promise<DriveStatus> {
    if (this.#runs.has(key)) return this.status(key)
    this.#runs.set(key, { inFlightThreadId: null, claimedThreadId: null, detail: null })
    this.#stopped.delete(key)
    this.deps.onStart?.(key)
    this.#announce(key)
    await this.pump(key)
    return this.status(key)
  }

  /**
   * Switch it off.
   *
   * THE TURN IN FLIGHT IS LEFT ALONE. Stopping means "issue nothing more", not
   * "kill the agent that is mid-sentence" — interrupting a run is its own
   * gesture, on the thread, where a person can see what they are interrupting.
   * The claim is released so the thread is free again; the conversation, the
   * files it is writing and the work it is doing are untouched.
   *
   * THE ONE THING IT WILL NOT DO IS RELEASE MID-SEND. A stop that lands while
   * a dispatch is still in flight knows nothing about what that dispatch is
   * starting, so freeing the conversation there hands it to another driver
   * while a message is on its way into it — see `#heldPastStop`. The release
   * then happens the instant the dispatch settles, and everything else about
   * the stop takes effect immediately: the run is gone and nothing more is
   * ever issued, which is the part a person pressing stop is asking for.
   */
  stop(key: string, reason?: string): DriveStatus {
    const run = this.#runs.get(key)
    if (run === undefined) return this.status(key)
    if (run.claimedThreadId !== null) {
      if (this.#sending.has(key)) this.#heldPastStop.set(key, run.claimedThreadId)
      else this.#claims.release(run.claimedThreadId, this.#owner(key))
    }
    this.#runs.delete(key)
    if (reason !== undefined) this.#stopped.set(key, reason)
    else this.#stopped.delete(key)
    this.deps.onEnd?.(key)
    this.#announce(key)
    return this.status(key)
  }

  /**
   * A turn ended somewhere. If this driver was waiting on it, take the next
   * step — and only this driver, because only one run can have claimed it.
   */
  onTurnComplete(threadId: string, success = true): void {
    const owner = this.#claims.ownerOf(threadId)
    // A CONVERSATION SOMEBODY ELSE IS DRIVING IS NOT OURS TO ADVANCE ON. Every
    // turn that ends while another driver holds the claim is one of ITS steps:
    // a run that handed its work to a chain must not treat the chain's first
    // finished stage as its own card being finished.
    if (owner !== null && owner.driver !== this.deps.name) return
    for (const [key, run] of this.#runs) {
      // `claimedThreadId` for a turn we started, `inFlightThreadId` for one we
      // handed over — the second is unclaimed by us, by construction.
      if (run.claimedThreadId !== threadId && run.inFlightThreadId !== threadId) continue
      // THE CLAIM SURVIVES THE TURN. What ended is one turn, not the run's hold
      // on the conversation — see `Run.claimedThreadId`. It is released when the
      // run moves on, or when it stops.
      run.inFlightThreadId = null
      run.detail = null
      this.deps.onSettled?.(key, threadId, success)
      void this.pump(key)
      return
    }
    // Claimed by this driver but by no live run — a stop raced the turn's end.
    if (owner !== null) this.#claims.release(threadId, owner)
  }

  /** Take the next step, or stop, or hold. Never throws. */
  async pump(key: string, turnlessSteps = 0): Promise<void> {
    const run = this.#runs.get(key)
    if (run === undefined) return
    const step = this.deps.decide(key, { inFlight: run.detail })
    if (step.kind === 'wait') return
    if (step.kind === 'stop') {
      this.stop(key, step.reason)
      return
    }
    try {
      // CLAIMED BEFORE THE SEND when the conversation is knowable — the refusal
      // has to happen before a message goes out, not after.
      const foreseen = this.deps.threadFor?.(key, step.work) ?? null
      if (foreseen !== null && !this.#take(key, run, foreseen)) {
        this.stop(key, ALREADY_DRIVEN)
        return
      }
      const sent = await this.#send(key, step.work)
      // The run may have been stopped while the dispatch was in flight — a
      // person pressing stop mid-send. Their gesture wins: the turn that was
      // started is left alone, and nothing more is issued.
      const live = this.#runs.get(key)
      if (live === undefined) return
      if (sent === null) {
        if (turnlessSteps + 1 >= MAX_TURNLESS_STEPS) {
          this.stop(key, MADE_NO_PROGRESS)
          return
        }
        await this.pump(key, turnlessSteps + 1)
        return
      }
      if (sent.drivenElsewhere === true) {
        // HANDED OVER, SO NOT HELD. Whatever we were holding is released —
        // including, in the ordinary case, nothing at all — and the other
        // driver's claim on this thread is left exactly where it is.
        if (live.claimedThreadId !== null) {
          this.#claims.release(live.claimedThreadId, this.#owner(key))
          live.claimedThreadId = null
        }
      } else if (!this.#take(key, live, sent.threadId)) {
        this.stop(key, ALREADY_DRIVEN)
        return
      }
      live.inFlightThreadId = sent.threadId
      live.detail = sent.detail
      this.#announce(key)
    } catch (error) {
      // THE RUN STOPS AND SAYS WHY. A dispatch that failed is not work that
      // failed — nobody ever got it — so advancing past it would skip a step
      // nobody has taken, silently.
      const current = this.#runs.get(key)
      if (current !== undefined) current.inFlightThreadId = null
      this.stop(key, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Hand the work over, with the window it is in flight marked.
   *
   * The marker is what `stop()` reads to know it must not free the
   * conversation yet, and the `finally` is what guarantees the deferred
   * release actually happens — including down the path where the dispatch
   * THREW, which is the one a reader forgets and the one that would otherwise
   * hold a conversation hostage for the rest of the session.
   */
  async #send(key: string, work: W): Promise<Dispatched | null> {
    this.#sending.add(key)
    try {
      return await this.deps.dispatch(key, work)
    } finally {
      this.#sending.delete(key)
      this.#settleHeldClaim(key)
    }
  }

  /** Release a claim a stop deferred, now that the send it waited on is over. */
  #settleHeldClaim(key: string): void {
    const held = this.#heldPastStop.get(key)
    if (held === undefined) return
    this.#heldPastStop.delete(key)
    // A RESTART MAY ALREADY HAVE TAKEN IT BACK. Same driver, same key, so the
    // registry cannot tell a new run's hold from the stopped one's — and
    // releasing here would leave a live run driving a conversation the registry
    // says is free, which is the invariant inverted rather than enforced.
    if (this.#runs.get(key)?.claimedThreadId === held) return
    this.#claims.release(held, this.#owner(key))
  }

  /**
   * Hold `threadId` for this run, releasing whatever it held before.
   *
   * False means somebody else has it — one conversation, one driver, refused in
   * code rather than by everyone remembering.
   */
  #take(key: string, run: Run, threadId: string): boolean {
    if (run.claimedThreadId === threadId) return true
    if (!this.#claims.claim(threadId, this.#owner(key))) return false
    if (run.claimedThreadId !== null) this.#claims.release(run.claimedThreadId, this.#owner(key))
    run.claimedThreadId = threadId
    return true
  }

  #owner(key: string): ThreadClaim {
    return { driver: this.deps.name, key }
  }

  #announce(key: string): void {
    this.deps.onChange(key, this.status(key))
  }
}

/** The stop reasons the driver itself authors. Plain, and about the work. */
export const ALREADY_DRIVEN = 'Something else is already working this conversation.'

/** How many steps in a row may finish without starting a turn. */
export const MAX_TURNLESS_STEPS = 8

export const MADE_NO_PROGRESS = 'This stopped making progress, so it was ended.'

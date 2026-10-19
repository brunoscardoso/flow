// Publishing a branch from the change review — the whole distance between a
// press and a remote, in one main-side seam.
//
// FOUR FACTS SHAPE EVERYTHING BELOW:
//
//  1. THE PUSH IS NOT A GIT CALL. It is `worktree push`, the same verb the
//     landing flow and `/execute-plan` already use (allowed-pattern #14). A raw
//     `git push` reachable from the renderer is precisely the wrong-but-valid
//     push the whole binding subsystem exists to prevent: it would send the
//     LOCAL branch name to whatever remote `push.default` happened to pick, to
//     a destination nobody chose.
//
//  2. AN UNBOUND BRANCH IS A QUESTION, NOT A FAILURE. The verb refuses a branch
//     nobody has aimed and attaches the entire ask — the suggestion, where it
//     came from, the remote, the remotes this repository actually has
//     (allowed-pattern #21). That refusal is relayed intact as `unbound`, so the
//     surface asking can pre-fill a real question instead of reporting a dead
//     end. NOTHING here fills the blank in from a default (allowed-pattern #22).
//
//  3. NOTHING IS SPAWNED UNTIL DIVERGENCE HAS BEEN RULED OUT. A branch whose
//     remote has commits it does not is refused in words, before any child
//     process exists. There is no force, no pull, no rebase and no merge
//     anywhere in this file — the reader is told what is true and left to
//     decide.
//
//  4. `ahead: 0` MEANS TWO OPPOSITE THINGS, which is why the upstream is read
//     alongside the status. A branch with nothing left to publish and a branch
//     nobody has ever published both report zero, because with no upstream
//     there is nothing to be ahead OF. Short-circuiting on the count alone
//     would answer a first publish with "there is nothing to publish".

import type {
  GitPublishBinding,
  GitPublishResult,
  GitStatus,
  ThreadBindingRequest,
} from '../../shared/ipc-contract'
import { parseCliJson, unboundRefusal } from './thread-merge'
import { refusalReason, checkoutNameArgs, type RunResult } from '../worktree/thread-worktree'

/** Everything the service reaches the outside world through. */
export interface GitPublishDeps {
  /**
   * Run the bundled `planflow-ai`. The SAME injected spawner
   * `ThreadLandingService` takes (`runBundledCliCapturing` bound to the bundle),
   * so there is one way this app runs the CLI and one place it is wired.
   */
  runCli: (cwd: string, args: readonly string[]) => Promise<RunResult>
  /** The checkout's git status — where `ahead` and `behind` come from. */
  status: (rootPath: string) => Promise<GitStatus | null>
  /**
   * The upstream ref this checkout's branch is aimed at, or null.
   *
   * GIT'S OWN CONFIGURATION, not Flow's mirror of a thread's binding — the two
   * can disagree and git is the one that decides where a push lands. It is
   * `GitManager.upstreamOf`, structurally, and it is here rather than derived
   * from the status because the status cannot tell "aimed and in sync" from
   * "never aimed at all" (fact 4 above).
   */
  upstreamOf: (rootPath: string) => Promise<string | null>
  /**
   * The thread that OWNS this checkout, or null when the root is a project
   * everyone shares.
   *
   * It decides `--thread` versus `--here` — and, with `--thread`, WHAT THE
   * TARGET IS. The verb derives a repo's thread-worktree container from
   * `--target`, so naming the worktree itself asks it to look for this thread
   * inside this thread's own checkout, where it will never be: the push refused
   * with "thread '<id>' has no worktree" for a worktree that was sitting
   * right there. `--target` is the project; `--thread` says which of its
   * worktrees.
   *
   * This is a FACT ABOUT THE CHECKOUT, answered in main, so no surface ever has
   * to choose between the two paths.
   */
  threadFor: (rootId: string) => { threadId: string; projectRoot: string } | null
  /**
   * Write a THREAD's binding — `ThreadBindingService.bind`, injected.
   *
   * NOT A STORE, AND NOT A SECOND IMPLEMENTATION. A thread's binding is written
   * in exactly one place, which also mirrors it into the thread store, records
   * a rename and reconciles against git; reaching for the store from here would
   * split that invariant across two code paths (allowed-pattern #14). So this
   * service asks for the existing function the way it asks for the spawner, and
   * main hands it the same instance the `threads:bindWorktree` channel calls.
   *
   * `ok: false` carries a sentence that is already display-safe — the service
   * relays the CLI's reason without composing a remedy out of it
   * (forbidden-pattern #12).
   */
  bindThread: (
    request: ThreadBindingRequest,
  ) => Promise<{ ok: true } | { ok: false; detail: string }>
}

/**
 * Every way an answer about where to publish can be unusable.
 *
 * Extracted from the result union rather than re-listed, so the binding step
 * cannot grow a refusal the channel has no way to report.
 */
export type GitPublishBindRefusal = Extract<
  GitPublishResult,
  { status: 'unconfirmed' | 'incomplete' | 'bind-failed' }
>

/** The branch is aimed, or here is what to say instead. */
export type GitPublishBindOutcome = { ok: true } | { ok: false; refusal: GitPublishBindRefusal }

/** What `worktree push` prints on success, as far as this module reads it. */
interface PushPayload {
  remote?: unknown
  remoteBranch?: unknown
  previouslyPushedAs?: unknown
}

/**
 * Publishes a checkout's branch. One instance per app, constructed in main and
 * reached only through the `git:publish` channel.
 */
export class GitPublishService {
  constructor(private readonly deps: GitPublishDeps) {}

  /**
   * Send this checkout's branch where it is bound, or say why nothing was sent.
   *
   * THE ORDER IS THE SAFETY STORY. Read, rule out, then spawn — each refusal
   * above the spawn is a push that provably never happened, which is the thing
   * a test can assert (allowed-pattern #24) and the thing a reader is promised.
   *
   * `binding` IS THE ANSWER COMING BACK. A first press sends none and may get
   * `unbound` — a question, not a failure; the surface asks it, and the press
   * that follows carries the answer here. Present and confirmed, the branch is
   * aimed and then pushed ONCE: one press, one push, whether or not a binding
   * had to be written first.
   */
  async publish(rootId: string, binding?: GitPublishBinding): Promise<GitPublishResult> {
    // ONE ROUND OF GIT, like the review's own read: the two questions are asked
    // of the same repository moments apart, and issuing them in sequence would
    // double the wait on the process every window is queued behind
    // (allowed-pattern #19).
    const [status, upstream] = await Promise.all([
      this.deps.status(rootId).catch(() => null),
      this.deps.upstreamOf(rootId).catch(() => null),
    ])
    if (status === null) {
      // CANNOT SAY IS NOT PERMISSION TO TRY. Without the counts, neither the
      // divergence check nor the nothing-to-do check has been made, and a
      // spawn here would be a push taken on no evidence at all.
      return {
        status: 'failed',
        detail: 'Flow couldn’t read this repository, so it didn’t publish anything.',
      }
    }

    // AIMED AND ALREADY THERE. Said plainly rather than pushed anyway: a push
    // with nothing to send succeeds, and reporting that as "published" would
    // teach the reader that the button lies about what it did.
    if (status.ahead === 0 && upstream !== null) return { status: 'nothing' }

    // BEFORE ANY SPAWN. Both sides have moved, so publishing is not a question
    // of permission but of what to do with the other side's commits — and
    // pulling, rebasing or forcing on the reader's behalf is exactly the
    // decision this control does not get to make.
    if (status.behind > 0 && status.ahead > 0) {
      return { status: 'diverged', behind: status.behind }
    }

    // THE ANSWER IS WRITTEN HERE, BELOW THE CHECKS AND ABOVE THE SPAWN, and the
    // order is not incidental. Binding first would move the ground the checks
    // stand on: the moment an upstream exists, `ahead: 0` stops meaning "never
    // published" and starts meaning "already there" (fact 4), so a first
    // publish of a branch with a single commit could bind itself and then
    // report there was nothing to publish. The checks are asked of the
    // repository as the reader found it.
    if (binding !== undefined) {
      const bound = await this.bindFor(rootId, binding)
      // A BIND THAT FAILED IS NOT A PUSH. Falling through would send the branch
      // to wherever it was aimed BEFORE the answer — which, for the case this
      // exists to serve, is nowhere anybody chose.
      if (!bound.ok) return bound.refusal
    }

    const owner = this.deps.threadFor(rootId)
    const run = await this.deps.runCli(rootId, [
      'worktree',
      'push',
      // The PROJECT for a thread's worktree, the checkout itself for a plain
      // one — see `threadFor`. Passing the worktree with `--thread` is what
      // made a push refuse a worktree that existed.
      '--target',
      owner === null ? rootId : owner.projectRoot,
      // `--thread` and `--here` are mutually exclusive and neither defaults to
      // the other. NOTHING ELSE IS PASSED: `--unattended` is the one flag that
      // can bind a branch without anybody answering, and this call is made by a
      // person pressing a button — the ask is the point (plan risk R4).
      ...(owner === null
        ? ['--here']
        : // rootId IS the thread's checkout here — its folder lets the CLI's one
          // resolver find a named checkout that predates its own record.
          ['--thread', owner.threadId, ...checkoutNameArgs(owner.threadId, rootId)]),
      '--json',
    ])

    if (!run.ok) {
      // THE REFUSAL THAT CARRIES ITS OWN ANSWER, read FIRST. An unbound branch
      // reached here by exiting non-zero, and reading that as a failure would
      // throw away the question it came with.
      const unbound = unboundRefusal(run)
      if (unbound !== null) return { status: 'unbound', suggestion: unbound }
      console.warn('[GitPublish] could not publish the branch', {
        rootId,
        reason: refusalReason(run),
      })
      return { status: 'failed', detail: publishFailureSentence(run) }
    }

    // WHAT THE VERB WROTE, NOT WHAT WAS ASKED FOR. The remote branch a push
    // lands on is the binding git holds, which a hand-edited config or a rename
    // may have moved since anything here last looked.
    const published = parseCliJson<PushPayload>(run.stdout)
    const remote = nonEmpty(published?.remote)
    const remoteBranch = nonEmpty(published?.remoteBranch)
    if (remote === null || remoteBranch === null) {
      // THE PUSH HAPPENED; THE REPORT DID NOT. `published` promises a place to
      // name, and naming one this module guessed would be a claim nothing
      // stands behind — so the honest answer is that Flow cannot say where it
      // went. The sentence never says "nothing was sent", because something was.
      return {
        status: 'failed',
        detail: 'The branch was sent, but Flow couldn’t tell where it landed.',
      }
    }
    const previous = nonEmpty(published?.previouslyPushedAs)
    return {
      status: 'published',
      remote,
      remoteBranch,
      // Omitted rather than null when there was no rename — an optional field
      // present-and-empty reads on the other side as "renamed to nothing".
      ...(previous === null ? {} : { previouslyPushedAs: previous }),
    }
  }

  /**
   * Say where this checkout publishes — one function, two paths, and the caller
   * chooses neither.
   *
   * WHICH PATH IS A FACT ABOUT THE CHECKOUT. A thread that owns this copy has a
   * store that mirrors the binding, records a rename and reconciles against
   * git; a project root is a plain checkout with none of that. The two are
   * written by different callers of the same verb, and the difference is
   * answered here — in main, from `threadFor` — precisely so that no surface
   * ever has to know a thread's binding is written differently from a
   * project's. A renderer that had to pick would be one refactor away from
   * picking wrong in a place nothing tests.
   *
   * BOTH GATES BEFORE EITHER PATH. The confirmation and the two blanks are
   * checked once, above the fork, so neither path can be reached with an
   * unconfirmed or half-given answer — and the thread path's own service checks
   * them again on its side, which is two gates on a write that decides where
   * real work lands, not one duplicated.
   */
  async bindFor(rootId: string, binding: GitPublishBinding): Promise<GitPublishBindOutcome> {
    // NO DEFAULT, AND NO TRUE-BY-OMISSION (forbidden-pattern #15). Anything but
    // an explicit `true` — absent, false, or whatever else crossed the wire —
    // is silence, and silence is not consent to write a destination.
    if (binding.confirmed !== true) {
      return refuse(
        'unconfirmed',
        'Choosing where this branch publishes needs someone to ask for it.',
      )
    }
    const remote = binding.remote.trim()
    const remoteBranch = binding.remoteBranch.trim()
    // NOTHING IS FILLED IN (allowed-pattern #22). The project's default remote
    // is sitting right there and completing the blank from it would be exactly
    // the silent guess this control exists to remove — moved one layer below
    // where anybody would look for it.
    if (remote === '') {
      return refuse('incomplete', 'Say where this work should be published.')
    }
    if (remoteBranch === '') {
      return refuse('incomplete', 'Say what this work should be called when it gets there.')
    }

    const owner = this.deps.threadFor(rootId)
    if (owner !== null) {
      const written = await this.deps.bindThread({
        threadId: owner.threadId,
        remote,
        remoteBranch,
        // NULL FOLLOWS THE BRANCH THE WORK WAS CUT FROM, which is right because
        // this press opens no pull request. Naming a base here would record an
        // answer to a question nobody was asked.
        prBase: null,
        // Relayed as the explicit thing it is — the gate above is what decided
        // it, and this is the one call allowed to have passed it.
        confirmed: true,
      })
      if (written.ok) return { ok: true }
      return { ok: false, refusal: { status: 'bind-failed', detail: written.detail } }
    }

    const run = await this.deps.runCli(rootId, [
      'worktree',
      'bind',
      '--target',
      rootId,
      // `--here`, matching how the push above names this checkout: a project
      // root is a plain checkout to the verb, with no thread the store could
      // hold a binding for.
      '--here',
      '--remote',
      remote,
      '--branch',
      remoteBranch,
      // `--pr-base` IS NEVER PASSED ON THIS PATH, and the verb would refuse the
      // whole call if it were (src/cli/commands/worktree.ts, `runBind`). Its
      // reason is the same one that makes this path exist: a plain checkout has
      // no store to keep a PR base in, git has no config key for one, and the
      // verb refuses rather than accepting a value it would silently drop. The
      // base belongs at the call that uses it — the pull request — and this
      // press opens none.
      '--json',
    ])
    if (!run.ok) {
      console.warn('[GitPublish] could not record where the branch publishes', {
        rootId,
        reason: refusalReason(run),
      })
      return { ok: false, refusal: { status: 'bind-failed', detail: bindFailureSentence(run) } }
    }
    // WHAT THE VERB WROTE IS NOT READ BACK HERE. The push that follows asks git
    // where this branch is aimed and reports THAT — so a binding the verb
    // normalised on its way to disk is reported from the one place that can
    // still be right about it.
    return { ok: true }
  }
}

/** One refusal, named by the status a surface will read it as. */
function refuse(
  status: GitPublishBindRefusal['status'],
  detail: string,
): { ok: false; refusal: GitPublishBindRefusal } {
  return { ok: false, refusal: { status, detail } }
}

/** A non-empty string off an unknown payload field, or null. */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Why the push failed, as a sentence a toolbar can print.
 *
 * THE DISPLAY BOUNDARY, AND ONLY HERE (forbidden-pattern #12, the same job
 * `withoutCommandHint` does for the loops panel — that helper lives in the
 * renderer, which main must not import from, so the rule is applied on this
 * side of the wire instead). The CLI already writes reasons for a terminal
 * reader and its own `pushFailureReason` already drops git's transcript and its
 * `hint:` lines; what can still ride along is a backticked invocation, and a
 * command in a toolbar is a dead end wearing a button's clothes.
 *
 * DISPLAY ONLY. Nothing that decides behaviour reads this — the raw reason goes
 * to the console for whoever is debugging.
 */
export function publishFailureSentence(run: RunResult): string {
  const sentence = plainRefusal(run)
  if (sentence === null) return 'Flow couldn’t publish this branch. Nothing was sent.'
  // The verb's reasons are fragments ("could not push to origin/x — …"), so
  // they are placed in a sentence rather than printed as one.
  return `Flow couldn’t publish this branch — ${sentence}.`
}

/**
 * Why the binding could not be written, as a sentence a toolbar can print.
 *
 * A SEPARATE SENTENCE BECAUSE IT IS A SEPARATE EVENT. `publishFailureSentence`
 * says a push did not happen; here the push was never reached, and telling the
 * reader their branch was not published would leave them looking for a problem
 * with the remote instead of with the answer they just gave. Same scrubbing,
 * same display boundary (forbidden-pattern #12) — only the frame differs.
 */
export function bindFailureSentence(run: RunResult): string {
  const sentence = plainRefusal(run)
  if (sentence === null) {
    return 'Flow couldn’t record where this branch publishes. Nothing was sent.'
  }
  return `Flow couldn’t record where this branch publishes — ${sentence}.`
}

/**
 * The CLI's reason with everything a reader cannot act on taken out of it, or
 * null when it said nothing readable at all.
 *
 * ONE SCRUBBER FOR BOTH SENTENCES. The rules below are the display boundary
 * itself, and two copies of them would be two boundaries that drift — the next
 * invocation shape the CLI learns to print would be stripped from one toolbar
 * string and not the other.
 */
function plainRefusal(run: RunResult): string | null {
  const reason = refusalReason(run)
  if (reason === null || reason.trim() === '') return null
  const plain = reason
    // A backticked invocation, with or without the lead-in that introduces it.
    .replace(/[—-]?\s*[a-z ]*\bwith\s+`[^`]*`/gi, '')
    .replace(/`[^`]*`/g, '')
    // A path — internals that change, in text a reader cannot act on.
    //
    // TWO RULES, AND THE SECOND ONE IS DELIBERATELY NARROW. An ABSOLUTE path is
    // recognisable on its own (it starts at the root, or at a drive letter), so
    // it goes whole. A RELATIVE one is not: `origin/feature/PF-42` has exactly
    // the shape of `flow/plans/x`, and a rule broad enough to catch the second
    // eats the remote branch name this sentence exists to report. So relative
    // paths are matched only when they end in a file this project actually
    // names, which is the same trade the renderer's own display-boundary helper
    // makes.
    .replace(/(^|\s)(?:[A-Za-z]:)?[\\/][^\s]+/g, '$1its settings')
    .replace(
      /(?:[A-Za-z]:)?[^\s:\\/]*(?:[\\/][^\s:\\/]+)+\.(?:md|json|jsonl|ya?ml|toml|flowconfig)/g,
      'its settings',
    )
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([—-])\s*$/, '')
    .trim()
  // A reason that scrubbed away to nothing was ALL invocation, and the raw one
  // is still better than silence — the caller frames it, and the console has
  // the untouched text for whoever is debugging.
  return plain === '' ? reason.trim() : plain
}

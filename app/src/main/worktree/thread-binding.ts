// Where a thread publishes, on the app's side of the wire
// (thread_remote_binding Phase 5).
//
// THIS MODULE DECIDES NOTHING. A binding is `{ remote, remoteBranch, prBase }`
// and every part of it comes from a person's answer, written to git's own
// upstream config by `worktree bind` — the one writer (allowed-pattern #14).
// What lives here is the two things the IDE needs around that verb:
//
//  1. READING. The store mirrors the binding so a panel costs no child
//     processes per row (allowed-pattern #19). A mirror can drift — somebody
//     used plain git, or worked in the checkout by hand — so a read reconciles
//     against `worktree list --json` and GIT WINS. `prBase` is the exception in
//     both directions: git has no key for it, so the mirror is its only home
//     and a reconcile carries it across rather than dropping it.
//
//  2. WRITING. `bind` requires `confirmed: true` and refuses without it
//     (forbidden-pattern #15). A binding decides where real work lands; a call
//     that did not say a person asked for it must do nothing at all.
//
// It NEVER writes git from the mirror. The migration case — a thread whose
// branch already had an upstream before any of this existed — is a read:
// git's answer becomes the mirror, and nothing is renamed, re-pointed or
// pushed to make the two agree (FR-10).

import type { ThreadBindingRequest, ThreadBindingState } from '../../shared/ipc-contract'
import { refusalReason, checkoutNameArgs, type RunResult } from './thread-worktree'

/** A thread, as a binding needs to see it. */
export interface BindingThread {
  id: string
  /** The registered project root — what `--target` names. */
  projectRoot: string
  worktreePath: string | null
  worktreeBranch: string | null
  worktreeBase: string | null
  /** The mirror. All null while nobody has decided anything. */
  remote: string | null
  remoteBranch: string | null
  prBase: string | null
  previouslyPushedAs: string | null
}

export interface ThreadBindingDeps {
  threadStore: {
    getThread(threadId: string): BindingThread | null
    setThreadBinding(
      threadId: string,
      binding: {
        remote: string
        remoteBranch: string
        prBase: string | null
        /** Omitted LEAVES the stored value — a rename records it once. */
        previouslyPushedAs?: string | null
      } | null,
    ): void
  }
  /** Run the bundled `planflow-ai`. Async, always (allowed-pattern #19). */
  runCli: (cwd: string, args: readonly string[]) => Promise<RunResult>
}

/** A thread that publishes nowhere and proposes nothing. */
const UNBOUND: ThreadBindingState = {
  bound: false,
  remote: null,
  remoteBranch: null,
  prBase: null,
  previouslyPushedAs: null,
  suggestion: null,
}

/** What `worktree list --json` says about one worktree's binding. */
interface ListedWorktree {
  thread?: unknown
  branch?: unknown
  remote?: unknown
  remoteBranch?: unknown
  bound?: unknown
}

/** What `worktree bind` prints on success. */
interface BindResult {
  remote?: unknown
  remoteBranch?: unknown
  prBase?: unknown
  previouslyPushedAs?: unknown
}

/**
 * The binding a thread's mirror holds — no git, no proposal.
 *
 * `bound` IS THE FIELD a consumer reads. Half a binding is not a binding: a
 * remote with no branch would read as decided and publish nowhere, so both
 * halves answer the question together, here, once.
 */
export function mirrorOf(thread: BindingThread): ThreadBindingState {
  const remote = thread.remote ?? null
  const remoteBranch = thread.remoteBranch ?? null
  return {
    bound: remote !== null && remote !== '' && remoteBranch !== null && remoteBranch !== '',
    remote,
    remoteBranch,
    prBase: thread.prBase ?? null,
    previouslyPushedAs: thread.previouslyPushedAs ?? null,
    suggestion: null,
  }
}

/**
 * Reads and writes one thread's remote binding. One instance per app,
 * constructed in main and reached only through the thread IPC layer.
 */
export class ThreadBindingService {
  constructor(private readonly deps: ThreadBindingDeps) {}

  /**
   * Where this thread publishes right now.
   *
   * READ-ONLY AGAINST GIT, and it may WRITE THE MIRROR — those are not the same
   * thing. Nothing here changes a remote, a branch or an upstream; when the two
   * sides disagree the mirror is rewritten from git, which is the only
   * direction that can be right (FR-5).
   *
   * It answers `suggestion: null` always. Proposing a name costs a ladder of
   * git reads, and the moment that is worth paying for is the refusal a push
   * gives back — the surface that asks pre-fills from THAT, or from the local
   * branch name labelled as exactly what it is.
   */
  async read(threadId: string): Promise<ThreadBindingState> {
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null) return UNBOUND
    const mirror = mirrorOf(thread)
    // NOTHING TO RECONCILE AGAINST. A thread with no checkout of its own has no
    // local branch for an upstream to hang off, so the mirror is all there is.
    if (thread.worktreePath === null) return mirror
    return this.#reconcile(thread, mirror)
  }

  /**
   * Say where this thread publishes.
   *
   * THE GATE IS FIRST AND HAS NO DEFAULT (forbidden-pattern #15). Everything
   * below writes git config that decides where real work lands, so a request
   * that did not say a person asked for it gets a sentence and no git at all.
   *
   * NOTHING IS FILLED IN. An empty remote or an empty branch is refused rather
   * than completed from the local name or the project's default — the silent
   * completion IS the bug this feature removes, and doing it here would hide it
   * one layer below where anybody would look for it.
   */
  async bind(
    request: ThreadBindingRequest,
  ): Promise<{ ok: true; state: ThreadBindingState } | { ok: false; detail: string }> {
    if (request.confirmed !== true) {
      return { ok: false, detail: 'Choosing where this thread publishes needs someone to ask for it.' }
    }
    const remote = request.remote.trim()
    const remoteBranch = request.remoteBranch.trim()
    if (remote === '') {
      return { ok: false, detail: 'Say where this thread’s work should be published.' }
    }
    if (remoteBranch === '') {
      return { ok: false, detail: 'Say what this thread’s work should be called when it gets there.' }
    }
    const thread = this.deps.threadStore.getThread(request.threadId)
    if (thread === null || thread.worktreePath === null) {
      return { ok: false, detail: 'This thread has no branch of its own.' }
    }
    if (thread.worktreeBranch === null || thread.worktreeBranch === '') {
      return {
        ok: false,
        detail: 'This thread’s work isn’t on a branch of its own yet, so there is nothing to publish.',
      }
    }

    const prBase = request.prBase === null ? '' : request.prBase.trim()
    const result = await this.deps.runCli(thread.projectRoot, [
      'worktree',
      'bind',
      '--target',
      thread.projectRoot,
      '--thread',
      thread.id,
      // THE FOLDER, SO THE VERB FINDS A NAMED CHECKOUT (the CLI's one resolver).
      ...checkoutNameArgs(thread.id, thread.worktreePath),
      '--remote',
      remote,
      '--branch',
      remoteBranch,
      ...(prBase === '' ? [] : ['--pr-base', prBase]),
      '--json',
    ])
    if (!result.ok) {
      // THE REASON, NOT THE REMEDY. The CLI's refusals are written for a
      // terminal and some of them end in an invocation; the display boundary
      // strips that (forbidden-pattern #12), and nothing here composes one.
      const reason = refusalReason(result)
      return {
        ok: false,
        detail:
          reason === null
            ? 'Flow couldn’t record where this thread publishes. Nothing changed.'
            : reason,
      }
    }

    // WHAT THE VERB WROTE, NOT WHAT WAS ASKED FOR. `bind` is the thing that
    // knows whether this re-pointed a branch that had already been published,
    // and the record of that old name comes back with the result.
    const written = parseCliJson<BindResult>(result.stdout)
    const boundRemote = text(written?.remote) ?? remote
    const boundBranch = text(written?.remoteBranch) ?? remoteBranch
    const boundBase = text(written?.prBase) ?? (prBase === '' ? null : prBase)
    const previously = text(written?.previouslyPushedAs)
    try {
      this.deps.threadStore.setThreadBinding(thread.id, {
        remote: boundRemote,
        remoteBranch: boundBranch,
        prBase: boundBase,
        // Omitted when the verb reported none: the record of a rename is
        // written once and must survive a later edit of the base.
        ...(previously === null ? {} : { previouslyPushedAs: previously }),
      })
    } catch (error) {
      console.warn('[ThreadBinding] could not mirror the binding', { threadId: thread.id, error })
    }
    return {
      ok: true,
      state: {
        bound: true,
        remote: boundRemote,
        remoteBranch: boundBranch,
        prBase: boundBase,
        previouslyPushedAs: previously ?? thread.previouslyPushedAs ?? null,
        suggestion: null,
      },
    }
  }

  // ── Reconciling ──────────────────────────────────────────────────────────

  /**
   * Git's answer, written into the mirror when the two disagree.
   *
   * ONE CLI CALL, and only for a thread that has a checkout. It covers the
   * migration case (FR-10) without a step of its own: a thread whose branch
   * already had an upstream before any of this existed simply reads as bound
   * the first time anything asks, with `prBase` left null because git never
   * had one to lose.
   *
   * FAIL-SOFT. A listing that cannot be read leaves the mirror exactly as it
   * was — an unreadable repository is not evidence that a binding is gone.
   */
  async #reconcile(thread: BindingThread, mirror: ThreadBindingState): Promise<ThreadBindingState> {
    const listed = await this.#listed(thread)
    if (listed === null) return mirror

    const remote = text(listed.remote)
    const remoteBranch = text(listed.remoteBranch)
    if (listed.bound === true && remote !== null && remoteBranch !== null) {
      if (remote === mirror.remote && remoteBranch === mirror.remoteBranch) return mirror
      // `prBase` CROSSES OVER. It is the one part of a binding git holds no key
      // for, so a reconcile that dropped it would lose a person's answer to a
      // question git was never asked.
      return this.#mirrorFromGit(thread, {
        remote,
        remoteBranch,
        prBase: mirror.prBase,
        previouslyPushedAs: mirror.previouslyPushedAs,
      })
    }

    // GIT SAYS NOBODY HAS DECIDED. Only believed for a worktree that really is
    // on a branch: a detached checkout has nothing an upstream could hang off,
    // and reading its silence as "unbound" would clear a mirror describing a
    // branch that is still there.
    if (mirror.bound && text(listed.branch) !== null) {
      return this.#mirrorFromGit(thread, null)
    }
    return mirror
  }

  /** Write git's answer into the mirror and hand back what it now says. */
  #mirrorFromGit(
    thread: BindingThread,
    binding: {
      remote: string
      remoteBranch: string
      prBase: string | null
      previouslyPushedAs: string | null
    } | null,
  ): ThreadBindingState {
    try {
      this.deps.threadStore.setThreadBinding(
        thread.id,
        binding === null
          ? null
          : { remote: binding.remote, remoteBranch: binding.remoteBranch, prBase: binding.prBase },
      )
    } catch (error) {
      // A mirror that could not be written is a mirror that will be rewritten
      // by the next read. It is not a reason to report the wrong answer.
      console.warn('[ThreadBinding] could not reconcile the mirror', {
        threadId: thread.id,
        error,
      })
    }
    if (binding === null) return UNBOUND
    return {
      bound: true,
      remote: binding.remote,
      remoteBranch: binding.remoteBranch,
      prBase: binding.prBase,
      previouslyPushedAs: binding.previouslyPushedAs,
      suggestion: null,
    }
  }

  /** This thread's row of `worktree list --json`, or null. */
  async #listed(thread: BindingThread): Promise<ListedWorktree | null> {
    try {
      const result = await this.deps.runCli(thread.projectRoot, [
        'worktree',
        'list',
        '--target',
        thread.projectRoot,
        '--thread',
        thread.id,
        ...checkoutNameArgs(thread.id, thread.worktreePath),
        '--json',
      ])
      if (!result.ok) return null
      const listing = parseCliJson<{ worktrees?: unknown }>(result.stdout)
      if (listing === null || !Array.isArray(listing.worktrees)) return null
      // FILTERED BY THE CLI, so the row it answers with IS this thread's. Its
      // `thread` field is the checkout's FOLDER — the id only for a checkout cut
      // before folders had names — so matching it against the id dropped every
      // named checkout's binding on the floor.
      const found = listing.worktrees.find(
        (entry): entry is ListedWorktree => typeof entry === 'object' && entry !== null,
      )
      return found ?? null
    } catch (error) {
      console.warn('[ThreadBinding] could not read the worktree listing', {
        threadId: thread.id,
        error,
      })
      return null
    }
  }
}

/** A non-empty string, or null — the only shape any field above is read as. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** Last JSON object on a transcript, or null. The CLI writes exactly one line
 *  of JSON for `--json`; anything else on the stream is somebody's warning. */
function parseCliJson<T>(stdout: string): T | null {
  for (const line of stdout.split('\n').map((entry) => entry.trim()).reverse()) {
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line) as T
    } catch {
      continue
    }
  }
  return null
}

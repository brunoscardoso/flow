// The end of a thread is a landing (thread-worktrees Phase 7).
//
// A thread's checkout is where its work happened; a branch is where that work
// is kept. This module is the ONE place that moves work from the first to the
// second — commit what is loose, merge it to the branch it was cut from (or
// open a pull request), and let the checkout go while the branch stays.
//
// SIX FACTS SHAPE EVERY DECISION HERE:
//
//  1. NOTHING IRREVERSIBLE HAPPENS BY DEFAULT (forbidden-pattern #15). Every
//     entry point that commits, merges, pushes or deletes requires
//     `confirmed: true` from its caller, and a call with no options at all runs
//     no git that writes. The incident that wrote that rule was a test calling
//     a function it believed was inert; the functions here delete directories
//     and move branch tips, so the confirmation is a parameter, not a comment.
//
//  2. THE MERGE HAPPENS INSIDE THE THREAD'S OWN CHECKOUT. The base branch is
//     merged INTO the thread's branch there, and only then does the base ref
//     move — which makes advancing it a fast-forward. Never a `git checkout` in
//     the project's shared tree (forbidden-pattern #11), and any conflict lands
//     in the thread's checkout, where the merge editor already works because
//     Phase 3.5 opened the git write channels to it.
//
//  3. A MOVED BASE IS MERGED, NOT REBASED. Rebasing would rewrite the commits
//     the thread's own Changes list has been showing the user all along
//     (a brainstorm rejection).
//
//  4. THE BASE MAY BE LOCAL ONLY. When the user chose "copy my changes in" at
//     the first message, the base is a branch that exists on this computer and
//     nowhere else. Merging to it is fine; opening a pull request against it is
//     not, and that is said rather than attempted.
//
//  5. WHERE THE WORK IS PUBLISHED IS A PERSON'S ANSWER, NOT THIS MODULE'S
//     (thread_remote_binding). The pull request path used to push the local
//     branch name verbatim to a hardcoded `origin`; it now calls `worktree
//     push` and `worktree pr` — the one writer — and an unbound thread comes
//     back REFUSED with a proposal attached, which this reports as an
//     `unbound` row for a surface to ask about. Nothing here guesses a remote,
//     a remote branch or a base, and the merge path is untouched by any of it.
//
//  6. NO ATOMICITY IS CLAIMED. A thread spanning two repositories lands them
//     one after another, each reporting its own outcome — one can succeed while
//     the next conflicts. Git has no cross-repository transaction, and
//     all-or-nothing was rejected because "nothing" would mean undoing a merge
//     that already worked.

import { countLosableChanges } from '../worktree/losable-work'
import type {
  TaskMergeResult,
  ThreadBindingState,
  ThreadBindingSuggestion,
  ThreadLandingOutcome,
  ThreadLandingPreview,
  ThreadLandingRepo,
  ThreadLandingResult,
  ThreadLandingRow,
  ThreadWorktreeForgetResult,
  ThreadWorktreeReleaseResult,
} from '../../shared/ipc-contract'
import {
  countChangedFiles,
  refusalReason,
  worktreeNameArgs,
  checkoutNameArgs,
  type RunResult,
} from '../worktree/thread-worktree'
import { checkoutName } from '../../shared/worktree-name'
import { resolveWorktreeSettings } from '../flow/worktree-settings'
import type { ResolvedWorktreeSettingsResult } from '../../shared/ipc-contract'

/** A thread, as landing needs to see it. */
export interface LandingThread {
  id: string
  title: string
  /** The registered project root — where the base branch lives. */
  projectRoot: string
  worktreePath: string | null
  worktreeBranch: string | null
  worktreeBase: string | null
  /**
   * The binding, as the store MIRRORS it (thread_remote_binding Phase 5).
   *
   * Optional because it is a mirror and a mirror can be empty: a thread that
   * has never published has all four null, which is read as unbound and asked
   * about at the first push rather than filled in from the local name. Git is
   * the truth behind these — the verbs write it and hand back what they wrote.
   */
  remote?: string | null
  remoteBranch?: string | null
  prBase?: string | null
  previouslyPushedAs?: string | null
}

/** One repository a landing acts on. */
export interface LandingTarget {
  /** How this repository is named to a person — never a path. */
  name: string
  /** The project's own checkout, where the base branch lives. */
  projectRoot: string
  /** The thread's checkout. */
  worktreePath: string
  /** The thread's branch, or null while the checkout is still detached. */
  branch: string | null
  /** The ref this lands on. May be a branch that exists only on this computer. */
  base: string | null
}

/**
 * The wire shapes live in the shared contract — ONE definition, so main's
 * rows and the renderer's rows can never drift into two vocabularies.
 */
export type LandingOutcome = ThreadLandingOutcome
export type LandingRow = ThreadLandingRow
export type LandingRepoPreview = ThreadLandingRepo
export type LandingPreview = ThreadLandingPreview
export type LandingResult = ThreadLandingResult
export type PruneResult = ThreadWorktreeReleaseResult
export type ForgetResult = ThreadWorktreeForgetResult

/**
 * A checkout on disk whose thread no longer exists.
 *
 * Everything a release needs that would otherwise have come off the thread
 * record. `base` is deliberately optional and usually absent: the ref it was
 * cut from lived on the record too, and without it the unlanded check has no
 * "ahead of what" to ask — which is why an abandoned copy is never treated as
 * landed and never released without the second say-so.
 */
export interface AbandonedCheckout {
  /** The project the copy belongs to. */
  projectRoot: string
  /** The copy itself. */
  worktreePath: string
  /** The branch it is on, or null while detached. */
  branch: string | null
  /** The ref it was cut from, when anything still knows it. */
  base?: string | null
}

/** What the caller wants done, and their explicit say-so. */
export interface LandingRequest {
  mode: 'merge' | 'pull-request'
  /** The commit message a person saw and accepted. */
  message?: string
  /**
   * True only when a person asked for this. Absent → nothing runs
   * (forbidden-pattern #15).
   */
  confirmed?: boolean
  /**
   * Release the checkout after a successful landing. Absent → the checkout
   * stays; deleting a directory is never something a caller gets by omission.
   */
  pruneAfter?: boolean
  /**
   * Land ONE repository — the one the pressed control belongs to.
   *
   * The landing surface used to be a single bar above a panel listing every
   * repository a thread touches, and pressing Merge there meant "all of the
   * ones that are mine", which nothing on screen said. The controls now sit
   * inside the group they act on, so the request says which repository that is
   * and this narrows the target list to it.
   *
   * Absent → every target, exactly as before. It is a NARROWING and never a
   * widening: a value naming no target of this thread lands nothing and says
   * so, rather than falling back to all of them.
   */
  projectRoot?: string
}

export interface ThreadLandingDeps {
  threadStore: {
    /** The checkouts this conversation's OTHER projects hold. Optional: a build
     *  without it has none to release, which is the pre-existing state. */
    getThreadRootWorktrees?(
      threadId: string,
    ): Array<{ rootPath: string; worktreePath: string; branch: string | null }>
    /** Clear ONE attached project's checkout record. */
    setThreadRootWorktree?(
      threadId: string,
      rootPath: string,
      worktree: { path: string; branch: string | null; base: string | null } | null,
    ): void
    getThread(threadId: string): LandingThread | null
    setThreadWorktree(
      threadId: string,
      worktree: { path: string; branch: string | null; base: string | null } | null,
    ): void
    /**
     * Mirror the binding a verb just wrote to git. THE STORE IS THE MIRROR and
     * the verbs are the writers (allowed-pattern #14): every value handed to
     * this came back out of `worktree bind` or `worktree push`, never out of a
     * default this module chose.
     */
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
  /** Run `git`. Async, always — main answers every IPC call (allowed-pattern #19). */
  runGit: (cwd: string, args: readonly string[]) => Promise<RunResult>
  /** Run the bundled `planflow-ai` — the only thing that removes a checkout. */
  runCli: (cwd: string, args: readonly string[]) => Promise<RunResult>
  /**
   * Whether `gh` can be reached at all. Absent → pull requests are not offered.
   *
   * A PROBE NOW, NOT A CALLER. The pull request itself is opened by `worktree
   * pr`, which runs `gh` on its own side with the repository resolved from the
   * BOUND remote — the `--repo` case a raw call from here would have got wrong
   * for a fork or a mirror. What is left of this dep is the one question main
   * still has to answer before offering the button: is there a `gh` here.
   */
  runGh?: (cwd: string, args: readonly string[]) => Promise<RunResult>
  /**
   * Stand a thread's agent down so its copy of the project can be removed, or
   * say why it cannot be.
   *
   * REMOVING A DIRECTORY DOES NOT REDIRECT THE AGENT STANDING IN IT. A session's
   * `cwd` is fixed at spawn and never re-read, so releasing a worktree while a
   * session is bound to the thread strands that session on a path that no longer
   * exists — and the damage outlives the press, because `sendMessage` skips
   * `ensureThreadWorktree` whenever a session already exists. The thread could
   * then never cut a new copy: it stayed pointed at nothing, permanently, and
   * the only surface that could cause it was the release button itself.
   *
   * The judgment lives on the other side of this dep, with the two things that
   * can answer it — the thread's status and the session map (allowed-pattern
   * #14). Absent → nothing is stood down, which is only true for a caller that
   * runs no agents.
   *
   * `force` is `forget`'s case and ONLY its case: there the copy is already gone
   * from disk, so there is nothing left to protect, and refusing would strand a
   * thread in exactly the broken state that verb exists to repair.
   */
  standDownAgent?: (
    threadId: string,
    force?: boolean,
  ) => { ok: true } | { ok: false; detail: string }
  /** The same suggestion the commit box's wand makes. Absent → the plain one. */
  suggestMessage?: (rootPath: string, filePaths: string[]) => Promise<string | null>
  /**
   * The project's worktree settings — `readWorktreeSettings`, the one place
   * the project file, the person's app-wide defaults and the built-ins are put
   * in order.
   *
   * WHAT IT IS FOR HERE IS ONE SENTENCE: an unbound push comes back as a
   * QUESTION, and this is what fills in the answer it offers. The verb reads
   * the project's own file on its own, but it cannot see a default that lives
   * in this app's settings and nowhere on disk — so the resolved remote and
   * naming pattern are handed to it, and it prefers them over the file.
   *
   * NOTHING IT CARRIES BINDS ANYTHING. A suggestion is shown, edited or thrown
   * away; a binding still exists only once a person has said so.
   *
   * ABSENT → THE BUILT-INS, through the same pure resolver.
   */
  settingsFor?: (rootPath: string) => Promise<ResolvedWorktreeSettingsResult>
  /**
   * Which repositories this thread lands in. The default is the thread's own
   * checkout — one repository, one row. A thread spanning more than one gets
   * more targets and the SAME sequential loop; nothing below counts to one.
   */
  targetsFor?: (thread: LandingThread) => LandingTarget[]
}

/** Longest a suggested subject line may be before it is cut. */
const MAX_SUBJECT = 72

// ── Pure helpers (exported for their tests) ────────────────────────────────

/** The path's last segment — how a repository is named when nothing else does. */
export function repoDisplayName(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const slash = trimmed.lastIndexOf('/')
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

/**
 * The commit message a landing STARTS from — a draft, never a decision.
 *
 * A silent commit was rejected outright: a message nobody chose ends up in a
 * history somebody reads later. So this is only ever a suggestion put in front
 * of a person, and `land` refuses to commit without one having come back.
 */
export function landingMessageSuggestion(title: string | null, changedFiles: number): string {
  const subject = (title ?? '').trim().replace(/\s+/g, ' ')
  if (subject === '') {
    return changedFiles === 1 ? 'Work from this thread (1 file)' : `Work from this thread (${changedFiles} files)`
  }
  return subject.length > MAX_SUBJECT ? `${subject.slice(0, MAX_SUBJECT - 1).trimEnd()}…` : subject
}

/** The `git status --porcelain` line count, untracked files included. */
export function countLandingChanges(porcelain: string): number {
  return countChangedFiles(porcelain)
}

/**
 * Whether a failed merge left the working tree conflicted rather than untouched.
 *
 * The porcelain codes for an unmerged path (`UU`, `AA`, `DD` and the four mixed
 * ones) are what tells a conflict apart from a genuine failure — a bad ref or an
 * unrelated history exits non-zero too, and leaves nothing unmerged behind.
 */
export function looksConflicted(statusPorcelain: string): boolean {
  return statusPorcelain
    .split('\n')
    .some((line) => /^(?:DD|AU|UD|UA|DU|AA|UU) /.test(line))
}

/**
 * Whether the worktree took its base branch rather than branching off it.
 *
 * ONE PREDICATE, READ EVERYWHERE (allowed-pattern #14). A worktree on its own
 * base has nothing to merge and nothing to fast-forward — its commits are
 * already on the branch — and every surface that would otherwise offer a Merge
 * that does nothing, or attempt a `branch --force` git will refuse because the
 * branch is open right here, asks this instead.
 */
export function worksOnBase(branch: string | null, base: string | null): boolean {
  return branch !== null && branch !== '' && branch === base
}

/** The ref a landing merges FROM — the branch when there is one, else the commit. */
export function landingRef(branch: string | null, head: string): string {
  return branch !== null && branch !== '' ? branch : head
}

// ── The service ────────────────────────────────────────────────────────────

/**
 * Lands a thread's work and releases its checkout. One instance per app,
 * constructed in main and reached only through the thread IPC layer.
 */
export class ThreadLandingService {
  constructor(private readonly deps: ThreadLandingDeps) {}

  /** The repositories this thread's landing would act on. */
  targets(thread: LandingThread): LandingTarget[] {
    if (this.deps.targetsFor !== undefined) return this.deps.targetsFor(thread)
    if (thread.worktreePath === null) return []
    return [
      {
        name: repoDisplayName(thread.projectRoot),
        projectRoot: thread.projectRoot,
        worktreePath: thread.worktreePath,
        branch: thread.worktreeBranch,
        base: thread.worktreeBase,
      },
    ]
  }

  /**
   * What is waiting, and the message it would be committed under.
   *
   * READ-ONLY. Every git call below reports; none writes. That is deliberate —
   * this runs when a person merely opens the landing surface, and opening a
   * panel must never stage, commit or move anything.
   */
  async preview(threadId: string): Promise<LandingPreview> {
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null) {
      return {
        threadId,
        message: '',
        repos: [],
        blockedReason: 'This thread is no longer here.',
        canOpenPullRequest: false,
        binding: null,
      }
    }
    const targets = this.targets(thread)
    if (targets.length === 0) {
      return {
        threadId,
        message: '',
        repos: [],
        blockedReason:
          'This thread works in the project’s own files, so there is nothing separate to land.',
        canOpenPullRequest: false,
        binding: mirroredBinding(thread),
      }
    }

    const repos: LandingRepoPreview[] = []
    for (const target of targets) {
      repos.push(await this.#previewTarget(target, thread))
    }
    const totalChanges = repos.reduce((sum, repo) => sum + repo.changedFiles, 0)
    const totalAhead = repos.reduce((sum, repo) => sum + (repo.aheadCommits ?? 0), 0)
    const blockedReason = nothingToLand(repos, totalChanges, totalAhead)

    return {
      threadId,
      message: await this.#suggestMessage(thread, targets[0], repos[0]?.changedFiles ?? 0),
      repos,
      blockedReason,
      canOpenPullRequest:
        this.deps.runGh !== undefined &&
        repos.some((repo) => repo.baseOnRemote && repo.branch !== null && !repo.onBase),
      binding: mirroredBinding(thread),
    }
  }

  /**
   * Land the thread's work — commit what is loose, then merge it to the branch
   * it was cut from, or open a pull request for it.
   *
   * Sequential across repositories, and it does not stop at the first failure:
   * a repository that conflicted says so on its own row while the next one is
   * still tried. That is what "no atomicity is claimed" means in code.
   */
  async land(threadId: string, request: LandingRequest = { mode: 'merge' }): Promise<LandingResult> {
    // THE GATE (forbidden-pattern #15). A caller that did not say a person
    // asked for this gets a report and no git that writes — not a merge, not a
    // commit, not a push.
    if (request.confirmed !== true) {
      return {
        threadId,
        rows: [
          {
            name: '',
            projectRoot: '',
            outcome: 'blocked',
            detail: 'Landing this thread’s work needs someone to ask for it.',
          },
        ],
        complete: false,
      }
    }
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null) {
      return { threadId, rows: [], complete: false }
    }

    // ONE REPOSITORY WHEN THE CALLER NAMED ONE. The narrowing happens here, on
    // the same target list every landing has always walked, so there is still
    // exactly one loop and one set of rules (allowed-pattern #14).
    const all = this.targets(thread)
    const targets =
      request.projectRoot === undefined
        ? all
        : all.filter((target) => target.projectRoot === request.projectRoot)
    if (all.length > 0 && targets.length === 0) {
      return {
        threadId,
        rows: [
          {
            name: '',
            projectRoot: request.projectRoot ?? '',
            outcome: 'blocked',
            detail: 'This thread has no branch in that project, so there was nothing to land.',
          },
        ],
        complete: false,
      }
    }

    const rows: LandingRow[] = []
    for (const target of targets) {
      rows.push(
        request.mode === 'pull-request'
          ? await this.#openPullRequest(thread, target, request)
          : await this.#merge(thread, target, request),
      )
    }
    const complete =
      rows.length > 0 && rows.every((row) => row.outcome === 'landed' || row.outcome === 'opened')
    return { threadId, rows, complete }
  }

  /**
   * Merge a thread's pull request — the review card's Merge button.
   *
   * GITHUB FIRST, LOCAL AS THE FALLBACK. A review card only exists because a PR
   * was opened, so the common path is a `gh pr merge --squash` of that PR; a
   * card with no PR (or a machine with no `gh`) falls back to the SAME local
   * merge the landing surface offers, so "merge" always means something. A gh
   * failure is reported, never silently downgraded to the local merge — that
   * would change what the person asked for under them.
   *
   * GUARDED like every writing entry point here (forbidden-pattern #15): no
   * `confirmed`, nothing runs.
   */
  async mergePullRequest(
    threadId: string,
    options: { prUrl?: string | null; confirmed?: boolean } = {},
  ): Promise<TaskMergeResult> {
    if (options.confirmed !== true) {
      return { ok: false, detail: 'Merging this pull request needs someone to ask for it.' }
    }
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null) {
      return { ok: false, detail: 'This thread is no longer here.' }
    }
    const prUrl =
      typeof options.prUrl === 'string' && options.prUrl.trim() !== '' ? options.prUrl.trim() : null

    if (prUrl !== null && this.deps.runGh !== undefined) {
      // Run in the project's own checkout — always present, always the right
      // repository; `gh` resolves the PR from its URL. `--squash` is the merge
      // method a review card uses.
      const merged = await this.deps.runGh(thread.projectRoot, ['pr', 'merge', prUrl, '--squash'])
      if (merged.ok) {
        return { ok: true, detail: 'The pull request is merged.', method: 'github-squash' }
      }
      console.warn('[ThreadLanding] gh pr merge failed', {
        threadId,
        reason: refusalReason(merged),
      })
      return {
        ok: false,
        detail: 'GitHub didn’t merge the pull request. Open it to see why.',
      }
    }

    // NO PR, OR NO gh → the local merge to base, the same one `land` runs. The
    // suggested message covers the case where the checkout still has loose work;
    // an already-clean checkout commits nothing and merges what is ahead.
    const result = await this.land(threadId, {
      mode: 'merge',
      confirmed: true,
      message: landingMessageSuggestion(thread.title, 0),
    })
    const landed = result.rows.some((r) => r.outcome === 'landed' || r.outcome === 'nothing')
    if (landed) {
      return { ok: true, detail: 'The work is merged into its base branch.', method: 'local' }
    }
    const detail = result.rows.find((r) => r.detail !== '')?.detail
    return { ok: false, detail: detail ?? 'Flow couldn’t merge this thread’s work.' }
  }

  /**
   * Release a thread's checkout, keeping its branch.
   *
   * TWO GUARDS, AND THEY ARE DIFFERENT. `confirmed` says a person asked; it is
   * required and has no default. `allowUnlanded` says they asked KNOWING the
   * checkout still holds work that lives nowhere else — without it, a checkout
   * with uncommitted files or unmerged commits is left exactly where it is and
   * says why. Unlanded work is never deleted by anything that was not told to.
   */
  async prune(
    threadId: string,
    options: {
      confirmed?: boolean
      allowUnlanded?: boolean
      /**
       * The checkout whose thread is GONE — the one case a release cannot look
       * its subject up. A thread can be deleted while its copy stays on disk,
       * and the management list is where that turns up; without this, the only
       * thing that could remove it would be a second deletion path.
       *
       * It widens what this can be pointed AT. It does not widen what may
       * happen without being asked: both gates below are unchanged, and the
       * same CLI call does the same thing.
       */
      abandoned?: AbandonedCheckout
    } = {},
  ): Promise<PruneResult> {
    if (options.confirmed !== true) {
      return {
        status: 'refused',
        detail: 'Releasing this thread’s files needs someone to ask for it.',
      }
    }
    const record = this.deps.threadStore.getThread(threadId)
    const thread: LandingThread | null =
      record !== null && record.worktreePath !== null
        ? record
        : abandonedThread(threadId, options.abandoned)
    if (thread === null || thread.worktreePath === null) {
      return { status: 'absent', detail: 'This thread has no branch of its own.' }
    }
    // A copy with no thread behind it has nothing to write back to; every other
    // release clears the three columns of the thread that owned it.
    const recorded = record !== null

    // BEFORE ANY OF THE READING BELOW, and before `allowUnlanded` can skip it.
    // A thread with an agent running in this checkout makes every number the
    // unlanded check is about to take stale the moment it is taken — and the
    // escalation that lets a person discard uncommitted work is not a licence to
    // pull the floor out from under a turn in flight.
    const standDown = this.deps.standDownAgent?.(thread.id) ?? { ok: true as const }
    if (!standDown.ok) return { status: 'refused', detail: standDown.detail }

    if (options.allowUnlanded !== true) {
      const held = await this.#unlandedWork({
        name: repoDisplayName(thread.projectRoot),
        projectRoot: thread.projectRoot,
        worktreePath: thread.worktreePath,
        branch: thread.worktreeBranch,
        base: thread.worktreeBase,
      })
      if (held !== null) return held
    }
    // `allowUnlanded` IS THE CLI'S `--discard`, and it has to travel. The CLI
    // now refuses to delete a checkout holding uncommitted work unless it is
    // told the person was shown what would go (#1797) — which is the same
    // second consent this method already collects one layer up. Without
    // forwarding it, the escalation a person just made would be refused by the
    // very verb it exists to authorise.
    return this.#removeCheckout(thread, recorded, options.allowUnlanded === true)
  }

  /**
   * Stop a thread pointing at a copy that is no longer on disk.
   *
   * DELETES NOTHING, AND REFUSES WHEN THERE IS SOMETHING TO DELETE. The whole
   * safety of this is the check: if the directory turns out to still be there,
   * forgetting it would strand real files somewhere nothing in the app would
   * ever mention again — so that answer is `still-there`, and the row keeps
   * offering the release that actually removes it.
   *
   * `confirmed` is required all the same. Discarding a record is not
   * irreversible — the thread's next message makes a new worktree — but it is
   * still a thing somebody has to ask for (forbidden-pattern #15).
   */
  async forget(
    threadId: string,
    options: { confirmed?: boolean } = {},
  ): Promise<ThreadWorktreeForgetResult> {
    if (options.confirmed !== true) {
      return {
        status: 'refused',
        detail: 'Clearing this thread’s files needs someone to ask for it.',
      }
    }
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null || thread.worktreePath === null) {
      return { status: 'absent', detail: 'This thread already has no files of its own.' }
    }
    const present = await this.deps.runGit(thread.worktreePath, ['rev-parse', '--git-dir'])
    if (present.ok) {
      return {
        status: 'still-there',
        detail:
          'This thread’s files are still on disk, so Flow won’t pretend they are not. Free them from Settings if you want the space back.',
      }
    }
    try {
      this.deps.threadStore.setThreadWorktree(thread.id, null)
    } catch (error) {
      console.warn('[ThreadLanding] could not clear the worktree record', { threadId, error })
      return {
        status: 'failed',
        detail: 'Flow couldn’t clear this thread’s files. Nothing changed.',
      }
    }
    // THE SESSION IS ALREADY BROKEN, so this cannot make anything worse and is
    // the only thing that makes the thread usable again: while a session exists
    // the next message will not cut a new copy, so a thread repaired here would
    // otherwise go straight back to running in a directory that is not there.
    // Forced, because the copy is gone — see `standDownAgent`.
    this.deps.standDownAgent?.(thread.id, true)
    return {
      status: 'forgotten',
      detail: `This thread works in the project’s own files again. ${branchLabel(thread.worktreeBranch)} keeps the record of what it did.`,
    }
  }

  // ── Merge ────────────────────────────────────────────────────────────────

  async #merge(
    thread: LandingThread,
    target: LandingTarget,
    request: LandingRequest,
  ): Promise<LandingRow> {
    const base = target.base
    if (base === null || base === '') {
      return row(target, 'no-base', 'Flow doesn’t know which branch this thread’s work belongs on.')
    }

    const committed = await this.#commitLooseWork(target, request.message)
    if ('outcome' in committed) return committed

    // THE WORKTREE IS ALREADY ON THE BRANCH. Nothing is merged and no ref is
    // moved: the commits went straight onto `base`, which is the whole point of
    // having taken it. Attempting the merge below would `branch --force` a
    // branch that is checked out right here, which git refuses — so the reader
    // would have been shown a failure for work that had in fact arrived.
    if (worksOnBase(target.branch, base)) {
      const saved = committed.committed !== undefined && committed.committed > 0
      const onBaseRow: LandingRow = {
        ...row(
          target,
          saved ? 'landed' : 'nothing',
          saved
            ? `${target.name} saved this thread’s changes on ${branchLabel(base)}, where it has been working all along.`
            : `${target.name} works on ${branchLabel(base)} directly, so everything this thread did is already there.`,
        ),
        branch: target.branch,
        ...(committed.commit === undefined ? {} : { commit: committed.commit }),
        ...(committed.committed === undefined ? {} : { committed: committed.committed }),
      }
      if (request.pruneAfter !== true) return onBaseRow
      const freed = await this.prune(thread.id, { confirmed: true })
      return { ...onBaseRow, pruned: freed.status === 'pruned' }
    }

    // THE BASE COMES TO THE WORK, not the other way round. Merging base into
    // the thread's branch here means any conflict lands in the thread's own
    // checkout — where the merge editor already works — and leaves the
    // project's shared tree untouched while it is resolved.
    const merged = await this.deps.runGit(target.worktreePath, ['merge', '--no-edit', base])
    if (!merged.ok) {
      const status = await this.deps.runGit(target.worktreePath, ['status', '--porcelain'])
      if (looksConflicted(status.stdout)) {
        return {
          ...row(
            target,
            'conflicted',
            `${target.name} has changes on both sides that disagree. Open them to choose what to keep, then land again.`,
          ),
          conflictRoot: target.worktreePath,
          ...(committed.commit === undefined ? {} : { commit: committed.commit }),
          ...(committed.committed === undefined ? {} : { committed: committed.committed }),
        }
      }
      return row(target, 'failed', `Flow couldn’t bring ${target.name} up to date with the rest of the project.`)
    }

    const head = (await this.deps.runGit(target.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim()
    // PROVEN, NOT ASSUMED. The base ref only moves when the thread's commit
    // really contains it — otherwise advancing it would drop somebody's commits.
    const contains = await this.deps.runGit(target.worktreePath, [
      'merge-base',
      '--is-ancestor',
      base,
      'HEAD',
    ])
    if (!contains.ok) {
      return row(
        target,
        'blocked',
        `${target.name} moved on while this was running. Land again to pick up what changed.`,
      )
    }

    const advanced = await this.#advanceBase(target, base, head)
    if (advanced !== null) return advanced

    const landedRow: LandingRow = {
      ...row(target, 'landed', `${target.name} now carries this thread’s work on ${branchLabel(base)}.`),
      branch: target.branch,
      ...(committed.commit === undefined ? {} : { commit: committed.commit }),
      ...(committed.committed === undefined ? {} : { committed: committed.committed }),
    }
    if (request.pruneAfter !== true) return landedRow

    // The work is in the base branch now, so the checkout holds nothing that
    // exists nowhere else — but the check runs anyway, because "it should be
    // safe" is not the same as "it is".
    const released = await this.prune(thread.id, { confirmed: true })
    return { ...landedRow, pruned: released.status === 'pruned' }
  }

  /**
   * Move the base branch onto the thread's commit.
   *
   * Two shapes, and which one applies is git's decision rather than this
   * module's guess: when the project's own checkout is sitting ON the base
   * branch, the move is a fast-forward of that checkout so the user's files
   * become the merged ones; otherwise the ref is moved directly, which git
   * itself refuses if the branch is checked out anywhere at all.
   *
   * Returns null on success, or the row that says what stopped it.
   */
  async #advanceBase(target: LandingTarget, base: string, head: string): Promise<LandingRow | null> {
    const current = await this.deps.runGit(target.projectRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const onBase = current.ok && current.stdout.trim() === base
    if (onBase) {
      const forward = await this.deps.runGit(target.projectRoot, [
        'merge',
        '--ff-only',
        landingRef(target.branch, head),
      ])
      if (forward.ok) return null
      return row(
        target,
        'blocked',
        `Your own unsaved changes in ${target.name} are in the way. Save or set them aside, then land again.`,
      )
    }
    const moved = await this.deps.runGit(target.worktreePath, ['branch', '--force', base, head])
    if (moved.ok) return null
    return row(
      target,
      'blocked',
      `${branchLabel(base)} is open somewhere else in ${target.name}, so Flow left it alone.`,
    )
  }

  // ── Pull request ─────────────────────────────────────────────────────────

  /**
   * Propose the thread's work — through the verbs, and only where a person said.
   *
   * THE PUSH AND THE PULL REQUEST ARE NOT GIT CALLS ANY MORE. They are
   * `worktree push` and `worktree pr`, which is the whole point of the change:
   * this file used to send the local branch name verbatim to a hardcoded
   * `origin` and open the request against whatever base it had recorded, and
   * three other writers did the same thing slightly differently. There is one
   * writer now (allowed-pattern #14), it refuses rather than guesses, and what
   * it hands back is mirrored into the store so the panel can be drawn without
   * asking git again.
   */
  async #openPullRequest(
    thread: LandingThread,
    target: LandingTarget,
    request: LandingRequest,
  ): Promise<LandingRow> {
    // THE PROBE, NOT THE CALLER (see `runGh` on the deps): the request itself
    // is opened by the verb. Without a `gh` on this machine there is nothing to
    // open it with, and that is said rather than attempted.
    if (this.deps.runGh === undefined) {
      return row(target, 'failed', 'Flow can’t reach GitHub from here, so it can’t open a pull request.')
    }
    if (target.branch === null || target.branch === '') {
      return row(
        target,
        'no-branch',
        'This thread’s work isn’t on a branch of its own yet, so there is nothing to propose.',
      )
    }
    const base = target.base
    if (base === null || base === '') {
      return row(target, 'no-base', 'Flow doesn’t know which branch this thread’s work belongs on.')
    }
    if (worksOnBase(target.branch, base)) {
      return row(
        target,
        'no-branch',
        `This thread works on ${branchLabel(base)} itself, so there is no separate branch to propose.`,
      )
    }
    // A base that lives only on this computer — which is exactly what the
    // "copy my changes in" choice produces — has nothing to propose against.
    // Said, rather than attempted and reported as a GitHub error.
    if (!(await this.#baseOnRemote(target, base, thread.remote ?? null))) {
      return row(
        target,
        'local-only',
        `${branchLabel(base)} only exists on this computer, so there is nothing to open a pull request against yet.`,
      )
    }

    const committed = await this.#commitLooseWork(target, request.message)
    if ('outcome' in committed) return committed

    // THE BASE A PULL REQUEST OPENS AGAINST is the one a person chose when they
    // chose one, and otherwise the branch this work was cut from. Never a
    // constant: `main` is a guess, and a guess here targets a branch nobody
    // picked — the same mistake as an unbound push, one level up.
    const prBase = thread.prBase ?? base
    // ONCE, FOR BOTH VERBS. The push and the pull request ask the same question
    // of the same project moments apart, and two reads could answer it two ways
    // if somebody saved the settings in between.
    const offer = await this.#suggestionArgs(target.projectRoot)
    const pushed = await this.deps.runCli(target.projectRoot, [
      'worktree',
      'push',
      '--target',
      target.projectRoot,
      '--thread',
      thread.id,
      // THE FOLDER, SO THE VERB FINDS A NAMED CHECKOUT that predates the
      // checkout's own record of its thread.
      ...checkoutNameArgs(thread.id, target.worktreePath),
      '--pr-base',
      prBase,
      // The ladder's second rung reads a ticket id out of this; it is a source
      // for the SUGGESTION only, and reaches nothing that writes.
      '--thread-title',
      thread.title,
      ...offer,
      '--json',
    ])
    if (!pushed.ok) {
      // THE REFUSAL THAT CARRIES ITS OWN ANSWER. `unbound` is a question, and
      // the payload on stdout is what the surface asking it needs — so it is
      // relayed as a row of its own rather than flattened into "didn't land".
      const unbound = unboundRefusal(pushed)
      if (unbound !== null) {
        return {
          ...row(
            target,
            'unbound',
            `Flow doesn’t know where ${target.name} should publish this thread’s work. Say where it goes and it will pick up from here.`,
          ),
          branch: target.branch,
          binding: unbound,
          ...(committed.commit === undefined ? {} : { commit: committed.commit }),
          ...(committed.committed === undefined ? {} : { committed: committed.committed }),
        }
      }
      console.warn('[ThreadLanding] could not publish the thread’s branch', {
        threadId: thread.id,
        reason: refusalReason(pushed),
      })
      return row(target, 'failed', `Flow couldn’t send this thread’s branch to ${target.name}’s remote.`)
    }
    // WHAT THE VERB WROTE, MIRRORED — never what was asked for. The remote
    // branch a push lands on is the binding git holds, which a hand-edited
    // config or a rename may have moved since anything here last looked.
    const published = parseCliJson<PushResult>(pushed.stdout)
    this.#mirror(thread, published, prBase)

    const opened = await this.deps.runCli(target.projectRoot, [
      'worktree',
      'pr',
      '--target',
      target.projectRoot,
      '--thread',
      thread.id,
      ...checkoutNameArgs(thread.id, target.worktreePath),
      '--title',
      landingMessageSuggestion(thread.title, committed.committed ?? 0),
      '--body',
      pullRequestBody(thread.title),
      '--pr-base',
      prBase,
      ...offer,
      '--json',
    ])
    if (!opened.ok) {
      const unbound = unboundRefusal(opened)
      if (unbound !== null) {
        return {
          ...row(
            target,
            'unbound',
            `Flow doesn’t know where ${target.name} should publish this thread’s work. Say where it goes and it will pick up from here.`,
          ),
          branch: target.branch,
          binding: unbound,
        }
      }
      console.warn('[ThreadLanding] GitHub did not accept the pull request', {
        threadId: thread.id,
        reason: refusalReason(opened),
      })
      return row(target, 'failed', `GitHub didn’t accept a pull request for ${target.name}.`)
    }
    const request_ = parseCliJson<PullRequestResult>(opened.stdout)
    const url = typeof request_?.url === 'string' && request_.url !== '' ? request_.url : null
    return {
      ...row(target, 'opened', `A pull request for ${target.name} is open and waiting for review.`),
      branch: target.branch,
      ...(url === null ? {} : { url }),
      ...(committed.commit === undefined ? {} : { commit: committed.commit }),
      ...(committed.committed === undefined ? {} : { committed: committed.committed }),
    }
  }

  /**
   * The resolved remote and naming pattern, as arguments the verbs understand.
   *
   * THE PATTERN IS OMITTED WHEN THERE IS NONE, rather than passed empty: an
   * absent flag means "the project file decides", and an empty one would be a
   * caller saying it has an opinion and then not having one.
   */
  async #suggestionArgs(rootPath: string): Promise<string[]> {
    const read = await this.deps.settingsFor?.(rootPath)
    const settings = (read ?? resolveWorktreeSettings({ projectRaw: {}, globalDefaults: {} }))
      .settings
    const pattern = settings.remoteBranchPattern.value
    return [
      '--default-remote',
      settings.remote.value,
      ...(pattern === null || pattern === '' ? [] : ['--branch-pattern', pattern]),
    ]
  }

  /**
   * Write what the verb reported into the store's mirror.
   *
   * SILENT WHEN THERE IS NOTHING TO MIRROR. A result that could not be read
   * back is not a reason to fail a push that really happened — the binding is
   * in git either way, and the next read reconciles from it.
   */
  #mirror(thread: LandingThread, published: PushResult | null, prBase: string | null): void {
    if (
      published === null ||
      typeof published.remote !== 'string' ||
      published.remote === '' ||
      typeof published.remoteBranch !== 'string' ||
      published.remoteBranch === ''
    ) {
      return
    }
    try {
      this.deps.threadStore.setThreadBinding(thread.id, {
        remote: published.remote,
        remoteBranch: published.remoteBranch,
        prBase,
        // Omitted when the verb reported none: the record of a rename is
        // written once and must survive a later edit of the base.
        ...(typeof published.previouslyPushedAs === 'string' && published.previouslyPushedAs !== ''
          ? { previouslyPushedAs: published.previouslyPushedAs }
          : {}),
      })
    } catch (error) {
      console.warn('[ThreadLanding] could not mirror the binding', { threadId: thread.id, error })
    }
  }

  // ── Shared steps ─────────────────────────────────────────────────────────

  /**
   * Commit everything loose in the thread's checkout under the message a person
   * accepted.
   *
   * NO MESSAGE, NO COMMIT. A silent commit was rejected by name: the message
   * ends up in a history somebody reads later, so it is one a person saw. When
   * the checkout is already clean this does nothing at all and says so.
   */
  async #commitLooseWork(
    target: LandingTarget,
    message: string | undefined,
  ): Promise<{ committed?: number; commit?: string } | LandingRow> {
    const status = await this.deps.runGit(target.worktreePath, ['status', '--porcelain'])
    if (!status.ok) {
      return row(target, 'failed', `Flow couldn’t read what changed in ${target.name}.`)
    }
    const changed = countLandingChanges(status.stdout)
    if (changed === 0) return {}

    const subject = (message ?? '').trim()
    if (subject === '') {
      return row(
        target,
        'needs-message',
        `${target.name} has changes waiting. Say what they are, and Flow will land them under that.`,
      )
    }

    const staged = await this.deps.runGit(target.worktreePath, ['add', '--all'])
    if (!staged.ok) {
      return row(target, 'failed', `Flow couldn’t gather ${target.name}’s changes together.`)
    }
    const committed = await this.deps.runGit(target.worktreePath, ['commit', '--cleanup=strip', '-m', subject])
    if (!committed.ok) {
      return row(target, 'failed', `Flow couldn’t save ${target.name}’s changes.`)
    }
    const hash = await this.deps.runGit(target.worktreePath, ['rev-parse', '--short', 'HEAD'])
    return { committed: changed, ...(hash.ok ? { commit: hash.stdout.trim() } : {}) }
  }

  async #previewTarget(target: LandingTarget, thread: LandingThread): Promise<LandingRepoPreview> {
    const status = await this.deps.runGit(target.worktreePath, ['status', '--porcelain'])
    const base = target.base
    let aheadCommits: number | null = null
    if (base !== null && base !== '') {
      const ahead = await this.deps.runGit(target.worktreePath, [
        'rev-list',
        '--count',
        `${base}..HEAD`,
      ])
      const parsed = Number.parseInt(ahead.stdout.trim(), 10)
      aheadCommits = ahead.ok && Number.isFinite(parsed) ? parsed : null
    }
    return {
      name: target.name,
      projectRoot: target.projectRoot,
      worktreePath: target.worktreePath,
      branch: target.branch,
      base,
      changedFiles: status.ok ? countLandingChanges(status.stdout) : 0,
      aheadCommits,
      baseOnRemote:
        base === null || base === ''
          ? false
          : await this.#baseOnRemote(target, base, thread.remote ?? null),
      onBase: worksOnBase(target.branch, base),
    }
  }

  /**
   * Whether the base branch has a counterpart on the remote this thread
   * publishes to.
   *
   * THE BOUND REMOTE, OR NO CHECK AT ALL. It used to ask about `origin`, which
   * was a guess dressed as a fact — a thread bound to a fork or a mirror was
   * told its base was local-only, or worse, that it was not. When the thread is
   * unbound there is no remote to ask about and this SKIPS rather than picks
   * one: the push verb is the thing that refuses an unbound thread, and it
   * refuses with the question attached. Blocking here would answer that
   * question with silence.
   */
  async #baseOnRemote(
    target: LandingTarget,
    base: string,
    remote: string | null,
  ): Promise<boolean> {
    if (remote === null || remote === '') return true
    const found = await this.deps.runGit(target.worktreePath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/${remote}/${base}`,
    ])
    return found.ok && found.stdout.trim() !== ''
  }

  /** The suggestion the landing surface starts from. */
  async #suggestMessage(
    thread: LandingThread,
    target: LandingTarget | undefined,
    changedFiles: number,
  ): Promise<string> {
    const plain = landingMessageSuggestion(thread.title, changedFiles)
    if (this.deps.suggestMessage === undefined || target === undefined || changedFiles === 0) {
      return plain
    }
    try {
      const files = await this.#changedPaths(target)
      if (files.length === 0) return plain
      const suggested = await this.deps.suggestMessage(target.worktreePath, files)
      return suggested === null || suggested.trim() === '' ? plain : suggested
    } catch (error) {
      // A suggestion is a nicety; a landing surface that cannot open because
      // the wand failed is not. The plain message is a perfectly good draft.
      console.warn('[ThreadLanding] could not suggest a message', { threadId: thread.id, error })
      return plain
    }
  }

  /** The repo-relative paths of everything uncommitted in the checkout. */
  async #changedPaths(target: LandingTarget): Promise<string[]> {
    const status = await this.deps.runGit(target.worktreePath, ['status', '--porcelain'])
    if (!status.ok) return []
    const paths: string[] = []
    for (const line of status.stdout.split('\n')) {
      const trimmed = line.trimEnd()
      if (trimmed.length < 4) continue
      const path = trimmed.slice(3).trim()
      const renamed = path.split(' -> ')
      const target_ = renamed[renamed.length - 1]
      if (target_ !== undefined && target_ !== '') paths.push(target_)
    }
    return paths
  }

  /** What the checkout still holds that exists nowhere else, or null. */
  async #unlandedWork(target: LandingTarget): Promise<PruneResult | null> {
    const status = await this.deps.runGit(target.worktreePath, ['status', '--porcelain'])
    // What deleting the checkout would LOSE: the links and untouched copies
    // every checkout is given are the project's own, not this thread's work.
    const changedFiles = status.ok
      ? await countLosableChanges(status.stdout, target.worktreePath, target.projectRoot)
      : 0
    if (changedFiles > 0) {
      return {
        status: 'holds-work',
        detail: `This thread still has ${fileCount(changedFiles)} that ${changedFiles === 1 ? 'hasn’t' : 'haven’t'} been landed anywhere. Land the work first, or say to let it go.`,
        changedFiles,
      }
    }

    // IS THERE A REF THAT SURVIVES THE DELETION? That is the whole question
    // below, and it is asked ONCE.
    //
    // Removing a checkout removes `.git/worktrees/<id>/` with its HEAD and its
    // reflog. Commits on a BRANCH outlive that — the branch is the record of
    // what the thread did, and prune keeps it deliberately. Commits on a
    // detached HEAD are reachable from nowhere else and are gone the same
    // second.
    const head = await this.deps.runGit(target.worktreePath, [
      'rev-parse',
      '--abbrev-ref',
      'HEAD',
    ])
    const onBranch = head.ok ? head.stdout.trim() : ''
    // 'HEAD' is what git prints for a detached one; '' is a checkout nobody
    // could read. Cannot-say takes the detached answer, because holding on to a
    // directory costs disk and the alternative costs the work inside it.
    const detached = onBranch === '' || onBranch === 'HEAD'

    const base = target.base
    if (base === null || base === '') {
      // NO BASE RECORDED IS NOT AN EMPTY WORKTREE — and it is not automatically
      // a full one either. The difference is the question just asked.
      //
      // Two very different checkouts arrive here. One is a copy no thread claims
      // any more: it sits on a branch, everything it did is on that ref, and
      // removing the directory loses nothing — the ordinary orphan cleanup, and
      // it has to stay possible. The other was cut while the project sat on a
      // DETACHED HEAD (on a tag, mid-bisect); its commits are on no ref at all.
      //
      // This returned null — "holds nothing, release it" — for BOTH. The disk
      // cap already reads a null base as `hasLanded: false` (`worktree-cap.ts`),
      // so one fact had two answers and the reader that DELETES held the
      // dangerous one.
      if (!detached) return null
      return {
        status: 'holds-work',
        detail:
          'This thread’s copy is on no branch, so anything it committed is reachable from nowhere else. Land the work first, or say to let it go.',
        changedFiles,
      }
    }

    const ahead = await this.deps.runGit(target.worktreePath, ['rev-list', '--count', `${base}..HEAD`])
    const count = Number.parseInt(ahead.stdout.trim(), 10)
    if (ahead.ok && Number.isFinite(count) && count > 0) {
      // A BRANCH KEEPS THEM, SO THIS IS NOT A REFUSAL AT ALL.
      //
      // It used to be one, described in its own comment as "a caution rather
      // than a refusal — but it is the caller's to overrule", and no caller ever
      // overruled it. So a worktree whose branch was simply not merged yet could
      // not be deleted from the panel at all, under a confirm dialog that had
      // just said in as many words that the branch and its commits stay and the
      // main folder is untouched (user, 2026-09-18). The dialog was right; the
      // guard was protecting something that was never at risk, and its remedy
      // — "say to keep it on its own branch" — was a sentence with nothing
      // behind it (forbidden-pattern #12).
      //
      // Detached is the other story entirely: `base..HEAD` on a detached HEAD
      // counts commits that live on no ref, and those DO go with the directory.
      // This case reached here as the overridable caution too, which is the same
      // bug pointing the other way.
      if (!detached) return null
      return {
        status: 'holds-work',
        detail:
          'This thread’s copy is on no branch, so anything it committed is reachable from nowhere else. Land the work first, or say to let it go.',
        aheadCommits: count,
      }
    }
    return null
  }

  /**
   * Remove the checkout and forget it.
   *
   * THE CLI IS THE ONLY THING THAT DELETES. It removes the directory and leaves
   * the branch — and the linked dependencies die with the checkout without
   * touching the project's own. Clearing the three columns afterwards is what
   * makes the thread stop pointing at a directory that is no longer there:
   * the orphan row, the terminal's scope and the address gate all read them.
   */
  async #removeCheckout(
    thread: LandingThread,
    recorded = true,
    discard = false,
  ): Promise<PruneResult> {
    const removed = await this.deps.runCli(thread.projectRoot, [
      'worktree',
      'prune',
      '--thread',
      thread.id,
      // THE FOLDER'S NAME, SO THE VERB CAN FIND IT.
      //
      // Without it the CLI rebuilds the path from the thread's id — which is
      // where checkouts lived before they had names — looks in a directory that
      // does not exist, and answers `absent`. That is a SUCCESS as far as this
      // call can tell, so the record was cleared and the real directory left on
      // disk, owned by nothing and mentioned nowhere (found 2026-09-18 while
      // fixing the refusal above: the switch went Off, no error, the folder
      // still there).
      ...worktreeNameArgs(checkoutName(thread.worktreePath) ?? undefined),
      '--json',
      '--target',
      thread.projectRoot,
      ...(discard ? ['--discard'] : []),
    ])
    if (!removed.ok) {
      return {
        status: 'failed',
        detail: 'Flow couldn’t release this thread’s files. Its work is untouched.',
      }
    }
    // A copy whose thread is gone has no columns to clear — and asking the
    // store to clear them for an id it does not know would throw.
    if (recorded) this.deps.threadStore.setThreadWorktree(thread.id, null)

    // AND EVERY OTHER PROJECT'S COPY. A conversation can carry several
    // projects, each with a checkout of its own; releasing only the one it
    // started in would leave the rest on disk, owned by a thread that no longer
    // believes it has any — invisible to this panel and to the person.
    //
    // BEST EFFORT, AFTER THE ONE THAT MATTERS. The primary is already gone and
    // this must not turn a success into a failure: a project whose release
    // fails keeps its copy and says so in the log, exactly as an orphan would.
    if (recorded) await this.#releaseAttached(thread.id, discard)

    return {
      status: 'pruned',
      detail: `The space is free again. ${branchLabel(thread.worktreeBranch)} keeps the record of what this thread did.`,
    }
  }

  /**
   * Release the checkouts a conversation's OTHER projects hold.
   *
   * Each is keyed by the same thread in a different project, so each is released
   * where it lives. A failure is reported and skipped — the copies that did go
   * are still gone, and leaving the rest is the state we were already in.
   */
  async #releaseAttached(threadId: string, discard: boolean): Promise<void> {
    const attached = this.deps.threadStore.getThreadRootWorktrees?.(threadId) ?? []
    for (const entry of attached) {
      try {
        const released = await this.deps.runCli(entry.rootPath, [
          'worktree',
          'prune',
          '--thread',
          threadId,
          // Same reason as the primary above: a named folder is not findable
          // from the thread's id.
          ...worktreeNameArgs(checkoutName(entry.worktreePath) ?? undefined),
          '--json',
          '--target',
          entry.rootPath,
          ...(discard ? ['--discard'] : []),
        ])
        if (!released.ok) {
          console.warn('[ThreadLanding] could not release an attached worktree', {
            threadId,
            root: entry.rootPath,
          })
          continue
        }
        this.deps.threadStore.setThreadRootWorktree?.(threadId, entry.rootPath, null)
      } catch (error) {
        console.warn('[ThreadLanding] could not release an attached worktree', {
          threadId,
          root: entry.rootPath,
          error,
        })
      }
    }
  }
}

// ── The verbs' results, as far as this module reads them ───────────────────

/** What `worktree push` prints on success. */
interface PushResult {
  remote?: unknown
  remoteBranch?: unknown
  previouslyPushedAs?: unknown
}

/** What `worktree pr` prints on success. */
interface PullRequestResult {
  url?: unknown
}

/** What `worktree push` / `worktree pr` print when nobody has decided yet. */
interface UnboundPayload {
  refused?: unknown
  suggestion?: unknown
  source?: unknown
  remote?: unknown
  remotes?: unknown
  base?: unknown
}

/** The sources a suggestion can come from — the ladder's four rungs. */
const SUGGESTION_SOURCES: ReadonlySet<string> = new Set(['pattern', 'ticket', 'learned', 'local'])

/**
 * The last JSON object on a transcript, or null.
 *
 * The CLI writes exactly one line of JSON for `--json`; anything else on the
 * stream is somebody's warning. Read from the END for the same reason the
 * worktree service does: a refusal's payload is the last thing written before
 * the reason line.
 *
 * EXPORTED so the publish service reads a verb's answer the same way this one
 * does — a second copy of this loop is a second set of rules for what counts as
 * the CLI's answer (allowed-pattern #14).
 */
export function parseCliJson<T>(stdout: string): T | null {
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

/**
 * The unbound question inside a refused verb's transcript, or null.
 *
 * VALIDATED, NOT CAST. Everything below crosses IPC and pre-fills a field a
 * person will accept; a malformed payload read as a suggestion would be a
 * proposal nothing stands behind, which is the one thing a suggestion may
 * never be. Anything short of the whole shape is treated as an ordinary
 * failure instead.
 */
export function unboundRefusal(result: RunResult): ThreadBindingSuggestion | null {
  const payload = parseCliJson<UnboundPayload>(result.stdout)
  if (payload === null || payload.refused !== 'unbound') return null
  if (typeof payload.suggestion !== 'string' || payload.suggestion === '') return null
  if (typeof payload.source !== 'string' || !SUGGESTION_SOURCES.has(payload.source)) return null
  return {
    suggestion: payload.suggestion,
    source: payload.source as ThreadBindingSuggestion['source'],
    // ABSENT IS NULL, NOT A FAILURE. The project's usual remote is a default a
    // person still confirms, and a bundled CLI old enough not to send one is
    // answering the same question — the ask simply arrives with nothing
    // pre-selected, which is where it started.
    remote:
      typeof payload.remote === 'string' && payload.remote !== '' ? payload.remote : null,
    remotes: Array.isArray(payload.remotes)
      ? payload.remotes.filter((name): name is string => typeof name === 'string' && name !== '')
      : [],
    base: typeof payload.base === 'string' && payload.base !== '' ? payload.base : null,
  }
}

/**
 * The binding as the store holds it — no git, no ladder, no proposal.
 *
 * `bound` IS THE FIELD, and it is answered here rather than left for a consumer
 * to derive from `remote !== null`: half a binding is not a binding, and a
 * surface that worked that out for itself would have to be found and changed
 * the day the two stop agreeing.
 */
export function mirroredBinding(thread: LandingThread): ThreadBindingState {
  const remote = thread.remote ?? null
  const remoteBranch = thread.remoteBranch ?? null
  return {
    bound: remote !== null && remote !== '' && remoteBranch !== null && remoteBranch !== '',
    remote,
    remoteBranch,
    prBase: thread.prBase ?? null,
    previouslyPushedAs: thread.previouslyPushedAs ?? null,
    // A PREVIEW PROPOSES NOTHING. Building one costs a ladder of git reads, and
    // the moment worth paying for that is the refusal, not the panel opening.
    suggestion: null,
  }
}

// ── Small shared shapes ────────────────────────────────────────────────────

/**
 * Why there is nothing to land, or null when there is.
 *
 * A WORKTREE ON ITS OWN BRANCH IS NOT "NOTHING CHANGED" — it may have done a
 * great deal, all of it already on the branch. Saying "this thread hasn't
 * changed anything yet" there would be false, and the kind of false a reader
 * acts on: they would go looking for work they were told was not done.
 */
function nothingToLand(
  repos: LandingRepoPreview[],
  totalChanges: number,
  totalAhead: number,
): string | null {
  if (totalChanges > 0) return null
  if (repos.length > 0 && repos.every((repo) => repo.onBase)) {
    const base = repos[0].base
    return repos.length === 1 && base !== null
      ? `This thread works on ${branchLabel(base)} directly, so everything it has done is already there.`
      : 'This thread works on its branches directly, so everything it has done is already there.'
  }
  if (totalAhead > 0) return null
  return 'This thread hasn’t changed anything yet, so there is nothing to land.'
}

/**
 * The abandoned checkout, as a thread — or null when the caller named none.
 *
 * A SYNTHETIC RECORD, USED ONLY TO POINT AT A DIRECTORY. It is never written
 * back and never carries a title: the whole reason it exists is that the real
 * record is gone.
 */
function abandonedThread(
  threadId: string,
  abandoned: AbandonedCheckout | undefined,
): LandingThread | null {
  if (abandoned === undefined) return null
  return {
    id: threadId,
    title: '',
    projectRoot: abandoned.projectRoot,
    worktreePath: abandoned.worktreePath,
    worktreeBranch: abandoned.branch,
    worktreeBase: abandoned.base ?? null,
  }
}

function row(target: LandingTarget, outcome: LandingOutcome, detail: string): LandingRow {
  return { name: target.name, projectRoot: target.projectRoot, outcome, detail }
}

/** A branch, as a sentence names it — never bare when there is no name. */
function branchLabel(branch: string | null): string {
  return branch === null || branch === '' ? 'the branch it was cut from' : `“${branch}”`
}

function fileCount(count: number): string {
  return count === 1 ? '1 file' : `${count} files`
}

/** The body a thread's pull request opens with. */
export function pullRequestBody(title: string | null): string {
  const subject = (title ?? '').trim()
  return subject === ''
    ? 'Opened from a Flow thread.'
    : `Opened from a Flow thread: ${subject}`
}

/** The first URL on a transcript — what `gh pr create` prints. */
export function firstUrl(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    const match = /https?:\/\/\S+/.exec(line)
    if (match !== null) return match[0]
  }
  return null
}

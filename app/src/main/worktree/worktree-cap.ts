// The disk cap on thread checkouts (thread-worktrees Phase 7, task 7.5).
//
// A checkout is a copy of the repository. Ten threads is ten copies, and the
// user named silent disk growth as the failure mode they expect from this
// feature — so there is a ceiling, the ceiling has a rule, and the total is on
// screen rather than inferred from a directory nobody opens.
//
// THE RULE HAS EXACTLY ONE DANGEROUS EDGE, AND IT IS CLOSED HERE:
//
//   Only a LANDED checkout is ever a candidate. A checkout still holding work
//   that has not reached its branch is not evicted, not ranked, not counted
//   toward what may go — it is held back and reported, even when that means
//   the cap cannot be met. "Unlanded ones are never touched by the cap" is not
//   a preference to be traded against disk; a cap that deletes work somebody
//   has not landed is a cap that loses work.
//
// NOTHING IN THIS FILE DELETES ANYTHING. {@link planWorktreeCap} is a pure
// decision: it reads a list and returns which entries a caller MAY release.
// {@link enforceWorktreeCap} is the only place a release happens, and it has no
// default releaser — a caller without one gets a refusal and an untouched disk
// (forbidden-pattern #15: the destructive branch requires something said on
// purpose, and `{}` reaches nothing).

import { realpath } from 'fs/promises'
import { resolve } from 'path'
import type { WorktreeUsage } from '../../shared/ipc-contract'
import { countLosableChanges } from './losable-work'

/** How many checkouts one repository keeps before the oldest landed one goes. */
export const DEFAULT_WORKTREE_CAP = 10

/** One thread checkout, as the cap needs to see it. */
export interface WorktreeCandidate {
  /** The thread the checkout belongs to. */
  thread: string
  /** The checkout itself. */
  path: string
  /**
   * Whether everything in it has reached the branch it was cut from. FALSE is
   * the safe answer and the one an unreadable checkout gets: an entry nobody
   * could ask about is never one the cap removes.
   */
  landed: boolean
  /** When this thread last did anything, in ms. Oldest goes first. */
  lastActiveAt: number
  /**
   * Whether somebody is working in this checkout right now — or is one instant
   * away from it (see `worktree-in-use.ts` for the rule and the incident).
   *
   * A SECOND WAY TO BE UNTOUCHABLE, and it had to be its own field rather than
   * folded into `landed`. `landed` is a question about HISTORY: clean status,
   * nothing ahead of base. A checkout cut four seconds ago answers it
   * perfectly, so the newest worktree on disk was reliably the most evictable
   * one — which is exactly what happened on 2026-09-08, to a worktree whose
   * agent session was still spawning into it.
   *
   * TRUE IS THE SAFE ANSWER here, as FALSE is for `landed`: an entry nobody can
   * establish is free is never one the cap removes.
   */
  inUse: boolean
}

/** What the cap would do, if a caller asked it to. */
export interface CapPlan {
  /** Every checkout this repository is holding. */
  total: number
  /** The ceiling in force. */
  cap: number
  /** How many above the ceiling — 0 when there is nothing to do. */
  over: number
  /** The oldest landed checkouts, oldest first. Empty unless `over > 0`. */
  release: WorktreeCandidate[]
  /** Checkouts held back because their work has not landed. */
  unlanded: number
  /** Checkouts held back because somebody is working in them. */
  inUse: number
  /**
   * True when the ceiling is exceeded and nothing may be released — every
   * checkout above it is holding unlanded work. The honest state, and the one
   * the surface says out loud rather than quietly growing.
   */
  stuck: boolean
}

/**
 * Which checkouts a repository may let go of, and which it may not.
 *
 * Pure. Reads a list, returns a decision, touches nothing. The ordering is
 * oldest-first by last activity, with the thread id as the tiebreak so two
 * checkouts stamped in the same millisecond do not swap places between runs.
 */
export function planWorktreeCap(input: {
  candidates: readonly WorktreeCandidate[]
  cap?: number
}): CapPlan {
  const cap = normalizeCap(input.cap)
  const total = input.candidates.length
  const unlanded = input.candidates.filter((candidate) => !candidate.landed).length
  const inUse = input.candidates.filter((candidate) => candidate.inUse).length
  const over = Math.max(0, total - cap)
  if (over === 0) {
    return { total, cap, over: 0, release: [], unlanded, inUse, stuck: false }
  }
  // TWO HOLD-BACKS, NOT ONE. Unlanded work is the loss the cap was written to
  // prevent; a checkout somebody is IN is the loss it caused — deleting one
  // does not free the agent working there, it strands it in a path that is
  // then recreated as an empty directory no future cut can use.
  const evictable = input.candidates
    .filter((candidate) => candidate.landed && !candidate.inUse)
    .sort(oldestFirst)
    .slice(0, over)
  return {
    total,
    cap,
    over,
    release: evictable,
    unlanded,
    inUse,
    // Being over the ceiling with nothing to release is the honest state and
    // the one the surface says out loud — whether the reason is unlanded work
    // or work in progress.
    stuck: evictable.length < over,
  }
}

/** What one enforcement run did. */
export interface CapEnforcement {
  plan: CapPlan
  /** The threads whose checkouts were released. */
  released: string[]
  /** The threads a release was attempted for and failed. */
  failed: string[]
  /** True when nothing was attempted because nothing was allowed to be. */
  refused: boolean
  /** Threads whose checkout became busy between the plan and the release. */
  skipped: string[]
}

/**
 * Release the oldest landed checkouts above the ceiling.
 *
 * `release` HAS NO DEFAULT, deliberately. This is the one function here that
 * deletes, and the incident that wrote forbidden-pattern #15 was a call with no
 * arguments reaching the real system — so a caller that does not hand over a
 * releaser gets `refused: true`, an untouched disk, and a plan it can read.
 *
 * The plan is recomputed here rather than accepted from the caller: a stale
 * plan is a list of directories that may since have grown work in them, and
 * deleting from a list somebody else computed is exactly the shape of the
 * accident this guards against.
 *
 * THAT RECOMPUTE IS NOT A RE-READ, and this comment used to imply it was. It is
 * a pure function over the array the caller already collected — no git runs
 * again, no `inUseFor` is asked again — so it cannot see anything that changed
 * since. `stillEligible` is the actual re-read, and it is where a fact that can
 * go stale between collecting and deleting has to be checked.
 */
export async function enforceWorktreeCap(input: {
  candidates: readonly WorktreeCandidate[]
  cap?: number
  /** Actually let one go. Absent → nothing is released and nothing is tried. */
  release?: (candidate: WorktreeCandidate) => Promise<boolean>
  /**
   * Asked again, immediately before each release: is this one STILL free?
   *
   * COLLECTING AND DELETING ARE NOT THE SAME MOMENT. A sweep spawns a CLI and
   * two git processes per checkout, so seconds pass between the verdict and the
   * `--force` that acts on it — and in those seconds a person can open a thread
   * and an agent can spawn into the very checkout the plan marked free. That is
   * the 2026-09-08 incident again through a later window: the in-use guard
   * closed the gap between cutting and spawning, and left this one open.
   *
   * Absent means "nothing changes between the two moments", which is only true
   * for a caller with no live sessions at all.
   */
  stillEligible?: (candidate: WorktreeCandidate) => boolean | Promise<boolean>
}): Promise<CapEnforcement> {
  const plan = planWorktreeCap({ candidates: input.candidates, ...(input.cap === undefined ? {} : { cap: input.cap }) })
  if (typeof input.release !== 'function') {
    return { plan, released: [], failed: [], skipped: [], refused: true }
  }
  const released: string[] = []
  const failed: string[] = []
  const skipped: string[] = []
  for (const candidate of plan.release) {
    // THE LAST LOOK, and the only one that sees the present. Everything above
    // this line is a decision made from a snapshot.
    if (input.stillEligible !== undefined && !(await input.stillEligible(candidate))) {
      skipped.push(candidate.thread)
      continue
    }
    // Sequential, and each failure is reported rather than thrown: a locked
    // checkout must not stop the next one from being reclaimed.
    const ok = await input.release(candidate)
    ;(ok ? released : failed).push(candidate.thread)
  }
  return { plan, released, failed, skipped, refused: false }
}

/** What the surface prints — defined once, in the IPC contract it crosses. */
export type { WorktreeUsage }

/** The visible total. Silent disk growth is the failure mode this answers. */
export function worktreeUsage(
  candidates: readonly WorktreeCandidate[],
  cap?: number,
): WorktreeUsage {
  const ceiling = normalizeCap(cap)
  return {
    total: candidates.length,
    cap: ceiling,
    unlanded: candidates.filter((candidate) => !candidate.landed).length,
    atCap: candidates.length >= ceiling,
  }
}

// ── Reading what is on disk (still nothing that writes) ────────────────────

/** Result of running a subprocess. Mirrors the worktree service's shape. */
export interface CapRunResult {
  ok: boolean
  stdout: string
  stderr?: string
  error?: string
}

/** One thread checkout as the CLI's listing reports it. */
export interface ListedCheckout {
  /**
   * The thread this checkout belongs to — its record's id when a thread's
   * `worktreePath` is this directory, otherwise the CLI's own key (the folder,
   * relative to the container: `worktree/<name>`), which is what an
   * unclaimed copy is known by.
   */
  thread: string
  /** The checkout itself. */
  path: string
  /** The branch it is on, or null while detached. */
  branch: string | null
  /** True when git's record points at a directory that is no longer there. */
  prunable: boolean
  /**
   * True when the owner holds this checkout as one of its ATTACHED projects
   * (thread_roots), not the project it runs in. `thread` is then that owner's
   * id — but every release keyed by a thread id (`prune(thread)`) acts on the
   * thread's PRIMARY checkout, so nothing may release this one by `thread`.
   */
  attached: boolean
}

/** The listing shape before it is validated. */
interface RawCheckout {
  thread?: unknown
  path?: unknown
  branch?: unknown
  prunable?: unknown
}

/**
 * Every thread checkout one project is holding, exactly as git reports it.
 *
 * THE ONE LISTING PATH (allowed-pattern #14). The cap reads it to rank what may
 * be released; the inventory reads it to show a person what is on disk. A
 * second `worktree list` reader would be a second answer to "what exists", and
 * the whole point of the inventory is that there is only one.
 *
 * Dead records are KEPT here and filtered by the caller that does not want
 * them: a record git can no longer resolve is invisible to the cap (it holds no
 * disk) and is precisely what the inventory has to surface.
 */
/** Who may claim a listed checkout: a thread and the directory it records. */
export interface CheckoutOwner {
  id: string
  worktreePath: string | null
  /** Held as an attached project's checkout (thread_roots) — see `ListedCheckout.attached`. */
  attached?: boolean
}

/**
 * Everyone who may own a checkout of `rootPath`: the threads that RUN in it
 * (archived included — archiving keeps the copy) and the threads that have it
 * ATTACHED with a checkout of their own. Without the second half, an attached
 * project's live checkout was listed as "a conversation that no longer exists"
 * — and offered for deletion as abandoned.
 */
export function checkoutOwnersFor(
  store: {
    listThreads(rootPath: string, options: { includeArchived: boolean }): readonly CheckoutOwner[]
    listAttachedCheckouts(rootPath: string): ReadonlyArray<{ threadId: string; worktreePath: string }>
  },
  rootPath: string,
): CheckoutOwner[] {
  return [
    ...store.listThreads(rootPath, { includeArchived: true }).map((thread) => ({
      id: thread.id,
      worktreePath: thread.worktreePath,
    })),
    ...store.listAttachedCheckouts(rootPath).map((row) => ({
      id: row.threadId,
      worktreePath: row.worktreePath,
      attached: true,
    })),
  ]
}

/** A path as the filesystem resolves it — `/var` and `/private/var` are one. */
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    // Gone (a dead record) or unreadable: the lexical form is all there is.
    return resolve(path)
  }
}

export async function listThreadCheckouts(input: {
  rootPath: string
  runCli: (cwd: string, args: readonly string[]) => Promise<CapRunResult>
  /**
   * The threads that may own these checkouts. THE JOIN IS BY PATH.
   *
   * The CLI names a checkout by its folder. That WAS the thread id, so every
   * caller keyed on it — and when checkouts moved to `worktree/<name>`, every
   * one of those joins silently stopped matching: the Storage page listed each
   * thread's checkout twice (once as "files already gone", once as a copy of
   * "a conversation that no longer exists"), and the cap could neither read a
   * checkout's base nor see that its thread was busy. The record's own
   * `worktreePath` is the identity that survives a folder's naming scheme.
   */
  owners: readonly CheckoutOwner[]
}): Promise<ListedCheckout[]> {
  const listed = await input.runCli(input.rootPath, [
    'worktree',
    'list',
    '--json',
    '--target',
    input.rootPath,
  ])
  if (!listed.ok) return []
  const owned = new Map<string, { id: string; attached: boolean }>()
  for (const owner of input.owners) {
    if (owner.worktreePath === null || owner.worktreePath === '') continue
    owned.set(await canonicalPath(owner.worktreePath), { id: owner.id, attached: owner.attached === true })
  }
  const entries: ListedCheckout[] = []
  for (const raw of parseListing(listed.stdout)) {
    const folder = typeof raw.thread === 'string' ? raw.thread : ''
    const path = typeof raw.path === 'string' ? raw.path : ''
    if (folder === '' || path === '') continue
    const owner = owned.get(await canonicalPath(path))
    entries.push({
      thread: owner?.id ?? folder,
      path,
      branch: typeof raw.branch === 'string' && raw.branch !== '' ? raw.branch : null,
      prunable: raw.prunable === true,
      attached: owner?.attached ?? false,
    })
  }
  return entries
}

/**
 * What thread checkouts one project is holding, and whether each has landed.
 *
 * READ-ONLY, and every question is asked of git rather than assumed: a checkout
 * counts as landed only when it has nothing uncommitted AND nothing its base
 * has not got. A checkout whose base nobody can name, or whose git answers
 * cannot be read, comes back `landed: false` — the answer that keeps it.
 */
export async function collectWorktreeCandidates(input: {
  rootPath: string
  runCli: (cwd: string, args: readonly string[]) => Promise<CapRunResult>
  runGit: (cwd: string, args: readonly string[]) => Promise<CapRunResult>
  /** The ref a thread's checkout was cut from, from the thread store. */
  baseFor: (thread: string) => string | null
  /**
   * Whether somebody is working in this checkout — see `worktree-in-use.ts`.
   *
   * REQUIRED, WITH NO DEFAULT, for the reason `enforceWorktreeCap`'s releaser
   * has none (forbidden-pattern #15): this feeds a decision that deletes
   * directories, and a caller that has not been asked the question would answer
   * it "no" by omission. A compile error is the right way to find the next
   * caller; a stranded agent is not.
   */
  inUseFor: (candidate: { thread: string; path: string }) => boolean
  /** The project's threads, so each checkout is known by its thread's id. */
  owners: readonly CheckoutOwner[]
}): Promise<WorktreeCandidate[]> {
  const entries = await listThreadCheckouts({
    rootPath: input.rootPath,
    runCli: input.runCli,
    owners: input.owners,
  })
  const candidates: WorktreeCandidate[] = []
  for (const entry of entries) {
    // A dead record holds no disk and has nothing to lose — the CLI's own
    // prune clears those, and the cap has no business ranking them.
    if (entry.prunable) continue
    candidates.push({
      thread: entry.thread,
      path: entry.path,
      landed: await hasLanded(input.runGit, input.rootPath, entry.path, input.baseFor(entry.thread)),
      lastActiveAt: await lastCommitTime(input.runGit, entry.path),
      // AN ATTACHED PROJECT'S CHECKOUT IS NEVER THE CAP'S TO TAKE. Its release
      // would be `prune(thread)`, which acts on the owner's PRIMARY checkout —
      // a different project's copy. Held as in use: counted, never released.
      inUse: entry.attached || input.inUseFor({ thread: entry.thread, path: entry.path }),
    })
  }
  return candidates
}

/**
 * How much disk one checkout is actually using, in kilobytes — or null.
 *
 * THE SAME AUTHORITY AS THE TOTAL, deliberately in this file rather than beside
 * the surface that prints it. {@link worktreeUsage} answers "how many, of how
 * many"; this answers "how big is that one", and a second module owning the
 * second half would be two spellings of the project's disk story.
 *
 * NOT ON THE CREATION PATH. `collectWorktreeCandidates` runs every time a
 * thread gets a worktree, and a directory walk there would tax the message
 * that caused it. This is called only by the inventory a person opened
 * (allowed-pattern #17).
 *
 * A worktree's `.git` is a FILE pointing back at the project's object store, so
 * what is measured is the working tree — the copy, not the history. Null when
 * the measurement cannot be trusted; the surface says nothing rather than a
 * number it made up.
 */
export async function measureCheckoutKb(
  path: string,
  runDu: (cwd: string, args: readonly string[]) => Promise<CapRunResult>,
): Promise<number | null> {
  try {
    const measured = await runDu(path, ['-sk', '.'])
    if (!measured.ok) return null
    const kb = Number.parseInt(measured.stdout.trim().split(/\s+/)[0] ?? '', 10)
    return Number.isFinite(kb) && kb >= 0 ? kb : null
  } catch {
    return null
  }
}

/** Whether a checkout holds nothing that its base has not already got. */
async function hasLanded(
  runGit: (cwd: string, args: readonly string[]) => Promise<CapRunResult>,
  rootPath: string,
  path: string,
  base: string | null,
): Promise<boolean> {
  if (base === null || base === '') return false
  const status = await runGit(path, ['status', '--porcelain'])
  if (!status.ok) return false
  if ((await countLosableChanges(status.stdout, path, rootPath)) > 0) return false
  const ahead = await runGit(path, ['rev-list', '--count', `${base}..HEAD`])
  const count = Number.parseInt(ahead.stdout.trim(), 10)
  return ahead.ok && Number.isFinite(count) && count === 0
}

/** When the checkout last had a commit made in it; 0 when unreadable (= oldest). */
async function lastCommitTime(
  runGit: (cwd: string, args: readonly string[]) => Promise<CapRunResult>,
  path: string,
): Promise<number> {
  const stamped = await runGit(path, ['log', '-1', '--format=%ct'])
  const seconds = Number.parseInt(stamped.stdout.trim(), 10)
  return stamped.ok && Number.isFinite(seconds) ? seconds * 1000 : 0
}

/** The last JSON object on a transcript — the CLI writes exactly one. */
function parseListing(stdout: string): RawCheckout[] {
  for (const line of stdout.split('\n').map((entry) => entry.trim()).reverse()) {
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as { worktrees?: unknown }
      return Array.isArray(parsed.worktrees) ? (parsed.worktrees as RawCheckout[]) : []
    } catch {
      continue
    }
  }
  return []
}

/** A ceiling of at least one; anything unreadable falls back to the default. */
function normalizeCap(cap: number | undefined): number {
  if (cap === undefined || !Number.isFinite(cap)) return DEFAULT_WORKTREE_CAP
  return Math.max(1, Math.floor(cap))
}

function oldestFirst(a: WorktreeCandidate, b: WorktreeCandidate): number {
  if (a.lastActiveAt !== b.lastActiveAt) return a.lastActiveAt - b.lastActiveAt
  return a.thread < b.thread ? -1 : a.thread > b.thread ? 1 : 0
}

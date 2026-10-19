// Every thread worktree one project is holding — the list that manages them.
//
// WHY THIS EXISTS. Worktrees were created and landed, and never MANAGED. A
// person could get one at the first message, change where it starts, land it,
// and let one go — one at a time, from inside the thread that owned it. There
// was no way to see all of them, which is the first thing "manage" means and
// the only way to notice that fifteen have accumulated.
//
// IT IS THE UNION OF TWO TRUTHS, AND THAT IS THE POINT. The database believes
// some threads own copies; git reports some copies exist. Those two lists drift
// — a directory deleted by hand, a thread deleted while its copy stayed, a git
// record pointing at nothing — and a management view that showed either one
// alone would hide exactly the rows somebody opened it to find. So both sides
// are read, joined on the thread id, and every row says which side is missing.
//
// READ-ONLY, ALL OF IT. Nothing here creates, moves or deletes; opening a list
// must never change what it lists. The actions the list offers are somebody
// else's code path — deletion is `ThreadLandingService.prune` and nothing else
// (allowed-pattern #14).
//
// NO PATH LEAVES THIS MODULE. A worktree crosses to the renderer as its
// thread, its branch and its state; where it sits on disk is Flow's business
// (forbidden-pattern #12).

import type {
  ThreadWorktreeDrift,
  ThreadWorktreeEntry,
  ThreadWorktreeInventory,
} from '../../shared/ipc-contract'
import { countLosableChanges } from './losable-work'
import {
  listThreadCheckouts,
  measureCheckoutKb,
  worktreeUsage,
  type CapRunResult,
  type ListedCheckout,
} from './worktree-cap'

/** One thread, as the inventory needs to see it. */
export interface InventoryThread {
  id: string
  title: string
  status: string
  worktreePath: string | null
  worktreeBranch: string | null
  worktreeBase: string | null
  /** Where its work publishes, mirrored from git. Null throughout while nothing
   *  has been decided, which is most worktrees most of the time. */
  remote: string | null
  remoteBranch: string | null
  prBase: string | null
  previouslyPushedAs: string | null
  /** True when its copy was cut without refreshing the branch it started from —
   *  the record's own answer, written by the cut that could not check. */
  baseMayBeBehind: boolean
  archived: boolean
}

export interface InventoryDeps {
  /** Every thread of this project, archived ones included. */
  threadsFor: (rootPath: string) => InventoryThread[]
  /**
   * The checkouts of this project held by threads that have it ATTACHED.
   * REQUIRED: without it those live copies are listed as abandoned and offered
   * for deletion (allowed-pattern #26).
   */
  attachedCheckoutsFor: (rootPath: string) => ReadonlyArray<{ threadId: string; worktreePath: string }>
  /** Run the bundled CLI — how the disk side is read. */
  runCli: (cwd: string, args: readonly string[]) => Promise<CapRunResult>
  /** Run `git`. Async, always — main answers every IPC call (allowed-pattern #19). */
  runGit: (cwd: string, args: readonly string[]) => Promise<CapRunResult>
  /**
   * Measure a directory. Absent → every row reports an unknown size, which is
   * exactly what the surface then says. A size is orientation, never a gate.
   */
  runDu?: (cwd: string, args: readonly string[]) => Promise<CapRunResult>
  /** The ceiling in force. Absent → the module default. */
  cap?: number
}

/** Statuses with a turn in flight. Nothing offers to touch one of these. */
const IN_FLIGHT = new Set(['working', 'needs-decision'])

/**
 * What this project is holding.
 *
 * SEQUENTIAL BY DESIGN. Each row costs two or three git reads plus one
 * measurement, and firing thirty child processes at once to fill a list
 * somebody just opened is how a main process stops answering
 * (allowed-pattern #19). A list of fifteen is the case this was built for, and
 * fifteen sequential reads is well inside what an opening dialog can wait for.
 */
export async function readWorktreeInventory(
  rootPath: string,
  deps: InventoryDeps,
): Promise<ThreadWorktreeInventory> {
  const threads = deps.threadsFor(rootPath)
  const listed = await listThreadCheckouts({
    rootPath,
    runCli: deps.runCli,
    owners: [
      ...threads,
      ...deps.attachedCheckoutsFor(rootPath).map((row) => ({
        id: row.threadId,
        worktreePath: row.worktreePath,
        attached: true,
      })),
    ],
  })
  const onDisk = new Map(listed.map((entry) => [entry.thread, entry]))

  const entries: ThreadWorktreeEntry[] = []
  const seen = new Set<string>()

  // The database's side first, so an ordinary row is built from the record that
  // owns it — the title, the base and the archived flag live only there.
  for (const thread of threads) {
    if (thread.worktreePath === null) continue
    seen.add(thread.id)
    const disk = onDisk.get(thread.id) ?? null
    entries.push(await entryFor(rootPath, thread, disk, deps))
  }

  // …then whatever is on disk that no thread claims.
  // An ATTACHED project's checkout is not abandoned: a live thread holds it,
  // and it is managed from that thread. It has no row here because every
  // action this list offers is keyed by thread id, and that id's checkout is
  // the thread's PRIMARY one — a row would offer to free the wrong copy.
  for (const checkout of listed) {
    if (seen.has(checkout.thread) || checkout.attached) continue
    entries.push(await abandonedEntry(rootPath, checkout, deps))
  }

  entries.sort(newestFirst)
  const usage = worktreeUsage(
    // The ceiling counts what actually occupies disk. A dead record occupies
    // none, and a thread pointing at a directory that is gone occupies none
    // either — counting them would tell somebody they were at a limit they
    // are not at, and the cap itself never saw them.
    entries
      .filter((entry) => entry.drift === 'none')
      .map((entry) => ({
        thread: entry.threadId,
        path: '',
        landed: entry.landed,
        lastActiveAt: entry.lastActiveAt,
        // The inventory already knows this one by another name — `busy` is what
        // it prints beside a row somebody is working in. Same fact, so it feeds
        // the count rather than being computed a second way here.
        inUse: entry.busy,
      })),
    deps.cap,
  )
  return {
    rootPath,
    usage,
    entries,
    // Nothing on either side is a project with no worktrees, which is a fine
    // and common answer. "Unreadable" is reserved for the case where git had
    // records the app could not read at all.
    unreadable: false,
  }
}

/** A row built from the thread that owns it. */
async function entryFor(
  rootPath: string,
  thread: InventoryThread,
  disk: ListedCheckout | null,
  deps: InventoryDeps,
): Promise<ThreadWorktreeEntry> {
  const drift: ThreadWorktreeDrift =
    disk === null ? 'gone' : disk.prunable ? 'dead-record' : 'none'
  const path = thread.worktreePath ?? ''
  // A row with nothing behind it is not asked about: git in a directory that is
  // not there costs a child process to be told what the listing already said.
  const work = drift === 'none' ? await readWork(rootPath, path, thread.worktreeBase, deps) : NO_WORK
  // THE RECORD'S BRANCH, WITH THE DISK ONLY FILLING A GAP. Every other surface
  // reads the column — the titlebar, the landing bar — and rename acts on it,
  // so preferring git here would make this one list disagree with all of them
  // and offer a rename of a name the renamer does not have.
  const branch = thread.worktreeBranch ?? disk?.branch ?? null
  return {
    threadId: thread.id,
    threadTitle: thread.title.trim() === '' ? null : thread.title,
    branch: branch === '' ? null : branch,
    base: thread.worktreeBase,
    landed: work.landed,
    changedFiles: work.changedFiles,
    aheadCommits: work.aheadCommits,
    lastActiveAt: work.lastActiveAt,
    diskKb: drift === 'none' ? await size(path, deps) : null,
    onBase:
      branch !== null && branch !== '' && branch === thread.worktreeBase,
    busy: IN_FLIGHT.has(thread.status),
    archived: thread.archived,
    drift,
    remote: thread.remote,
    remoteBranch: thread.remoteBranch,
    prBase: thread.prBase,
    previouslyPushedAs: thread.previouslyPushedAs,
    // THE RECORD'S ANSWER, NOT A READING TAKEN HERE. Nothing in this module
    // refreshes anything, so it cannot know whether a base is current — the
    // cut that could not check is what wrote this, and re-deriving it would
    // mean a network round trip per row of a list somebody just opened
    // (allowed-pattern #19).
    baseMayBeBehind: thread.baseMayBeBehind,
  }
}

/** A row for a copy on disk that no thread claims. */
async function abandonedEntry(
  rootPath: string,
  checkout: ListedCheckout,
  deps: InventoryDeps,
): Promise<ThreadWorktreeEntry> {
  const drift: ThreadWorktreeDrift = checkout.prunable ? 'dead-record' : 'abandoned'
  // NO BASE, SO NOTHING IS "LANDED". The base lived on the thread record, and
  // that record is what went missing — so whether its commits reached anywhere
  // is genuinely unknown, and unknown must not read as safe to delete.
  const work =
    drift === 'abandoned' ? await readWork(rootPath, checkout.path, null, deps) : NO_WORK
  return {
    threadId: checkout.thread,
    threadTitle: null,
    branch: checkout.branch,
    base: null,
    landed: false,
    changedFiles: work.changedFiles,
    aheadCommits: 0,
    lastActiveAt: work.lastActiveAt,
    diskKb: drift === 'abandoned' ? await size(checkout.path, deps) : null,
    onBase: false,
    busy: false,
    archived: false,
    drift,
    // NO RECORD, SO NO BINDING TO REPORT. The thread that held it is what went
    // missing; where it published — if it ever did — is genuinely unknown, and
    // unknown is null, never a guess reconstructed from the branch name.
    remote: null,
    remoteBranch: null,
    prBase: null,
    previouslyPushedAs: null,
    // …and no record means no answer to this either. False is the honest
    // reading of "nothing known", and there is no thread left to have been
    // told otherwise.
    baseMayBeBehind: false,
  }
}

interface WorkState {
  landed: boolean
  changedFiles: number
  aheadCommits: number
  lastActiveAt: number
}

/** What a row reports when there is nothing behind it to ask. */
const NO_WORK: WorkState = { landed: false, changedFiles: 0, aheadCommits: 0, lastActiveAt: 0 }

/**
 * What one checkout is still holding.
 *
 * UNREADABLE IS NEVER "LANDED". Every failure below leaves `landed: false`, the
 * answer that keeps the worktree — the same rule the cap has, for the same
 * reason: the cost of being wrong runs one way only.
 */
async function readWork(
  rootPath: string,
  path: string,
  base: string | null,
  deps: InventoryDeps,
): Promise<WorkState> {
  const status = await deps.runGit(path, ['status', '--porcelain'])
  // What deleting it would LOSE — the links and untouched copies every
  // checkout is given are not work (losable-work.ts).
  const changedFiles = status.ok ? await countLosableChanges(status.stdout, path, rootPath) : 0
  const stamped = await deps.runGit(path, ['log', '-1', '--format=%ct'])
  const seconds = Number.parseInt(stamped.stdout.trim(), 10)
  const lastActiveAt = stamped.ok && Number.isFinite(seconds) ? seconds * 1000 : 0

  if (base === null || base === '') {
    return { landed: false, changedFiles, aheadCommits: 0, lastActiveAt }
  }
  const ahead = await deps.runGit(path, ['rev-list', '--count', `${base}..HEAD`])
  const count = Number.parseInt(ahead.stdout.trim(), 10)
  const aheadCommits = ahead.ok && Number.isFinite(count) && count > 0 ? count : 0
  return {
    landed: status.ok && ahead.ok && changedFiles === 0 && aheadCommits === 0,
    changedFiles,
    aheadCommits,
    lastActiveAt,
  }
}

/** Kilobytes on disk, or null — one authority, in the module that owns usage. */
async function size(path: string, deps: InventoryDeps): Promise<number | null> {
  if (deps.runDu === undefined) return null
  return measureCheckoutKb(path, deps.runDu)
}

/**
 * Newest activity first; anything unreadable sorts last.
 *
 * The thread id is the tiebreak so two rows stamped in the same second never
 * swap places between two openings of the same list.
 */
function newestFirst(a: ThreadWorktreeEntry, b: ThreadWorktreeEntry): number {
  if (a.lastActiveAt !== b.lastActiveAt) return b.lastActiveAt - a.lastActiveAt
  return a.threadId < b.threadId ? -1 : a.threadId > b.threadId ? 1 : 0
}

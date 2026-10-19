// The thread's own checkout — created, named, and refused out loud
// (thread-worktrees Phase 5).
//
// Everything the earlier phases built is inert until something writes
// `threads.worktree_path`. This is that something, and it is the only one: the
// store's `setThreadWorktree` is the single writer of the three columns, and
// this module is the single caller of it (allowed-pattern #14).
//
// THREE FACTS SHAPE EVERY DECISION HERE:
//
//  1. A thread that never sends a message never gets a checkout. Creation hangs
//     off the send path and nothing else — not thread creation, not selection,
//     not the sidebar's render. That is the user's stated guarantee ("a
//     chat-only thread must feel identical to today"), and it is a fact about
//     WHERE this is called from, which is why the test that proves it counts
//     calls rather than inspecting a flag.
//
//  2. The session's root is fixed when the session spawns (Phase 4). So the
//     checkout must exist BEFORE that, or the turn runs in the project's own
//     tree and no later creation moves it. Everything here is `await`ed by
//     `AgentManager.sendMessage` before `ensureSession`.
//
//  3. A refusal is said out loud. A non-git directory and a repository with no
//     commits are both refused by the CLI before anything is created; the
//     thread then works exactly as threads did before this feature, and a line
//     in the transcript says so. Never a silent fallback (a brainstorm
//     rejection) — a user whose agent quietly started writing to their own
//     working tree deserves to have been told.
//
// The uncommitted-work offer (task 5.2) lives here too, because the choice
// changes what gets created and creation is not the renderer's to do. Its
// non-destructive branch is deliberate: `git stash create` writes a commit
// OBJECT and touches nothing — the user's files stay dirty exactly as they
// were, and the thread starts from a copy of them. Only the explicit `stash`
// choice moves anything of the user's, and only because they picked it
// (forbidden-pattern #15: no destructive default — `carry` absent means
// `clean`, which does nothing at all).

import type {
  CarryChoice,
  ResolvedWorktreeSettings,
  ResolvedWorktreeSettingsResult,
  ThreadWorktreeRenameResult,
  ThreadWorktreeStatus,
  WorktreeBranchChoices,
  WorktreeBranchOption,
  WorktreeRetargetResult,
  WorktreeStart,
} from '../../shared/ipc-contract'
import { existsSync } from 'node:fs'
import { countLosableChanges } from './losable-work'
import { join } from 'node:path'
import { isValidRefName, threadBranchName } from '../../shared/thread-branch'
// `checkoutName` lives in shared because the worktree panel prints the name
// this passes to the CLI — one namer, so the two cannot disagree about a
// nested path (allowed-pattern #14).
import {
  checkoutName,
  folderForBranch,
  uniqueWorktreeName,
  worktreeNameFromTitle,
} from '../../shared/worktree-name'
export { checkoutName }
import { BASE_REFRESH_TIMEOUT_MS, resolveWorktreeSettings } from '../flow/worktree-settings'
import { unpreparedNote } from './unprepared-worktree'
// The folder-behind notice: the decision is pure and lives beside this, the
// row's wording is shared with the renderer that reads it back.
import {
  folderFreshnessVerdict,
  parseAheadBehind,
  parseUpstreamName,
} from './folder-freshness'
import { formatFolderBehindMarker } from '../../shared/folder-behind-marker'

/** A thread, as this module needs to see it. */
export interface WorktreeThread {
  id: string
  /** The registered project root — where git runs and what the checkout is of. */
  projectRoot: string
  title: string
  status: string
  worktreePath: string | null
  worktreeBranch: string | null
  /** The ref the checkout was cut from — preserved across a rename. */
  worktreeBase: string | null
  /**
   * The loop driving this thread, or null when a person is.
   *
   * Stamped once by whatever picked the work up — `board-loop.ts` sets it before
   * its first message. It is the ONLY thing that separates a thread nobody is
   * watching from a conversation somebody is having, and `automaticWorktree`
   * below is the first thing to ask it.
   */
  originLoop?: string | null
}


/** What the cut tells the window about its own progress. `running` raises the
 *  line; `done` and `failed` are the only two things that take it down. */
export type SetupProgressEvent = { state: 'running' | 'done' | 'failed'; detail?: string }

/** Result of running a subprocess. Mirrors learn-session's CliRunResult. */
export interface RunResult {
  ok: boolean
  stdout: string
  stderr?: string
  error?: string
}

export interface ThreadWorktreeDeps {
  threadStore: {
    getThread(threadId: string): WorktreeThread | null
    setThreadWorktree(
      threadId: string,
      worktree: {
        path: string
        branch: string | null
        base: string | null
        /** Omitted leaves the stored answer alone — only a cut answers it. */
        baseMayBeBehind?: boolean
      } | null,
    ): void
    appendMessage(threadId: string, role: 'system', content: string): unknown
    /**
     * Whether this thread already carries this exact system row.
     *
     * The folder-behind notice's once-per-thread guard, and durable with it:
     * the in-memory "first turn" flag is gone on the next launch, while a row
     * in the transcript is the same answer it was yesterday.
     */
    hasSystemMessage(threadId: string, content: string): boolean
    /** The other projects this conversation carries. */
    getThreadRoots(threadId: string): string[]
    /** Those projects' checkouts — the single writer's read side. */
    getThreadRootWorktrees(
      threadId: string,
    ): Array<{ rootPath: string; worktreePath: string; branch: string | null; base: string | null }>
    /**
     * Every checkout this app has recorded — the names already spoken for.
     *
     * REQUIRED, not optional. Without it a folder named from a title would
     * collide with the one beside it and the cut would fail on `git worktree
     * add`; a caller that could forget to pass it is a caller that meets that
     * failure (allowed-pattern #26).
     */
    listThreadWorktrees(): Array<{ worktreePath: string; projectRoot: string }>
    /** Record or clear ONE attached project's checkout. */
    setThreadRootWorktree(
      threadId: string,
      rootPath: string,
      worktree: { path: string; branch: string | null; base: string | null } | null,
    ): void
  }
  /** Run the bundled `planflow-ai` in a directory, capturing stdout. */
  runCli: (cwd: string, args: readonly string[]) => Promise<RunResult>
  /**
   * Whether a recorded checkout is still a checkout — see `#prepare`.
   *
   * Injected so the "it vanished, cut again" branch is testable without a real
   * directory. Defaults to reading the filesystem, which is what every caller
   * in the app wants; a fake answers for a path that never existed.
   */
  checkoutPresent?: (path: string) => boolean
  /**
   * Whether a path exists at all — used to ask the PROJECT whether it keeps a
   * dependency folder git will not carry. Injected for the same reason
   * `checkoutPresent` is: the answer is about a real machine, and no test
   * should need one.
   */
  pathPresent?: (path: string) => boolean
  /**
   * Run `git` in a directory. MUST be async — main answers every IPC call and
   * a synchronous child there freezes every window (allowed-pattern #19).
   *
   * `options` is honoured by the real runner and ignorable by a fake: the base
   * refresh bounds itself either way (see `#refreshBase`), so a collaborator
   * that drops the ceiling cannot turn a slow remote into a hang.
   */
  runGit: (
    cwd: string,
    args: readonly string[],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ) => Promise<RunResult>
  /** Whether this project wants thread worktrees (`readThreadWorktreesEnabled`). */
  isEnabled: (rootPath: string) => Promise<boolean>
  /**
   * Every worktree setting in effect for a project — `readWorktreeSettings`,
   * which walks the project's own file, then the person's app-wide defaults,
   * then the built-in behaviour.
   *
   * THE ONLY PLACE THIS MODULE LEARNS WHAT A PROJECT WANTS (allowed-pattern
   * #14). It used to ask a question at a time (`remoteFor`) and fill the gaps
   * with constants of its own, which meant the precedence lived here as well as
   * in the resolver; now the resolver decides and this reads the answer.
   *
   * ABSENT → THE BUILT-INS, resolved through the same pure function rather than
   * hand-assembled, so a test that injects nothing gets exactly what a project
   * that has configured nothing gets.
   */
  settingsFor?: (rootPath: string) => Promise<ResolvedWorktreeSettingsResult>
  /**
   * Drop the thread's session so its NEXT turn spawns in the new checkout.
   * Absent → a thread that already has a session keeps writing where it was,
   * which is why `prepare` refuses a `requested` move while a turn is running
   * rather than pretending it took effect.
   */
  disposeSession?: (threadId: string) => void
  /**
   * Called after a checkout is CREATED (never after one is merely found).
   *
   * The disk cap hangs off this (Phase 7, task 7.5): the moment a project gains
   * a copy is the moment to ask whether it is now holding more than it should.
   * Fire-and-forget on the coordinator's side — a sweep must never delay the
   * message that caused it.
   */
  onCreated?: (rootPath: string) => void
  /**
   * Run the project's own setup command in a new worktree.
   *
   * ABSENT → NO SETUP EVER RUNS, whatever a project configured. That is not a
   * convenience for tests: it means a caller has to hand this module the
   * ability to execute a project's shell command on purpose, and nothing gets
   * it by forgetting to pass something (forbidden-pattern #15).
   */
  runSetup?: (
    cwd: string,
    command: string,
    options: { timeoutMs?: number },
  ) => Promise<RunResult>
  /**
   * Break a worktree's `node_modules` symlink so an install lands in it.
   *
   * The CLI's `detachSharedModules` — one answer to "break the link", shared
   * with the dependency promotion (allowed-pattern #14). Absent → the link is
   * left alone, which is only safe for a caller that also runs no setup.
   */
  detachModules?: (threadId: string, projectRoot: string, worktreePath: string) => Promise<void> | void
  /**
   * Say what is happening to a worktree while a person waits for their reply.
   *
   * The cut has always been silent — only refusals ever reached the thread —
   * and a project that sets a setup command turns a four-second silence into a
   * multi-minute one. Absent → nothing is reported, exactly as before.
   */
  onSetupProgress?: (threadId: string, event: SetupProgressEvent) => void
  /** Injected for deterministic WIP branch names. */
  now?: () => Date
}

/** What the caller wants done with the project's uncommitted work. */
export type { CarryChoice }

export interface PrepareOptions {
  /**
   * Whether this conversation gets a checkout of its OWN — the worktree half
   * of a question that used to be one.
   *
   * `project` means the thread works in the project's folder, and it is an
   * ANSWER rather than the absence of one: it used to be expressed by not
   * calling this service at all, so main could not tell "nobody decided" from
   * "they decided no", and a branch could not be chosen without a checkout
   * coming with it (user, 2026-09-17: "we need to separate that concept
   * everywhere"). Absent → `own`, which is what every existing caller means.
   */
  worktree?: 'own' | 'project'
  /**
   * True when the caller can put a question on screen. The send path passes
   * false — `sendMessage` cannot wait on a dialog, and a message must never be
   * blocked by one.
   */
  ask?: boolean
  /** The answer, once there is one. Absent = `clean` (do nothing). */
  carry?: CarryChoice
  /**
   * True when a person asked for this by name (the thread menu). Only a
   * requested move disposes a live session, and only a requested move retries
   * a project that refused earlier in this app run.
   */
  requested?: boolean
  /**
   * Stops the base refresh — and ONLY the base refresh.
   *
   * A person who has decided not to wait for a remote has not decided to
   * abandon their worktree: aborting here drops the network step, the cut goes
   * ahead from the last thing the repository knew, and the result says so.
   * Absent → the refresh runs to its own ceiling.
   */
  signal?: AbortSignal
  /**
   * Where the worktree begins. Absent → `here`: the branch the project is on.
   *
   * THE SEND PATH PASSES NOTHING, and that is the fix rather than an omission.
   * The default used to be the repository's trunk, so a thread opened to help
   * with the branch someone was on was handed a copy of the project that could
   * see neither that branch nor the commits on it they had not pushed. A thread
   * exists to help with the work in front of a person; it starts there.
   */
  start?: WorktreeStart
  /**
   * What the checkout's FOLDER should be called.
   *
   * THE OTHER NAME. `branch` names the ref; this names the directory, and they
   * are free to differ — a worktree holds many branches over its life, and a
   * directory called after a thread's uuid tells nobody anything (user,
   * 2026-09-17: "we should have two dif things, one is branch, and another is
   * worktree"). Absent → the thread's id, which is what every caller before
   * this meant.
   */
  worktreeName?: string
  /**
   * What the new checkout's branch should be CALLED — a different question from
   * `start`, which says where it begins.
   *
   * A TYPED NAME: validated, never repaired (allowed-pattern #22). Absent is
   * every caller that existed before the Create-thread modal — the checkout
   * stays detached and earns its name from the generated title once the first
   * reply lands (`nameAfterTitle`).
   *
   * NAMED AND BOUND AT THE CUT, because that is the moment a person has just
   * said where this work goes. The same name serves the local branch and the
   * remote it publishes to, so nothing has to ask again at the first push.
   */
  branch?: string
}

export interface PrepareResult {
  status: ThreadWorktreeStatus
  /** Files changed in the PROJECT's own tree — only on `needs-choice`. */
  changedFiles?: number
  /** The project's current branch — only on `needs-choice`. */
  baseBranch?: string | null
  /** The branch the carried work was parked on, when one was made. */
  wipBranch?: string | null
  /** The branch this worktree's work belongs on, once there is one. */
  base?: string | null
  /** True when the worktree took `base` as its own branch — nothing to merge. */
  onBase?: boolean
  /** True when the cut went ahead without refreshing its base first. */
  baseMayBeBehind?: boolean
  /** One sentence a person reads. Never a command, a path or a config key. */
  detail?: string
}

/** Prefix the CLI puts on every refusal (`worktree refused: <reason>`). */
const REFUSAL_PREFIX = 'worktree refused:'

/** Branch prefix for work parked out of the way at a thread's first message. */
const WIP_BRANCH_PREFIX = 'wip/'

/**
 * Longest the base refresh may take before the cut goes ahead without it.
 *
 * DEFINED WITH THE SETTING IT IS THE DEFAULT FOR (`flow/worktree-settings.ts`)
 * and re-exported here, where it is used: the moment a person can configure this
 * wait, the built-in and the clamp have to be the same number, and one constant
 * in two files is the drift this repo keeps paying for (allowed-pattern #14).
 * The reasoning for eight seconds lives beside the definition.
 */
export { BASE_REFRESH_TIMEOUT_MS }


// ── Pure helpers (exported for their tests) ────────────────────────────────

/**
 * The branch a titled thread's checkout should carry.
 *
 * RE-EXPORTED, NOT REDEFINED. The slug rule moved to `shared/thread-branch`
 * when the titlebar had to ask whether a branch was derived from its thread's
 * title: two spellings of one grammar would drift, and the drift would be
 * invisible (allowed-pattern #14). Every existing importer keeps its import.
 */
export { THREAD_BRANCH_PREFIX } from '../../shared/thread-branch'
export { threadBranchName }

/** The branch uncommitted work is parked on, stamped so two threads on one day
 *  never collide. */
export function wipBranchName(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  return `${WIP_BRANCH_PREFIX}${stamp}`
}

/**
 * What the thread is told when it could not have a checkout of its own.
 *
 * NOT the CLI's line. That line is written for a terminal — it names the
 * directory and sometimes the command that would fix it, and a GUI must not
 * hand either to a reader (forbidden-pattern #12). The substance survives; the
 * spelling is the app's. Every variant ends with the same fact, because that
 * fact is the only one with a consequence: this thread writes to the project's
 * own files, exactly as every thread did before.
 */
/**
 * Whether a refusal is a fact about the PROJECT rather than about one thread.
 *
 * Only these are cached per project (see `#refuse`). A repository with no git
 * and one with no commits can give no thread a worktree, so asking again for
 * each message of each thread is a CLI spawn that cannot succeed. Everything
 * else — a branch taken, a checkout that could not be read back, a path left
 * behind by something else — is about the one cut that failed, and must not
 * answer for the threads beside it.
 *
 * Exported for the test that holds that distinction; the note function below
 * reads the same reasons for its own purpose.
 */
/**
 * Whether a recorded checkout is still there.
 *
 * The `.git` FILE, not the directory. A worktree's directory can be recreated
 * by anything that writes into it — an agent whose cwd was fixed at spawn does
 * exactly that the moment the directory is removed underneath it — while `.git`
 * is written once, by the cut. Testing the directory would say "present" for
 * precisely the empty shell this is here to detect.
 */
export function checkoutIsPresent(path: string): boolean {
  return existsSync(join(path, '.git'))
}

export function isProjectWideRefusal(reason: string): boolean {
  const lower = reason.toLowerCase()
  return (
    lower.includes('not a git repository') ||
    lower.includes('not a repository') ||
    lower.includes('no commits') ||
    lower.includes('unborn')
  )
}

/**
 * What a thread is told when its dependencies changed in a language Flow may
 * not install for.
 *
 * NAMES THE FILES, NOT A COMMAND (forbidden-pattern #12). Which files changed
 * is the fact a person needs to act; which installer to run is theirs to know,
 * and a guess here would be Flow running another ecosystem's toolchain on a
 * hunch — the exact thing `promoteDependencies` refuses to do.
 */
export function dependencyNote(manifests: readonly string[] | undefined): string {
  const named = (manifests ?? []).filter((file) => typeof file === 'string' && file !== '')
  const which = named.length === 0 ? 'This thread’s dependencies' : named.join(', ')
  return `${which} changed in this thread’s own files. Flow only installs JavaScript packages on its own, so this project’s dependencies here are yours to bring up to date.`
}

/**
 * What a thread is told when its worktree setup did not finish.
 *
 * TWO SENTENCES AND NO TRANSCRIPT. A setup command prints megabytes on failure
 * and none of it belongs in a chat thread; what a person can act on is which
 * kind of not-finishing happened and whether their message was affected. The
 * command itself is deliberately absent — they wrote it, and quoting their own
 * configuration back at them says nothing (forbidden-pattern #12).
 */
export function setupFailureNote(result: RunResult): string {
  const timedOut = (result.error ?? '').toLowerCase().includes('timed out')
  const cause = timedOut
    ? 'took longer than this project allows'
    : 'didn’t finish'
  return `Preparing this thread’s files ${cause}. They are ready to work in either way, so anything the setup would have installed may be missing.`
}

/**
 * Does this thread get a worktree WITHOUT anybody asking for one?
 *
 * ONLY WHEN NOBODY IS WATCHING. Flow cut a checkout for every thread's first
 * message, which no other agentic IDE does: Zed, Devin and Codex never create
 * one unasked, and Cursor creates automatically only in its Agents Window,
 * where an agent works alone. Reported here as "the management is really poor …
 * it is really hard to follow what is happening" — a second copy of the project
 * per conversation, chosen by nobody and visible as a badge.
 *
 * `originLoop` is the whole test, and it already existed: null for a person, the
 * loop's name for a run that picked its own work up. "Is anybody watching?" was
 * recorded all along; this is the first thing to ask it.
 *
 * AUTOMATIC IS NOT THE ONLY WAY IN — it is the way that happens TO you. A
 * person's thread runs in the project until somebody says otherwise, and both
 * the row menu and the checkout bar say otherwise through `prepare`, which this
 * does not touch.
 *
 * Pure and exported so the gate, the tests and the settings help read one rule
 * rather than three (allowed-pattern #14).
 */
/**
 * What happened for ONE of a thread's attached projects.
 *
 * Per project, because the answer differs per project: one repository can be
 * isolated while the one beside it cannot, and a single verdict for the whole
 * thread would have to round that to a lie in one direction or the other.
 */
export interface AttachedWorktreeResult {
  rootPath: string
  status: 'created' | 'ready' | 'disabled' | 'failed'
  branch?: string | null
  /** One sentence, when there is one to give. */
  detail?: string
}

export function automaticWorktree(thread: { originLoop?: string | null }): boolean {
  const loop = thread.originLoop ?? null
  return typeof loop === 'string' && loop.trim() !== ''
}

/**
 * What to say when a conversation's OTHER projects could not be given copies.
 *
 * Names the projects by the folder a person recognises and says what is true of
 * them now. No path, no command, no setting key (forbidden-pattern #12) — the
 * panel beside it carries the action.
 */
export function attachedFailureNote(
  stuck: readonly { rootPath: string; status: string }[],
): string {
  const names = stuck.map((entry) => entry.rootPath.split('/').filter(Boolean).pop() ?? entry.rootPath)
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
  const subject = names.length === 1 ? 'it is' : 'they are'
  return `Flow couldn’t give ${list} a copy of its own, so ${subject} still the folder you have open.`
}

export function worktreeUnavailableNote(reason: string): string {
  const lower = reason.toLowerCase()
  const consequence =
    'It will work directly in the project’s files, the way every thread did before.'
  if (lower.includes('not a git repository') || lower.includes('not a repository')) {
    return `This project isn’t tracked by git, so this thread can’t have a branch of its own. ${consequence}`
  }
  if (lower.includes('already open in another checkout')) {
    return `That branch is open somewhere else now, so this thread can’t work on it. Try again and it will offer to start a new branch from the same place instead. ${consequence}`
  }
  if (lower.includes('no commits') || lower.includes('unborn') || lower.includes('head')) {
    return `This project has no commits yet, so there’s nothing for this thread’s branch to start from. ${consequence}`
  }
  return `Flow couldn’t give this thread a branch of its own. ${consequence}`
}

/**
 * What the thread is told when its worktree was cut without a fresh base.
 *
 * SAID, NOT HIDDEN, and said as a fact rather than an apology: the worktree
 * exists, the work in it is fine, and the one thing worth knowing is that its
 * starting point might not be the latest. A stale cut that says nothing becomes
 * a merge conflict nobody saw coming, days later, with no explanation attached.
 *
 * NOTHING TO DO ABOUT IT IS OFFERED HERE, because there is nothing a person
 * types (forbidden-pattern #12) — bringing the copy up to date is a landing's
 * business, and this sentence exists to make the surprise not a surprise.
 */
export function staleBaseNote(base: string | null): string {
  const from =
    base === null || base === '' ? 'the branch it was cut from' : `${quoted(base)} as it was here`
  return `This thread’s branch started from ${from}, which may be behind the shared copy — Flow couldn’t check before it began.`
}

/**
 * The refusal reason inside a CLI transcript, or null when there is none.
 *
 * Reads stdout AND stderr: this repo's logger routes `error()` through
 * `console.log` (allowed-pattern #15), so a refusal arrives on stdout as often
 * as not, and a reader of one stream alone misses it silently.
 */
export function refusalReason(result: RunResult): string | null {
  const transcript = `${result.stdout ?? ''}\n${result.stderr ?? ''}\n${result.error ?? ''}`
  for (const line of transcript.split('\n')) {
    const index = line.indexOf(REFUSAL_PREFIX)
    if (index !== -1) {
      const reason = line.slice(index + REFUSAL_PREFIX.length).trim()
      if (reason !== '') return reason
    }
  }
  return null
}

/** The `worktree create` result object, as far as this module reads it. */
interface CreateResult {
  path?: unknown
  branch?: unknown
  /** The branch the work belongs on — what a landing merges to. */
  base?: unknown
  /** True when the worktree IS on `base`, so nothing has to be merged back. */
  onBase?: unknown
  /** True only for a checkout THIS call made. */
  created?: unknown
  /**
   * The untracked entries the cut carried across, and what became of each.
   *
   * READ RATHER THAN ASSUMED: the default set is three entries, but a project
   * can configure more, and a notice about what a copy LACKS must be based on
   * what this cut actually did.
   */
  links?: unknown
}

/** The `worktree name` result object. */
interface NameResult {
  branch?: unknown
  status?: unknown
}

/** Last JSON object on a transcript, or null. The CLI writes exactly one line
 *  of JSON for `--json`; anything else on the stream is somebody's warning. */
function parseResultJson<T>(stdout: string): T | null {
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
 * Where a worktree begins when the caller did not say.
 *
 * THE CALLER STILL WINS. A start named by a person — the thread menu's picker,
 * a re-target — is a decision about THIS worktree and nothing configured may
 * override it; the setting answers only the callers that never had a screen to
 * ask on (the send path, `ensureBeforeSession`). That is the difference between
 * a default and a bypass, and it is the whole contract of this setting.
 *
 * The built-in behind it is `here` — the branch the project is already on — so
 * a project that has configured nothing gets exactly what it got yesterday.
 */
export function startFor(
  options: Pick<PrepareOptions, 'start'>,
  settings: ResolvedWorktreeSettings,
): WorktreeStart {
  return options.start ?? settings.worktreeStart.value
}

/**
 * The worktree-start choice, as the CLI's own argument list.
 *
 * `--detach` TRAVELS WITH THE CHOICE rather than being a constant, because one
 * choice genuinely does not want it: a worktree that TAKES an existing branch
 * has that branch's name from the moment it exists, and there is nothing to
 * wait for a title to name.
 */
export function startArgs(start: WorktreeStart): string[] {
  if (start.kind === 'checkout') return ['--checkout', start.branch]
  if (start.kind === 'branch') return ['--detach', '--base', start.branch]
  if (start.kind === 'trunk') return ['--detach', '--trunk']
  return ['--detach']
}

/**
 * The folder's name as the CLI's own argument, or nothing at all.
 *
 * NOTHING IS THE OLD BEHAVIOUR, exactly: the CLI falls back to the thread's
 * slug, which is where every checkout cut before this lives. A name is only
 * ever added, never substituted, so no existing checkout moves because this
 * shipped.
 */
/**
 * The entry names a cut actually carried, from the CLI's own report.
 *
 * `missing` IS NOT CARRIED. The CLI reports every entry it was asked about,
 * including the ones the project does not have — counting those would say a
 * copy has `node_modules` because somebody configured it, on a project that has
 * none.
 */
export function carriedEntries(links: unknown): string[] {
  if (!Array.isArray(links)) return []
  return links
    .filter(
      (link): link is { entry: string; status?: string } =>
        typeof link === 'object' &&
        link !== null &&
        typeof (link as { entry?: unknown }).entry === 'string',
    )
    .filter((link) => link.status !== 'missing')
    .map((link) => link.entry)
}

export function worktreeNameArgs(name: string | undefined): string[] {
  const value = name?.trim() ?? ''
  return value === '' ? [] : ['--worktree-name', value]
}

/**
 * The folder of a thread's EXISTING checkout, for a `--thread` verb to find it
 * by (the CLI's one resolver). Omitted when there is no path, or when the folder
 * is the thread id itself — a checkout cut before folders had names, which the
 * id alone already finds.
 */
export function checkoutNameArgs(threadId: string, worktreePath: string | null): string[] {
  const name = checkoutName(worktreePath)
  return name === null || name === threadId ? [] : worktreeNameArgs(name)
}

/** Count of changed files in `git status --porcelain` output. */
export function countChangedFiles(porcelain: string): number {
  return porcelain.split('\n').filter((line) => line.trim() !== '').length
}

// ── The service ────────────────────────────────────────────────────────────

/**
 * Creates, names and explains a thread's checkout. One instance per app,
 * constructed in main and handed to the send path, the IPC layer, and nothing
 * else.
 */
export class ThreadWorktreeService {
  /**
   * Projects that refused during this app run, so the send path does not spawn
   * a CLI (and write a second identical note) on every message of a thread in a
   * repository that cannot have worktrees at all. A person asking for one by
   * name always retries — they may have just run `git init`.
   */
  readonly #refusedRoots = new Set<string>()

  /**
   * Preparations in flight, by thread. Two callers can legitimately arrive at
   * once — the composer settles the worktree before its send, and the send
   * path settles it again for every caller that never went through a composer
   * — and a check-then-act gap between them would spawn two CLIs and write the
   * column twice. Same shape as AgentManager's session-creation reservation.
   *
   * The first caller's options win, which is right for the only overlap that
   * can actually happen: both of those callers want the same thing done once.
   */
  readonly #inFlight = new Map<string, Promise<PrepareResult>>()

  /**
   * Dependency promotions in flight, by thread.
   *
   * A promotion is started when a turn ENDS and must be finished before the
   * next one begins — the rule `promoteDependencies` states about itself and
   * the reason it refuses to run mid-turn. Holding the promise is what turns
   * that from a hope into a guarantee: `settleDependencies` below is awaited on
   * the send path, so a person who answers within the install window waits for
   * it rather than starting a turn in a half-installed tree.
   */
  readonly #promoting = new Map<string, Promise<void>>()

  constructor(private readonly deps: ThreadWorktreeDeps) {}

  /**
   * A turn just ended: give this thread's worktree its own dependencies if its
   * manifests have stopped matching the main checkout's.
   *
   * THE CALLER `promoteDependencies` NEVER HAD. That function has been
   * implemented, registered as a CLI verb, and named in the comment that
   * justifies symlinking `node_modules` — "its one real hazard … is what
   * `promoteDependencies` below exists to close" — while nothing in the app
   * ever called it. The hazard was closed on paper: an `npm install` run by an
   * agent inside its worktree installed into the USER'S checkout, changing the
   * dependencies of work the thread was never allowed to touch.
   *
   * AFTER A TURN, NEVER DURING. That is the function's own rule, and it is why
   * this hangs off turn completion rather than off the write that changed the
   * manifest. It does nothing at all unless a dependency manifest actually
   * changed, which is the common case and costs one `git status`.
   *
   * Fire-and-forget for the caller, awaited by the next turn: see `#promoting`.
   */
  promoteAfterTurn(threadId: string): void {
    if (this.#promoting.has(threadId)) return
    const run = this.#promote(threadId).finally(() => {
      this.#promoting.delete(threadId)
    })
    this.#promoting.set(threadId, run)
  }

  /**
   * Wait for any promotion this thread owes. Resolves immediately when none is
   * in flight, which is every turn but the one after a lockfile changed.
   */
  async settleDependencies(threadId: string): Promise<void> {
    await this.#promoting.get(threadId)
  }

  async #promote(threadId: string): Promise<void> {
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null || thread.worktreePath === null) return
    try {
      const result = await this.deps.runCli(thread.projectRoot, [
        'worktree',
        'promote',
        '--thread',
        thread.id,
        // THE FOLDER, SO THE VERB FINDS A NAMED CHECKOUT (the CLI's one resolver).
        ...checkoutNameArgs(thread.id, thread.worktreePath),
        '--json',
        '--target',
        thread.projectRoot,
      ])
      if (!result.ok) {
        // A promotion that fails costs a slower next turn, never the turn
        // itself. The worktree is exactly as usable as it was a moment ago.
        console.warn('[ThreadWorktree] could not promote dependencies', { threadId })
        return
      }
      const promoted = parseResultJson<{ status?: string; manifests?: string[] }>(result.stdout)
      if (promoted?.status !== 'manual') return
      // ANOTHER ECOSYSTEM'S MANIFEST — a Python, Ruby, Go or Rust file changed,
      // and this may not presume to run that toolchain's installer. Said out
      // loud rather than swallowed: the thread's dependencies are now out of
      // date in a way only the person can fix, and silence would let the next
      // turn fail for a reason nothing on screen explains.
      this.deps.threadStore.appendMessage(thread.id, 'system', dependencyNote(promoted.manifests))
    } catch (error) {
      console.warn('[ThreadWorktree] could not promote dependencies', { threadId, error })
    }
  }

  /**
   * Called by `AgentManager.sendMessage` immediately before the session spawns
   * — the ONE automatic creation point in the app, and now the one gate on it.
   *
   * Never throws and never asks: a message must not be lost to a failure in
   * this, and `sendMessage` has no screen to put a question on. A thread that
   * already owns a checkout, a project that turned the feature off, and a
   * repository that cannot have one all resolve to "carry on exactly as
   * before".
   */
  async ensureBeforeSession(threadId: string, context: { firstTurn: boolean }): Promise<void> {
    try {
      // THE GATE, asked here and nowhere else. A thread nobody is watching gets
      // its own copy; a conversation runs in the project until somebody asks.
      const thread = this.deps.threadStore.getThread(threadId)
      if (thread === null) return
      if (automaticWorktree(thread)) {
        await this.prepare(threadId, { ask: false })
        return
      }
      // HOW STALE IS THE FOLDER WE ARE ABOUT TO WORK IN? Asked only as a
      // conversation BEGINS, and never awaited: it needs a fetch, and a turn
      // that waits on the network to print a line nobody asked for is a turn
      // that starts late for no gain. The notice lands above the work when the
      // answer arrives, which is where the feed puts it anyway.
      if (context.firstTurn) {
        void this.#noteFolderBehind(threadId).catch((error: unknown) =>
          console.warn('[ThreadWorktree] could not compare the project folder', { threadId, error }),
        )
      }
      // A PERSON'S THREAD THAT ALREADY HAS A COPY: nothing is cut for ITS
      // project, but every project attached since must be isolated too.
      // Returning here left a project attached after the cut — a chip, the
      // context gate on the first send, an accepted offer — with no checkout,
      // so the session was handed that project's MAIN tree beside its own
      // isolated one (tasklist bug, 2026-10-05). `prepareAttached` is the one
      // code path `prepare` uses for the same promise; a project that already
      // has a checkout is a store read and nothing else. A thread with no copy
      // has nothing to match, and its attached projects stay in their trees.
      if (thread.worktreePath !== null) await this.prepareAttached(threadId)
    } catch (error) {
      // The turn is worth more than the worktree. Say it once in the log; the
      // thread runs in the project's tree, which is where it ran yesterday.
      console.warn('[ThreadWorktree] could not prepare a worktree', { threadId, error })
    }
  }

  /**
   * Resolve a thread's worktree: report one it already has, ask about
   * uncommitted work when asked to, or create one.
   */
  async prepare(threadId: string, options: PrepareOptions = {}): Promise<PrepareResult> {
    // Reserve the thread's slot SYNCHRONOUSLY, before any await.
    const running = this.#inFlight.get(threadId)
    if (running !== undefined) return running
    const attempt = this.#prepare(threadId, options)
    this.#inFlight.set(threadId, attempt)
    try {
      return await attempt
    } finally {
      this.#inFlight.delete(threadId)
    }
  }

  async #prepare(threadId: string, options: PrepareOptions): Promise<PrepareResult> {
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null) return { status: 'unavailable' }

    // THE ANSWER "NO CHECKOUT", SAID OUT LOUD.
    //
    // A conversation that works in the project's folder used to be expressed by
    // never calling this service, so it had no answer here at all. Now it has
    // one, and the two halves of the old single question can disagree: a branch
    // may be named for a thread that has no checkout.
    //
    // WHICH THIS REFUSES, deliberately and by name. Honouring it means checking
    // that branch out in the project's one folder, moving files nobody in this
    // call asked to move; the surfaces do not offer it (user, 2026-09-17), and
    // a contract that accepts a combination its only implementation would have
    // to guess at is worse than one that says no (allowed-pattern #21).
    if (options.worktree === 'project') {
      if (options.branch !== undefined) {
        return {
          status: 'refused',
          detail:
            'A conversation working in your project folder uses the branch that folder is on. Give it a copy of its own to put the work on another branch.',
        }
      }
      return { status: 'in-project' }
    }
    if (thread.worktreePath !== null) {
      // RECORDED IS NOT THE SAME AS PRESENT. This answered `ready` from the
      // database alone, so a checkout that had been removed underneath it —
      // by the disk cap, by `git worktree remove`, by a person with a
      // Finder window — kept every future session pointed at a path that was
      // not a worktree. The session then recreated it as an empty directory,
      // which `git worktree add` refuses forever (2026-09-08).
      //
      // One `stat` of the checkout's `.git`, on a path that is about to be
      // used as a process's cwd. Present and plausible → ready, exactly as
      // before. Gone → forget it and cut again, which is what the thread
      // wanted in the first place.
      const present = this.deps.checkoutPresent ?? checkoutIsPresent
      if (present(thread.worktreePath)) {
        // READY MEANS READY FOR EVERY PROJECT THE THREAD CARRIES.
        //
        // This returned here, and only the CUT below prepared the attached
        // projects — so isolation covered whatever set of projects the thread
        // happened to have at the moment it was first isolated. Add a second
        // project afterwards and it silently stayed in the real checkout: the
        // panel reported `orbit-core — in your files` under a switch reading
        // On (user, 2026-09-17: "if the worktree is enabled, is enabled for all
        // the projects on that thread"). Backfilling here makes that sentence
        // true in ONE code path (allowed-pattern #14) rather than in a repair
        // button somebody has to find. Projects that already have one are
        // skipped, so the common case is a store read and nothing else.
        // AND WHAT BECAME OF THEM IS REPORTED, not dropped.
        //
        // This awaited the backfill and threw the array away, so a conversation
        // whose second project could not be isolated was told `ready` with
        // nothing to say — a refused step reported as a finished one
        // (forbidden-pattern #20). The panel then repainted identically and the
        // person saw a press that did nothing.
        const attached = await this.prepareAttached(thread.id)
        const stuck = attached.filter((entry) => entry.status === 'failed' || entry.status === 'disabled')
        if (stuck.length === 0) return { status: 'ready' }
        return { status: 'ready', detail: attachedFailureNote(stuck) }
      }
      // FALL THROUGH TO THE CUT, and do NOT clear the record on the way. The
      // null branch of `setThreadWorktree` also wipes the thread's remote
      // binding, and `prBase` lives nowhere else — that is a person's answer to
      // "where does this publish to", and a directory going missing is no
      // reason to forget it. `#create` re-cuts at the same conventional path
      // and records it with a non-null write, which leaves the binding alone.
    }

    const root = thread.projectRoot
    if (options.requested !== true && this.#refusedRoots.has(root)) {
      return { status: 'refused' }
    }
    if (!(await this.deps.isEnabled(root))) return { status: 'disabled' }

    // ONCE PER PREPARE, and read from here down. Every question below — where
    // this worktree begins, whether its base is refreshed first, how long that
    // may take, which remote it looks at — is answered by the same resolution,
    // so a settings file edited mid-cut cannot make one step disagree with the
    // next. It is a file read, not a git call, and it happens after the two
    // checks that can end this without cutting anything.
    const settings = await this.#settings(root)

    // A live turn's session is already bound to the project's tree and cannot
    // be moved (Phase 4: the root is fixed at spawn). Saying "done" here would
    // be a lie for the rest of that turn, so say what is actually true.
    if (options.requested === true && isBusy(thread.status)) {
      return {
        status: 'busy',
        detail:
          'This thread is working right now. Give it a branch of its own once the current turn has finished.',
      }
    }

    // THE OFFER IS THE START QUESTION, WHICHEVER WAY IT IS ANSWERED.
    //
    // This was gated on the start being `here`, on the reasoning that "bring my
    // changes" parks the work on a branch cut from where the project stands and
    // a worktree starting elsewhere could not also start from that. Both
    // halves are true; the conclusion was not. `#carry` parks the work as a
    // BRANCH and the worktree simply starts from it, so the answer supplies
    // its own starting point: "bring them" starts from the parked branch,
    // "start fresh" starts from wherever the caller or the project said.
    //
    // The gate mattered when nothing moved the default off `here`. The default
    // is now the project's BASE branch (2026-09-17: "new thread should always
    // start from main"), which would have retired this question everywhere
    // without anybody deciding to — the one option a person just asked for
    // ("bring my changes or not") reachable only by changing a setting.
    // ONE START STILL CANNOT ANSWER IT: a worktree that TAKES an existing
    // branch is already on a branch somebody else named, and it cannot also
    // start from the parked one. There the question has no honest "bring them",
    // so it is not asked and nothing of the person's moves — which is `clean`,
    // the answer that changes nothing (forbidden-pattern #15).
    const takesABranch = startFor(options, settings).kind === 'checkout'
    if (options.ask === true && options.carry === undefined && !takesABranch) {
      const changedFiles = await this.#countProjectChanges(root)
      if (changedFiles > 0) {
        return {
          status: 'needs-choice',
          changedFiles,
          baseBranch: await this.#currentBranch(root),
        }
      }
    }

    return this.#create(thread, options, settings)
  }

  /**
   * The settings in effect for a project, or the built-ins when nobody wired a
   * reader in.
   *
   * THE FALLBACK IS THE RESOLVER, not a literal. Assembling a "defaults" object
   * here would be a second copy of the built-in table, and the day one of them
   * changed would be the day a test and the app quietly disagreed about what an
   * unconfigured project does.
   */
  async #settings(rootPath: string): Promise<ResolvedWorktreeSettings> {
    const read = await this.deps.settingsFor?.(rootPath)
    return (read ?? resolveWorktreeSettings({ projectRaw: {}, globalDefaults: {} })).settings
  }

  /**
   * Give a detached checkout the branch its title earned — called once the
   * title lands, never before.
   *
   * A branch named at the first message would be named after nothing: the title
   * is generated from the first turn, and only when that turn SUCCEEDS. Silent
   * about everything it cannot do (no checkout, no title, already named), which
   * is why it is safe to call after every turn.
   */
  async nameAfterTitle(threadId: string): Promise<void> {
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null || thread.worktreePath === null) return
    if (thread.worktreeBranch !== null) return
    const branch = threadBranchName(thread.title)
    if (branch === null) return

    const result = await this.deps.runCli(thread.projectRoot, [
      'worktree',
      'name',
      '--thread',
      thread.id,
      // THE FOLDER, SO THE VERB CAN FIND IT. The CLI works out which thread a
      // checkout belongs to from its DIRECTORY NAME, so a named folder is
      // invisible to a lookup by thread id — the same conflation the name
      // exists to end, one level down.
      ...worktreeNameArgs(checkoutName(thread.worktreePath) ?? undefined),
      '--branch',
      branch,
      '--json',
      '--target',
      thread.projectRoot,
    ])
    if (!result.ok) {
      // A checkout with no branch still holds every commit. Nothing is lost by
      // staying detached, and the next successful turn tries again.
      console.warn('[ThreadWorktree] could not name the checkout', {
        threadId,
        reason: refusalReason(result),
      })
      return
    }
    const named = parseResultJson<NameResult>(result.stdout)
    // THE BRANCH THE CLI RETURNED, never the one asked for: naming dedupes to
    // `-2`/`-3`, and persisting the request would record a branch that is not
    // the one on disk.
    if (named === null || typeof named.branch !== 'string' || named.branch === '') return
    const current = this.deps.threadStore.getThread(threadId)
    if (current === null || current.worktreePath === null) return
    this.deps.threadStore.setThreadWorktree(threadId, {
      path: current.worktreePath,
      branch: named.branch,
      base: current.worktreeBase,
    })
  }

  /**
   * The branch the checkout is ACTUALLY on, with the record corrected when the
   * two disagree. Resolves with that branch, or null for a thread with no
   * checkout (and for a detached one, which has no branch to be).
   *
   * GIT WINS (allowed-pattern #23: a mirror whose docs do not name a winner
   * becomes two sources of truth on the first drift). `worktreeBranch` is
   * written at the cut and at a rename, and nothing was watching for the
   * branch moving any other way — someone switching the checkout by hand, a
   * rebase, a `git switch` from a terminal in that tree. Found live: a thread
   * whose record read `thread/mapping-orbit-core-data-architecture` while its
   * checkout had been re-pointed to `feat/data-contract-guard`, so the landing
   * surface named one branch and the panel beside it named another.
   *
   * Cheap and safe to call on the paths that were going to read that checkout
   * anyway: ONE `git branch --show-current`, and a store write only when the
   * answer is new. It moves nothing in git.
   */
  async reconcileBranch(threadId: string): Promise<string | null> {
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null || thread.worktreePath === null) return null
    const read = await this.deps.runGit(thread.worktreePath, ['branch', '--show-current'])
    if (!read.ok) return thread.worktreeBranch // unreadable — keep what we had
    const actual = read.stdout.trim()
    // A DETACHED CHECKOUT READS AS EMPTY, and empty is a real answer here: the
    // worktree runs detached until its first reply names it. Recording null is
    // the truth; recording the old name would be the drift this exists to end.
    const branch = actual === '' ? null : actual
    if (branch === thread.worktreeBranch) return branch
    this.deps.threadStore.setThreadWorktree(threadId, {
      path: thread.worktreePath,
      branch,
      base: thread.worktreeBase,
    })
    return branch
  }

  // ── Renaming what it works on ────────────────────────────────────────────

  /**
   * Give a thread's worktree a different branch name.
   *
   * WHICH OF THE TWO THINGS "RENAME" MEANT. A thread worktree has a DIRECTORY
   * (named after the thread id) and a BRANCH (`thread/<title>`). The directory
   * is not on screen anywhere — the Source Control header that used to print it
   * was the UUID bug, and it prints the repository's name now — so renaming it
   * would be work nobody could see, at the cost of a `git worktree move`, a
   * stale path in every running terminal and session, and a record to migrate.
   * The BRANCH is what a person reads, what their work lands on, and what a
   * pull request is opened from. That is what is renamed here, and the
   * directory is deliberately left alone.
   *
   * `confirmed` HAS NO DEFAULT (forbidden-pattern #15): this moves a ref, and a
   * call with no options at all runs no git that writes.
   *
   * IT ALSO NAMES A WORKTREE THAT HAS NO NAME. A detached checkout used to be
   * refusal #2 of five — "there is nothing to rename; it gets a name when its
   * first reply lands". That is the state every thread is in between being
   * created and being answered, which is precisely when a person knows what
   * the branch should be called, so the refusal made them wait for a generated
   * name in order to correct it. Naming goes through the cut's own verb
   * (`#applyChosenName`); renaming moves the ref with `branch -m`.
   *
   * FOUR REFUSALS, AND EACH ONE IS A DIFFERENT FACT:
   *
   *  1. A turn is running. A session's checkout was bound when it spawned;
   *     moving the branch under it is not something to do while it works.
   *  2. The worktree TOOK its base branch. That branch is the person's own,
   *     not this thread's; renaming it would rename something the thread merely
   *     borrowed, and every other checkout and remote that knows it.
   *  3. The name is not one a branch can have. An emoji is not a branch name.
   *  4. Something already answers to that name. Never `-B`, never a dedupe —
   *     a rename that quietly became `-2` is a rename that did not happen.
   *
   * A branch that was PUSHED is renamed anyway and the result says so: the
   * remote still has the old name, and finding that out from a pull request
   * pointing at a ref nothing answers to is worse than being told now.
   */
  /**
   * Could a worktree in this project take this branch name? READ-ONLY.
   *
   * THE SAME TWO REFUSALS `renameBranch` GIVES, and deliberately the same
   * sentences — a name rejected here and a name rejected at the cut must not
   * explain themselves differently for the same reason (allowed-pattern #14).
   *
   * It answers a question; it does not reserve anything. A name free at this
   * call can be taken before the cut runs, which is why the cut checks too.
   */
  async branchAvailable(
    rootPath: string,
    branch: string,
  ): Promise<{ ok: boolean; detail: string | null }> {
    const wanted = branch.trim()
    if (!isValidRefName(wanted)) {
      return { ok: false, detail: `${quoted(wanted)} isn’t a name a branch can have.` }
    }
    const taken = await this.deps.runGit(rootPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${wanted}`,
    ])
    if (taken.ok && taken.stdout.trim() !== '') {
      return { ok: false, detail: 'Something already works under that name. Pick another one.' }
    }
    return { ok: true, detail: null }
  }

  async renameBranch(
    threadId: string,
    name: string,
    options: { confirmed?: boolean } = {},
  ): Promise<ThreadWorktreeRenameResult> {
    if (options.confirmed !== true) {
      return { status: 'refused', detail: 'Renaming this thread’s branch needs someone to ask for it.' }
    }
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null || thread.worktreePath === null) {
      return { status: 'refused', detail: 'This thread has no branch of its own.' }
    }
    if (isBusy(thread.status)) {
      return {
        status: 'refused',
        detail:
          'This thread is working right now. Rename its branch once the current turn has finished.',
      }
    }
    const current = thread.worktreeBranch
    if (current !== null && current === thread.worktreeBase) {
      return {
        status: 'refused',
        detail: `This thread works on ${quoted(current)} itself rather than on a branch of its own, so that name isn’t this thread’s to change.`,
      }
    }
    // A TYPED NAME IS VALIDATED, NEVER REPAIRED (allowed-pattern #22).
    //
    // This used to run the typed value through `threadBranchName`, which
    // SANITIZES: it forced the `thread/` prefix and slugged everything else, so
    // `feature/PF-42-fix-parser` was silently stored as
    // `thread/feature-pf-42-fix-parser`. A person was told one name and given
    // another — and a ticket-shaped name, which is the reason anybody types one
    // by hand, could not be expressed at all.
    //
    // `threadBranchName` still names the branch a thread earns from its own
    // title (see `nameAfterTitle`), which is a value this app derived and is
    // entitled to shape.
    const wanted = name.trim()
    if (!isValidRefName(wanted)) {
      return {
        status: 'refused',
        detail: `${quoted(wanted)} isn’t a name a branch can have.`,
      }
    }
    if (current !== null && wanted === current) {
      return { status: 'unchanged', branch: current, detail: 'That is already what it is called.' }
    }
    const taken = await this.deps.runGit(thread.projectRoot, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${wanted}`,
    ])
    if (taken.ok && taken.stdout.trim() !== '') {
      return {
        status: 'refused',
        detail: 'Something already works under that name. Pick another one.',
      }
    }
    // A WORKTREE WITH NO NAME IS NAMED, NOT REFUSED.
    //
    // This used to answer "there is no name to change — it gets one when its
    // first reply lands", which is true and useless: the state it describes is
    // every thread between being created and being answered, and that is
    // exactly when a person knows what the branch should be called. Waiting for
    // the model to invent a name so it can be corrected is the long way round.
    //
    // Through `#applyChosenName` — the same CLI verb the cut uses when someone
    // types a branch in the Create-thread dialog (allowed-pattern #14), so a
    // name given here and a name given there are applied identically.
    if (current === null || current === '') {
      const named = await this.#applyChosenName(thread, thread.worktreePath, wanted, null)
      if (named === null) {
        return {
          status: 'failed',
          detail: 'Flow couldn’t give this branch that name. It is exactly where it was.',
        }
      }
      this.deps.threadStore.setThreadWorktree(threadId, {
        path: thread.worktreePath,
        branch: named,
        base: thread.worktreeBase,
      })
      return {
        status: 'renamed',
        branch: named,
        // Never "renamed from" anything — it had no name to be renamed from,
        // and a sentence implying otherwise would describe work that moved.
        detail: `This thread’s work is on ${quoted(named)} now.`,
      }
    }
    // Asked BEFORE the move, while the old name still resolves.
    const upstream = await this.deps.runGit(thread.worktreePath, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      `${current}@{upstream}`,
    ])
    const staleOnRemote = upstream.ok && upstream.stdout.trim() !== ''

    const moved = await this.deps.runGit(thread.worktreePath, ['branch', '-m', current, wanted])
    if (!moved.ok) {
      return {
        status: 'failed',
        detail: 'Flow couldn’t rename this thread’s branch. It is exactly where it was.',
      }
    }
    // `setThreadWorktree` is the only writer of the three columns, and the two
    // it is not asked to change are passed back exactly as they were.
    this.deps.threadStore.setThreadWorktree(threadId, {
      path: thread.worktreePath,
      branch: wanted,
      base: thread.worktreeBase,
    })
    return {
      status: 'renamed',
      branch: wanted,
      detail: staleOnRemote
        ? `This thread’s work is on ${quoted(wanted)} now. It had already been shared under its old name, and that copy keeps it.`
        : `This thread’s work is on ${quoted(wanted)} now.`,
      ...(staleOnRemote ? { staleOnRemote: true } : {}),
    }
  }

  // ── Choosing where it starts ─────────────────────────────────────────────

  /**
   * GIVE THIS CONVERSATION'S OTHER PROJECTS CHECKOUTS TOO.
   *
   * A thread can carry several projects, and until now only the one it started
   * in got a checkout — so the conversation was isolated in one repository and
   * writing straight into the others, with nothing on screen saying so: the
   * file tree showed `orbit-app (thread/…)` above a plain `orbit-core`
   * (user, 2026-09-17). Partial isolation is worse than none, because it is the
   * kind a person trusts.
   *
   * KEEP WHAT WORKED, SAY WHAT DID NOT. A project that is not a repository, or
   * whose cut fails, is reported and skipped — the others are still isolated.
   * Rolling the successful ones back would let one unrelated repository stop a
   * conversation from being isolated at all, and asking first would put a dialog
   * in front of what is meant to be one press.
   *
   * THE SAME THREAD ID IN EACH PROJECT. The CLI keys a checkout by thread, so
   * running `create` inside another project's root gives that project its own
   * checkout for this same conversation — one identity, several trees, and every
   * one of them discoverable by the listing that already exists.
   */
  async prepareAttached(threadId: string): Promise<AttachedWorktreeResult[]> {
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null) return []
    const roots = this.deps.threadStore
      .getThreadRoots(threadId)
      // The project the thread started in already has one, on `threads`.
      .filter((root) => root !== thread.projectRoot)
    const already = new Set(
      this.deps.threadStore.getThreadRootWorktrees(threadId).map((entry) => entry.rootPath),
    )

    const results: AttachedWorktreeResult[] = []
    for (const root of roots) {
      if (already.has(root)) {
        results.push({ rootPath: root, status: 'ready' })
        continue
      }
      try {
        // THE CONVERSATION'S OWN NAMES, read off the primary checkout it
        // already has: the branch from the thread record, the folder's name
        // from the path that record holds (its last segment IS the name —
        // storing it twice would be a second source of truth,
        // allowed-pattern #23).
        const made = await this.#cutAttached(thread.id, root, {
          branch: thread.worktreeBranch ?? null,
          ...(checkoutName(thread.worktreePath) === null
            ? {}
            : { worktreeName: checkoutName(thread.worktreePath) as string }),
        })
        results.push(made)
      } catch (error) {
        console.warn('[ThreadWorktree] could not prepare an attached worktree', { root, error })
        results.push({ rootPath: root, status: 'failed' })
      }
    }
    return results
  }

  /** One attached project's checkout, cut and recorded. */
  async #cutAttached(
    threadId: string,
    root: string,
    naming: { branch?: string | null; worktreeName?: string } = {},
  ): Promise<AttachedWorktreeResult> {
    if (!(await this.deps.isEnabled(root))) return { rootPath: root, status: 'disabled' }
    // ONE CONVERSATION, ONE NAME, ACROSS EVERY PROJECT IT CARRIES.
    //
    // This passed neither name, so the CLI fell back to the thread's id and the
    // attached checkout landed on `worktree/<uuid>` — which is what a person
    // saw in Source Control under their second repository while the first one
    // read `feat/data-contract-guard` (user, 2026-09-17). The primary's names
    // are the conversation's names; an attached checkout takes them.
    //
    // A DETACHED PRIMARY MEANS DETACHED ATTACHMENTS: passing no branch is how
    // the CLI is told to cut detached, and the two must not disagree about
    // whether this conversation has a branch at all.
    const wanted = naming.branch?.trim() ?? ''
    const result = await this.deps.runCli(root, [
      'worktree',
      'create',
      '--thread',
      threadId,
      ...worktreeNameArgs(naming.worktreeName),
      ...(wanted === '' ? ['--detach'] : ['--branch', wanted]),
      '--no-fetch',
      '--json',
      '--target',
      root,
    ])
    if (!result.ok) {
      return {
        rootPath: root,
        status: 'failed',
        detail: refusalReason(result) ?? result.error ?? undefined,
      }
    }
    const created = parseResultJson<CreateResult>(result.stdout)
    if (created === null || typeof created.path !== 'string' || created.path === '') {
      return { rootPath: root, status: 'failed' }
    }
    const branch =
      typeof created.branch === 'string' && created.branch !== '' ? created.branch : null
    this.deps.threadStore.setThreadRootWorktree(threadId, root, {
      path: created.path,
      branch,
      base: typeof created.base === 'string' && created.base !== '' ? created.base : null,
    })
    return { rootPath: root, status: 'created', branch }
  }

  /**
   * The branches a worktree could start from, for the surface that asks.
   *
   * READ-ONLY, and it never invents an answer: a project whose branches cannot
   * be read reports none rather than a list the picker would act on.
   */
  async branches(rootPath: string): Promise<WorktreeBranchChoices> {
    const result = await this.deps.runCli(rootPath, [
      'worktree',
      'branches',
      '--json',
      '--target',
      rootPath,
    ])
    if (!result.ok) return { current: null, branches: [] }
    const listed = parseResultJson<{ current?: unknown; branches?: unknown }>(result.stdout)
    if (listed === null || !Array.isArray(listed.branches)) return { current: null, branches: [] }
    return {
      current: typeof listed.current === 'string' && listed.current !== '' ? listed.current : null,
      branches: listed.branches.filter(isBranchOption),
    }
  }

  /**
   * Change where an existing worktree starts.
   *
   * NOTHING A PERSON HAS IS DISCARDED TO HONOUR A RE-PICK (forbidden-pattern
   * #15). A worktree that holds nothing — no edits, no commits of its own — is
   * simply made again from the new starting point, which is the "I picked the
   * wrong branch a moment ago" case and costs nobody anything. A worktree that
   * holds work is NEVER moved: its files and its commits stay exactly where
   * they are, and what changes is the branch its work will land on. Both
   * outcomes are said out loud, because they are genuinely different and a
   * caller that was told "done" for the second one would be misled.
   */
  async retarget(threadId: string, start: WorktreeStart): Promise<WorktreeRetargetResult> {
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null || thread.worktreePath === null) {
      return { status: 'unavailable', detail: 'This thread has no branch of its own.' }
    }
    if (isBusy(thread.status)) {
      return {
        status: 'busy',
        detail:
          'This thread is working right now. Change where its branch starts once the current turn has finished.',
      }
    }

    const settings = await this.#settings(thread.projectRoot)
    const wanted = await this.#startBranch(thread.projectRoot, start)
    if (wanted !== null && wanted === thread.worktreeBase) {
      return { status: 'unchanged', base: wanted, detail: `This thread already works from ${quoted(wanted)}.` }
    }

    if (await this.#holdsWork(thread)) {
      // The record changes; the checkout does not. `setThreadWorktree` is still
      // the only writer of the three columns, and the two it is not asked to
      // change are passed back exactly as they were.
      this.deps.threadStore.setThreadWorktree(threadId, {
        path: thread.worktreePath,
        branch: thread.worktreeBranch,
        base: wanted,
      })
      return {
        status: 'retargeted',
        base: wanted,
        detail:
          wanted === null
            ? 'This thread already has work of its own, so it stays exactly as it is. Flow no longer has a branch to put that work on.'
            : `This thread already has work of its own, so it stays exactly as it is — but it will land on ${quoted(wanted)} now.`,
      }
    }

    const released = await this.deps.runCli(thread.projectRoot, [
      'worktree',
      'prune',
      '--thread',
      thread.id,
      // Without the folder a named checkout is looked for where it is not, and
      // `absent` comes back as a success that removed nothing.
      ...checkoutNameArgs(thread.id, thread.worktreePath),
      '--json',
      '--target',
      thread.projectRoot,
    ])
    if (!released.ok) {
      return {
        status: 'failed',
        detail: 'Flow couldn’t start this thread’s branch again. It is exactly where it was.',
      }
    }
    this.deps.threadStore.setThreadWorktree(threadId, null)
    const remade = await this.#create(
      this.deps.threadStore.getThread(threadId) ?? thread,
      { requested: true, start },
      settings,
    )
    if (remade.status !== 'created') {
      return {
        status: 'failed',
        detail: 'Flow couldn’t start this thread’s branch again. Its next message will make a new one.',
      }
    }
    return {
      status: 'recut',
      base: remade.base ?? null,
      detail:
        remade.base === null || remade.base === undefined
          ? 'This thread’s branch starts again from where the project is now.'
          : `This thread’s branch starts from ${quoted(remade.base)} now.`,
    }
  }

  /** The branch a start choice would put the work on, without creating anything. */
  async #startBranch(root: string, start: WorktreeStart): Promise<string | null> {
    if (start.kind === 'branch' || start.kind === 'checkout') return start.branch
    if (start.kind === 'here') return this.#currentBranch(root)
    const listed = await this.branches(root)
    return listed.branches.find((branch) => branch.trunk)?.name ?? null
  }

  /**
   * Whether the worktree is holding anything that a re-cut would destroy —
   * uncommitted files, or commits its base does not have.
   *
   * TRUE WHEN GIT CANNOT ANSWER. An unreadable checkout is treated as holding
   * work, because the cost of being wrong runs one way only.
   */
  async #holdsWork(thread: WorktreeThread): Promise<boolean> {
    const path = thread.worktreePath
    if (path === null) return false
    const status = await this.deps.runGit(path, ['status', '--porcelain'])
    if (!status.ok) return true
    if ((await countLosableChanges(status.stdout, path, thread.projectRoot)) > 0) return true
    const base = thread.worktreeBase
    if (base === null || base === '') return false
    const ahead = await this.deps.runGit(path, ['rev-list', '--count', `${base}..HEAD`])
    if (!ahead.ok) return true
    const count = Number.parseInt(ahead.stdout.trim(), 10)
    return Number.isFinite(count) && count > 0
  }

  // ── Creation ─────────────────────────────────────────────────────────────

  /**
   * Give a brand-new checkout the name a person typed.
   *
   * NAMED, NOT BOUND. This used to follow the rename with `worktree bind
   * --branch <name>` — without `--remote`, which the CLI requires, so every
   * call was refused and logged as a warning, for the whole life of the
   * feature. Passing a remote would not fix it: the person typed a BRANCH
   * name, not a destination, and nothing at the cut knows which remote they
   * publish to. The project's `remote` setting only shapes a suggestion, and a
   * binding is a person's answer, never a default (CLAUDE.md, Thread Remote
   * Binding). So the branch stays unbound and the first push asks — with the
   * local name among its suggestions, which is the honest form of what the
   * old bind meant to record.
   *
   * FAIL-SOFT ON PURPOSE, and only here. Everything this touches is a name; a
   * checkout that could not take one still holds every commit, and the next
   * successful turn names it from the title. Refusing the whole worktree over
   * a branch name would throw away work that is already on disk. The caller
   * that must refuse INSTEAD OF creating is the modal, which asks
   * `threads:branchAvailable` before it creates anything at all.
   *
   * Returns the name that stuck — the typed one, or whatever the cut produced.
   */
  async #applyChosenName(
    thread: WorktreeThread,
    path: string,
    wanted: string,
    fallback: string | null,
  ): Promise<string | null> {
    const named = await this.deps.runCli(thread.projectRoot, [
      'worktree',
      'name',
      '--thread',
      thread.id,
      // THE FOLDER, SO THE VERB CAN FIND IT — and `path` is the checkout this
      // call is about, which is the one fact the thread record may not carry
      // yet: it is written after the cut, and this runs during it.
      ...worktreeNameArgs(checkoutName(path) ?? undefined),
      '--branch',
      wanted,
      '--json',
      '--target',
      thread.projectRoot,
    ])
    if (!named.ok) {
      console.warn('[ThreadWorktree] could not take the chosen branch name', {
        threadId: thread.id,
        wanted,
      })
      return fallback
    }
    return wanted
  }

  /**
   * What to call a checkout nobody named — the conversation's title, slugged,
   * wearing the folder prefix.
   *
   * UNIQUE WITHIN THE PROJECT, because titles repeat and two checkouts cannot
   * share a directory. The taken set is every checkout this app has recorded
   * for this project; one it does not know about still fails at `git worktree
   * add`, loudly and with nothing created, which is what it did before this
   * existed.
   */
  #nameFromTitle(thread: WorktreeThread): string {
    const wanted = folderForBranch(worktreeNameFromTitle(thread.title))
    const taken = this.deps.threadStore
      .listThreadWorktrees()
      .filter((entry) => entry.projectRoot === thread.projectRoot)
      .map((entry) => checkoutName(entry.worktreePath))
      .filter((name): name is string => name !== null)
    return uniqueWorktreeName(wanted, taken)
  }

  /**
   * Cut a worktree, and GUARANTEE that the line this raises comes down again.
   *
   * The announcement and its retraction are a pair, and for the life of the
   * feature only the announcement was structural: `running` was emitted at the
   * top and the terminal event was emitted by whichever exit the code happened
   * to take. Two of them did not. One branch returned a refusal without an
   * edge, and — worse, because it covers every await in the body — a THROW
   * returned none at all: `ensureBeforeSession` catches it ("the turn is worth
   * more than the worktree"), logs, and lets the turn run, which is right for
   * the turn and silently strands the indicator for the rest of the session.
   *
   * So the edge is no longer anybody's job to remember. It is a `finally`, and
   * the body says only what KIND of ending it was by writing to `report`. A
   * path added later cannot forget it, because there is nothing left to forget.
   */
  async #create(
    thread: WorktreeThread,
    options: PrepareOptions,
    settings: ResolvedWorktreeSettings,
  ): Promise<PrepareResult> {
    // THE FIRST THING THE CUT HAS EVER SAID.
    //
    // Creating a worktree blocks the first message — measured at ~3.6 s for
    // `git worktree add` on a 2k-file repo, and up to eight seconds more if the
    // base is refreshed first — and for the whole life of the feature it said
    // NOTHING. A project with a setup command turns those seconds into minutes.
    //
    // Announced BEFORE the first slow thing, and taken down after the last one,
    // so it covers the whole wait rather than one step of it.
    this.deps.onSetupProgress?.(thread.id, { state: 'running' })
    // Default `done`: an unexpected throw takes the line down without inventing
    // a card about it. The failure already reaches the log, and the turn it did
    // not stop carries on in the project's tree — saying so here would be a new
    // product decision, not this one's business.
    const report: { event: SetupProgressEvent } = { event: { state: 'done' } }
    try {
      return await this.#cut(thread, options, settings, report)
    } finally {
      this.deps.onSetupProgress?.(thread.id, report.event)
    }
  }

  /**
   * The cut itself. Every exit — returned, refused or thrown — is covered by
   * `#create`'s `finally`; this one only records what kind of ending it was.
   */
  async #cut(
    thread: WorktreeThread,
    options: PrepareOptions,
    settings: ResolvedWorktreeSettings,
    report: { event: SetupProgressEvent },
  ): Promise<PrepareResult> {
    const root = thread.projectRoot
    const carry = options.carry ?? 'clean'
    const carried = await this.#carry(root, carry)

    // WHERE THE WORKTREE BEGINS, AS ONE ARGUMENT LIST. The parked work is not
    // a separate mechanism — it is a branch, and a branch is something the
    // worktree can simply start from. It used to be a second step (create,
    // then move the new checkout's HEAD onto the parked branch), which meant
    // two answers to "where does this start" and a guard in the app to stop the
    // second one from moving a checkout it did not create. The CLI applies a
    // start point only when it creates, so that guard is now the same code path
    // for everybody (allowed-pattern #14).
    // The parked branch wins when there is one, and there can only be one when
    // the person chose to start where they are — the offer is not made in any
    // other case, so the two choices can never contradict each other.
    const start: WorktreeStart =
      carried.wipBranch === null
        ? startFor(options, settings)
        : { kind: 'branch', branch: carried.wipBranch }

    // THE REFRESH IS ITS OWN STEP, and it happens here — after the start is
    // settled, because what to refresh is a question only the start can answer,
    // and before the cut, because a base refreshed afterwards refreshed nothing
    // this worktree started from. It is bounded and abortable; the cut runs
    // whatever it reports.
    const refresh = await this.#refreshBase(root, start, options.signal, settings)

    const result = await this.deps.runCli(root, [
      'worktree',
      'create',
      '--thread',
      thread.id,
      // A NAME EVEN WHEN NOBODY TYPED ONE.
      //
      // Passing nothing here leaves the CLI's own fallback — the thread's slug
      // — which is how a checkout comes to be a uuid in somebody's shell
      // prompt. Every surface that asks says so in as many words ("Leave it
      // empty and it takes the conversation's title"), and that promise was
      // kept by nothing: an empty field sent no name and the uuid came back.
      //
      // It is the same rule the ask uses, so a checkout nobody named and one
      // named by hand are indistinguishable afterwards.
      ...worktreeNameArgs(options.worktreeName ?? this.#nameFromTitle(thread)),
      ...startArgs(start),
      // NO FETCH. Everything else here is bounded by the disk; a fetch against
      // a real remote is bounded by nothing the app knows, and it is the one
      // cost that could turn a wait into a hang.
      //
      // MEASURED (2026-08-21, a 2,000-file repo on a sandboxed tmp volume):
      // `git worktree add` 3,478 ms; this CLI's own overhead 64 ms of startup
      // plus 77 ms to list. The checkout IS the cost, it is proportional to the
      // repo, and it is why every part of this runs off the main process and
      // behind the composer's optimistic echo — the user's message and the
      // working indicator are already on screen while it happens.
      '--no-fetch',
      '--json',
      '--target',
      root,
    ])
    if (!result.ok) return this.#refuse(thread, refusalReason(result) ?? result.error ?? 'failed')
    const created = parseResultJson<CreateResult>(result.stdout)
    if (created === null || typeof created.path !== 'string' || created.path === '') {
      return this.#refuse(thread, 'the worktree could not be read back')
    }

    // THE PATH THE CLI RETURNED. It realpaths its target, and this repo's own
    // `flow/` is a symlink — a recomputed path would miss every later match
    // against `git worktree list`.
    const path = created.path
    const cut = typeof created.branch === 'string' && created.branch !== '' ? created.branch : null
    // A NAME A PERSON CHOSE, applied while the checkout is new and nothing has
    // been committed into it. `#applyChosenName` returns the name that actually
    // stuck: it refuses rather than repairs, and a refusal leaves the checkout
    // exactly as the CLI made it — detached, usable, and named later from the
    // title like every worktree before this one.
    const branch =
      options.branch === undefined ? cut : await this.#applyChosenName(thread, path, options.branch, cut)

    // THE BASE THE CLI RETURNED, for exactly the reason the path is. It is the
    // repository's answer at the moment the checkout was cut; reading "which
    // branch is the project on" again here would be answering a question about
    // a different moment, and the whole bug this fixes was a recorded base that
    // did not match the commit the worktree actually started from.
    const base = typeof created.base === 'string' && created.base !== '' ? created.base : null
    // WRITTEN WITH THE CUT, by the one caller that can answer it. Every other
    // writer of these columns omits the flag and leaves whatever this recorded
    // standing — a rename is not a new cut and must not quietly clear a warning
    // that is still true.
    this.deps.threadStore.setThreadWorktree(thread.id, {
      path,
      branch,
      base,
      baseMayBeBehind: refresh.stale,
    })
    // A session bound to the old root would keep writing there for its whole
    // life. Only a REQUESTED move can meet one (the send path runs before any
    // session exists), and only an idle thread reaches this line.
    if (options.requested === true) this.deps.disposeSession?.(thread.id)
    // THE PROJECT FINISHES BUILDING ITS OWN COPY, before the agent arrives.
    //
    // A `git worktree` carries tracked files only, so a fresh copy is often a
    // repository that cannot build — and until now nothing in the app could do
    // anything about that. The store write above already happened on purpose:
    // a setup that fails must leave a worktree that is recorded and usable,
    // not one that exists on disk and nowhere else.
    const setup = await this.#runSetup(thread, path, settings)
    // THE WAIT IS OVER — one edge for the whole of it, cut and setup together.
    // A person waiting for their first reply is not waiting for two things;
    // they are waiting once, and the line that appeared has to come down.
    // Recorded, not sent: `#create`'s `finally` is what sends it.
    report.event = setup === null ? { state: 'done' } : { state: 'failed', detail: setup }
    // A project just gained a copy of itself. Whoever is watching the disk gets
    // told; nothing here waits on what they do about it.
    this.deps.onCreated?.(root)

    // AND WHETHER THIS COPY CAN ACTUALLY BE WORKED IN.
    //
    // A `git worktree` carries tracked files only, and the untracked set Flow
    // adds is JS-shaped — so a Python project's checkout has no interpreter and
    // says nothing about it until a command fails with somebody else's error
    // message (user, 2026-09-18). It TELLS rather than runs: the project's setup
    // command is the mechanism, and choosing one for somebody would be spending
    // their network and disk from a filename.
    const exists = this.deps.pathPresent ?? ((path: string) => existsSync(path))
    const unprepared = unpreparedNote({
      setupConfigured: (settings.worktreeSetup.value ?? '').trim() !== '',
      carried: carriedEntries(created.links),
      projectHas: (dir: string) => exists(join(root, dir)),
    })

    // ONE SENTENCE, EVEN WHEN TWO THINGS HAPPENED. The carried-work line says
    // what became of the person's own files and the stale-base line says what
    // this copy started from; both are facts about the same creation, so they
    // arrive as one paragraph rather than as two notes racing each other.
    const detail = [
      carried.detail,
      refresh.stale ? staleBaseNote(base ?? refresh.base) : null,
      setup,
      unprepared,
    ]
      .filter((line): line is string => line !== null)
      .join(' ')

    // THE CONVERSATION'S OTHER PROJECTS, TOO. Isolating one repository and
    // leaving the rest pointing at their shared trees is partial isolation, and
    // partial isolation is the kind a person trusts. Awaited rather than fired
    // and forgotten: the turn that follows must not start against a tree that
    // is halfway through being replaced.
    //
    // It never fails the primary. A project that cannot be isolated is reported
    // by `prepareAttached` and skipped; the copy just made is still a copy.
    await this.prepareAttached(thread.id)

    return {
      status: 'created',
      base,
      onBase: created.onBase === true,
      ...(refresh.stale ? { baseMayBeBehind: true } : {}),
      ...(carried.wipBranch === null ? {} : { wipBranch: carried.wipBranch }),
      ...(detail === '' ? {} : { detail }),
    }
  }

  // ── Finishing the copy the project asked for ─────────────────────────────

  /**
   * Run the project's own setup command in a worktree that was just created.
   *
   * Returns the sentence to carry, or null when there is nothing to say — which
   * is every project that has not set a command, and every successful run.
   *
   * NOTHING RUNS WITHOUT A COMMAND. The built-in is null, so a project that has
   * configured nothing takes the early return on its first line: no detach, no
   * child process, no extra wait. That is the promise the whole feature rests
   * on and it is enforced here rather than by any caller.
   *
   * THE LINK IS BROKEN FIRST, and this is the sharpest thing in the feature. A
   * worktree's `node_modules` is a symlink into the user's own checkout, so
   * `npm ci` run here would not install into the worktree — it would install
   * into the project, changing the dependencies of work this thread was never
   * allowed to touch. A project that writes a setup command has taken ownership
   * of its own dependencies, so its copies stop sharing; every project that
   * writes nothing keeps the symlink exactly as before.
   *
   * A FAILURE IS NOT FATAL. The turn is worth more than the worktree — the
   * stance `ensureBeforeSession` already takes for the whole cut — so a
   * non-zero exit, a timeout, or a command that will not spawn all resolve to
   * a sentence and a usable checkout.
   */
  async #runSetup(
    thread: WorktreeThread,
    path: string,
    settings: ResolvedWorktreeSettings,
  ): Promise<string | null> {
    const command = settings.worktreeSetup.value
    if (command === null || command.trim() === '') return null
    const runSetup = this.deps.runSetup
    if (runSetup === undefined) return null

    // The link, before the install that would follow it into the user's tree.
    // AWAITED: an install racing the unlink would be the hazard with extra
    // steps — the whole point is that the link is gone before anything writes.
    await this.deps.detachModules?.(thread.id, thread.projectRoot, path)
    const result = await runSetup(path, command, {
      timeoutMs: settings.worktreeSetupTimeoutMs.value,
    })
    if (result.ok) return null
    // WHAT FAILED AND WHAT IT COSTS — never the command, never the path, never
    // the child's transcript (forbidden-pattern #12, allowed-pattern #18). The
    // reader does not need Flow to quote their own configuration back at them;
    // they need to know that the copy is usable and that something in it is not
    // finished.
    const note = setupFailureNote(result)
    console.warn('[ThreadWorktree] worktree setup did not finish', {
      threadId: thread.id,
      error: result.error,
    })
    return note
  }

  // ── Refreshing what it starts from ───────────────────────────────────────

  /**
   * Bring the branch this worktree is about to be cut from up to date with the
   * remote — bounded, abortable, and honest when it could not.
   *
   * WHY IT IS NOT INSIDE THE CUT. `worktree create` is called with
   * `--no-fetch` on purpose: the checkout is measured in seconds and bounded by
   * the disk, and a fetch is bounded by nothing the app knows. Folding the two
   * together makes one step whose worst case is a hang, which is why they are
   * two steps whose worst case is a copy that says what it does not know.
   *
   * IT SKIPS FAR MORE OFTEN THAN IT RUNS, and every skip is a case where the
   * network could tell us nothing:
   *
   *  * No base to speak of — a detached project, an unreadable HEAD.
   *  * A base with no counterpart on the remote. A branch that lives only here
   *    — the parked `wip/` branch every carried-work cut starts from, a local
   *    experiment — cannot be behind anything, and asking a remote about it is
   *    a round trip that can only fail. This is also what keeps the ordinary
   *    "start where I am" cut off the network entirely.
   *
   * WHAT IT DOES NOT DO: it does not move the person's branch. A fetch updates
   * what the repository knows about the remote; fast-forwarding a local branch
   * is a write to somebody's own work and nobody asked for it here. For a
   * `trunk` start the CLI's own refresh then fast-forwards inside the new
   * checkout off the ref this just updated, which is precisely why this runs
   * first.
   */
  async #refreshBase(
    root: string,
    start: WorktreeStart,
    signal: AbortSignal | undefined,
    settings: ResolvedWorktreeSettings,
  ): Promise<{ base: string | null; stale: boolean }> {
    // TURNED OFF MEANS OFF, AND SILENT WITH IT. A person who has said not to go
    // to the network before a cut has not asked to be told their copy might be
    // behind — the fetch, the flag and the sentence are one decision, and
    // keeping the warning while dropping the check would mark every worktree
    // stale forever. Returned before `#startBranch`, so the skip costs nothing.
    if (!settings.baseRefresh.value) return { base: null, stale: false }

    const base = await this.#startBranch(root, start)
    if (base === null || base === '') return { base, stale: false }

    const remote = settings.remote.value
    const tracked = await this.deps.runGit(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/remotes/${remote}/${base}`,
    ])
    // A branch nothing on the remote answers to is not behind — it is simply
    // ours. `--quiet` makes an absent ref an empty answer rather than an error,
    // so both halves are asked.
    if (!tracked.ok || tracked.stdout.trim() === '') return { base, stale: false }

    // ALREADY GIVEN UP ON. A caller that aborted before we got here has said it
    // is not waiting; the cut proceeds and the copy says what it started from.
    if (signal?.aborted === true) return { base, stale: true }

    const fetched = await this.#boundedFetch(
      root,
      remote,
      base,
      signal,
      settings.baseRefreshTimeoutMs.value,
    )
    return { base, stale: !fetched }
  }

  /**
   * Run the fetch under a ceiling, and say only whether it finished.
   *
   * THE BOUND IS ENFORCED HERE, not delegated. The options handed to `runGit`
   * ask the real runner to kill its own child — which it does — but a
   * collaborator that ignores them must not be able to turn a slow remote into
   * a hung worktree, so the wait itself is raced against the ceiling. Losing
   * that race abandons the WAIT, never the repository: a killed or orphaned
   * `git fetch` leaves refs exactly as it found them, and nothing of the
   * thread's has been written yet.
   */
  async #boundedFetch(
    root: string,
    remote: string,
    base: string,
    signal: AbortSignal | undefined,
    ceilingMs: number,
  ): Promise<boolean> {
    const ceiling = new AbortController()
    const giveUp = (): void => ceiling.abort()
    // ALREADY WITHIN THE BOUNDS — the resolver clamps every configured wait
    // before it can become a `setTimeout`, and clamping it again here would be
    // a second opinion about the same number (allowed-pattern #14).
    const timer = setTimeout(giveUp, ceilingMs)
    signal?.addEventListener('abort', giveUp, { once: true })
    try {
      const result = await Promise.race([
        this.deps.runGit(root, ['fetch', '--quiet', remote, base], {
          timeoutMs: ceilingMs,
          signal: ceiling.signal,
        }),
        stopWaiting(ceiling.signal),
      ])
      return result !== null && result.ok
    } catch {
      // A runner that rejects rather than resolving is still just a refresh
      // that did not happen. The cut is worth more than the freshness.
      return false
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', giveUp)
    }
  }

  /**
   * Record the refusal, say it on the thread once, and report it.
   *
   * ONLY A PROJECT-WIDE REASON POISONS THE PROJECT. The cache exists so a
   * repository that CANNOT have worktrees — no git, no commits — does not spawn
   * a CLI on every message of every thread in it. Those are facts about the
   * repository, and every thread in it gets the same answer.
   *
   * A failure about ONE thread's checkout is not that, and caching it as if it
   * were is what turned the 2026-09-08 eviction race into a whole project going
   * quiet: one thread's directory was left behind by a force-remove, its next
   * cut hit "already exists", and from then on every OTHER thread in
   * orbit-app was refused silently, with no note at all, for the rest of the
   * app's run. The thread that failed still reports and still explains itself;
   * its siblings are simply none of its business.
   */
  #refuse(thread: WorktreeThread, reason: string): PrepareResult {
    const note = worktreeUnavailableNote(reason)
    if (isProjectWideRefusal(reason)) {
      const firstTime = !this.#refusedRoots.has(thread.projectRoot)
      this.#refusedRoots.add(thread.projectRoot)
      if (firstTime) {
        this.deps.threadStore.appendMessage(thread.id, 'system', note)
      }
    } else {
      this.deps.threadStore.appendMessage(thread.id, 'system', note)
    }
    return { status: 'refused', detail: note }
  }

  // ── The uncommitted-work offer ───────────────────────────────────────────

  /**
   * Do what the person chose with the project's uncommitted work, and report
   * where (if anywhere) it now lives.
   *
   * `clean` is the default and does nothing — the whole point of
   * forbidden-pattern #15 is that the branch which moves a person's work
   * requires them to have said so.
   */
  async #carry(
    root: string,
    carry: CarryChoice,
  ): Promise<{ wipBranch: string | null; detail: string | null }> {
    if (carry === 'clean') return { wipBranch: null, detail: null }

    if (carry === 'stash') {
      const stashed = await this.deps.runGit(root, [
        'stash',
        'push',
        '-m',
        'Set aside when a thread got its own branch',
      ])
      return {
        wipBranch: null,
        detail: stashed.ok
          ? 'Your changes are stashed. This thread starts from the last commit.'
          : 'Your changes could not be stashed, so they are still where you left them. This thread starts from the last commit.',
      }
    }

    // NON-DESTRUCTIVE BY CONSTRUCTION. `stash create` writes a commit object
    // and changes nothing on disk: the user's files stay exactly as dirty as
    // they were, and the thread gets a copy of them to start from.
    const snapshot = await this.deps.runGit(root, ['stash', 'create'])
    const commit = snapshot.stdout.trim().split('\n')[0]?.trim() ?? ''
    if (!snapshot.ok || commit === '') {
      return {
        wipBranch: null,
        detail:
          'Your changes could not be copied to this thread’s branch, so it starts from the last commit. Nothing of yours was moved.',
      }
    }
    const wipBranch = wipBranchName(this.deps.now?.() ?? new Date())
    const branched = await this.deps.runGit(root, ['branch', wipBranch, commit])
    if (!branched.ok) {
      return {
        wipBranch: null,
        detail:
          'Your changes could not be copied to this thread’s branch, so it starts from the last commit. Nothing of yours was moved.',
      }
    }
    return {
      wipBranch,
      detail: `This thread starts from a copy of your changes, saved on ${wipBranch}. Your own files are untouched.`,
    }
  }

  /**
   * Files with uncommitted changes in the project's own tree.
   *
   * TRACKED ONLY. Nothing on offer touches an untracked file — the copy is made
   * from `stash create`, which does not take them, and `stash push` leaves them
   * alone — so counting them would put a number in the question that none of
   * its answers acts on.
   *
   * 0 when git cannot answer: an offer nobody can act on is worse than no offer.
   */
  async #countProjectChanges(root: string): Promise<number> {
    const status = await this.deps.runGit(root, [
      'status',
      '--porcelain',
      '--untracked-files=no',
    ])
    return status.ok ? countChangedFiles(status.stdout) : 0
  }

  /** The project's current branch, or null when HEAD is detached/unreadable. */
  async #currentBranch(root: string): Promise<string | null> {
    const head = await this.deps.runGit(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const branch = head.stdout.trim()
    return head.ok && branch !== '' && branch !== 'HEAD' ? branch : null
  }

  /**
   * Say, once, that the folder this conversation works in is behind its remote
   * branch — and leave the pulling to the person.
   *
   * THE FETCH IS THE SAME FETCH. It goes through `#boundedFetch` under the same
   * ceiling as a cut's, and it honours `base_refresh` for the same reason: that
   * setting is a person saying "do not go to the network before starting work",
   * and a second opinion about it here would be a second meaning for one
   * switch (allowed-pattern #14).
   *
   * EVERY STEP CAN DECLINE, AND DECLINING IS SILENT. No upstream, a detached
   * HEAD, a fetch that did not finish, a count git would not give — each ends
   * in no row, because a notice is a claim and none of those is evidence for
   * one. The only thing that writes is a branch measurably behind the branch it
   * tracks.
   */
  async #noteFolderBehind(threadId: string): Promise<void> {
    const thread = this.deps.threadStore.getThread(threadId)
    if (thread === null) return
    // A COPY OF ITS OWN WAS ALREADY STARTED FROM THE LATEST. Asked before any
    // subprocess, so the common isolated thread costs nothing at all. (The
    // verdict below is handed the same fact and would refuse it too; this is
    // the cheap door, not a second rule.)
    if (thread.worktreePath !== null) return

    const root = thread.projectRoot
    const branch = await this.#currentBranch(root)
    if (branch === null) return

    const read = await this.deps.runGit(root, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{upstream}',
    ])
    const upstream = read.ok ? parseUpstreamName(read.stdout) : null
    if (upstream === null) return

    // THE NUMBERS, AFTER THE NETWORK HAS HAD ITS BOUNDED CHANCE. A fetch that
    // does not finish is not fatal: the comparison then runs against the refs
    // already on disk, which is the same thing the git panel has been showing
    // all along — older than the truth, never invented.
    const settings = await this.#settings(root)
    if (settings.baseRefresh.value) {
      await this.#boundedFetch(
        root,
        settings.remote.value,
        branch,
        undefined,
        settings.baseRefreshTimeoutMs.value,
      )
    }
    const counted = await this.deps.runGit(root, [
      'rev-list',
      '--count',
      '--left-right',
      `${branch}...${upstream}`,
    ])
    const verdict = folderFreshnessVerdict({
      hasOwnCheckout: false,
      branch,
      upstream,
      distance: counted.ok ? parseAheadBehind(counted.stdout) : null,
    })
    if (!verdict.note) return

    const content = formatFolderBehindMarker(verdict.branch, verdict.upstream)
    if (content === null) return
    // ONCE PER THREAD. A retried first send, and a first send after a relaunch,
    // find the row already there.
    if (this.deps.threadStore.hasSystemMessage(threadId, content)) return
    this.deps.threadStore.appendMessage(threadId, 'system', content)
  }
}

/**
 * Resolves to null the moment the ceiling gives up.
 *
 * It abandons the WAIT, not the work: whatever it was racing is left to finish
 * or be killed by its own runner, and the caller carries on with the honest
 * answer that it did not hear back in time.
 */
function stopWaiting(signal: AbortSignal): Promise<null> {
  return new Promise<null>((resolve) => {
    if (signal.aborted) {
      resolve(null)
      return
    }
    signal.addEventListener('abort', () => resolve(null), { once: true })
  })
}

/** A branch name, as a sentence names it. */
function quoted(branch: string): string {
  return `“${branch}”`
}

/** Whether a parsed entry is a branch option — a list is only as good as this. */
function isBranchOption(value: unknown): value is WorktreeBranchOption {
  if (value === null || typeof value !== 'object') return false
  const entry = value as Record<string, unknown>
  return typeof entry.name === 'string' && entry.name !== ''
}

/** A thread whose turn is in flight — its session's root cannot be moved. */
function isBusy(status: string): boolean {
  return status === 'working' || status === 'needs-decision'
}

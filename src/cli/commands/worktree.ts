/**
 * Worktree CLI command — `planflow-ai worktree <verb>`.
 *
 * THE THREAD-FACING DOOR onto the machinery the loops already run on. Every
 * verb here is thin: `create` is `resolveThreadWorktree`, `prune` is
 * `pruneThreadWorktree`, `list` is `parseWorktreeList`, `name` is
 * `nameWorktreeBranch`. Nothing about a worktree's lifecycle is decided in this
 * file — a second set of rules for threads is exactly what allowed-pattern #14
 * says not to build, and the first divergence would be the one nobody noticed.
 *
 * Contract (the `loop` / `guard classify` precedent):
 *
 *   - Success: the result JSON via `process.stdout.write`, exit 0. `--json` is
 *     what a machine passes; without it the same object renders as one human
 *     line. A SECOND FORMATTER, never a second computation.
 *   - Refusal: ONE `worktree refused: <reason>` line via the repo logger (which
 *     routes through console.log — allowed-pattern #15), exit code 1, and
 *     nothing written. A non-git directory and an unborn branch both refuse
 *     BEFORE anything is created, so the app can say so on the thread and fall
 *     back to today's behaviour rather than fail halfway.
 *   - One refusal ANSWERS: `unbound` also writes its payload (the suggested
 *     remote branch, where it came from, the remotes, the base) to stdout,
 *     with or without `--json`, because refusing a push nobody has aimed yet
 *     is a QUESTION and the surface asking it needs the answer in the same
 *     breath. Everything else refuses with the line alone.
 *   - No model call ever enters a verb.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { error as logError } from '../utils/logger.js';
import { flagOrStdinSync } from '../utils/flag-or-stdin.js';
import { parseFlowConfig } from '../state/flowconfig-parser.js';
import { QUIET_CHILD_STDIO } from '../utils/child-stdio.js';
import type { FlowConfig } from '../state/types.js';
import {
  autoBindDecision,
  bindingRefspec,
  bindingStaleness,
  isValidRefName,
  isValidRemoteName,
  lastBinding,
  readBinding,
  remoteNames,
  suggestRemoteBranch,
  writeBinding,
  type RemoteBinding,
  type RemoteBranchSource,
} from '../loop/remote-binding.js';
import {
  firstUrl,
  parseRepoSlug,
  previousPushRecord,
  resolvePrBase,
} from '../loop/remote-target.js';
import {
  currentBranch,
  nameWorktreeBranch,
  parseWorktreeList,
  detachSharedModules,
  promoteDependencies,
  pruneThreadWorktree,
  resolveThreadWorktree,
  threadWorktreePath,
  threadWorktreeRoot,
  type DependencyPromotion,
  type GitExec,
  resolveThreadStart,
  threadBranchOptions,
  type ThreadBranchOption,
  type ThreadWorktreePrune,
  type ThreadWorktreeResolution,
  type WorktreeEntry,
  type WorktreeFs,
  type WorktreeNaming,
} from '../loop/worktree.js';

/** Prefix every refusal line carries — never doubled. */
const WORKTREE_REFUSED_PREFIX = 'worktree refused:';

/** How long any single git call may take before it is a failure. */
const GIT_TIMEOUT_MS = 120_000;

/**
 * How long a refusal reason may run before it is truncated.
 *
 * The same bound the sibling family uses for the same job (`NOTE_MAX_LENGTH`,
 * `loop.ts`) — a reason is a sentence a person reads, and a subprocess that
 * wrote a page did not write a sentence.
 */
const REASON_MAX_LENGTH = 200;

/** Every verb this command answers to. */
export const WORKTREE_VERBS = [
  'create',
  'prune',
  'list',
  'name',
  'promote',
  'detach',
  'branches',
  'bind',
  'push',
  'pr',
] as const;

/** One of the verbs. */
export type WorktreeVerb = (typeof WORKTREE_VERBS)[number];

/** Whether a value is a known verb. */
export function isWorktreeVerb(value: string): value is WorktreeVerb {
  return (WORKTREE_VERBS as readonly string[]).includes(value);
}

/** Everything the verbs read off the command line. */
export interface WorktreeCommandOptions {
  /** The main checkout. Defaults to the current directory. */
  target: string;
  /** Which thread — required by create, prune and name. */
  thread?: string;
  /** Create the checkout detached, to be named once the thread has a title. */
  detach?: boolean;
  /**
   * Prune a worktree even though it holds uncommitted work (#1797).
   *
   * A SECOND CONSENT, not a louder first one — the refusal that precedes it
   * names the files, so this flag is only reachable by someone who has read
   * what they are agreeing to lose.
   */
  discard?: boolean;
  /**
   * A branch (or commit) to start FROM — the worktree gets a branch of its own.
   *
   * DEFAULTS TO THE BRANCH THE MAIN CHECKOUT IS ON, not the repository's trunk.
   * A thread is opened to help with the work in front of somebody, and the work
   * in front of them includes commits they have not pushed.
   */
  base?: string;
  /** A branch to WORK ON — the worktree checks it out and commits land on it. */
  checkout?: string;
  /** Start from the repository's default branch, brought up to date. */
  trunk?: boolean;
  /** The branch to create (name), or to attach at creation. */
  branch?: string;
  /**
   * What the worktree's FOLDER is called — a different question from
   * `branch`, which names the ref.
   *
   * Absent → the thread's slug, which is what this verb did for its whole life
   * and what put a uuid in every person's shell prompt. Passed to prune as
   * well as create: prune finds the checkout by rebuilding its path, so a
   * create that named the folder and a prune that did not would look in two
   * different places.
   */
  worktreeName?: string;
  /** Emit the result object rather than the human line. */
  json?: boolean;
  /** Commander sets this false for `--no-fetch`. */
  fetch?: boolean;
  /** Commander sets this false for `--no-create`. */
  create?: boolean;
  /**
   * The remote a binding names (`bind`). A NAME git knows, never a URL, and
   * never defaulted — a push whose destination came from a default is the bug
   * this family exists to stop.
   */
  remote?: string;
  /** The base a pull request opens against, as recorded WITH the binding. */
  prBase?: string;
  /** The pull request's title (`pr`). */
  title?: string;
  /** The pull request's body (`pr`). */
  body?: string;
  /**
   * The thread's own title, for the suggestion ladder's ticket rung. Passed by
   * the caller because a slug is not a title and the CLI has no thread store.
   */
  threadTitle?: string;
  /** The plan whose work this is — the ladder's second place to find a ticket. */
  plan?: string;
  /**
   * The remote to OFFER when nobody has said where this worktree publishes
   * (push/pr), ahead of the project file's own.
   *
   * A SUGGESTION INPUT, NOT A DESTINATION. Nothing here binds anything: the
   * value reaches exactly one field of the `unbound` refusal — the remote a
   * person is offered — and only when this checkout really has a remote by that
   * name. A caller that omits it gets the project file, which is what every
   * terminal caller has always got.
   *
   * IT EXISTS BECAUSE THE FILE IS NOT THE ONLY LAYER ANY MORE. The app resolves
   * a project's settings over the person's app-wide defaults, and a default
   * that lives only there would otherwise be invisible to this process — which
   * reads one file and knows nothing about who is running it.
   */
  defaultRemote?: string;
  /**
   * The branch-name pattern to suggest with (push/pr), ahead of the project
   * file's `remote_branch_pattern`. Same reason, same non-binding reach: it
   * feeds the suggestion ladder's first rung and nothing else.
   */
  branchPattern?: string;
  /**
   * Bind, push or open from the checkout at `--target` itself, on the branch it
   * is currently on, rather than from a thread's worktree.
   *
   * FOR EVERY CALLER THAT IS NOT A THREAD. The execute-plan skill runs in
   * whatever checkout the user started it in — often the project itself, with
   * no thread and no worktree — and before this option its only way to
   * publish was the raw `git push` these verbs exist to replace. Refusing it a
   * door would have left that push in the prompt, which is precisely the
   * drift allowed-pattern #14 says one code path prevents.
   *
   * MUTUALLY EXCLUSIVE WITH `--thread`, and neither defaults to the other: a
   * caller that names both has two different checkouts in mind, and a caller
   * that names neither has not said which one it means. Both are refused.
   */
  here?: boolean;
  /**
   * No person is present to answer the unbound question (`push`).
   *
   * A DECLARED PROPERTY OF THE CALL, NEVER SNIFFED (C-3). When true and the
   * worktree is unbound, a CONFIDENT suggestion (source `pattern`/`ticket`) is
   * applied and the push proceeds; a weak rung still refuses exactly as an
   * attended call would. Absent or false, every path is byte-for-byte the old
   * behaviour (NFR-1). This is the single narrowing of allowed-pattern #22, and
   * it lives behind this flag so it can never reach an attended surface.
   */
  unattended?: boolean;
}

/**
 * The default exec — `execFileSync`, so no shell quoting can ever be wrong.
 *
 * QUIET BY DEFAULT (#1798). Several verbs probe git for facts that are
 * legitimately absent — `origin/HEAD` in a repo with no remote, a
 * remote-tracking ref that was never pushed — catch the failure and carry on
 * correctly. Without `stdio`, git had already written `fatal:` to the inherited
 * stderr by then, so `worktree branches` printed three of them and exited 0.
 * See `QUIET_CHILD_STDIO` for why stderr is captured rather than discarded.
 */
export const defaultWorktreeExec: GitExec = (file, args, cwd) =>
  execFileSync(file, [...args], {
    encoding: 'utf-8',
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
    stdio: [...QUIET_CHILD_STDIO],
  });

/**
 * Injected collaborators. Production passes none; tests pass a fake exec and a
 * fake filesystem, so no test shells out to git and none creates a symlink on
 * the developer's machine (allowed-pattern #12).
 */
export interface WorktreeRuntime {
  exec?: GitExec;
  fs?: WorktreeFs;
}

/** The runtime once its defaults are filled in — the filesystem stays optional
 *  because the module below defaults it to the real one. */
interface ResolvedRuntime {
  exec: GitExec;
  fs?: WorktreeFs;
}

/** One thread checkout, as `list` reports it. */
export interface ThreadWorktreeEntry {
  /**
   * The checkout's folder inside the thread container — `<id>` for a checkout
   * cut before folders had names, `worktree/<name>` after. A filter by
   * `--thread` answers with the checkout the resolver found, whatever its
   * folder is called.
   */
  thread: string;
  /**
   * The thread this checkout was cut for, as the checkout itself records it
   * (written by `create` and `name`). Absent for a checkout that predates the
   * record — the folder is then the only identity there is.
   */
  owner?: string;
  path: string;
  branch: string | null;
  head: string | null;
  locked: boolean;
  /** git holds a record for a directory that is no longer there. */
  prunable: boolean;
  /**
   * Where this worktree publishes — read from git's own upstream config.
   *
   * PRESENT ON EVERY `list` ENTRY, absent when the listing was taken for some
   * other verb's internal use. Reading a binding costs two `git config` calls
   * per worktree, and `name` runs after every turn of every thread (allowed
   * -pattern #17: pay only for what someone can see), so only the verb whose
   * caller asked for bindings pays for them.
   *
   * `bound` is the one field a caller should branch on: a half-set upstream
   * reads as unbound, so `remote` and `remoteBranch` are either both there or
   * both null.
   */
  remote?: string | null;
  remoteBranch?: string | null;
  bound?: boolean;
}

/** What `list` answers with. */
export interface WorktreeListing {
  status: 'listed';
  /** The container the entries live in. */
  root: string;
  worktrees: ThreadWorktreeEntry[];
}

/** What `bind` answers with — the binding as git now holds it. */
export interface WorktreeBinding {
  status: 'bound';
  /** The thread this binding belongs to, or null under `--here`. */
  thread: string | null;
  /** The local branch the binding belongs to. */
  branch: string;
  remote: string;
  remoteBranch: string;
  /**
   * Echoed back, never written: git has no key for a pull request's base, so
   * the thread store is its home and this verb is only confirming what it was
   * told (FR-5).
   */
  prBase: string | null;
  /**
   * A name this worktree published under before, still sitting on the remote.
   * Recorded, NEVER removed (FR-11) — deleting a branch somebody may have a
   * pull request open against is not this verb's decision to make.
   */
  previouslyPushedAs?: string;
}

/**
 * A binding written by the run itself, not answered by a person.
 *
 * CARRIED BACK SO THE COORDINATOR CAN RECORD IT. `worktree` does not write
 * `flow/.rounds.jsonl` — that store has one writer, the execute-plan/loop
 * coordinator (CLAUDE.md). So an unattended auto-bind reports WHAT it decided
 * here, and the caller turns it into the `escalation` rounds entry (FR-6). The
 * `source` rides along because "applied unattended" only ever happens on a
 * confident rung, and the audit trail should say which one.
 */
export interface AutoBound {
  source: RemoteBranchSource;
  remote: string;
  remoteBranch: string;
}

/** What `push` answers with. */
export interface WorktreePush {
  status: 'pushed';
  /** The thread that pushed, or null under `--here`. */
  thread: string | null;
  branch: string;
  remote: string;
  remoteBranch: string;
  /** Always true — a push that did not happen is a refusal, not a result. */
  pushed: true;
  previouslyPushedAs?: string;
  /**
   * Present only when this push AUTO-BOUND an unbound branch (unattended +
   * confident). Its absence means the branch was already bound or a person
   * answered — the coordinator records an escalation entry only when it is here.
   */
  autoBound?: AutoBound;
}

/** What `pr` answers with. */
export interface WorktreePullRequest {
  status: 'opened';
  /** The thread the pull request belongs to, or null under `--here`. */
  thread: string | null;
  remote: string;
  remoteBranch: string;
  /** The base the pull request opens against — never guessed. */
  base: string;
  /** The first URL `gh` printed, or null when it printed none. */
  url: string | null;
}

/**
 * What a caller is handed when a worktree has no binding yet.
 *
 * A REFUSAL THAT CARRIES ITS OWN ANSWER. The whole point of refusing an
 * unbound push is that somebody has to decide where it goes — so the refusal
 * ships everything the deciding surface needs (the suggestion, where it came
 * from, which remotes exist, which base to offer) and nothing it would have to
 * ask git for a second time. Printed on stdout even without `--json`, because
 * the two callers that hit it — the IDE's landing path and the execute-plan
 * skill — both parse it.
 */
export interface UnboundRefusal {
  refused: 'unbound';
  suggestion: string;
  source: RemoteBranchSource;
  /**
   * The remote this project usually publishes to, or null when nobody has
   * named one this repository actually has.
   *
   * A DEFAULT SOMEBODY STILL CONFIRMS — never a value applied on their behalf.
   * It rides along so the ask can arrive with the ordinary answer already
   * selected and a person only has to say yes; nothing below the ask may turn
   * it into a binding (allowed-pattern #22). A configured name this checkout
   * has no remote for is reported as null rather than offered, because a
   * pre-selected remote that does not exist is a guess wearing a default's
   * clothes — and `bind` would refuse it a moment later anyway.
   */
  remote: string | null;
  /** The remotes this repository has, in git's order. */
  remotes: string[];
  /** The base a pull request would open against, or null when nobody has said. */
  base: string | null;
}

/** The outcome of any verb. */
export type WorktreeVerbResult =
  | ThreadWorktreeResolution
  | ThreadWorktreePrune
  | WorktreeListing
  | WorktreeBranchListing
  | WorktreeBinding
  | WorktreePush
  | WorktreePullRequest
  | ({ status: 'named' | 'unchanged'; thread: string } & WorktreeNaming)
  | ({ thread: string } & DependencyPromotion)
  | { thread: string; detached: boolean };

/**
 * A refusal that has something to hand back — today, only `unbound`.
 *
 * THE PAYLOAD GOES TO STDOUT AND THE REASON GOES TO THE LOGGER, which keeps
 * the family's contract intact (one `worktree refused:` line, exit 1) while
 * still giving a machine caller a parseable object on the stream it already
 * reads. A refusal without a payload is a plain `Error`, exactly as before.
 */
class WorktreeRefusal extends Error {
  readonly payload: unknown;

  constructor(reason: string, payload: unknown) {
    super(reason);
    this.name = 'WorktreeRefusal';
    this.payload = payload;
  }
}

/**
 * Collapse a multi-line failure into one bounded, printable line.
 *
 * The sibling family has had this for the same reason (`oneLine`, `loop.ts`):
 * anything that wraps a subprocess can throw with a page of that subprocess's
 * output inside `Error.message`, and a family whose contract is ONE line has to
 * make that true of every thrown error rather than of the ones it remembered.
 */
function oneLine(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > REASON_MAX_LENGTH
    ? `${collapsed.slice(0, REASON_MAX_LENGTH - 1)}…`
    : collapsed;
}

/**
 * Normalize any thrown error into a single `worktree refused: <reason>` line.
 * Errors already carrying the prefix pass through untouched.
 *
 * SINGLE IS ENFORCED, not assumed. This said "a single line" while only
 * prefixing the message, so every refusal wrapping a git subprocess printed as
 * many lines as git wrote — ten, for a rejected push (#1792) — and consumers
 * told to scan for one `worktree refused:` line (allowed-pattern #15, #21) got
 * a paragraph. Collapsing here covers every verb, including the ones written
 * after this one.
 */
function toRefusalLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(WORKTREE_REFUSED_PREFIX)) {
    return oneLine(message);
  }
  return `${WORKTREE_REFUSED_PREFIX} ${oneLine(message)}`;
}

/**
 * The main checkout, as GIT will name it.
 *
 * CANONICALIZED, and an E2E is what found this: on macOS a project reached
 * through `/tmp` (a symlink to `/private/tmp`) makes every path this command
 * builds start with `/tmp`, while `git worktree list` reports the real one — so
 * a worktree this verb had just created could not be found by the next verb,
 * and `name` refused a thread whose checkout was plainly on disk. Resolving
 * once, here, means every derived path and every comparison speaks git's
 * spelling.
 *
 * Fail-soft: a path that cannot be resolved (it does not exist yet) is used as
 * given — the verb's own refusal is a better error than this one's would be.
 */
function canonicalTarget(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}

/** The thread a verb requires, refusing by name when absent. */
function requireThread(options: WorktreeCommandOptions, verb: string): string {
  const thread = options.thread?.trim() ?? '';
  if (thread.length === 0) {
    throw new Error(`${verb} requires --thread <slug>`);
  }
  return thread;
}

/**
 * The project's configured cache directories — the untracked entries a link
 * step should carry that are neither dependencies, secrets nor `flow/`.
 *
 * Fail-soft: a project with no flowconfig links the built-in set, which is
 * every project's behaviour before anyone configures anything.
 */
function configuredLinks(target: string): string[] {
  try {
    return parseFlowConfig(join(target, 'flow')).worktree_links ?? [];
  } catch {
    return [];
  }
}

/** `worktree create` — resolve a thread's checkout, creating it on first use. */
function runCreate(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
): ThreadWorktreeResolution {
  const thread = requireThread(options, 'create');
  // WHERE A THREAD BEGINS IS RESOLVED IN ONE PLACE, and this verb is not it.
  // It used to be: this line read the repository's TRUNK and handed it over as
  // the base, which is right for a loop (a scheduled run starts from somewhere
  // shared and stable) and wrong for a thread — a person opening a thread about
  // the branch they are on got a worktree that could not see that branch, nor
  // the commits on it they had not pushed.
  const start = resolveThreadStart(runtime.exec, options.target, {
    base: options.base,
    checkout: options.checkout,
    trunk: options.trunk,
  });
  const resolution = resolveThreadWorktree({
    exec: runtime.exec,
    repoRoot: options.target,
    thread,
    start,
    links: configuredLinks(options.target),
    ...(runtime.fs === undefined ? {} : { fs: runtime.fs }),
    ...(options.detach === true ? { detach: true } : {}),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    ...(options.worktreeName === undefined ? {} : { worktreeName: options.worktreeName }),
    ...(options.create === false ? { create: false } : {}),
    ...(options.fetch === false ? { fetch: false } : {}),
  });
  if (resolution.status !== 'absent') recordCheckoutOwner(resolution.path, thread);
  return resolution;
}

/**
 * `worktree prune` — remove a thread's checkout, keeping its branch.
 *
 * THE TYPED VERB IS THE CONFIRMATION. `pruneThreadWorktree` refuses without one
 * (forbidden-pattern #15) because the caller it is guarding against is a
 * program that reached for it by accident — a test, or a sweep. Someone who
 * spelled `worktree prune --thread <slug>` has said it on purpose, and this is
 * the one place that is true.
 *
 * `--discard` IS A SECOND CONSENT, TO A DIFFERENT SENTENCE (#1797). Typing the
 * verb says "remove this worktree"; it does not say "discard these two files
 * I never committed". The library refuses the second one on its own, names what
 * is in the way, and this flag is how a person who has now READ that list says
 * yes to it. That is why the flag is not passed unconditionally the way
 * `confirmed` is — a flag nobody has to type is not a consent.
 */
function runPrune(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
): ThreadWorktreePrune {
  const thread = requireThread(options, 'prune');
  // FOUND, THEN REMOVED. The library rebuilds the path from the folder name, so
  // a named checkout pruned by id alone would be looked for where it is not and
  // answered `absent` — a success that removed nothing.
  const named = options.worktreeName?.trim() ?? '';
  const found = named.length > 0 ? null : findThreadCheckout(options, runtime, thread);
  const worktreeName =
    found !== null && found.folder !== thread ? found.folder : options.worktreeName;
  return pruneThreadWorktree({
    exec: runtime.exec,
    repoRoot: options.target,
    thread,
    confirmed: true,
    ...(runtime.fs === undefined ? {} : { fs: runtime.fs }),
    ...(options.discard === true ? { discard: true } : {}),
    ...(worktreeName === undefined ? {} : { worktreeName }),
  });
}

/** Whether a listed checkout sits inside this repo's thread container. */
function threadOf(entry: WorktreeEntry, root: string): string | null {
  if (!entry.path.startsWith(`${root}/`)) return null;
  const rest = entry.path.slice(root.length + 1);
  if (rest.length === 0) return null;
  // ONE NESTED LEVEL IS A CHECKOUT TOO. Thread checkouts live at
  // `worktree/<name>` now, and a rule written when the folder WAS the thread id
  // would report every one of them as "not a thread's checkout" — invisible to
  // the list, the cap and the orphan sweep alike.
  return rest.split('/').length > 2 ? null : rest;
}

/**
 * `worktree list` — every thread checkout this repo currently has.
 *
 * THREAD CHECKOUTS ONLY. The loops' worktrees are the loop verb's to report,
 * and the main checkout is not a worktree anyone can be handed. What a caller
 * wants from this is "which threads are holding disk, and which records are
 * dead" — the two questions Phase 5's orphan row and Phase 7's cap ask.
 */
function runList(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
  read: { bindings?: boolean } = {},
): WorktreeListing {
  const root = threadWorktreeRoot(options.target);
  const only = options.thread?.trim() ?? '';
  const checkouts =
    only.length > 0
      ? (() => {
          // A LISTING NEVER REFUSES OVER TWO CLAIMS: it is how a person sees
          // both, so every candidate is listed (the verbs that act refuse).
          if ((options.worktreeName?.trim() ?? '').length > 0) {
            const found = findThreadCheckout(options, runtime, only);
            return found === null ? [] : [found];
          }
          return threadCheckoutCandidates(threadCheckouts(options, runtime), only);
        })()
      : threadCheckouts(options, runtime);
  const worktrees: ThreadWorktreeEntry[] = checkouts.map(({ entry, folder, owner }) => {
    const branch = entry.branch ?? null;
    return {
      thread: folder,
      ...(owner === null ? {} : { owner }),
      path: entry.path,
      branch,
      head: entry.head ?? null,
      locked: entry.locked,
      prunable: entry.prunable,
      // ONE READ ANSWERS THE PANEL (NFR-3). The IDE reconciles its mirror from
      // this listing rather than asking git per row; a detached worktree has
      // no branch to carry an upstream, so it is unbound without being asked.
      ...(read.bindings === true
        ? bindingFields(runtime.exec, entry.path, branch)
        : {}),
    };
  });
  return { status: 'listed', root, worktrees };
}

/** One thread checkout as git lists it, with its folder and recorded owner. */
interface ThreadCheckout {
  entry: WorktreeEntry;
  /** Its folder inside the thread container (`<id>` or `worktree/<name>`). */
  folder: string;
  /** The thread the checkout records it was cut for, or null when unrecorded. */
  owner: string | null;
}

/** Every thread checkout git knows about for this repository. */
function threadCheckouts(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
): ThreadCheckout[] {
  const root = threadWorktreeRoot(options.target);
  const listing = parseWorktreeList(
    runtime.exec('git', ['worktree', 'list', '--porcelain'], options.target),
  );
  const checkouts: ThreadCheckout[] = [];
  for (const entry of listing) {
    const folder = threadOf(entry, root);
    if (folder === null) continue;
    checkouts.push({ entry, folder, owner: readCheckoutOwner(entry.path) });
  }
  return checkouts;
}

/**
 * THE ONE ANSWER TO "WHICH CHECKOUT IS THIS THREAD'S".
 *
 * Every verb that takes `--thread` and acts on an EXISTING checkout asks here —
 * list, name, promote, detach, prune, bind, push, pr. It used to be a folder
 * comparison (`folder === thread`), which was true while the folder WAS the
 * thread id and became false for every checkout cut after folders got names
 * (`worktree/<name>`): bind, push and pr refused `has no worktree` over a
 * checkout that was right there. The app had already moved to joining by
 * canonical path; this is the CLI's half.
 *
 * Git's own worktree list is the source of truth for what exists. Matched, in
 * order of how much each one knows:
 *
 *   1. The folder the caller named (`--worktree-name`) — the app's record of
 *      the path, compared canonically so `/tmp` and `/private/tmp` agree.
 *   2. The owner the checkout records for itself — written by `create` and
 *      `name`, so a terminal or a skill passing only `--thread` finds it.
 *   3. A folder that IS the thread id — every checkout cut before names.
 *
 * TWO CLAIMS ARE A QUESTION, NOT A RACE. When 2 and 3 name different checkouts
 * (or two checkouts both record the thread), the order above would silently
 * pick one — and prune would delete it. Instead this refuses `ambiguous-thread`
 * with every claimant in the payload; naming the folder settles it.
 *
 * A NAMED FOLDER THAT IS NOT THERE IS NOT A REASON TO GUESS. When the caller
 * says which folder, and git lists nothing there, the answer is null rather
 * than whichever other checkout happens to carry the id.
 */
function findThreadCheckout(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
  thread: string,
): ThreadCheckout | null {
  const checkouts = threadCheckouts(options, runtime);
  const named = options.worktreeName?.trim() ?? '';
  if (named.length > 0) {
    const expected = canonicalTarget(threadWorktreePath(options.target, thread, named));
    return checkouts.find((checkout) => canonicalTarget(checkout.entry.path) === expected) ?? null;
  }
  const candidates = threadCheckoutCandidates(checkouts, thread);
  if (candidates.length > 1) {
    // TWO CHECKOUTS CLAIM ONE THREAD — never pick one. Every caller here acts
    // on what it gets (prune deletes it, push publishes it), so the person
    // decides which one by naming its folder (`--worktree-name`).
    const payload: AmbiguousThreadRefusal = {
      refused: 'ambiguous-thread',
      thread,
      checkouts: candidates.map((checkout) => ({
        folder: checkout.folder,
        path: checkout.entry.path,
        owner: checkout.owner,
        branch: checkout.entry.branch ?? null,
      })),
    };
    throw new WorktreeRefusal(
      `ambiguous-thread — ${String(candidates.length)} checkouts claim thread '${thread}'; name the one you mean by its folder`,
      payload,
    );
  }
  return candidates[0] ?? null;
}

/** The payload of an `ambiguous-thread` refusal: every checkout that claims the thread. */
interface AmbiguousThreadRefusal {
  refused: 'ambiguous-thread';
  thread: string;
  checkouts: Array<{ folder: string; path: string; owner: string | null; branch: string | null }>;
}

/**
 * Every checkout that claims `thread` by id alone: each one recording it as
 * its owner, and a folder that IS the id. One owner and the same checkout's
 * folder are one claim; anything else that adds up to two is a disagreement.
 */
function threadCheckoutCandidates(checkouts: readonly ThreadCheckout[], thread: string): ThreadCheckout[] {
  const owned = checkouts.filter((checkout) => checkout.owner === thread);
  const byFolder = checkouts.filter((checkout) => checkout.folder === thread);
  // A folder named for the thread but recorded as ANOTHER thread's is that thread's.
  const unclaimedFolders = byFolder.filter((checkout) => checkout.owner === null);
  if (owned.length === 0) return byFolder;
  const extra = unclaimedFolders.filter((checkout) => !owned.includes(checkout));
  return [...owned, ...extra];
}

/** Where git keeps one worktree's own administrative files, or null. */
function checkoutGitDir(path: string): string | null {
  try {
    const pointer = readFileSync(join(path, '.git'), 'utf-8').trim();
    if (!pointer.startsWith('gitdir:')) return null;
    const dir = pointer.slice('gitdir:'.length).trim();
    return isAbsolute(dir) ? dir : resolve(path, dir);
  } catch {
    // Not a linked worktree (or not on disk): nothing records an owner there.
    return null;
  }
}

/**
 * The file a checkout records its thread in.
 *
 * INSIDE GIT'S PER-WORKTREE DIRECTORY, not the checkout: it never shows up in
 * `git status`, and git removes it with the worktree, so a pruned checkout
 * cannot leave a stale claim behind.
 */
const OWNER_FILE = 'planflow-thread';

/** The thread a checkout records it belongs to, or null. Fail-soft. */
function readCheckoutOwner(path: string): string | null {
  const dir = checkoutGitDir(path);
  if (dir === null) return null;
  try {
    const owner = readFileSync(join(dir, OWNER_FILE), 'utf-8').trim();
    return owner.length > 0 ? owner : null;
  } catch {
    return null;
  }
}

/**
 * Record on the checkout which thread it was cut for.
 *
 * Fail-soft by design: the record is how a later `--thread` lookup finds a
 * NAMED folder without being told its name; failing to write it leaves the
 * folder-name and `--worktree-name` routes exactly as they were.
 */
function recordCheckoutOwner(path: string, thread: string): void {
  const dir = checkoutGitDir(path);
  if (dir === null) return;
  try {
    writeFileSync(join(dir, OWNER_FILE), `${thread}\n`);
  } catch {
    // Unwritable admin dir: the other two lookup routes still work.
  }
}

/** The three binding fields of one listed worktree, read from git. */
function bindingFields(
  exec: GitExec,
  path: string,
  branch: string | null,
): { remote: string | null; remoteBranch: string | null; bound: boolean } {
  const binding = branch === null ? null : readBinding(exec, path, branch);
  if (binding === null) return { remote: null, remoteBranch: null, bound: false };
  return { remote: binding.remote, remoteBranch: binding.remoteBranch, bound: true };
}

/** What `branches` answers with. */
export interface WorktreeBranchListing {
  status: 'listed';
  /** The branch the main checkout is on, or null when its HEAD is detached. */
  current: string | null;
  branches: ThreadBranchOption[];
}

/**
 * `worktree branches` — the branches a worktree could start from.
 *
 * READ-ONLY, AND IT EXISTS FOR THE PICKER. A surface that asks a person which
 * branch to start from needs to know which branches there are AND which of them
 * are already open somewhere — because a branch open in the project's own
 * checkout cannot be opened in a second one, and offering an action git will
 * refuse is worse than offering the two that work. That fact comes from
 * `git worktree list`, never from a path-shaped guess.
 */
function runBranches(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
): WorktreeBranchListing {
  return {
    status: 'listed',
    current: currentBranch(runtime.exec, options.target),
    branches: threadBranchOptions(runtime.exec, options.target),
  };
}

/** `worktree name` — give a detached checkout the branch its title earned. */
function runName(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
): { status: 'named' | 'unchanged'; thread: string } & WorktreeNaming {
  const thread = requireThread(options, 'name');
  const branch = options.branch?.trim() ?? '';
  if (branch.length === 0) {
    throw new Error('name requires --branch <ref>');
  }
  // LOOKED UP, NOT RESOLVED. A resolve would refresh the checkout on the way
  // past — a fetch and a fast-forward nobody asked for, in the middle of what
  // is only a rename. Found through the one resolver, which knows a named
  // folder from the thread id (see `findThreadCheckout`).
  const existing = findThreadCheckout(options, runtime, thread);
  if (existing === null) {
    throw new Error(`thread '${thread}' has no worktree to name`);
  }
  // Recorded on the way past, so a checkout cut before the record existed is
  // findable by its thread id from now on.
  recordCheckoutOwner(existing.entry.path, thread);
  const naming = nameWorktreeBranch({
    exec: runtime.exec,
    repoRoot: options.target,
    path: existing.entry.path,
    branch,
  });
  return { ...naming, thread };
}

/**
 * `worktree promote` — give a worktree its own dependencies once its manifests
 * have stopped matching the main checkout's.
 *
 * A VERB, because the app cannot reach the mechanism any other way: it never
 * imports CLI source, so a promotion that existed only as an exported function
 * would be a hazard closed on paper. WHEN this runs is the app's decision —
 * after a turn, before the next one, never during (plan decision 3).
 */
function runPromote(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
): { thread: string } & DependencyPromotion {
  const thread = requireThread(options, 'promote');
  const existing = findThreadCheckout(options, runtime, thread)?.entry;
  if (existing === undefined) {
    throw new Error(`thread '${thread}' has no worktree whose dependencies could be promoted`);
  }
  const promoted = promoteDependencies({
    exec: runtime.exec,
    path: existing.path,
    ...(runtime.fs === undefined ? {} : { fs: runtime.fs }),
  });
  return { ...promoted, thread };
}

/**
 * `worktree detach` — break a worktree's `node_modules` link and say whether
 * there was one.
 *
 * WHY A VERB AND NOT A FUNCTION CALL. The app does not import this package; it
 * spawns the bundled binary. Without a verb, the app's worktree-setup step
 * would have to reimplement "is it a symlink, unlink it" on its own side, which
 * is exactly the second copy of the rule `detachSharedModules` exists to
 * prevent (allowed-pattern #14). One rule, two callers, one door.
 *
 * It removes a LINK and never a directory: a worktree that already has real
 * dependencies is a previous promotion's work and is left alone.
 */
function runDetach(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
): { thread: string; detached: boolean } {
  const thread = requireThread(options, 'detach');
  const existing = findThreadCheckout(options, runtime, thread)?.entry;
  if (existing === undefined) {
    throw new Error(`thread '${thread}' has no worktree whose dependencies could be detached`);
  }
  const detached = detachSharedModules({
    path: existing.path,
    ...(runtime.fs === undefined ? {} : { fs: runtime.fs }),
  });
  return { thread, detached };
}

// ---------------------------------------------------------------------------
// The remote binding verbs — the ONE writer of a thread's push destination
// ---------------------------------------------------------------------------
//
// NEVER GUESS is the rule all three share, and it is the reason these are verbs
// at all rather than a note in a prompt. Before them, the IDE's landing path
// pushed a thread's LOCAL branch name to a hardcoded `origin` and the
// execute-plan skill opened a pull request against whatever base was lying
// around: both succeeded, both looked right in the transcript, and both could
// put the work somewhere nobody was watching. A wrong-but-valid push is the bug.
//
// So an unbound worktree is REFUSED here (with its suggestion attached), a
// binding whose remote has gone is refused as stale, and the only way a
// destination is ever written is somebody typing it into `bind`. Enforcement
// lives in this one code path because a rule spread across prompts drifts and a
// code path cannot (allowed-pattern #14).

/** The git config key holding the name this branch published under before. */
function previousPushKey(localBranch: string): string {
  return `branch.${localBranch}.planflowPreviousPush`;
}

/** A worktree, its path and the branch it is on — what every binding verb needs. */
interface BoundWorktree {
  /** Null under `--here` — a plain checkout belongs to no thread. */
  thread: string | null;
  path: string;
  /** Never null: a detached worktree is refused before this is built. */
  branch: string;
}

/**
 * The checkout at `--target`, on whatever branch it is standing on.
 *
 * READ FROM GIT, NEVER FROM A PATH. `--here` says "this checkout"; which
 * branch that is, is git's answer and nobody else's — a caller that passed its
 * own idea of the branch could bind one branch while pushing another.
 *
 * A DETACHED HEAD IS REFUSED FOR THE SAME REASON A DETACHED WORKTREE IS: an
 * upstream is configuration on a branch, so there is nowhere to write the
 * answer to the question binding would ask.
 */
function hereWorktree(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
): BoundWorktree {
  const branch = currentBranch(runtime.exec, options.target);
  if (branch === null) {
    throw new Error('this checkout is not on a branch yet — a worktree publishes from a branch');
  }
  return { thread: null, path: options.target, branch };
}

/**
 * The thread's worktree, refused by name when it is missing or nameless.
 *
 * A DETACHED WORKTREE IS REFUSED FIRST, and with its own reason rather than
 * as "unbound". An upstream is configuration ON A BRANCH — git has nowhere to
 * write one for a detached HEAD — so a thread whose title has not landed yet
 * cannot be bound, and telling somebody their worktree is unbound would send
 * them to answer a question that has no place to put the answer.
 */
function requireWorktree(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
  verb: string,
): BoundWorktree {
  const named = options.thread?.trim() ?? '';
  const here = options.here === true;
  if (here && named.length > 0) {
    throw new Error(`${verb} takes either --thread <slug> or --here, never both`);
  }
  if (!here && named.length === 0) {
    throw new Error(`${verb} requires --thread <slug> or --here`);
  }
  if (here) return hereWorktree(options, runtime);

  const thread = requireThread(options, verb);
  const existing = findThreadCheckout(options, runtime, thread)?.entry;
  if (existing === undefined) {
    throw new Error(`thread '${thread}' has no worktree`);
  }
  if (existing.branch === undefined || existing.branch === null) {
    throw new Error(
      `thread '${thread}' is not on a branch yet — a worktree publishes from a branch`,
    );
  }
  return { thread, path: existing.path, branch: existing.branch };
}

/**
 * The project's `.flowconfig`, or null when it has none.
 *
 * FAIL-SOFT, like `configuredLinks` above it: a project without one has no
 * pattern, no default remote and no default base, which is a fine state to be
 * in — every one of those is optional and every absence falls to a lower rung.
 */
function flowConfigOf(target: string): FlowConfig | null {
  try {
    return parseFlowConfig(join(target, 'flow'));
  } catch {
    return null;
  }
}

/** `git config user.name`, for the `{user}` placeholder. Absent is fine. */
function gitUser(exec: GitExec, path: string): string | null {
  try {
    const value = exec('git', ['config', 'user.name'], path).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Whether this checkout already has a remote-tracking ref for that branch.
 *
 * THE ANSWER TO "HAS THIS THREAD PUBLISHED BEFORE", asked of git rather than of
 * a store. `refs/remotes/<remote>/<branch>` exists only because a fetch or a
 * push put it there, which makes it the local, free, offline-safe evidence
 * that this binding has been used at least once — the exact question
 * `bindingStaleness` needs answered before it is allowed to call a missing
 * remote branch stale, and the one that separates "deleted after a merge" from
 * "never pushed yet".
 */
function remoteTrackingExists(
  exec: GitExec,
  path: string,
  remote: string,
  remoteBranch: string,
): boolean {
  try {
    exec(
      'git',
      ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${remoteBranch}`],
      path,
    );
    return true;
  } catch {
    return false;
  }
}

/** The name recorded as this branch's previous published name, if any. */
function previousPushOf(exec: GitExec, path: string, localBranch: string): string | null {
  try {
    const value = exec('git', ['config', '--get', previousPushKey(localBranch)], path).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Write (or clear) the rename record `previousPushRecord` decided on. */
function recordPreviousPush(
  exec: GitExec,
  path: string,
  localBranch: string,
  value: string | null,
): void {
  try {
    if (value === null) {
      exec('git', ['config', '--unset', previousPushKey(localBranch)], path);
      return;
    }
    exec('git', ['config', previousPushKey(localBranch), value], path);
  } catch {
    // A record nobody could write is not a reason to fail a bind — the binding
    // itself is already in git, and this is a note about a branch on a remote.
  }
}

/**
 * The name still on the remote that this worktree no longer publishes to.
 *
 * Reported only while the branch is REALLY still there: the record is a pointer
 * at something somebody may need to clean up or reopen a pull request against,
 * and a pointer at a branch that has since been deleted is noise.
 */
function previouslyPushedAs(
  exec: GitExec,
  worktree: BoundWorktree,
  remote: string,
): string | undefined {
  const stamped = previousPushOf(exec, worktree.path, worktree.branch);
  if (stamped === null) return undefined;
  return remoteTrackingExists(exec, worktree.path, remote, stamped) ? stamped : undefined;
}

/** The placeholders a branch-name pattern may name, in the order they read. */
const PATTERN_PLACEHOLDERS = ['ticket', 'slug', 'local', 'user'] as const;

/** Every `{word}` a pattern names that nothing can fill. */
function unknownPlaceholders(pattern: string): string[] {
  const named = [...pattern.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '');
  return named.filter(
    (name) => !(PATTERN_PLACEHOLDERS as readonly string[]).includes(name),
  );
}

/** What a push or a pull request would OFFER if it found nothing bound. */
interface SuggestionInputs {
  /** The remote to offer, before it is checked against this checkout's own. */
  remote: string;
  /** The pattern the suggestion ladder's first rung fills, or null for none. */
  pattern: string | null;
}

/**
 * The suggestion inputs a caller typed, over the ones the project file holds.
 *
 * VALIDATED HERE, WHERE THEY WERE TYPED (allowed-pattern #22), and validated
 * whether or not a suggestion ends up being built: a caller that hands this
 * verb a remote name git could never hold has made a mistake, and reporting it
 * only for the worktrees that happen to be unbound would make the refusal
 * depend on state the caller cannot see.
 *
 * THE FILE'S OWN VALUES ARE NOT VALIDATED, deliberately. `.flowconfig` is
 * hand-editable and its bad values already degrade — an unfillable pattern
 * falls to the next rung, a remote this checkout does not have is dropped from
 * the offer — and turning that into a refusal would break projects that work
 * today for a suggestion nobody is obliged to accept.
 */
function suggestionInputs(
  options: WorktreeCommandOptions,
  config: FlowConfig | null,
): SuggestionInputs {
  const typedRemote = options.defaultRemote?.trim() ?? '';
  if (typedRemote.length > 0 && !isValidRemoteName(typedRemote)) {
    throw new Error(`'${typedRemote}' is not the name of a remote`);
  }
  const typedPattern = options.branchPattern?.trim() ?? '';
  if (typedPattern.length > 0) {
    const unknown = unknownPlaceholders(typedPattern);
    if (unknown.length > 0) {
      throw new Error(
        `a branch name pattern cannot fill '{${unknown[0] as string}}' — it knows ` +
          `${PATTERN_PLACEHOLDERS.map((name) => `{${name}}`).join(', ')}`,
      );
    }
  }
  return {
    remote: typedRemote.length > 0 ? typedRemote : (config?.remote?.trim() ?? ''),
    pattern: typedPattern.length > 0 ? typedPattern : (config?.remote_branch_pattern ?? null),
  };
}

/** The base a pull request would open against, from the caller and the project. */
function baseFor(options: WorktreeCommandOptions, config: FlowConfig | null): string | null {
  return resolvePrBase({
    override: options.base ?? null,
    prBase: options.prBase ?? null,
    configBranch: config?.branch ?? null,
  });
}

/**
 * The worktree's binding, or a refusal carrying what a person needs to decide.
 *
 * THE SUGGESTION IS BUILT HERE, at the moment of refusal, because that is the
 * only moment it is worth building: every rung of the ladder costs a git call
 * or a config read, and a bound worktree — which is nearly all of them after
 * the first push — never pays any of it.
 */
function requireBinding(
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
  worktree: BoundWorktree,
  config: FlowConfig | null,
  inputs: SuggestionInputs,
): { binding: RemoteBinding; autoBound?: AutoBound } {
  const binding = readBinding(
    runtime.exec,
    worktree.path,
    worktree.branch,
    options.prBase ?? null,
  );
  if (binding !== null) return { binding };

  const suggested = suggestRemoteBranch({
    pattern: inputs.pattern,
    threadTitle: options.threadTitle ?? null,
    planName: options.plan ?? null,
    lastBinding: lastBinding(runtime.exec, options.target),
    localBranch: worktree.branch,
    user: gitUser(runtime.exec, worktree.path),
    // The built-in `feat/…` default is offered ONLY when nobody is present to
    // decide; an attended unbound refusal keeps its historical suggestion.
    applyBuiltinDefault: options.unattended === true,
  });
  const remotes = remoteNames(runtime.exec, worktree.path);
  // THE PROJECT'S USUAL REMOTE IS OFFERED, NOT APPLIED. It is checked against
  // the remotes this checkout really has for the same reason `bind` checks a
  // typed one: git will hold `branch.<x>.remote = typo` without complaint and
  // only fail at the push.
  const configured = inputs.remote;
  const offeredRemote = remotes.includes(configured) ? configured : null;

  // AUTO-BIND — the single narrowing of "never guess" (allowed-pattern #22),
  // reachable ONLY through the explicit `--unattended` flag and ONLY on a
  // confident rung. `autoBindDecision` is the one place that judgment lives; if
  // it says `apply`, the run writes the binding it would otherwise have asked a
  // person to confirm, and reports it back so the coordinator can record the
  // escalation (FR-6). A weak rung falls straight through to the refusal below,
  // so an unattended run is never worse than an attended one — only quieter when
  // the answer was already the project's own convention.
  //
  // THE REMOTE STILL MUST EXIST. The confident decision is about the BRANCH
  // NAME; the remote is the project's usual one, and if this checkout does not
  // actually have it there is nothing safe to apply — so we decline to the ask
  // rather than binding to a remote that would only fail at push (the empty-
  // remote corollary of allowed-pattern #22).
  if (
    options.unattended === true &&
    offeredRemote !== null &&
    autoBindDecision(suggested, { unattended: true }) === 'apply'
  ) {
    const applied: RemoteBinding = {
      remote: offeredRemote,
      remoteBranch: suggested.suggestion,
      prBase: baseFor(options, config),
    };
    writeBinding(runtime.exec, worktree.path, worktree.branch, applied);
    return {
      binding: applied,
      autoBound: {
        source: suggested.source,
        remote: offeredRemote,
        remoteBranch: suggested.suggestion,
      },
    };
  }

  const payload: UnboundRefusal = {
    refused: 'unbound',
    suggestion: suggested.suggestion,
    source: suggested.source,
    remote: offeredRemote,
    remotes,
    base: baseFor(options, config),
  };
  throw new WorktreeRefusal(
    `unbound — nobody has said where '${worktree.branch}' publishes to`,
    payload,
  );
}

/**
 * `worktree bind` — say where this worktree publishes, once and on purpose.
 *
 * BOTH VALUES ARE REQUIRED (C-4, forbidden-pattern #15). A `bind` that
 * defaulted its remote, or took the local name when `--branch` was omitted,
 * would be the guess this whole feature exists to remove — wearing a verb's
 * clothes, so that every caller after it could honestly say a person had
 * decided.
 *
 * TYPED INPUT IS VALIDATED, NEVER SANITIZED. `sanitizeRefName` exists for the
 * suggestion path, where a thread title has to become SOMETHING; here the
 * value came from a person, and quietly rewriting it would mean the branch
 * they were shown is not the branch that gets written.
 */
function runBind(options: WorktreeCommandOptions, runtime: ResolvedRuntime): WorktreeBinding {
  const remote = options.remote?.trim() ?? '';
  const remoteBranch = options.branch?.trim() ?? '';
  if (remote.length === 0) throw new Error('bind requires --remote <name>');
  if (remoteBranch.length === 0) throw new Error('bind requires --branch <ref>');
  if (!isValidRemoteName(remote)) throw new Error(`'${remote}' is not the name of a remote`);
  if (!isValidRefName(remoteBranch)) throw new Error(`'${remoteBranch}' is not a branch name`);

  // A PLAIN CHECKOUT HAS NOWHERE TO KEEP A PR BASE, so it refuses the flag
  // rather than echoing it back as decided (#1834).
  //
  // `writeBinding` deliberately writes only the two keys git owns
  // (`branch.<local>.remote` / `.merge`) — its comment says why: "prBase IS NOT
  // WRITTEN. Git has no key for it; the store is its home", and keeping that
  // function git-only is what makes "git is the truth" true for the fields git
  // actually has. A `--thread` caller is fine because the app mirrors `prBase`
  // into the thread store and passes it back on the next call. `--here` has no
  // store, so the value was accepted, printed in `bound: … onto <prBase>`, and
  // dropped — and the next `pr --here` fell through to the project's `branch:`
  // key and opened against a base the person had explicitly not chosen, exit 0.
  //
  // REFUSED, NOT INVENTED A HOME FOR. Adding a git key for it would overturn
  // the decision quoted above, which is not this fix's to make. Nothing is
  // lost: `pr` takes `--pr-base` directly, which is where a plain checkout's
  // base belongs — at the call that uses it.
  if (options.here === true && (options.prBase?.trim() ?? '').length > 0) {
    throw new Error(
      '--pr-base cannot be recorded by a --here bind: a plain checkout has no store to keep it in. ' +
        'Pass --pr-base to `worktree pr` instead, which is the call that uses it',
    );
  }

  const worktree = requireWorktree(options, runtime, 'bind');
  // A REMOTE THIS REPOSITORY DOES NOT HAVE is refused before anything is
  // written: git will accept `branch.<x>.remote = typo` without complaint and
  // only fail at the push, by which time the binding is on disk and looks
  // decided.
  const remotes = remoteNames(runtime.exec, worktree.path);
  if (remotes.length > 0 && !remotes.includes(remote)) {
    throw new Error(`this repository has no remote named '${remote}'`);
  }

  const existing = readBinding(runtime.exec, worktree.path, worktree.branch);
  const renamedFrom =
    existing !== null &&
    existing.remoteBranch !== remoteBranch &&
    remoteTrackingExists(runtime.exec, worktree.path, existing.remote, existing.remoteBranch)
      ? existing.remoteBranch
      : null;

  const prBase = options.prBase?.trim() ?? '';
  writeBinding(runtime.exec, worktree.path, worktree.branch, {
    remote,
    remoteBranch,
    prBase: prBase.length > 0 ? prBase : null,
  });

  const record = previousPushRecord({
    stamped: previousPushOf(runtime.exec, worktree.path, worktree.branch),
    renamedFrom,
    remoteBranch,
  });
  recordPreviousPush(runtime.exec, worktree.path, worktree.branch, record);

  return {
    status: 'bound',
    thread: worktree.thread,
    branch: worktree.branch,
    remote,
    remoteBranch,
    prBase: prBase.length > 0 ? prBase : null,
    ...(record === null ? {} : { previouslyPushedAs: record }),
  };
}

/**
 * `worktree push` — send the worktree's branch exactly where it is bound.
 *
 * THE REFSPEC IS SPELLED OUT ON BOTH SIDES (`bindingRefspec`), so the
 * destination is the binding rather than a function of whatever `push.default`
 * this machine happens to have.
 *
 * THE UPSTREAM IS RE-WRITTEN AFTER A SUCCESSFUL PUSH rather than passed as
 * `--set-upstream`: the two keys are already what `bind` wrote, so this is an
 * idempotent confirmation that costs nothing and repairs a worktree whose
 * config was edited by hand between the read and the push.
 */
function runPush(options: WorktreeCommandOptions, runtime: ResolvedRuntime): WorktreePush {
  const worktree = requireWorktree(options, runtime, 'push');
  const config = flowConfigOf(options.target);
  const { binding, autoBound } = requireBinding(
    options,
    runtime,
    worktree,
    config,
    suggestionInputs(options, config),
  );

  // ONLY A BINDING THAT HAS PUBLISHED BEFORE can be stale for a missing remote
  // branch — a first push has nothing on the remote yet and refusing it would
  // make the feature impossible to use.
  const stale = bindingStaleness({
    exec: runtime.exec,
    path: worktree.path,
    binding,
    expectRemoteBranch: remoteTrackingExists(
      runtime.exec,
      worktree.path,
      binding.remote,
      binding.remoteBranch,
    ),
  });
  if (stale !== null) throw new Error(`stale — ${stale}`);

  try {
    runtime.exec(
      'git',
      ['push', binding.remote, bindingRefspec(worktree.branch, binding)],
      worktree.path,
    );
  } catch (error) {
    throw new Error(pushFailureReason(error, binding));
  }
  writeBinding(runtime.exec, worktree.path, worktree.branch, binding);

  const previous = previouslyPushedAs(runtime.exec, worktree, binding.remote);
  return {
    status: 'pushed',
    thread: worktree.thread,
    branch: worktree.branch,
    remote: binding.remote,
    remoteBranch: binding.remoteBranch,
    pushed: true,
    ...(previous === undefined ? {} : { previouslyPushedAs: previous }),
    ...(autoBound === undefined ? {} : { autoBound }),
  };
}

/**
 * Why a push failed, as a sentence — never git's transcript.
 *
 * TWO THINGS WERE WRONG WITH LETTING THE RAW ERROR THROUGH (#1792). The reason
 * a reader saw began `Command failed: git push origin feat/x:feature/x` — an
 * argv, not a reason, and a terminal command inside text that `--human`
 * surfaces and the execute-plan skill relay verbatim (forbidden-pattern #12).
 * And git had ALREADY written that transcript to the inherited stderr, so
 * embedding it again put the same eight lines on the terminal twice. The
 * transcript is still there, once, where git put it; this is the line that says
 * what it meant.
 *
 * THE REJECTION IS NAMED because it is the one failure here a reader can act
 * on. Collapsed into a generic "could not push", a non-fast-forward is
 * indistinguishable from a network outage — which is exactly what the IDE's
 * landing flow was reduced to reporting. Anything else keeps git's own words,
 * bounded, minus the invocation.
 */
function pushFailureReason(error: unknown, binding: RemoteBinding): string {
  const message = error instanceof Error ? error.message : String(error);
  const where = `${binding.remote}/${binding.remoteBranch}`;
  if (/\[rejected\]|fetch first|non-fast-forward|behind its remote/i.test(message)) {
    return `${where} has work this branch does not — nothing was pushed`;
  }
  // GIT'S DIAGNOSIS, NOT ITS TRANSCRIPT. Two kinds of line are dropped on the
  // way out and both are forbidden-pattern #12: the `Command failed: git push
  // …` preamble, which is an invocation the caller already made, and git's
  // `hint:` lines, which are instructions to run something else ("use 'git
  // pull' before pushing again") aimed at a terminal user this reason may never
  // reach. What is left is what git said went wrong.
  const detail = oneLine(
    message
      .split('\n')
      .filter((line) => /^\s*(?:fatal|error|remote):/i.test(line))
      .join(' '),
  );
  return detail.length === 0
    ? `could not push to ${where}`
    : `could not push to ${where} — ${detail}`;
}

/**
 * `worktree pr` — open a pull request from the bound branch onto a named base.
 *
 * `--repo` FOR ANYTHING BUT `origin`, and this is the failure the plan's risk
 * table named: `gh` works its repository out from the checkout's `origin`, so
 * a thread bound to a fork or a mirror would have its pull request opened
 * against the wrong repository while reporting success. The remote's own URL
 * is the only place the right answer lives.
 *
 * NO BASE, NO PULL REQUEST. `main` is a guess, and a guess here targets a
 * branch nobody chose — the same mistake as an unbound push, one level up.
 */
function runPr(options: WorktreeCommandOptions, runtime: ResolvedRuntime): WorktreePullRequest {
  const worktree = requireWorktree(options, runtime, 'pr');
  const config = flowConfigOf(options.target);
  const { binding } = requireBinding(
    options,
    runtime,
    worktree,
    config,
    suggestionInputs(options, config),
  );

  const title = options.title?.trim() ?? '';
  if (title.length === 0) throw new Error('pr requires --title <text>');

  const base = baseFor(options, config);
  if (base === null) {
    throw new Error('no base — nothing has said which branch this pull request opens against');
  }

  const args = [
    'pr',
    'create',
    '--head',
    binding.remoteBranch,
    '--base',
    base,
    '--title',
    title,
    '--body',
    flagOrStdinSync(options.body),
  ];
  if (binding.remote !== 'origin') {
    const slug = parseRepoSlug(remoteUrl(runtime.exec, worktree.path, binding.remote));
    if (slug === null) {
      throw new Error(`cannot tell which repository '${binding.remote}' names`);
    }
    args.push('--repo', slug);
  }

  let output: string;
  try {
    output = runtime.exec('gh', args, worktree.path);
  } catch (error) {
    throw new Error(prFailureReason(error, binding, base));
  }

  return {
    status: 'opened',
    thread: worktree.thread,
    remote: binding.remote,
    remoteBranch: binding.remoteBranch,
    base,
    url: firstUrl(output),
  };
}

/**
 * Why a pull request could not be opened, as a sentence — never gh's argv.
 *
 * `runPush` has had this since #1792; `runPr` did not, so its failure fell to
 * the generic refusal formatter and the reason a reader saw was the whole
 * `gh pr create …` invocation (#1836). Same forbidden-pattern #12, one verb
 * over.
 *
 * THE BODY IS IN THAT INVOCATION, and that is what makes this worse than #1792
 * rather than equal to it. The auto-PR path passes the five-section body
 * regenerated from `flow/.rounds.jsonl`, so the 200-character reason budget was
 * spent printing the user's own PR description back at them and gh's actual
 * diagnosis — "No commits between main and feature/probe" — was truncated off
 * the end. They were told the PR failed and shown their own body as the
 * explanation.
 *
 * WHAT IS KEPT IS WHAT GH SAID. Its diagnosis arrives on stderr, which
 * `execFileSync` appends to the message after the `Command failed:` preamble,
 * so the preamble and the argv are dropped and the rest is bounded. If nothing
 * recognisable survives, the sentence still names the destination — a reason
 * that says where it failed beats one that quotes a command back.
 */
function prFailureReason(error: unknown, binding: RemoteBinding, base: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const where = `${binding.remote}/${binding.remoteBranch} → ${base}`;

  // Everything from gh's own report onward. `gh` prefixes its failures with
  // one of these; anything before is the invocation this caller already made.
  const said = message.match(/(?:pull request create failed|GraphQL|HTTP \d{3}|gh:)[^\n]*/i);
  const detail = oneLine(
    (said?.[0] ?? '')
      // The prefix is scaffolding — "pull request create failed: GraphQL: X"
      // says "X" twice over before it says anything.
      .replace(/^pull request create failed:\s*/i, '')
      .replace(/^GraphQL:\s*/i, ''),
  );

  return detail.length === 0
    ? `could not open a pull request on ${where}`
    : `could not open a pull request on ${where} — ${detail}`;
}

/** A remote's configured URL, or null when it has none this checkout can read. */
function remoteUrl(exec: GitExec, path: string, remote: string): string | null {
  try {
    const value = exec('git', ['remote', 'get-url', remote], path).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Where a resolve says the worktree began, for the human line. */
function startedFrom(resolved: ThreadWorktreeResolution): string {
  if (resolved.onBase) return ` on ${resolved.base ?? ''}`;
  if (resolved.base === null) return ' from a detached HEAD';
  return ` from ${resolved.base}`;
}

/** The compact human form of the SAME result object. */
export function renderHuman(verb: WorktreeVerb, result: WorktreeVerbResult): string {
  if (verb === 'bind') {
    const bound = result as WorktreeBinding;
    const base = bound.prBase === null ? '' : ` onto ${bound.prBase}`;
    const previous =
      bound.previouslyPushedAs === undefined
        ? ''
        : `\n  previously published as ${bound.previouslyPushedAs} — still on ${bound.remote}`;
    return `bound: ${bound.branch} → ${bound.remote}/${bound.remoteBranch}${base}${previous}`;
  }
  if (verb === 'push') {
    const pushed = result as WorktreePush;
    const previous =
      pushed.previouslyPushedAs === undefined
        ? ''
        : `\n  previously published as ${pushed.previouslyPushedAs} — still on ${pushed.remote}`;
    const bound =
      pushed.autoBound === undefined
        ? ''
        : `\n  auto-bound unattended (${pushed.autoBound.source}) — no one was asked`;
    return `pushed: ${pushed.branch} → ${pushed.remote}/${pushed.remoteBranch}${bound}${previous}`;
  }
  if (verb === 'pr') {
    const opened = result as WorktreePullRequest;
    const where = opened.url === null ? '' : `\n  ${opened.url}`;
    return `opened: ${opened.remote}/${opened.remoteBranch} → ${opened.base}${where}`;
  }
  if (verb === 'branches') {
    const listing = result as WorktreeBranchListing;
    if (listing.branches.length === 0) return 'no branches';
    return listing.branches
      .map((branch) => {
        const notes = [
          branch.current ? 'current' : '',
          branch.trunk ? 'default' : '',
          branch.remoteOnly ? 'remote only' : '',
          branch.heldBy === null ? '' : `open in ${branch.heldBy}`,
        ].filter((note) => note.length > 0);
        return notes.length === 0 ? branch.name : `${branch.name} (${notes.join(', ')})`;
      })
      .join('\n');
  }
  if (verb === 'list') {
    const listing = result as WorktreeListing;
    if (listing.worktrees.length === 0) return 'no thread worktrees';
    return listing.worktrees
      .map((entry) => {
        const flags = [entry.locked ? 'locked' : '', entry.prunable ? 'prunable' : ''].filter(
          (flag) => flag.length > 0,
        );
        const suffix = flags.length > 0 ? ` (${flags.join(', ')})` : '';
        const publishes =
          entry.bound === true ? ` → ${entry.remote ?? ''}/${entry.remoteBranch ?? ''}` : '';
        return `${entry.path} [${entry.branch ?? 'detached'}]${publishes}${suffix}`;
      })
      .join('\n');
  }
  if (verb === 'name') {
    const naming = result as WorktreeNaming;
    const moved = naming.requested === undefined ? '' : ` (asked for ${naming.requested})`;
    return `${naming.status}: ${naming.branch}${moved}`;
  }
  if (verb === 'promote') {
    const promoted = result as DependencyPromotion;
    if (promoted.status === 'clean') return 'clean: dependencies still match the project';
    if (promoted.status === 'manual') return `manual: ${promoted.detail}`;
    return `installed: ${(promoted.installed ?? []).join(' ')} (${promoted.manifests.join(', ')})`;
  }
  if (verb === 'prune') {
    const pruned = result as ThreadWorktreePrune;
    return `${pruned.status}: ${pruned.path}`;
  }
  const resolved = result as ThreadWorktreeResolution;
  const lines = [
    `${resolved.status}: ${resolved.path} [${resolved.branch ?? 'detached'}]${startedFrom(resolved)}`,
  ];
  if (resolved.refresh !== undefined && resolved.refresh.detail.length > 0) {
    lines.push(`  ${resolved.refresh.state} — ${resolved.refresh.detail}`);
  }
  const linked = (resolved.links ?? []).filter((link) => link.status === 'linked');
  if (linked.length > 0) {
    lines.push(`  linked: ${linked.map((link) => link.entry).join(', ')}`);
  }
  return lines.join('\n');
}

/** Route a verb to its runner. */
function dispatch(
  verb: WorktreeVerb,
  options: WorktreeCommandOptions,
  runtime: ResolvedRuntime,
): WorktreeVerbResult {
  switch (verb) {
    case 'create':
      return runCreate(options, runtime);
    case 'prune':
      return runPrune(options, runtime);
    case 'list':
      return runList(options, runtime, { bindings: true });
    case 'name':
      return runName(options, runtime);
    case 'promote':
      return runPromote(options, runtime);
    case 'detach':
      return runDetach(options, runtime);
    case 'branches':
      return runBranches(options, runtime);
    case 'bind':
      return runBind(options, runtime);
    case 'push':
      return runPush(options, runtime);
    case 'pr':
      return runPr(options, runtime);
  }
}

/**
 * `worktree <verb>` — the thread worktree family behind one refusal contract.
 *
 * On any failure: one `worktree refused:` line, exit 1, and nothing created.
 * The two refusals that matter most — a non-git directory and a repository with
 * no commits — are checked before `git worktree add` runs, so a refusal never
 * leaves half a worktree behind.
 */
export function runWorktree(
  verb: string,
  options: WorktreeCommandOptions,
  runtime: WorktreeRuntime = {},
): void {
  try {
    if (!isWorktreeVerb(verb)) {
      throw new Error(`unknown verb '${verb}' — expected ${WORKTREE_VERBS.join('|')}`);
    }
    const resolved: ResolvedRuntime = {
      exec: runtime.exec ?? defaultWorktreeExec,
      ...(runtime.fs === undefined ? {} : { fs: runtime.fs }),
    };
    const result = dispatch(verb, { ...options, target: canonicalTarget(options.target) }, resolved);
    process.stdout.write(
      options.json === true ? `${JSON.stringify(result)}\n` : `${renderHuman(verb, result)}\n`,
    );
  } catch (error) {
    // A REFUSAL THAT CARRIES AN ANSWER STILL ANSWERS. `unbound` is not a
    // failure to compute anything — it is a question, and the payload is what
    // the surface asking it needs. Written to stdout with or without `--json`
    // because both callers (the IDE landing path, the execute-plan skill) parse
    // the stream rather than the exit code.
    if (error instanceof WorktreeRefusal) {
      process.stdout.write(`${JSON.stringify(error.payload)}\n`);
    }
    logError(toRefusalLine(error));
    process.exitCode = 1;
  }
}

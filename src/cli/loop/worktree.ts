/**
 * One worktree per owner — resolved, created on first use, pruned on demand.
 *
 * TWO CALLERS, ONE LIFECYCLE. This module was written for loops and is now also
 * what a THREAD's checkout is made of: `.{repo}-threads/<slug>` sits beside
 * `.{repo}-loops/<loop>`, created by the same `git worktree add`, refreshed by
 * the same fail-soft refresh, pruned by the same removal. A second
 * implementation for threads would be a second set of rules to keep in step
 * (allowed-pattern #14) — and the first divergence would be the one nobody
 * noticed. The loop-named exports below are kept exactly as they were; the
 * generalized ones sit underneath them.
 *
 * Forbidden-pattern #11 was written in this repo after commits landed on the
 * wrong branch twice: parallel agents sharing one checkout race on
 * `git checkout`, and the losing agent's commits go somewhere nobody asked for.
 * A worktree per loop removes the race by construction rather than by
 * discipline — and because the CLI can RESOLVE that path, an interactive
 * terminal lands in the same checkout a headless run uses instead of
 * improvising its own.
 *
 * ONE PER LOOP, REUSED ACROSS BEATS. Not one per issue: a loop's runs are
 * sequential (its lock says so), and a worktree per issue would leave a
 * directory behind for every item ever claimed. The consumer branches per issue
 * INSIDE its worktree.
 *
 * A WORKTREE ISOLATES CODE, NOT `flow/`. `flow/` is a single symlink into the
 * central vault, so every worktree sees the same `STATE.md` and the same loop
 * state — which is exactly why the pipeline lock exists. Nothing here tries to
 * fix that; it isolates the checkout and leaves the machinery single-writer.
 *
 * GIT IS AN INJECTED EXEC (allowed-pattern #12). Tests pass a fake and assert on
 * the argv; no test in this feature runs a real `git`, and no test manipulates
 * PATH.
 */

import {
  constants,
  copyFileSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { LOOP_NAME_PATTERN } from './directive-parser.js';
import { loopBranch } from './push-guard.js';

/** Minimal exec surface: run a binary with argv in a cwd, return stdout. */
export type GitExec = (file: string, args: readonly string[], cwd: string) => string;

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Absolute path of the checkout. */
  path: string;
  /** The commit it is on, when the listing named one. */
  head?: string;
  /** Branch name without `refs/heads/`, when it is on one. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

/**
 * Parse `git worktree list --porcelain`.
 *
 * The format is line-oriented, blank-line separated, and carries bare keys
 * (`bare`, `detached`, `prunable`) alongside `key value` pairs. Unknown keys are
 * ignored rather than refused — git has added keys before and will again, and a
 * listing this cannot parse must not stop a run from finding its checkout.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const rawLine of porcelain.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) {
      if (current !== null) entries.push(current);
      current = null;
      continue;
    }
    const spaceIndex = line.indexOf(' ');
    const key = spaceIndex === -1 ? line : line.slice(0, spaceIndex);
    const value = spaceIndex === -1 ? '' : line.slice(spaceIndex + 1).trim();

    if (key === 'worktree') {
      if (current !== null) entries.push(current);
      current = { path: value, bare: false, detached: false, locked: false, prunable: false };
      continue;
    }
    if (current === null) continue;
    if (key === 'HEAD') current.head = value;
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') current.bare = true;
    else if (key === 'detached') current.detached = true;
    else if (key === 'locked') current.locked = true;
    else if (key === 'prunable') current.prunable = true;
  }
  if (current !== null) entries.push(current);
  return entries;
}

/**
 * Who a worktree belongs to. The kind is the only thing that differs between
 * `.{repo}-loops/fix` and `.{repo}-threads/<slug>`, which is why it is a
 * parameter rather than two path builders.
 */
export type WorktreeOwnerKind = 'loop' | 'thread';

/** What each kind's container is named after — pluralized once, here. */
const OWNER_CONTAINERS: Record<WorktreeOwnerKind, string> = {
  loop: 'loops',
  thread: 'threads',
};

/**
 * Refuse rather than build a path out of a name that is not an owner name.
 *
 * ONE GRAMMAR FOR BOTH KINDS, and it is the loop's: lowercase alphanumerics
 * joined by `-`. A thread is identified by its uuid, which that grammar already
 * accepts, so nothing had to be loosened to let threads in — and loosening it
 * is what would have let a name out of its container.
 */
function requireOwnerName(name: string, kind: WorktreeOwnerKind): string {
  const value = name.trim();
  // ONE NESTED LEVEL, EACH SEGMENT HELD TO THE SAME RULE.
  //
  // A thread's checkout is named `worktree/<name>` so the folder above it says
  // what kind of thing it is and a shell prompt reads the clean name (user,
  // 2026-09-17: "should be worktree/feature-branch"). The grammar check is
  // still the traversal check — it is applied to every segment, `..` is not a
  // name, an empty segment is not a name, and three levels are refused — so the
  // guard changed shape without changing strength.
  const segments = value.split('/');
  if (segments.length > 2 || !segments.every((part) => LOOP_NAME_PATTERN.test(part))) {
    throw new Error(
      `'${name}' is not a ${kind} name — expected lowercase words joined by '-', optionally one folder deep`,
    );
  }
  return value;
}

/** Refuse rather than build a path out of a name that is not a loop name. */
function requireLoopName(loop: string): string {
  return requireOwnerName(loop, 'loop');
}

/**
 * The container every one of a repo's worktrees of ONE KIND lives in — a hidden
 * sibling of the repository.
 *
 * A SIBLING, not a subdirectory: a worktree inside the repo would show up in
 * every `git status`, every glob and every test run of the repo it is a copy
 * of. Hidden and named after the repo so one machine checking out two projects
 * gets two containers rather than a collision.
 *
 * ONE CONTAINER PER KIND, so a loop named `x` and a thread whose slug is `x`
 * cannot become the same directory, and so a person looking at their projects
 * folder can tell at a glance which pile is which.
 */
export function worktreeContainer(repoRoot: string, kind: WorktreeOwnerKind): string {
  return join(dirname(repoRoot), `.${basename(repoRoot)}-${OWNER_CONTAINERS[kind]}`);
}

/** The container every one of a repo's thread worktrees lives in. */
export function threadWorktreeRoot(repoRoot: string): string {
  return worktreeContainer(repoRoot, 'thread');
}

/**
 * Separator between a loop's name and its slot number in a worktree directory.
 *
 * `.` FOR THE SAME REASON THE ITEM BRANCH USES IT: a loop name cannot contain a
 * dot (`LOOP_NAME_PATTERN` is lowercase alphanumerics joined by `-`), so
 * `fix.2` splits back to exactly one loop and one slot. A `-` would not — a loop
 * genuinely named `fix-2` and slot 2 of loop `fix` would be the same directory.
 */
export const SLOT_SEPARATOR = '.';

/** The first slot — the original path and the original branch. */
export const PRIMARY_SLOT = 1;

/** Refuse a slot number that is not a slot. */
function requireSlot(slot: number): number {
  if (!Number.isInteger(slot) || slot < PRIMARY_SLOT) {
    throw new Error(`'${String(slot)}' is not a run slot — expected an integer of 1 or more`);
  }
  return slot;
}

/**
 * Where a named loop's worktree for a given run slot lives.
 *
 * SLOT 1 KEEPS THE BARE NAME. Every existing checkout, every path a person has
 * typed and every worktree already registered with git is slot 1's, so adding
 * slots must not move it — `fix` stays `fix`, and only genuine concurrency ever
 * produces `fix.2`.
 */
export function loopWorktreePath(repoRoot: string, loop: string, slot = PRIMARY_SLOT): string {
  return ownerWorktreePath(repoRoot, 'loop', loop, slot);
}

/**
 * Where any owner's worktree lives — the generalized form of the above.
 *
 * SLOTS ARE A LOOP'S PROBLEM, not a kind's. A thread has exactly one checkout
 * (its runs are its turns, and its turns are sequential by construction), so it
 * only ever asks for the primary slot and its directory is the bare slug. The
 * parameter stays here rather than in two functions because the numbering rule
 * — slot 1 keeps the bare name — must hold for whatever asks next.
 */
export function ownerWorktreePath(
  repoRoot: string,
  kind: WorktreeOwnerKind,
  name: string,
  slot = PRIMARY_SLOT,
): string {
  const owner = requireOwnerName(name, kind);
  const suffix = requireSlot(slot) === PRIMARY_SLOT ? '' : `${SLOT_SEPARATOR}${String(slot)}`;
  return join(worktreeContainer(repoRoot, kind), `${owner}${suffix}`);
}

/**
 * Where a thread's checkout lives.
 *
 * THE DIRECTORY'S NAME IS NOT THE THREAD'S ID. It was: the thread slug went
 * straight in as the owner name, so every checkout was a uuid on disk and a
 * person's shell prompt read `e2265b48-03e9-43e3-8f76-ff887a48615e` (user,
 * 2026-09-17). A uuid PASSES `requireOwnerName` — lowercase alphanumerics
 * joined by `-` describes one exactly — so nothing ever refused it.
 *
 * `name` is what the directory is called; absent, it stays the thread id,
 * which is what every caller written before this meant.
 */
export function threadWorktreePath(repoRoot: string, thread: string, name?: string): string {
  const owner = name?.trim();
  return ownerWorktreePath(repoRoot, 'thread', owner === undefined || owner === '' ? thread : owner);
}

/** How a resolve left the checkout relative to the remote base (#1584). */
export type WorktreeRefreshState =
  | 'refreshed' // fast-forwarded (or re-detached) to origin/<base>
  | 'current' // already at origin/<base>
  | 'skipped-dirty' // uncommitted changes — left untouched
  | 'skipped-foreign-branch' // a human's checkout — left untouched
  | 'diverged' // local commits origin/<base> lacks — left untouched
  | 'failed'; // a git step failed (offline, no remote) — left untouched

/** The refresh outcome that travels with a resolution. */
export interface WorktreeRefresh {
  state: WorktreeRefreshState;
  /** One line of why, for every state that left the tree stale; '' otherwise. */
  detail: string;
}

/**
 * Tracked modifications in a checkout, first three named — '' when clean.
 *
 * `--untracked-files=no` for the #1650 reason: build artifacts are routine in
 * these worktrees and a fast-forward cannot harm them; only real edits count.
 */
function trackedDirt(exec: GitExec, path: string): string {
  const dirt = exec('git', ['status', '--porcelain', '--untracked-files=no'], path).trim();
  if (dirt.length === 0) return '';
  return dirt
    .split('\n')
    .slice(0, 3)
    .map((line) => line.trim())
    .join(', ');
}

/**
 * Everything in a checkout that exists nowhere else, as `git status` lines.
 *
 * NOT `trackedDirt`, AND THE DIFFERENCE IS THE POINT. That one passes
 * `--untracked-files=no` because it guards a REFRESH, and a fast-forward cannot
 * harm a file git is not tracking (#1650). This guards a DELETE, where an
 * untracked file is the single most losable thing in the directory — the live
 * report was an untracked `important.txt` going silently to nothing.
 *
 * Ignored files are excluded because `--porcelain` excludes them, and SYMLINKS
 * are excluded because this function asks what would be LOST. Every thread
 * worktree has the untracked set linked into it — `node_modules`, `.env` — and
 * a repository that does not gitignore them reports each one as `??`. Deleting
 * a link destroys nothing: the target is in the main checkout and outlives the
 * prune, which `promoteDependencies` and the E2E both already rely on. Counting
 * them would degrade this guard into "never prune a worktree that has
 * dependencies", which is every worktree — the same way the refresh guard
 * failed before #1650.
 *
 * Fail-soft on a checkout git cannot read: an unreadable directory is not
 * evidence of safety, but it is also not this function's refusal to make — the
 * caller decides, and it is given `null` rather than a confident empty list.
 */
function losableWork(
  exec: GitExec,
  fs: WorktreeFs,
  path: string,
  repoRoot: string,
): string[] | null {
  try {
    const dirt = exec('git', ['status', '--porcelain'], path).trim();
    if (dirt.length === 0) return [];
    return dirt
      .split('\n')
      .filter((line) => !isProvidedIn(fs, path, repoRoot, line))
      .map((line) => line.trim());
  } catch {
    return null;
  }
}

/**
 * Whether one porcelain line names something the MAIN CHECKOUT still has.
 *
 * Two shapes, one question — "would deleting this lose anything?":
 *
 *  - an untracked SYMLINK. Deleting a link destroys nothing; the target lives
 *    in the main checkout and outlives the prune.
 *  - an untracked COPY that is still byte-identical to the main checkout's. The
 *    untracked set copies `.env*` rather than linking it, so every worktree
 *    now carries a real, untracked file that would otherwise report as dirt —
 *    which would degrade this guard into "never prune a worktree that has
 *    configuration", i.e. every worktree, the same failure #1650 fixed for the
 *    refresh guard.
 *
 * A copy that has been EDITED is losable and stays counted, which is the whole
 * reason `.env` is copied in the first place: the edit exists only here.
 */
function isProvidedIn(fs: WorktreeFs, root: string, repoRoot: string, line: string): boolean {
  if (!line.startsWith('??')) return false;
  // `?? node_modules/` — git marks a directory entry with a trailing slash, and
  // the link itself is the thing to stat.
  const name = line.slice(2).trim().replace(/\/$/, '');
  if (name.length === 0) return false;
  try {
    if (fs.isSymlink(join(root, name))) return true;
    const here = fs.readFile(join(root, name));
    if (here === null) return false;
    const there = fs.readFile(join(repoRoot, name));
    return there !== null && there === here;
  } catch {
    return false;
  }
}

/** The first few entries, for a refusal line that stays one line. */
function namedDirt(entries: readonly string[]): string {
  const shown = entries.slice(0, 3).join(', ');
  return entries.length > 3 ? `${shown}, +${String(entries.length - 3)} more` : shown;
}

/**
 * The per-checkout owner stamp — which run this slot's worktree was last
 * handed to (#1742).
 *
 * `git config --worktree`, not a loose file: it lives in git's own per-worktree
 * store, travels with the checkout, and dies with `worktree remove` — nothing
 * to clean up and nothing a build can clobber.
 */
const OWNER_CONFIG_KEY = 'planflow.loopOwner';

function lastOwnerOf(exec: GitExec, path: string): string | null {
  try {
    const value = exec('git', ['config', '--worktree', OWNER_CONFIG_KEY], path).trim();
    return value.length === 0 ? null : value;
  } catch {
    // Unset key (git exits 1) or a git too old for worktree config — no claim.
    return null;
  }
}

function stampOwner(exec: GitExec, repoRoot: string, path: string, owner: string): void {
  try {
    // Idempotent prerequisite: per-worktree config is an extension flag.
    exec('git', ['config', 'extensions.worktreeConfig', 'true'], repoRoot);
    exec('git', ['config', '--worktree', OWNER_CONFIG_KEY, owner], path);
  } catch {
    // Fail-soft: the stamp is the guard's memory, not the work itself — a git
    // that cannot store it degrades to the pre-#1742 behaviour, no worse.
  }
}

function refreshFailure(error: unknown): WorktreeRefresh {
  const message = error instanceof Error ? error.message : String(error);
  return { state: 'failed', detail: message.split('\n')[0].trim() };
}

/**
 * Bring a loop's checkout up to date with `origin/<base>` — fail-soft (#1584).
 *
 * The only `git pull` in a run used to touch the MAIN checkout, so the tree the
 * run actually worked in stayed pinned at whatever commit created it: producers
 * swept a stale slice and consumers cut item branches from a stale base. This
 * runs IN the worktree on every resolve, and refuses to touch anything that is
 * not plainly the loop's own scaffolding:
 *
 * - uncommitted changes, or a branch that is not the loop's own → left as-is,
 *   said out loud (a human's checkout is theirs; see resolveWorktree's note);
 * - `loop/<name>` with commits origin/<base> lacks → `diverged`, not reset —
 *   real work is never discarded to win freshness;
 * - offline / no remote → `failed` with the first error line, tree untouched.
 *
 * Never throws: staleness must be REPORTED (the gate's `pull: ok` claimed a
 * freshness the working tree did not have), but it must not stop a run that
 * still has local work it can do.
 */
export function refreshWorktree(input: {
  exec: GitExec;
  /** The worktree to refresh — every git command below runs in it. */
  path: string;
  /** Slot 1's `loop/<name>`, or null for a detached slot. */
  branch: string | null;
  /** The base branch to match, e.g. `main`. */
  base: string;
  /**
   * Whether to contact the remote. Default true — the safe direction.
   *
   * FALSE MEANS "SOMEONE ELSE ALREADY DID IT, FOR THIS BASE, THIS RUN" (#1625).
   * A loop worktree is a linked worktree, so `origin/<base>` here IS the ref the
   * gate's `git pull --ff-only` just updated in the main checkout — fetching it
   * again is a network round trip to learn something the ref store already
   * knows. Everything below still runs: the ff-merge to `origin/<base>` is what
   * makes the checkout current, and it is local either way.
   *
   * The caller owes the guarantee, not this function. `loop worktree` passes
   * false only from a stamp on the run's OWN unexpired lock naming this same
   * base (`LoopLockRecord.pulled`), which is the only evidence that says so.
   */
  fetch?: boolean;
}): WorktreeRefresh {
  const { exec, path, branch, base } = input;
  const shouldFetch = input.fetch !== false;
  try {
    // TRACKED modifications only (#1650). Bare `--porcelain` counts `??`
    // entries, and untracked build artifacts are ROUTINE in these worktrees
    // (node_modules links, dist/, out/) — so the guard degraded to "never
    // refresh once anything was built here", and a slot sat four days and 15
    // commits behind main reporting skipped-dirty on nothing but two symlinks.
    // A fast-forward cannot harm an untracked file; only real edits block.
    // NAME the entries — "uncommitted changes" alone was undebuggable from
    // the one-line notice a resolve prints.
    const names = trackedDirt(exec, path);
    if (names.length > 0) {
      return { state: 'skipped-dirty', detail: `uncommitted changes (${names}) — left untouched` };
    }
    const head = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], path).trim();
    if (branch !== null && head !== branch) {
      return {
        state: 'skipped-foreign-branch',
        detail: `on '${head}', not '${branch}' — left untouched`,
      };
    }
    if (branch === null && head !== 'HEAD') {
      return {
        state: 'skipped-foreign-branch',
        detail: `on '${head}', expected detached — left untouched`,
      };
    }
    if (shouldFetch) {
      exec('git', ['fetch', 'origin', base], path);
    }
    const target = exec('git', ['rev-parse', `origin/${base}`], path).trim();
    if (target === exec('git', ['rev-parse', 'HEAD'], path).trim()) {
      return { state: 'current', detail: '' };
    }
    if (branch === null) {
      exec('git', ['checkout', '--detach', `origin/${base}`], path);
      return { state: 'refreshed', detail: '' };
    }
    try {
      exec('git', ['merge', '--ff-only', `origin/${base}`], path);
    } catch {
      return {
        state: 'diverged',
        detail: `'${branch}' has commits origin/${base} lacks — left untouched`,
      };
    }
    return { state: 'refreshed', detail: '' };
  } catch (error) {
    return refreshFailure(error);
  }
}

/** What `resolveWorktree` answers with. */
export interface WorktreeResolution {
  /** `ready` — it already existed; `created` — this call made it; `absent` — it does not exist and creation was not asked for. */
  status: 'ready' | 'created' | 'absent';
  loop: string;
  /** Which run slot this checkout serves. */
  slot: number;
  /** Where the checkout is (or would be). */
  path: string;
  /**
   * The branch it sits on, or null for a slot that is detached.
   *
   * ONLY SLOT 1 HAS A BASE BRANCH, and git is what decides that: `loop/<name>`
   * is stored as the FILE `refs/heads/loop/<name>`, and a branch can be checked
   * out in exactly one worktree at a time. A second slot therefore cannot sit on
   * `loop/<name>` and must not invent a base branch of its own — a new name in
   * the `loop/*` namespace would be inside the push carve-out and would then
   * have to be recognised by the merge gate, which reads `loop/<name>.<id>` as a
   * loop and an ITEM. Detaching costs nothing instead: a consumer branches per
   * item the moment it claims one, so the base a slot starts from is scaffolding
   * that is replaced within seconds.
   */
  branch: string | null;
  /** Whether this call created it. */
  created: boolean;
  /**
   * How the checkout stands relative to `origin/<base>` after this resolve
   * (#1584). Absent only for `absent` — a tree that does not exist has no
   * freshness to report.
   */
  refresh?: WorktreeRefresh;
}

/** Everything the resolve/prune verbs need. */
export interface WorktreeInput {
  exec: GitExec;
  /**
   * Any checkout of the repository — the caller's cwd, which need not be the
   * main one. Resolved to the true main checkout via `canonicalRepoRoot`
   * before it is used to build any container path (#7).
   */
  repoRoot: string;
  loop: string;
  /** Which run slot to resolve. Defaults to the primary. */
  slot?: number;
}

/** List the repo's worktrees. */
function listWorktrees(input: { exec: GitExec; repoRoot: string }): WorktreeEntry[] {
  return parseWorktreeList(input.exec('git', ['worktree', 'list', '--porcelain'], input.repoRoot));
}

/**
 * The repository's one true root, however this call was invoked (#7).
 *
 * GIT ALWAYS ANSWERS `worktree list` WITH THE MAIN WORKTREE FIRST, from every
 * one of its linked worktrees — verified live, run from inside a loop's own
 * checkout against a repo with a dozen thread and loop worktrees registered.
 * `worktreeContainer` builds a container's path from `repoRoot`'s OWN dirname
 * and basename, so a caller whose `repoRoot` was really its own worktree (a
 * run's `--target` defaults to `process.cwd()`, and a run's cwd IS its
 * worktree) built a container next to ITSELF instead of next to the
 * repository every run shares. Two runs of the same loop, invoked from two
 * different worktrees, then computed two different containers for the same
 * loop — and because both still shared one `.git`, the second `git worktree
 * add -B loop/<name>` hard-failed: that branch was already checked out at the
 * first container's path.
 *
 * Falls back to what it was given when the listing has nothing to answer
 * with — never true of a real repository (it always has at least itself),
 * but a resolve must not crash rather than degrade to the old behaviour.
 */
function canonicalRepoRoot(repoRoot: string, entries: readonly WorktreeEntry[]): string {
  return entries[0]?.path ?? repoRoot;
}

/** What a checkout resolution establishes, before an owner names itself on it. */
interface CheckoutOutcome {
  status: 'ready' | 'created' | 'absent';
  created: boolean;
  refresh?: WorktreeRefresh;
}

/**
 * The checkout half of a resolve, with no idea who is asking.
 *
 * BOTH KINDS' RESOLVES ARE THIS FUNCTION (allowed-pattern #14). A loop's
 * resolve adds its slot bookkeeping and its owner stamp around it; a thread's
 * adds its link step. Neither owns a second copy of "does the path exist, do I
 * create it, and how does it stand relative to the base" — the rule that a
 * resolve NEVER checks out a different branch in a checkout it did not create
 * has to hold for both, and one body is the only way it does.
 */
function resolveCheckout(input: {
  exec: GitExec;
  repoRoot: string;
  path: string;
  branch: string | null;
  base: string;
  create?: boolean;
  fetch?: boolean;
  /**
   * Runs once the checkout's existence is known and before it is refreshed —
   * where a caller claims it. `existed` is false for one this call created.
   * Throwing here aborts the resolve, which is how the loop's owner guard
   * refuses a checkout carrying a sibling run's live edits (#1742).
   */
  onCheckout?: (existed: boolean) => void;
  /**
   * The commit-ish a CREATE starts from. Absent → the main checkout's HEAD,
   * which is `git worktree add`'s own default and every loop's behaviour.
   *
   * A LOCAL REF, ALWAYS. This is the half of "base" that says WHERE THE WORK
   * BEGINS, and it is deliberately not the half that says what to fetch: a
   * branch with commits that have never been pushed is exactly the case this
   * exists for, and `origin/<anything>` cannot see those commits.
   */
  startPoint?: string;
  /**
   * True when `branch` is an EXISTING branch to be checked out as it stands,
   * rather than a name to (re-)create at the start point.
   *
   * The distinction is `-B` versus nothing at all: `-B` moves a branch onto a
   * commit, and doing that to a branch somebody already has work on is a
   * silent rewrite of their history.
   */
  attach?: boolean;
  /**
   * False → never move the tree toward `origin/<base>`, on create or on reuse.
   *
   * THREADS CUT FROM A LOCAL BRANCH PASS FALSE, and the reason is the bug this
   * parameter was added for: the refresh's whole job is to fast-forward to the
   * REMOTE, so a worktree cut from a branch with unpushed commits was created
   * correctly and then immediately yanked back to `origin/<trunk>`, losing the
   * very commits the person opened the thread about. Freshness is a loop's
   * requirement (it starts from trunk on purpose); a thread's requirement is
   * that its worktree is where the person actually was.
   */
  refresh?: boolean;
  /**
   * Already-fetched `git worktree list` entries, for a caller that read the
   * listing to resolve the canonical repo root and would otherwise pay for a
   * second `git worktree list` to find them again.
   */
  entries?: readonly WorktreeEntry[];
  /** The filesystem seam, so the dead-shell cleanup below is injectable too. */
  fs?: WorktreeFs;
}): CheckoutOutcome {
  const { exec, path, branch, base } = input;
  const fs = input.fs ?? nodeWorktreeFs;
  const shouldRefresh = input.refresh !== false;
  const existing = (input.entries ?? listWorktrees(input)).find((entry) => entry.path === path);

  // A LIVE CHECKOUT IS REUSED; A DEAD SHELL IS NOT. `git worktree list` keeps
  // reporting a worktree whose `.git` has gone — its directory removed by the
  // disk cap, by a person with a Finder window, or emptied and rebuilt as a bare
  // `.claude/` folder by the very session whose cwd was pinned to it — but flags
  // it `prunable` ("gitdir file points to non-existent location"). Handing that
  // entry back as `ready` gives the caller a path that is not a git repository
  // at all: the session spawns there and every `git status` fails with "not a
  // git repository", wedging the whole thread (#1901). git's own `prunable`
  // verdict is the authority, so a prunable match counts as no match.
  const live = existing !== undefined && existing.prunable !== true;
  if (live) {
    input.onCheckout?.(true);
    if (!shouldRefresh) return { status: 'ready', created: false };
    const refresh = refreshWorktree({
      exec,
      path,
      branch,
      base,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    });
    return { status: 'ready', created: false, refresh };
  }
  if (input.create === false) {
    // A dead shell is not a worktree a probe may report as usable, and a
    // read-only probe writes nothing to earn the truth: it reports `absent`
    // rather than reviving anything.
    return { status: 'absent', created: false };
  }

  // CLEAR A DEAD SHELL BEFORE REBUILDING. Reaching here to create means no live
  // worktree claims this path — one would have returned `ready` above — so a
  // prunable record or a leftover directory is a corpse, and `git worktree add`
  // refuses both ("missing but already registered" for the record, "already
  // exists" for the directory), leaving a run that hit this state broken
  // forever. Pruning drops the dead record; removing the directory clears the
  // shell — but ONLY when it carries no `.git` of its own, so a real checkout
  // git merely failed to list is never destroyed (forbidden-pattern #15).
  if (existing?.prunable === true || fs.exists(path)) {
    try {
      exec('git', ['worktree', 'prune'], input.repoRoot);
    } catch {
      // A prune that could not run leaves `git worktree add` to refuse loudly,
      // which is better than removing a directory on a repo we cannot read.
    }
    if (fs.exists(path) && !fs.exists(join(path, '.git'))) {
      fs.removeDir(path);
    }
  }

  // The start point is appended, never substituted: omitting it is `git`'s own
  // "the main checkout's HEAD", which is what every loop has always got.
  const from = input.startPoint === undefined ? [] : [input.startPoint];
  if (input.attach === true && branch !== null) {
    // AN EXISTING BRANCH, TAKEN AS IT STANDS. No `-B` and no start point: this
    // is the "continue the work I already have" case, and the one thing it must
    // never do is move the branch it was handed.
    exec('git', ['worktree', 'add', path, branch], input.repoRoot);
  } else if (branch === null) {
    // DETACHED, per `WorktreeResolution.branch`. Started at the main checkout's
    // HEAD, which is where slot 1's branch would have been created from too.
    exec('git', ['worktree', 'add', '--detach', path, ...from], input.repoRoot);
  } else {
    // `-B` rather than `-b`: a loop that was pruned and is coming back still has
    // its branch, and refusing to re-create the worktree because the branch it
    // would attach already exists is a failure with no cause.
    exec('git', ['worktree', 'add', '-B', branch, path, ...from], input.repoRoot);
  }
  input.onCheckout?.(false);
  if (!shouldRefresh) return { status: 'created', created: true };
  // A fresh worktree starts at the MAIN checkout's HEAD, which is only as
  // current as the last pull there — refresh closes that gap too.
  const refresh = refreshWorktree({
    exec,
    path,
    branch,
    base,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return { status: 'created', created: true, refresh };
}

/**
 * Resolve a loop's worktree, creating it on first use.
 *
 * IDEMPOTENT, because a run runs this every time it wakes up: an existing
 * worktree at the expected path is `ready`, and the only commands run against
 * it are the refresh's read-or-fast-forward steps — never a checkout of a
 * different branch. Creation attaches the loop's own `loop/<name>` branch — inside the
 * push carve-out by construction, so the branch a worktree is born on is
 * already the only branch it is allowed to push.
 *
 * A worktree already present at the path but registered to a DIFFERENT branch is
 * returned as-is rather than corrected: it is a human's checkout at that point,
 * and silently moving someone's branch is worse than working where they left it.
 *
 * EVERY RESOLVE ALSO REFRESHES (#1584): existing or just-created, the checkout
 * is brought up to `origin/<base>` when that is safe, and the result carries how
 * that went — a run that could not be made current says so instead of working a
 * stale tree behind a `pull: ok`.
 */
export function resolveWorktree(
  input: WorktreeInput & {
    create?: boolean;
    base?: string;
    fetch?: boolean;
    owner?: string;
    fs?: WorktreeFs;
  },
): WorktreeResolution {
  const loop = requireLoopName(input.loop);
  const slot = requireSlot(input.slot ?? PRIMARY_SLOT);
  const entries = listWorktrees({ exec: input.exec, repoRoot: input.repoRoot });
  const repoRoot = canonicalRepoRoot(input.repoRoot, entries);
  const path = loopWorktreePath(repoRoot, loop, slot);
  const branch = slot === PRIMARY_SLOT ? loopBranch(loop) : null;
  const base = input.base ?? 'main';

  const outcome = resolveCheckout({
    exec: input.exec,
    repoRoot,
    path,
    branch,
    base,
    entries,
    ...(input.create === undefined ? {} : { create: input.create }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.fs === undefined ? {} : { fs: input.fs }),
    onCheckout: (existed) => {
      if (input.owner === undefined) return;
      if (existed) {
        // A CHECKOUT CARRYING ANOTHER RUN'S LIVE EDITS IS NEVER REASSIGNED
        // (#1742). Slot reuse is how an expired-but-alive run's worktree got
        // handed to a sibling, whose per-item `git reset --hard` then destroyed
        // uncommitted work — forbidden-pattern #11, produced by our own slot
        // assignment. A clean tree reassigns freely (whatever branch it sits on
        // is scaffolding; its commits survive in refs); uncommitted edits refuse,
        // because only a human may decide that run is dead.
        const last = lastOwnerOf(input.exec, path);
        if (last !== null && last !== input.owner) {
          const names = trackedDirt(input.exec, path);
          if (names.length > 0) {
            throw new Error(
              `worktree '${path}' still carries run '${last}'s uncommitted work (${names}) — a sibling run is never handed a checkout over live edits. If that run is truly dead, a person can clear the slot: \`planflow-ai loop worktree --loop ${loop} --slot ${String(slot)} --prune\``,
            );
          }
        }
      }
      stampOwner(input.exec, repoRoot, path, input.owner);
    },
  });

  return {
    status: outcome.status,
    loop,
    slot,
    path,
    branch,
    created: outcome.created,
    ...(outcome.refresh === undefined ? {} : { refresh: outcome.refresh }),
  };
}

/** What `pruneWorktree` answers with. */
export interface WorktreePrune {
  status: 'pruned' | 'absent';
  loop: string;
  slot: number;
  path: string;
  branch: string | null;
}

/**
 * Remove a loop's worktree and clean up git's administrative record.
 *
 * The BRANCH SURVIVES. Pruning is for reclaiming a checkout — after a run that
 * died holding one, or when a loop is retired — and deleting the branch would
 * take with it work that may already be pushed and under review.
 */
export function pruneWorktree(input: WorktreeInput): WorktreePrune {
  const loop = requireLoopName(input.loop);
  const slot = requireSlot(input.slot ?? PRIMARY_SLOT);
  const entries = listWorktrees({ exec: input.exec, repoRoot: input.repoRoot });
  const repoRoot = canonicalRepoRoot(input.repoRoot, entries);
  const path = loopWorktreePath(repoRoot, loop, slot);
  const branch = slot === PRIMARY_SLOT ? loopBranch(loop) : null;
  const status = removeCheckout(input.exec, repoRoot, path, entries);
  return { status, loop, slot, path, branch };
}

/**
 * Remove one checkout and clean up git's administrative record — the removal
 * both kinds' prunes are made of.
 *
 * `worktree remove --force` DELETES A REAL DIRECTORY, which is why nothing
 * here has a default: the exec, the repo root and the exact path are all
 * required arguments, so there is no call shape that quietly deletes something
 * on the machine it happens to run on (forbidden-pattern #15). The callers add
 * their own consent on top — see `pruneThreadWorktree`.
 */
function removeCheckout(
  exec: GitExec,
  repoRoot: string,
  path: string,
  entries?: readonly WorktreeEntry[],
): 'pruned' | 'absent' {
  const existing = (entries ?? listWorktrees({ exec, repoRoot })).find((entry) => entry.path === path);
  if (existing === undefined) {
    // `prune` regardless: an absent directory whose record git still holds is
    // exactly the state this verb is asked to clean up.
    exec('git', ['worktree', 'prune'], repoRoot);
    return 'absent';
  }
  exec('git', ['worktree', 'remove', '--force', path], repoRoot);
  exec('git', ['worktree', 'prune'], repoRoot);
  return 'pruned';
}

/**
 * The base branch a worktree refreshes to (#1754) — the REPOSITORY'S default
 * branch, never the main checkout's incidental HEAD. A human sitting on a local
 * WIP branch with no remote counterpart must not become every worktree's fetch
 * target: that made every resolve run `git fetch origin <wip>` and fail,
 * silently pinning worktree freshness to whenever the human last sat on the
 * default branch. `origin/HEAD` names the default; when it is unset, a remote
 * branch named `main` then `master` is accepted, and `main` is the last-resort
 * convention.
 *
 * LIVES HERE, NOT IN THE LOOP COMMAND, because more than one caller asks which
 * branch is this project's trunk and two copies of that answer would be two
 * answers waiting to disagree (allowed-pattern #14).
 *
 * A THREAD DOES NOT ASK THIS UNLESS IT IS ASKED FOR. It used to — every thread
 * worktree was cut from here — and that was the wrong question for it: a
 * thread is opened to help with the work in front of a person, so it starts on
 * the branch they are on (`currentBranch`, below). Only the explicit "start
 * fresh" choice comes back to this one. The distinction is not a preference:
 * cutting a thread from trunk hid a feature branch AND two commits its owner
 * had never pushed, and the agent reconstructed the whole thing from the remote
 * because the remote was the only place the trunk default could see.
 */
export function defaultBaseBranch(exec: GitExec, repoRoot: string): string {
  try {
    const ref = exec('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repoRoot).trim();
    const name = ref.startsWith('origin/') ? ref.slice('origin/'.length) : ref;
    if (name.length > 0) return name;
  } catch {
    // origin/HEAD is unset — fall through to the named candidates.
  }
  for (const candidate of ['main', 'master']) {
    try {
      exec('git', ['rev-parse', '--verify', `refs/remotes/origin/${candidate}`], repoRoot);
      return candidate;
    } catch {
      // no such remote branch — try the next candidate.
    }
  }
  return 'main';
}

/**
 * The branch the main checkout is sitting on, or null when its HEAD is detached.
 *
 * THE OTHER ANSWER TO "WHICH BRANCH", and the reason there are now two. A LOOP
 * asks "which branch is this project's trunk" (`defaultBaseBranch`) because a
 * scheduled run must start from somewhere stable and shared. A THREAD asks
 * "which branch is this person on" because a thread is opened to help with the
 * work in front of them — and answering a thread's question with the loop's
 * answer is the whole of #the-bug: a thread opened to resolve a merge on a
 * feature branch was cut from trunk, could see neither that branch nor its
 * owner's unpushed commits, and spent a session reconstructing from the remote
 * what was already on the disk beside it.
 *
 * Two callers, two questions, two functions (allowed-pattern #14 cuts the other
 * way here: one code path per INVARIANT, and these are two invariants).
 */
export function currentBranch(exec: GitExec, repoRoot: string): string | null {
  try {
    const head = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim();
    return head === '' || head === 'HEAD' ? null : head;
  } catch {
    return null;
  }
}

/**
 * Which checkout holds each branch, by branch name.
 *
 * READ FROM GIT, NEVER GUESSED FROM A PATH. A branch can be checked out in
 * exactly one worktree at a time, and `git worktree list --porcelain` is the
 * only thing that knows which — a directory-name heuristic would be wrong the
 * first time somebody checked a branch out somewhere unusual, and wrong
 * silently.
 */
export function branchCheckouts(exec: GitExec, repoRoot: string): Map<string, string> {
  const held = new Map<string, string>();
  for (const entry of listWorktrees({ exec, repoRoot })) {
    if (entry.branch !== undefined && entry.branch !== '') held.set(entry.branch, entry.path);
  }
  return held;
}

/** How a thread's worktree was cut, and what that means for landing it. */
export type ThreadStartMode =
  /** The branch the main checkout is on — the default. */
  | 'here'
  /** A branch the person named, cut from its local tip. The thread branches. */
  | 'branch'
  /** A branch the person named, CHECKED OUT here. The thread commits onto it. */
  | 'checkout'
  /** The repository's default branch, brought up to date from the remote. */
  | 'trunk';

/** Where a thread's worktree begins, once the request has met the repository. */
export interface ThreadStart {
  mode: ThreadStartMode;
  /** The commit-ish `git worktree add` starts from. Null → the main checkout's HEAD. */
  ref: string | null;
  /**
   * The branch this worktree's work belongs on — what a landing merges to.
   *
   * Null when there is none to name: a main checkout on a detached HEAD has no
   * branch to hand over, and inventing one would be a landing target nobody
   * chose.
   */
  base: string | null;
  /** True when the worktree takes `base` as its own checked-out branch. */
  attach: boolean;
  /** Whether this start wants the origin fast-forward. Only `trunk` does. */
  refresh: boolean;
}

/** What a caller asks for, before the repository has had its say. */
export interface ThreadStartRequest {
  /** A branch (or any commit-ish) to cut FROM. The thread gets its own branch. */
  base?: string | undefined;
  /** A branch to CHECK OUT in the worktree. The thread commits onto it. */
  checkout?: string | undefined;
  /** Start from the repository's default branch, brought up to date. */
  trunk?: boolean | undefined;
}

/** How many candidate branches `threadBranchOptions` will report. */
const MAX_BRANCH_OPTIONS = 60;

/** One branch a thread's worktree could start from. */
export interface ThreadBranchOption {
  name: string;
  /** True for the branch the main checkout is on right now. */
  current: boolean;
  /** True for the repository's default branch. */
  trunk: boolean;
  /** The checkout holding it, or null when nothing does. */
  heldBy: string | null;
  /** True when it exists only as `origin/<name>` — no local branch yet. */
  remoteOnly: boolean;
  /**
   * Whether a worktree may take this branch as its own.
   *
   * FALSE MEANS GIT WOULD REFUSE, not that we would rather not: a branch open
   * in another checkout cannot be opened in a second one. The caller offers the
   * alternatives (branch from its tip) instead of offering an action that fails.
   */
  canCheckOut: boolean;
}

/**
 * The branches a thread's worktree could be started from, best-first.
 *
 * A READ, AND ONLY A READ. Nothing here writes a ref, creates a branch or
 * touches the network — it exists so the surface that asks the person can offer
 * real choices rather than a text box and a refusal.
 *
 * Ordered by most-recently-committed with the current branch first, and capped:
 * a repository with 400 stale branches is a picker nobody can use.
 */
export function threadBranchOptions(exec: GitExec, repoRoot: string): ThreadBranchOption[] {
  const held = branchCheckouts(exec, repoRoot);
  const here = currentBranch(exec, repoRoot);
  const trunk = defaultBaseBranch(exec, repoRoot);

  const locals = refNames(exec, repoRoot, 'refs/heads');
  const options: ThreadBranchOption[] = [];
  for (const name of locals) {
    const heldBy = held.get(name) ?? null;
    options.push({
      name,
      current: name === here,
      trunk: name === trunk,
      heldBy,
      remoteOnly: false,
      canCheckOut: heldBy === null,
    });
  }
  const known = new Set(locals);
  for (const ref of refNames(exec, repoRoot, 'refs/remotes/origin')) {
    // `origin/HEAD` is a symbolic pointer, not a branch anybody works on.
    if (ref === 'HEAD' || known.has(ref)) continue;
    options.push({
      name: ref,
      current: false,
      trunk: ref === trunk,
      heldBy: null,
      remoteOnly: true,
      // Nothing holds a branch that does not exist locally yet, so taking it is
      // always available — creation is part of the taking.
      canCheckOut: true,
    });
  }
  options.sort((a, b) => Number(b.current) - Number(a.current));
  return options.slice(0, MAX_BRANCH_OPTIONS);
}

/** Short names under a ref namespace, most-recently-committed first. */
function refNames(exec: GitExec, repoRoot: string, namespace: string): string[] {
  try {
    const out = exec(
      'git',
      ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', namespace],
      repoRoot,
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => (namespace.startsWith('refs/remotes/') ? line.replace(/^origin\//, '') : line));
  } catch {
    return [];
  }
}

/** Whether a ref of that exact name resolves in this repository. */
function refExists(exec: GitExec, repoRoot: string, ref: string): boolean {
  try {
    exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turn a request into a start point, refusing before anything is created.
 *
 * THE ONE PLACE THAT DECIDES WHERE A THREAD BEGINS (allowed-pattern #14). The
 * CLI verb, the app and any future caller all arrive here, so "the default is
 * the branch you are on" is a fact about the code rather than a convention
 * three call sites are each expected to remember.
 *
 * DETACHED HEAD IN THE MAIN CHECKOUT is a real state and it gets a real answer:
 * the worktree starts at that exact commit (`ref` null → git's own default),
 * and `base` is NULL. There is no branch the work belongs to, so none is
 * claimed — landing says it does not know where this belongs rather than
 * quietly picking trunk and merging somebody's detached experiment into it.
 */
export function resolveThreadStart(
  exec: GitExec,
  repoRoot: string,
  request: ThreadStartRequest = {},
): ThreadStart {
  const named = request.base?.trim() ?? '';
  const wanted = request.checkout?.trim() ?? '';
  const chosen = [named !== '', wanted !== '', request.trunk === true].filter(Boolean).length;
  if (chosen > 1) {
    throw new Error(
      'a worktree starts from one place — name a branch to branch from, a branch to work on, or the default branch, not several',
    );
  }

  if (request.trunk === true) {
    const trunk = defaultBaseBranch(exec, repoRoot);
    return { mode: 'trunk', ref: null, base: trunk, attach: false, refresh: true };
  }

  if (wanted !== '') {
    const branch = requireBranchName(wanted);
    const heldBy = branchCheckouts(exec, repoRoot).get(branch);
    if (heldBy !== undefined) {
      // The user's own case, and the one git will not do: a branch open in the
      // project's own checkout cannot also be open here. Named rather than
      // attempted, so the caller can offer the two things that DO work.
      throw new Error(
        `'${branch}' is already open in another checkout, so a worktree cannot take it too — start a new branch from its tip instead`,
      );
    }
    if (refExists(exec, repoRoot, `refs/heads/${branch}`)) {
      return { mode: 'checkout', ref: null, base: branch, attach: true, refresh: false };
    }
    if (refExists(exec, repoRoot, `refs/remotes/origin/${branch}`)) {
      // It exists on the remote and nowhere here yet. Taking it means creating
      // the local branch at the remote tip — still a direct checkout, still
      // nothing to merge back.
      return { mode: 'checkout', ref: `origin/${branch}`, base: branch, attach: false, refresh: false };
    }
    throw new Error(`'${branch}' is not a branch in this repository`);
  }

  if (named !== '') {
    if (!refExists(exec, repoRoot, named)) {
      throw new Error(`'${named}' is not a branch or commit in this repository`);
    }
    // A branch name is what a landing can move; anything else (a tag, a sha) is
    // a fine place to start and a place nothing can land on.
    const isBranch = refExists(exec, repoRoot, `refs/heads/${named}`);
    return {
      mode: 'branch',
      ref: named,
      base: isBranch ? named : null,
      attach: false,
      refresh: false,
    };
  }

  const here = currentBranch(exec, repoRoot);
  return { mode: 'here', ref: here, base: here, attach: false, refresh: false };
}

// ── threads ──────────────────────────────────────────────
//
// Everything below serves the OTHER caller. It reuses the resolve, the refresh
// and the removal above rather than restating them; what is genuinely new is
// what a thread needs and a loop never did — a checkout that starts nameless,
// the untracked files a `git worktree add` does not bring, and the moment a
// dependency manifest changes underneath a symlink.

/**
 * Refuse before anything is created, when the repository cannot answer the one
 * question a worktree is built on: which commit does this start from.
 *
 * TWO REFUSALS, BOTH SILENT-FAILURE-SHAPED WITHOUT THIS. A non-git directory
 * makes `git worktree add` print git's own error and leave nothing behind; an
 * unborn branch (a repo with no commit yet) makes it fail in a way that reads
 * like a bug in us. Naming both here means the caller says so on the thread
 * and falls back to today's behaviour — never a silent fallback.
 */
export function requireCommittedRepo(exec: GitExec, repoRoot: string): void {
  try {
    exec('git', ['rev-parse', '--git-dir'], repoRoot);
  } catch {
    throw new Error(`'${repoRoot}' is not a git repository — there is nothing to branch a worktree from`);
  }
  try {
    exec('git', ['rev-parse', '--verify', 'HEAD'], repoRoot);
  } catch {
    throw new Error(
      `'${repoRoot}' has no commits yet — a worktree starts at a commit, and an unborn branch has none`,
    );
  }
}

/**
 * The namespace a thread's branch lives in.
 *
 * WELCOME, AND DELIBERATE (plan decision 7): the branch is what survives the
 * worktree. Once the checkout is pruned, `thread/<title-slug>` is the only
 * record that this thread did work at all.
 */
/**
 * DELIBERATELY A SECOND COPY of `THREAD_BRANCH_PREFIX` in
 * `app/src/shared/thread-branch.ts`, not an oversight.
 *
 * One definition is not reachable: the root package compiles with
 * `rootDir: ./src`, so importing the app's copy fails with TS6059 ("File … is
 * not under rootDir") — verified against tsc, not assumed. The two are also
 * different packages with different module systems.
 *
 * A duplication a test defends is a decision; one nothing defends is a bug
 * waiting to happen. `thread-branch-prefix.test.ts` reads both files and
 * asserts the literal matches, which works under any build config precisely
 * because it imports neither.
 */
export const THREAD_BRANCH_PREFIX = 'worktree/';

/** The branch a thread's checkout sits on when it is not detached. */
export function threadBranch(slug: string): string {
  return `${THREAD_BRANCH_PREFIX}${slug}`;
}

/** One entry of the untracked set, and what became of it. */
export interface WorktreeLink {
  /** The name as it sits in the main checkout — `node_modules`, `.env.local`. */
  entry: string;
  /** `linked`/`copied` — this call made it; `present` — something was already there; `missing` — the main checkout has no such entry. */
  status: 'linked' | 'copied' | 'present' | 'missing';
}

/**
 * How one entry reaches a worktree.
 *
 * `link` is a syscall and a shared identity: edit it in the worktree and you
 * have edited the main checkout's. That is right for `node_modules` (machine
 * output nobody hand-edits) and for `flow` (shared on purpose — a worktree
 * isolates code, not knowledge).
 *
 * `copy` gives the worktree its OWN file. It is right for exactly the entries
 * an agent may legitimately edit and must not edit in the user's tree, which
 * today means the project's local config. Files only, by construction.
 */
export type UntrackedEntryMode = 'link' | 'copy';

/**
 * One entry of the untracked set and how it is materialised.
 *
 * NOT `WorktreeEntry` — that name is already taken in this file by a row of
 * `git worktree list`, which is a different thing entirely (a checkout, not a
 * file inside one). The compiler caught the collision; the name change is the
 * fix rather than a namespace.
 */
export interface UntrackedEntry {
  entry: string;
  mode: UntrackedEntryMode;
}

/**
 * What a worktree needs from the main checkout that git will never hand it.
 *
 * A WORKTREE CONTAINS ONLY TRACKED FILES. Everything a project actually runs on
 * is untracked by design: the dependencies, the secrets, and — in this repo —
 * `flow/`, which is itself a symlink into the central vault. A fresh checkout
 * without them is a repo that cannot build, cannot start and cannot see its own
 * knowledge, which is exactly what a thread would find when it tried to work.
 *
 * LINKED, NEVER COPIED AND NEVER INSTALLED (a brainstorm rejection): a
 * `node_modules` copy is a gigabyte and a minute per thread, and a per-worktree
 * install is the same minute with a different failure mode. The link costs a
 * syscall. Its one real hazard — an `npm install` inside the worktree writing
 * through the link into the user's checkout — is what `promoteDependencies`
 * below exists to close.
 *
 * `*` IS A TRAILING WILDCARD ONLY, matching `.env`, `.env.local` and `.envrc`
 * alike. That is the whole glob grammar; anything else is a literal name.
 */
export const DEFAULT_LINKED_ENTRIES: readonly UntrackedEntry[] = [
  { entry: 'node_modules', mode: 'link' },
  // COPIED, NOT LINKED — the one entry on this list an agent actually edits.
  // Linked, `<worktree>/.env` and the user's own `.env` are one file, so a
  // thread told to "add the new API key" edits the tree it was cut away from.
  // Containment does not catch it: every check in `path-containment.ts` is
  // lexical, and lexically the path IS inside the worktree.
  //
  // This does not overturn the "linked, never copied" rule above it — that
  // rule's stated cost is a gigabyte and a minute, and a config file is
  // neither. It narrows it to the entry the reasoning was about.
  { entry: '.env*', mode: 'copy' },
  { entry: 'flow', mode: 'link' },
  // PLAN-FLOW'S OWN ASSETS, which provisioning writes and projects gitignore:
  // the commands, the skills and resources they read, and the hooks. Absent
  // from a worktree, a thread working there could not open the discovery
  // skill or the walkthrough template — measured on a Copilot thread, which
  // stopped with "walkthrough-template.html is absent from this worktree"
  // (Claude sessions got them from the staged config dir; no other runtime
  // does). `.claude` itself comes first: a repo that tracks nothing under it
  // gets the whole directory linked, and one that tracks `.claude/rules` keeps
  // its own tree and gains the three owned folders inside it.
  { entry: '.claude', mode: 'link' },
  { entry: '.claude/commands', mode: 'link' },
  { entry: '.claude/resources', mode: 'link' },
  { entry: '.claude/hooks', mode: 'link' },
];

/**
 * The filesystem surface the link and promotion steps need.
 *
 * Injected for the same reason git is (allowed-pattern #12): no test in this
 * feature creates a symlink on the developer's machine, and none has to guess
 * what is already on it.
 */
export interface WorktreeFs {
  /** Entry names of a directory. Throws when it does not exist. */
  readDir(path: string): string[];
  /** Whether a path exists WITHOUT following links — a broken link still counts. */
  exists(path: string): boolean;
  /** Whether a path is a directory, following links. */
  isDirectory(path: string): boolean;
  /** Whether the path is itself a symlink. */
  isSymlink(path: string): boolean;
  /** Create a symlink at `path` pointing at `target`. */
  symlink(target: string, path: string, type: 'dir' | 'file'): void;
  /** Remove a SYMLINK. Never used on a real directory — see `promoteDependencies`. */
  unlink(path: string): void;
  /**
   * Remove a directory and everything under it.
   *
   * REACHED ONLY TO CLEAR A DEAD WORKTREE SHELL — a path git has disowned
   * (`prunable`) that carries no `.git` of its own (`resolveCheckout`). That
   * narrowness is the whole safety of a recursive delete: it never runs on a
   * live checkout, only on a corpse git itself refuses to `worktree remove`.
   */
  removeDir(path: string): void;
  /**
   * Copy one FILE. Never a directory, and that limit is the design.
   *
   * The copy mode exists for a project's local config — a few hundred bytes
   * that an agent may legitimately edit and must not edit in the user's own
   * checkout. A recursive directory copy would be the gigabyte-per-thread the
   * link mode was chosen to avoid, so the surface simply cannot express it.
   */
  copyFile(source: string, target: string): void;
  /**
   * The bytes of a file, or null when it cannot be read.
   *
   * Only ever used to answer "is this copy still the main checkout's?" — see
   * `losableWork`. Null is the safe answer everywhere it is asked: a file
   * nobody can read is one nobody can prove is disposable.
   */
  readFile(path: string): string | null;
}

/** The real filesystem. */
export const nodeWorktreeFs: WorktreeFs = {
  readDir: (path) => readdirSync(path),
  exists: (path) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  },
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  isSymlink: (path) => {
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return false;
    }
  },
  // 'junction' is what Windows accepts for a directory link without elevation;
  // every other platform ignores the type entirely.
  symlink: (target, path, type) => {
    symlinkSync(target, path, type === 'dir' && process.platform === 'win32' ? 'junction' : type);
  },
  unlink: (path) => {
    unlinkSync(path);
  },
  removeDir: (path) => {
    rmSync(path, { recursive: true, force: true });
  },
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  copyFile: (source, target) => {
    // COPYFILE_EXCL: refuse rather than overwrite. The caller has already
    // checked the target is absent, and a race that made it appear in between
    // is somebody else's file — the same rule the link branch follows.
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  },
};

/** Expand the one glob form this set supports: a trailing `*`. */
function expandEntry(entry: string, names: readonly string[]): string[] {
  if (!entry.endsWith('*')) return [entry];
  const prefix = entry.slice(0, -1);
  // Sorted so two machines with the same files produce the same report.
  return names.filter((name) => name.startsWith(prefix)).sort();
}

/**
 * Link the untracked set into a worktree.
 *
 * MISSING SOURCES ARE SKIPPED SILENTLY — a project without a `.env` is not a
 * project with a problem, and a link step that refuses on the absence of an
 * optional file would refuse on most repositories.
 *
 * EXISTING TARGETS ARE NEVER OVERWRITTEN, which is the rule that makes this
 * safe to run on every resolve. A worktree where someone ran a real install has
 * a real `node_modules`; replacing it with a link into the main checkout would
 * silently discard the thing that made the two trees differ — and that is the
 * state `promoteDependencies` deliberately creates.
 */
export function linkUntrackedSet(input: {
  /** The main checkout — every link points into it. */
  repoRoot: string;
  /** The worktree the links are created in. */
  worktreePath: string;
  /** Entries to materialise, defaulting to the untracked set above. */
  entries?: readonly UntrackedEntry[];
  fs?: WorktreeFs;
}): WorktreeLink[] {
  const fs = input.fs ?? nodeWorktreeFs;
  let names: string[] = [];
  try {
    names = fs.readDir(input.repoRoot);
  } catch {
    // An unreadable main checkout has nothing to offer; every entry reports
    // missing rather than throwing, because linking is never the point of the
    // call that asked for it.
  }

  const links: WorktreeLink[] = [];
  for (const { entry, mode } of input.entries ?? DEFAULT_LINKED_ENTRIES) {
    for (const name of expandEntry(entry, names)) {
      const source = join(input.repoRoot, name);
      const target = join(input.worktreePath, name);
      if (!fs.exists(source)) {
        links.push({ entry: name, status: 'missing' });
        continue;
      }
      if (fs.exists(target)) {
        links.push({ entry: name, status: 'present' });
        continue;
      }
      // A DIRECTORY IS ALWAYS LINKED, whatever the mode says. `copy` is a file
      // mode by construction (see `WorktreeFs.copyFile`), and a mode that
      // silently recursed into a directory would be the gigabyte this design
      // exists to avoid — so the fallback is the cheap operation, not the
      // expensive one.
      const copying = mode === 'copy' && !fs.isDirectory(source);
      try {
        if (copying) fs.copyFile(source, target);
        else fs.symlink(source, target, fs.isDirectory(source) ? 'dir' : 'file');
        links.push({ entry: name, status: copying ? 'copied' : 'linked' });
      } catch {
        // A filesystem that refuses links (or a race with another resolve)
        // leaves the entry unmade and says so, rather than failing a resolve
        // whose checkout is already usable. A copy that fails is the same kind
        // of nothing: a worktree without the project's local config still
        // builds, and refusing the cut over it would refuse most repositories.
        links.push({ entry: name, status: 'missing' });
      }
    }
  }
  return links;
}

/** What a thread's resolve answers with. */
export interface ThreadWorktreeResolution {
  /** `ready` — it already existed; `created` — this call made it; `absent` — it does not exist and creation was not asked for. */
  status: 'ready' | 'created' | 'absent';
  thread: string;
  path: string;
  /** The branch it sits on, or null while it is detached. */
  branch: string | null;
  /**
   * The branch this worktree's work belongs on — what a landing merges to.
   * Null when the repository had no branch to name (a detached main checkout).
   *
   * RETURNED SO IT IS PERSISTED RATHER THAN RECOMPUTED. The app records the
   * three worktree columns from what this call answers; a second, later reading
   * of "which branch was the user on" would be answering a question about a
   * different moment.
   */
  base: string | null;
  /** How it was cut — `here` unless the caller asked for something else. */
  baseMode: ThreadStartMode;
  /**
   * True when the worktree CHECKED THE BASE BRANCH OUT, rather than branching
   * from it — its commits are already on that branch and there is nothing to
   * merge back. Equivalent to `branch === base`, which is why no store needs a
   * fourth column: that equality happens in no other shape.
   */
  onBase: boolean;
  created: boolean;
  /** How the checkout stands relative to `origin/<base>`. Absent for `absent`. */
  refresh?: WorktreeRefresh;
  /** The untracked set, and what became of each entry. Absent for `absent`. */
  links?: WorktreeLink[];
}

/**
 * Resolve a thread's checkout, creating it on first use.
 *
 * DETACHED IS THE NORMAL CASE, and the reason is a fact about threads rather
 * than a preference: a thread has no title until its first turn SUCCEEDS
 * (`maybeGenerateTitle`), so a branch created at the first message would be
 * named after nothing. The checkout starts detached and is named after the fact
 * by `nameWorktreeBranch` — which is also why a caller that already knows the
 * name can pass one and skip the second step entirely.
 *
 * Idempotent for the same reason the loop's resolve is: the app resolves on
 * every message, and an existing checkout is refreshed and re-linked, never
 * re-checked-out.
 */
export function resolveThreadWorktree(input: {
  exec: GitExec;
  /**
   * Any checkout of the repository — the caller's cwd, which need not be the
   * main one. Resolved to the true main checkout, where `git worktree` runs
   * and where the links point, via `canonicalRepoRoot` (#7).
   */
  repoRoot: string;
  /** The thread's slug (its id). */
  thread: string;
  /**
   * Where this worktree begins — from `resolveThreadStart`.
   *
   * Absent → the main checkout's current branch, which is the whole point of
   * this parameter existing: the default a thread gets when nobody says
   * otherwise is the work the person is actually doing.
   */
  start?: ThreadStart;
  /** False reports where the checkout would be without creating it. */
  create?: boolean;
  /** False skips the network fetch — see `refreshWorktree`'s note. */
  fetch?: boolean;
  /** Start detached, to be named once the thread has a title. */
  detach?: boolean;
  /** An explicit branch, for a caller that already knows the name. */
  branch?: string;
  /**
   * What the DIRECTORY is called — a different question from `branch`, which
   * names the ref.
   *
   * Absent → the thread's id, which is what every caller written before this
   * meant and what produced a uuid in every person's shell prompt. A caller
   * that supplies it also supplies the branch's fallback, so neither
   * identifier has to be derived from an id.
   */
  worktreeName?: string;
  /** Extra names to link beyond the untracked set (configured caches). */
  links?: readonly string[];
  fs?: WorktreeFs;
}): ThreadWorktreeResolution {
  const thread = requireOwnerName(input.thread, 'thread');

  // BEFORE ANYTHING IS WRITTEN, AND BEFORE CANONICALIZING. A repo that cannot
  // answer "which commit" is refused with nothing created and nothing to
  // clean up, on the RAW `input.repoRoot` — that is the directory the caller
  // actually pointed the CLI at, and `git worktree list` (the canonicalizing
  // read below) fails with git's own raw error on a non-git directory, which
  // is exactly the case this refusal exists to replace with one a person can
  // read. It runs before the start is resolved too, so a non-git directory
  // says so rather than reporting that it has no branches.
  if (input.create !== false) requireCommittedRepo(input.exec, input.repoRoot);

  // `input.repoRoot` is whatever cwd the caller was in — possibly a thread's
  // or a loop's own worktree, never guaranteed to be the main checkout. Every
  // one of the repo's worktrees answers `worktree list` with the main one
  // first, so this resolves the ONE root every container is built from,
  // rather than a different one per caller (#7).
  const entries = listWorktrees({ exec: input.exec, repoRoot: input.repoRoot });
  const repoRoot = canonicalRepoRoot(input.repoRoot, entries);
  const path = threadWorktreePath(repoRoot, thread, input.worktreeName);

  const start = input.start ?? resolveThreadStart(input.exec, repoRoot);
  // A DIRECT CHECKOUT HAS ITS NAME FROM THE START — it is the one shape that
  // does not wait for a title, because the branch already had one. Everything
  // else is detached until `nameWorktreeBranch` says otherwise, and that
  // function leaves a named checkout exactly as it is.
  const branch = threadCheckoutBranch(
    start,
    thread,
    input.detach === true,
    input.branch,
    input.worktreeName,
  );
  // Only `trunk` refreshes, so only `trunk` needs a base to refresh AGAINST.
  const refreshBase = start.base ?? 'main';

  const outcome = resolveCheckout({
    exec: input.exec,
    repoRoot,
    path,
    branch,
    base: refreshBase,
    refresh: start.refresh,
    entries,
    ...(start.ref === null ? {} : { startPoint: start.ref }),
    ...(start.attach ? { attach: true } : {}),
    ...(input.create === undefined ? {} : { create: input.create }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    ...(input.fs === undefined ? {} : { fs: input.fs }),
  });

  const onBase = branch !== null && branch === start.base;
  if (outcome.status === 'absent') {
    return {
      status: 'absent',
      thread,
      path,
      branch,
      base: start.base,
      baseMode: start.mode,
      onBase,
      created: false,
    };
  }
  const links = linkUntrackedSet({
    repoRoot,
    worktreePath: path,
    // A PROJECT'S OWN ENTRIES ARE LINKED, as they always have been. The key
    // that supplies them (`worktree_links`) names cache directories, and
    // nothing in its grammar can express a mode — so it keeps the one it has
    // always had rather than inheriting a new default nobody wrote.
    entries: [
      ...DEFAULT_LINKED_ENTRIES,
      ...(input.links ?? []).map((entry) => ({ entry, mode: 'link' as const })),
    ],
    ...(input.fs === undefined ? {} : { fs: input.fs }),
  });
  return {
    status: outcome.status,
    thread,
    path,
    branch,
    base: start.base,
    baseMode: start.mode,
    onBase,
    created: outcome.created,
    ...(outcome.refresh === undefined ? {} : { refresh: outcome.refresh }),
    links,
  };
}

/**
 * The branch a thread's checkout sits on the moment it is created.
 *
 * THREE SHAPES, ONE FUNCTION, because the rule that separates them is one rule:
 * a worktree that TOOK an existing branch already has that branch's name, and
 * everything else has no name to take yet. Left as a nested ternary this read
 * as three unrelated decisions (forbidden-pattern #3).
 */
function threadCheckoutBranch(
  start: ThreadStart,
  thread: string,
  detach: boolean,
  requested: string | undefined,
  worktreeName: string | undefined,
): string | null {
  if (start.mode === 'checkout') return requireBranchName(start.base ?? '');
  if (detach) return null;
  // NOT THE THREAD ID. This fell back to `threadBranch(thread)`, which is how
  // an attached project's checkout came to sit on `worktree/<uuid>` — a branch
  // name carrying a thread id, in a person's Source Control panel, for a
  // decision nobody made (user, 2026-09-17).
  //
  // The worktree's NAME is the honest fallback: it is the readable thing this
  // checkout is already called, and a caller that names the directory has said
  // enough to name the branch. A caller that names neither is where the id
  // still leaks, and `requireNotAnId` below is what stops it there.
  //
  // AND NOT THE PREFIX TWICE. The folder's name already CARRIES
  // `THREAD_BRANCH_PREFIX` — a checkout lives at `worktree/<name>` — so handing
  // it to `threadBranch` whole produced `worktree/worktree/<name>`: a branch
  // nested one level deeper than anything that made it, for the one caller that
  // named the folder and left the branch to be derived.
  const named = worktreeName?.trim() ?? '';
  const fallback = named.startsWith(THREAD_BRANCH_PREFIX)
    ? named.slice(THREAD_BRANCH_PREFIX.length)
    : named;
  return requireBranchName(requested ?? threadBranch(fallback === '' ? thread : fallback));
}

/** What a thread's prune answers with. */
export interface ThreadWorktreePrune {
  status: 'pruned' | 'absent';
  thread: string;
  path: string;
  /**
   * What the prune destroyed, when it destroyed anything.
   *
   * PRESENT ONLY WHEN IT IS TRUE. A clean prune answers exactly as it always
   * has, so nothing downstream has to learn a new shape to keep working — and
   * `pruned` stops being indistinguishable from `pruned nothing of value`.
   */
  discarded?: string[];
}

/**
 * Remove a thread's checkout. The BRANCH SURVIVES, as it does for a loop —
 * pruning reclaims disk, and the branch is the record of what the thread did.
 *
 * `confirmed` IS NOT CEREMONY (forbidden-pattern #15). This deletes a directory
 * that may hold hours of a person's work, and the incident that wrote that rule
 * was a test calling a destructive function it believed was inert. There is no
 * default: a caller either says a person asked for this, or gets a refusal.
 */
export function pruneThreadWorktree(input: {
  exec: GitExec;
  repoRoot: string;
  thread: string;
  /** True only when a person asked for the removal. */
  confirmed: boolean;
  /** The filesystem seam, so the linked-dependency check is injectable too. */
  fs?: WorktreeFs;
  /**
   * True only when a person was told what would be lost and asked anyway.
   *
   * SEPARATE FROM `confirmed`, because they answer different questions.
   * `confirmed` asks "did a person type this verb"; this asks "did a person
   * agree to lose THESE files". Someone who typed `worktree prune` consented to
   * removing a worktree, not to discarding two files they had not committed —
   * those are different sentences, and only the code knew they were the same
   * act (#1797).
   */
  discard?: boolean;
  /**
   * What the directory is called, when it is not the thread's id.
   *
   * PRUNE HAS TO BE TOLD TOO. It finds the checkout by rebuilding its path, so
   * a create that named the directory and a prune that did not would look in
   * two different places — and the prune would report `absent` over a checkout
   * that is very much there.
   */
  worktreeName?: string;
}): ThreadWorktreePrune {
  const thread = requireOwnerName(input.thread, 'thread');
  // NOT A GIT CALL YET. Confirmation is checked before anything is read, so a
  // refusal here leaves the machine untouched, exactly as tested.
  if (input.confirmed !== true) {
    throw new Error(
      `removing thread '${thread}'s worktree needs an explicit confirmation — it deletes uncommitted work that exists nowhere else`,
    );
  }

  // Resolved from `git worktree list` rather than trusted from `input.repoRoot`
  // for the same reason `resolveThreadWorktree` does it — the caller's cwd may
  // be a worktree of its own, and every worktree answers with the main one
  // first (#7).
  const entries = listWorktrees({ exec: input.exec, repoRoot: input.repoRoot });
  const repoRoot = canonicalRepoRoot(input.repoRoot, entries);
  const path = threadWorktreePath(repoRoot, thread, input.worktreeName);

  // WHAT GIT SEES, BEFORE OVERRIDING WHAT GIT WOULD DO. `worktree remove
  // --force` exists to defeat git's own refusal to delete a checkout with
  // modified or untracked files; this verb overrode it on every prune, looked
  // at nothing, and answered `pruned` with exit 0 either way. Two things in this
  // repo already treat a dirty checkout as sacred — git's default and
  // `refreshWorktree`'s `skipped-dirty` — and this path used to override both
  // without a word.
  const losable = losableWork(input.exec, input.fs ?? nodeWorktreeFs, path, repoRoot);
  if (input.discard !== true && losable !== null && losable.length > 0) {
    throw new Error(
      `thread '${thread}'s worktree has uncommitted work (${namedDirt(losable)}) — left untouched; ` +
        `it exists nowhere else, so removing it has to be asked for separately`,
    );
  }

  const status = removeCheckout(input.exec, repoRoot, path, entries);
  // Said AFTER the fact as well as before it: a forced prune that names what it
  // took is the difference between a person knowing and a person finding out.
  const discarded = status === 'pruned' && losable !== null && losable.length > 0 ? losable : null;
  return { status, thread, path, ...(discarded === null ? {} : { discarded }) };
}

/**
 * The characters git will accept in a branch name, narrowed to what a slug can
 * produce. Checked here rather than left to `git checkout -b` so a bad name is
 * one refusal line instead of git's own multi-line complaint.
 */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** How many `-N` suffixes a naming will try before giving up. */
const MAX_BRANCH_DEDUPE = 50;

function requireBranchName(branch: string): string {
  const value = branch.trim();
  if (
    !BRANCH_NAME_PATTERN.test(value) ||
    value.includes('..') ||
    value.endsWith('/') ||
    value.endsWith('.lock')
  ) {
    throw new Error(`'${branch}' is not a branch name`);
  }
  return value;
}

/** Whether a local branch of that name already exists. */
function branchExists(exec: GitExec, repoRoot: string, branch: string): boolean {
  try {
    exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

/** What a naming answers with. */
export interface WorktreeNaming {
  /** `named` — this call created the branch; `unchanged` — it was already on one. */
  status: 'named' | 'unchanged';
  /** The branch the checkout is on afterwards — deduped, so not always the one asked for. */
  branch: string;
  /** The name the caller asked for, when deduping moved it. */
  requested?: string;
  path: string;
}

/**
 * Give a detached checkout a branch at the commit it is already on.
 *
 * WHY AFTER THE FACT: the thread's title is generated from its first turn, and
 * only when that turn SUCCEEDS. Naming the branch at creation would name it
 * after an empty thread; naming it here names it after what the thread turned
 * out to be.
 *
 * DEDUPES RATHER THAN REFUSES. Two threads about the same thing produce the
 * same title slug, and the second one losing its branch — or its worktree —
 * over a name collision would be a data loss dressed as tidiness. The second
 * becomes `<name>-2`, the third `<name>-3`.
 *
 * IDEMPOTENT: a checkout already on a branch is left exactly as it is. The app
 * calls this after every successful turn, and only the first one has anything
 * to do.
 */
export function nameWorktreeBranch(input: {
  exec: GitExec;
  /** The main checkout — where the ref store is read. */
  repoRoot: string;
  /** The worktree being named. */
  path: string;
  /** The branch to create, e.g. `thread/fix-the-parser`. */
  branch: string;
}): WorktreeNaming {
  const requested = requireBranchName(input.branch);
  const head = input.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], input.path).trim();
  if (head !== 'HEAD') {
    // Already named — by an earlier call, or by a person. Either way it is not
    // this function's to move.
    return { status: 'unchanged', branch: head, path: input.path };
  }

  let branch = requested;
  for (let n = 2; branchExists(input.exec, input.repoRoot, branch); n += 1) {
    if (n > MAX_BRANCH_DEDUPE) {
      throw new Error(
        `'${requested}' and ${String(MAX_BRANCH_DEDUPE)} numbered variants are all taken — name this worktree's branch by hand`,
      );
    }
    branch = `${requested}-${String(n)}`;
  }
  // `-b`, never `-B`: `-B` would move an existing branch onto this commit, and
  // the whole point of the dedupe above is that an existing branch is somebody
  // else's.
  input.exec('git', ['checkout', '-b', branch], input.path);
  return {
    status: 'named',
    branch,
    ...(branch === requested ? {} : { requested }),
    path: input.path,
  };
}

/**
 * The files whose change means the worktree's dependencies are no longer the
 * main checkout's (plan decision 3).
 *
 * Matched by BASENAME, anywhere in the tree: a monorepo's `app/package.json` is
 * as much a dependency change as the root one.
 */
export const DEPENDENCY_MANIFESTS: readonly string[] = [
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'requirements.txt',
  'pyproject.toml',
  'Gemfile',
  'go.mod',
  'Cargo.toml',
];

/** How many leading columns `git status --porcelain` spends on the status itself. */
const PORCELAIN_STATUS_WIDTH = 3;

/**
 * The dependency manifests this worktree has changed, by repo-relative path.
 *
 * Untracked manifests count: a `package-lock.json` that did not exist before is
 * the strongest possible signal that an install has happened here.
 */
export function changedManifests(exec: GitExec, path: string): string[] {
  // NOT `.trim()` ON THE WHOLE OUTPUT — the status columns are two characters
  // and a space, so ' M package.json' loses its own first character to a
  // whole-string trim and the manifest silently stops being recognised.
  const status = exec('git', ['status', '--porcelain'], path);
  if (status.trim().length === 0) return [];
  const changed: string[] = [];
  for (const line of status.split('\n')) {
    if (line.length <= PORCELAIN_STATUS_WIDTH) continue;
    const entry = line.slice(PORCELAIN_STATUS_WIDTH).trim();
    // A rename reports `old -> new`; the new name is the one on disk.
    const file = entry.includes(' -> ') ? entry.slice(entry.lastIndexOf(' -> ') + 4) : entry;
    const cleaned = file.replace(/^"|"$/g, '');
    if (DEPENDENCY_MANIFESTS.includes(basename(cleaned)) && !changed.includes(cleaned)) {
      changed.push(cleaned);
    }
  }
  return changed.sort();
}

/** The lockfiles that name which installer owns a JavaScript project. */
const JS_INSTALLERS: readonly { lockfile: string; command: readonly string[] }[] = [
  { lockfile: 'pnpm-lock.yaml', command: ['pnpm', 'install'] },
  { lockfile: 'yarn.lock', command: ['yarn', 'install'] },
  { lockfile: 'package-lock.json', command: ['npm', 'install'] },
  { lockfile: 'package.json', command: ['npm', 'install'] },
];

/** What a promotion answers with. */
export interface DependencyPromotion {
  /** `clean` — no manifest changed; `installed` — the link was replaced and the install ran; `manual` — a manifest changed that this cannot install for. */
  status: 'clean' | 'installed' | 'manual';
  /** The manifests that changed, by repo-relative path. */
  manifests: string[];
  /** The install that ran, as argv. Null when nothing ran. */
  installed: readonly string[] | null;
  /** Whether a `node_modules` symlink was replaced by this call. */
  detached: boolean;
  /** One line of why, when the status is `manual`; '' otherwise. */
  detail: string;
}

/**
 * Break a worktree's `node_modules` link so an install lands HERE.
 *
 * ONE ANSWER TO "BREAK THE LINK", asked from two places (allowed-pattern #14):
 * `promoteDependencies` below, when a manifest changed mid-life, and the app's
 * worktree setup step, before it runs a project's own command. Both exist for
 * the identical reason — an `npm install` under a symlinked `node_modules`
 * does not install into the worktree, it installs into the user's checkout and
 * changes the dependencies of work the thread was never allowed to touch — and
 * two copies of that rule would be two rules, of which the second would be the
 * one that is wrong.
 *
 * IT REMOVES A LINK, NEVER A DIRECTORY. A worktree that already has a real
 * `node_modules` is a previous promotion's work and is left exactly as it is;
 * the directory a link pointed AT is untouched either way. Returns whether it
 * actually detached anything, because "there was nothing to break" and "the
 * link is gone now" are different facts to report.
 */
export function detachSharedModules(input: { path: string; fs?: WorktreeFs }): boolean {
  const fs = input.fs ?? nodeWorktreeFs;
  const modules = join(input.path, 'node_modules');
  if (!fs.isSymlink(modules)) return false;
  fs.unlink(modules);
  return true;
}

/**
 * Give a worktree its own dependencies, once its manifests stop matching the
 * main checkout's.
 *
 * THE HAZARD THIS CLOSES IS THAT A SYMLINK RESOLVES. `node_modules` is linked
 * into the user's checkout, so an `npm install` run inside the worktree does
 * not install into the worktree — it installs into the user's tree, changing
 * the dependencies of work the thread was never allowed to touch. Unlinking
 * first makes the install land where the caller thinks it does.
 *
 * DETECTED AFTER A TURN, RUN BEFORE THE NEXT ONE — never mid-turn, the rule
 * that shaped this whole design. This function is the mechanism only; the
 * moment it is called is the app's decision.
 *
 * The unlink is not destructive: it removes a LINK, and the directory it
 * pointed at is untouched. A real `node_modules` already in the worktree is
 * left exactly where it is, because that is a previous promotion's work.
 */
export function promoteDependencies(input: {
  exec: GitExec;
  /** The worktree — both the status read and the install run in it. */
  path: string;
  fs?: WorktreeFs;
}): DependencyPromotion {
  const fs = input.fs ?? nodeWorktreeFs;
  const manifests = changedManifests(input.exec, input.path);
  if (manifests.length === 0) {
    return { status: 'clean', manifests, installed: null, detached: false, detail: '' };
  }

  const names = new Set(manifests.map((file) => basename(file)));
  const installer = JS_INSTALLERS.find((candidate) => names.has(candidate.lockfile));
  if (installer === undefined) {
    // A Python, Ruby, Go or Rust manifest changed. Those toolchains keep their
    // dependencies somewhere this never linked, so there is no link to replace
    // and no install this may presume to run — the caller surfaces it instead
    // of a promotion silently doing the wrong ecosystem's work.
    return {
      status: 'manual',
      manifests,
      installed: null,
      detached: false,
      detail: `${manifests.join(', ')} changed — this worktree's dependencies for that toolchain are the project's own to install`,
    };
  }

  const detached = detachSharedModules({ path: input.path, fs });
  input.exec(installer.command[0], installer.command.slice(1), input.path);
  return { status: 'installed', manifests, installed: installer.command, detached, detail: '' };
}

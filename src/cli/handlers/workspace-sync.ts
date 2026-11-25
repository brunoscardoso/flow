/**
 * `workspace sync` — THE one door through which a Workspace's knowledge moves
 * between machines (workspaces-knowledge-hub FR-14..18, Phase 6). The app's
 * sync engine, the heartbeat daemon and the terminal all call it.
 *
 * One run, in order:
 *
 *   1. COMMIT. Refresh the repo's `.gitignore`/`.gitattributes` from the one
 *      class table, summarize any archived rounds record not yet summarized
 *      (its full text kept in the project's personal `.evidence/rounds/`),
 *      stage everything, and STOP TRACKING what must not be published: a
 *      personal or generated file the Workspace already held, and any symlink
 *      (`untracked` — each stays on disk). Then the pre-push guard runs over
 *      the staged paths AND every path any not-yet-pushed commit added or
 *      changed (not just the net change). A personal file refuses the whole
 *      run (`personal-files`) — unstaged again, nothing committed, nothing
 *      pushed (R-3). Otherwise commit, as the person git knows
 *      (`user.useConfigOnly` — git never invents an author).
 *   2. No remote → `local-only`. Otherwise FETCH (hardened env, `--`, https/ssh
 *      only). A fetch that cannot reach the remote → `offline`; one the remote
 *      REFUSES (authentication, permission, 401/403, repository not found) →
 *      `no-access` (`classifyRemoteFailure`). Either way the commit stays, and
 *      the result says so.
 *      A fetch that finds the remote's history REWRITTEN (the new tip does not
 *      descend from the last one seen) refuses `remote-rewritten`, puts the
 *      tracking ref back, and merges and pushes nothing.
 *   3. MERGE the remote branch: nothing to do when it is behind us. Before
 *      anything is checked out, what the remote changed since the common
 *      ancestor is judged: a personal file (any spelling), a symlink, a nested
 *      `.gitattributes`/`.gitignore`, or a root one changed outside Flow's
 *      generated block refuses `incoming-unsafe` (fast-forward included) —
 *      except a root `.gitignore` that only ignores MORE (`onlyIgnoresMore`).
 *      Every git call that writes the tree runs with `core.symlinks=false`.
 *      Then a fast-forward when we are behind it, otherwise `merge --no-ff
 *      --no-commit` and `workspace-merge.ts` sorts what both sides touched.
 *      Only safe classes are settled by Flow, each one recorded in `merges/`;
 *      anything that needs a person (`ask`) or an agent's draft (`review`)
 *      ABORTS the merge — the working tree is back on the pre-merge commit
 *      and nothing is pushed (R-2).
 *   4. After a pull, every project's generated `brain/index.md` is rebuilt
 *      (it is never synced, so the pull did not bring one).
 *   5. PUSH — plain `git push -- origin HEAD:refs/heads/<branch>`. Never a
 *      force, never a rebase of published history. A rejected push (the
 *      remote moved meanwhile) fetches and merges ONCE more, then reports
 *      `behind` if it is still rejected. A push the remote itself DECLINED
 *      (`[remote rejected]` — a hook, a protected branch) is `no-access`, with
 *      `rejection` naming why — EXCEPT a branch that only takes pull requests:
 *      the Workspace moves ONCE to `WORKSPACE_FALLBACK_BRANCH` at the current
 *      commit, merges what the remote holds there, and pushes again (`moved`).
 *      Every member's fetch also asks for that branch (a glob, so its absence
 *      costs nothing), and a member still on the old branch FOLLOWS the moment
 *      it exists — nobody is told, nothing is written on the refusing branch.
 *
 * Identity: the Workspace repository sits outside every project folder, so a
 * per-folder git identity never reaches it. With no email of its own, it takes
 * the one every linked project checkout here agrees on (`identity`).
 *
 * Deciding an ask or review: `--id <item id> [--resolve <path>] --take ours|theirs|merged|file:<file>`
 * (the id applies the decision only to exactly the content it was shown —
 * otherwise `stale-decision`; `--resolve <path>` alone still works)
 * re-runs the merge against the ALREADY-FETCHED remote state (the one the
 * question was put about — no new fetch), records the decision in `.git`
 * (never committed; keyed to both sides' exact content, see workspace-merge.ts)
 * and completes the merge when nothing else is waiting.
 *
 * Many decisions in ONE run: `--decisions <file>` (`{ "decisions": [ { id,
 * take, content? } ] }`) goes through the same matching, storing and applying
 * as a single `--id`, and the merge completes in one pass. The batch is all or
 * nothing: one id that no longer names a current item (`stale-decision`) or
 * one take its item does not accept (`invalid-resolution`) refuses every
 * decision, writes nothing and leaves no merge in progress.
 * `--hold <ids>` (with `--decisions`) holds items still under review aside:
 * the merge commits the WORKSPACE's version at their paths and this machine's
 * decided text goes to `.git/plan-flow-held.json` (`holdPendingItems`), never
 * committed — so no push publishes it. `--settle-held <id> --take
 * ours|theirs|file:<path>` writes the agreed text as an ordinary commit
 * (`knowledge: settle <path>`) and syncs on; every result lists `heldAside`.
 * A merge that applied decisions names each decided path and who agreed
 * (`Agreed-by:`, git's user.name) in its commit body; the subject is unchanged.
 * With `--no-push` a committed merge is `merged-local`, `awaitingReview`, and
 * `mergedItems` lists what was decided in it. Its decided items are recorded
 * as the OPEN REVIEW (`.git/plan-flow-review.json`, never committed): while
 * anything is recorded, a run that would push stops at `merged-local` instead
 * unless it says `--agreed` (a person agreed), whose successful push clears
 * the record — so a restart or another caller never publishes an unreviewed
 * merge. `--hold-back <ids>` puts recorded items back to the Workspace's
 * version as one local commit and holds this machine's text aside (a
 * disagreed decision then no longer blocks publishing the agreed rest).
 *
 * `--commit-only` (`commitOnly`) stops after step 1: no fetch, no merge, no
 * push — `committed` or `nothing-to-do`. The app's quit path uses it, so
 * closing Flow never starts a network merge; the next open syncs.
 *
 * Recovery (before step 1, under the lock):
 *   - A LOCK whose recorded process is gone is cleared at once (moved aside
 *     atomically, and only if it is still the lock that was judged); one with no
 *     readable process older than the longest a sync may run
 *     (`LOCK_TIMEOUT_MS`), or a live-pid one older than `STALE_LOCK_MS` (the
 *     pid was reused), is cleared too. `recovered.lock` says which.
 *   - A MERGE left half-done by Flow's OWN sync (its marker in `.git` names
 *     exactly this HEAD and MERGE_HEAD) is undone with `git merge --abort` —
 *     never `reset --hard` — when no conflicted file was resolved by hand.
 *     Flow only starts a merge on a clean tree (everything had just been
 *     committed), so the abort cannot lose an edit made before the merge;
 *     an edit made after it to a file the merge did not touch survives the
 *     abort and is committed by step 1; one to a file the merge DID touch
 *     makes git refuse the abort, and so does the sync (`merge-in-progress`,
 *     the tree untouched). A merge someone else started is never touched.
 *
 * Team rules: after a run that pulled commits, each project of the Workspace
 * with a checkout on this machine whose `flow` links here gets its
 * `projects/<p>/rules/` mirrored into `<checkout>/.claude/rules`
 * (`mirrorTeamRules`) — beside the person's own rules, never over them: Flow
 * removes only files its manifest (in the checkout's `.git`) says it copied.
 * A `rules` that is a link is ignored, links inside it are not copied, a
 * `.claude` or `.claude/rules` that is a link is skipped
 * (`rules-folder-is-a-link`), and a checkout whose code repository TRACKS
 * `.claude/rules` is skipped.
 *
 * Fail-closed (forbidden-pattern #15): the Flow folder and whether to push are
 * REQUIRED inputs. A caller that forgets either does not compile — no test can
 * reach the person's real Workspaces or publish anything by leaving them out.
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { writeBrainIndex } from '../state/brain-index.js';
import { summarizeArchivedRounds } from '../state/rounds-summary.js';
import { atomicWriteFile } from '../utils/atomic-write.js';
import {
  classifyKnowledgePath,
  classifyKnowledgePathDetailed,
  findPersonalFiles,
  splitWorkspaceBlock,
  workspaceGitattributes,
} from './knowledge-classes.js';
import { WORKSPACE_FALLBACK_BRANCH, switchWorkspaceBranch } from './workspace-branch.js';
import { parseGitRemote, redactRemote } from './knowledge-migration.js';
import {
  applyDecisions,
  applyResolutions,
  decidedText,
  inspectMerge,
  isIntentPath,
  MAX_DECISION_CONTENT,
  readDecisions,
  readMergeFacts,
  textAt,
  writeDecisions,
  writeMergeLog,
  type AskKind,
  type MergeFacts,
  type MergeResolution,
  type ReviewKind,
  type StoredDecision,
  type SyncAsk,
  type SyncReview,
  type Take,
} from './workspace-merge.js';
import {
  chosenBranchOf,
  defaultWorkspaceGit,
  markPullRequestOnly,
  projectFolder,
  recordBranchMove,
  readLocalProjects,
  readLocalWorkspaceNames,
  readWorkspace,
  realOrResolved,
  scanWorkspaces,
  slugify,
  WORKSPACE_PROJECTS_DIRNAME,
  WorkspaceRefusal,
  workspaceDir,
  writeWorkspaceRepoFiles,
  writeLocalWorkspaceName,
  type LoadedWorkspace,
  type WorkspaceDeps,
  type WorkspaceGit,
} from './workspace-model.js';

// ─── Names ──────────────────────────────────────────────────────────────────

const REMOTE_NAME = 'origin';
export { WORKSPACE_FALLBACK_BRANCH } from './workspace-branch.js';
export const SYNC_LOCK_GIT_PATH = 'plan-flow-sync.lock';
/** Written right before Flow's own merge starts, removed once it is committed or undone. */
export const SYNC_MERGE_MARKER_GIT_PATH = 'plan-flow-sync-merge.json';
/**
 * Inside `.git`: this machine's text of items still under review, held aside
 * while the Workspace's version is what the merge committed (never committed).
 */
export const SYNC_HELD_GIT_PATH = 'plan-flow-held.json';
/**
 * Inside `.git`: the decided items of merges committed here with `--no-push`
 * and not yet agreed by a person (never committed). While it lists anything,
 * a sync publishes only with `--agreed`; without it the run is `merged-local`.
 */
export const SYNC_REVIEW_GIT_PATH = 'plan-flow-review.json';
/** The largest `--decisions` file read (each `content` is still capped at MAX_DECISION_CONTENT). */
export const MAX_DECISIONS_FILE = 256 * 1024 * 1024;
/** How many decided paths a merge commit's body names before it says how many more. */
const MAX_BODY_DECISIONS = 50;
/** The longest one sync may run (the network git timeout, and the app's bound): a lock with no live owner older than this is stale. */
export const LOCK_TIMEOUT_MS = 5 * 60 * 1000;
/** Even a lock whose recorded process looks alive is stale after this — the pid was reused. */
const STALE_LOCK_MS = 15 * 60 * 1000;
const TEAM_RULES_DIRNAME = 'rules';
/** Inside a CHECKOUT's `.git`: the team-rule files Flow copied into `.claude/rules` (and so may remove). */
export const TEAM_RULES_MANIFEST_GIT_PATH = 'plan-flow-team-rules.json';
/** Every git call that writes a working tree: a symlink arrives as a plain file holding its target. */
const NO_SYMLINKS = ['-c', 'core.symlinks=false'] as const;
/** git's empty tree — the "before" of a history with no common ancestor. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SYMLINK_MODE = '120000';
const DEFAULT_MESSAGE_PREFIX = 'knowledge: sync';
const MAX_MESSAGE_LENGTH = 200;

// ─── Types ──────────────────────────────────────────────────────────────────

export type SyncState =
  | 'synced'
  | 'local-only'
  | 'nothing-to-do'
  | 'ask'
  | 'review'
  | 'behind'
  | 'offline'
  /** The remote answered and refused this machine's access. */
  | 'no-access'
  /** `--commit-only`: local changes were committed; nothing was exchanged. */
  | 'committed'
  /**
   * `--no-push`: a merge was committed on this machine and NOT published — it
   * waits for a person's review (`awaitingReview`, `mergedItems`).
   */
  | 'merged-local';

export interface SyncCommit {
  sha: string;
  message: string;
  files: number;
}

/**
 * Kept for the result's shape: always empty since the hard migration — a
 * project with its own knowledge repository is linked with --import, never
 * skipped by the Workspace sync.
 */
export interface SkippedProject {
  id: string;
  slug: string;
  reason: 'keeps-own-knowledge-repo';
}

export interface SyncResult {
  action: 'sync';
  workspace: { name: string; slug: string; path: string };
  branch: string;
  /** The remote, credentials masked; null for a local-only Workspace. */
  remote: string | null;
  state: SyncState;
  /** The commit this run made of local changes, or null. */
  committed: SyncCommit | null;
  /** How many incoming commits were merged in. */
  pulled: number;
  pushed: boolean;
  /** Commits on this machine the remote does not have yet. */
  ahead: number;
  /** The merge commit and its audit file, when one was made. */
  merge: { sha: string; log: string | null } | null;
  resolutions: MergeResolution[];
  asks: SyncAsk[];
  reviews: SyncReview[];
  /** Ids of items a decision was recorded or applied for in this run. */
  decided: string[];
  /** Projects whose knowledge stays in their own repository — not part of this sync. */
  skipped: SkippedProject[];
  indexes: { rebuilt: string[]; failed: { project: string; detail: string }[] };
  /** Team rules mirrored into checkouts after a pull (empty when nothing was pulled). */
  rules: TeamRulesReport;
  /** `full` — commit, fetch, merge, push; `commit-only` — step 1 alone. */
  mode: 'full' | 'commit-only';
  /** What this run cleared that an interrupted run left behind. */
  recovered: { lock: LockRecovery | null; merge: boolean };
  /**
   * Paths this run stopped tracking: personal or generated files the
   * Workspace held (their removal is in `committed`), and symlinks, which are
   * never published. Every one stays on this machine's disk.
   */
  untracked: string[];
  /**
   * This run moved the Workspace onto `WORKSPACE_FALLBACK_BRANCH`: because its
   * branch refused a direct push (`pull-request-required`), or because another
   * member already moved it (`followed`). Absent when nothing moved.
   */
  moved?: { from: string; to: string; reason: 'pull-request-required' | 'followed' };
  /**
   * The email this run gave the Workspace repository, copied from the one
   * every linked project on this machine commits as. Absent when nothing changed.
   */
  identity?: { email: string; source: 'projects' };
  /**
   * `no-access` only: WHY the remote refused, so the app can say what is
   * wrong instead of blaming access for a policy the remote enforces.
   */
  rejection?: SyncRejection;
  /** One sentence for `offline` / `no-access` / `behind` / `ask` / `review`. */
  detail?: string;
  /** `--put-back`: the intent document this run put back to the text it was given. */
  putBack?: { path: string };
  /**
   * Every ask/review decided in the merge this run committed (empty when none):
   * what the app shows for review. A held item is listed with `take: 'theirs'`
   * and `held: true` — the Workspace's version is what the merge holds.
   */
  mergedItems: MergedItem[];
  /** `merged-local` only: the merge is committed here and waits for a person's review before it is pushed. */
  awaitingReview?: true;
  /**
   * What is held aside on this machine now (read from the store in `.git`),
   * whatever this run did. Not named `held`: that was the retired draft-hold
   * report, and an older reader must not mistake one for the other.
   */
  heldAside: HeldSummary[];
  /** `--settle-held`: the held item this run settled, and the commit it made (null when the text was already there, or `theirs`). */
  settled?: { id: string; path: string; take: 'ours' | 'theirs' | 'file'; sha: string | null };
  /** `--hold-back`: the review items put back to the Workspace's version, and the commit (null when nothing changed). */
  heldBack?: { ids: string[]; sha: string | null };
}

/** One decided item of a merge. */
export interface MergedItem {
  id: string;
  path: string;
  kind: AskKind | ReviewKind;
  take: Take;
  held?: true;
}

/**
 * One item held aside: the merge committed the Workspace's version at `path`;
 * `text` is this machine's decided text (null = the file removed), kept in
 * `.git` until it is settled.
 */
export interface HeldItem {
  id: string;
  path: string;
  kind: AskKind | ReviewKind;
  text: string | null;
  heldAt: string;
}

/** A held item without its text — what every sync result carries. */
export type HeldSummary = Omit<HeldItem, 'text'>;

/**
 * Why a remote refused a sync:
 *  · `access` — authentication or permission (401/403, not found, denied).
 *  · `author-not-allowed` — a policy on the remote refuses the commits' author
 *    email (Azure DevOps VS403702, GitHub GH007). `email` is the refused
 *    address when the remote names it.
 *  · `pull-request-required` — the branch only accepts pull requests (Azure
 *    DevOps TF402455, GitHub "must be made through a pull request").
 *  · `declined` — any other `[remote rejected]` (a hook, a policy we do not name).
 */
export type SyncRejection =
  | { kind: 'access' }
  | { kind: 'author-not-allowed'; email: string | null }
  | { kind: 'pull-request-required' }
  | { kind: 'declined' };

export interface TeamRulesReport {
  copied: string[];
  skipped: { project: string; reason: 'rules-tracked-in-code-repo' | 'not-linked-here' | 'rules-folder-is-a-link' }[];
  failed: { project: string; detail: string }[];
}

/** Why a leftover lock was taken over. */
export type LockRecovery = 'owner-gone' | 'expired';

export interface SyncAllResult {
  action: 'sync';
  all: true;
  results: (SyncResult | { action: 'sync'; workspace: { slug: string }; refused: string; detail: string; [key: string]: unknown })[];
  unreadable: { workspace: string; detail: string }[];
}

export interface SyncResolve {
  /**
   * Workspace-relative (or absolute inside the Workspace) path of the ask/review.
   * Optional when `id` names the item.
   */
  path?: string;
  /**
   * The ask/review `id` the decision was made about. When given, the decision
   * applies only to exactly that content: an item whose content changed since
   * (a new id) refuses `stale-decision`. The app always passes it.
   */
  id?: string;
  /** `ours` | `theirs` | `merged` | `file:<path to the merged text>`. */
  take: string;
}

/**
 * Settle ONE held item (`--settle-held <id> --take …`): `ours` writes the held
 * text, `file:<path>` a new text, as an ordinary local commit
 * (`knowledge: settle <path>`) that the same run then syncs; `theirs` keeps the
 * Workspace's version and only lets go of the held text.
 */
export interface SyncSettleHeld {
  id: string;
  take: string;
}

/**
 * Put ONE intent document (a decision, plan or discovery) back to a given text —
 * the app's Undo of an agent's merge, and its "keep yours / theirs" — as an
 * ordinary new commit, which the same run then syncs. Never a force push.
 */
export interface SyncPutBack {
  /** Workspace-relative path of the document. Only intent documents may be put back. */
  path: string;
  /**
   * sha256 (hex) of the text the document holds NOW, as the caller last saw it.
   * Anything else there — a teammate changed it since — refuses `stale-decision`.
   */
  expect: string;
  /** `file:<path to the text>` — the only take a put-back accepts. */
  take: string;
}

export interface SyncOptions {
  /** REQUIRED — there is no default Flow folder here (forbidden-pattern #15). */
  flowFolder: string;
  /** REQUIRED — whether this run may publish. */
  push: boolean;
  /** Which Workspace (slug or name). Optional when the machine has exactly one. */
  workspace?: string;
  message?: string;
  resolve?: SyncResolve;
  /**
   * A JSON file `{ "decisions": [ { "id", "take", "content"? } ] }` deciding
   * many waiting items in ONE run and one merge. Every id must name a current
   * item and every take must be one it accepts — otherwise the WHOLE batch is
   * refused (`stale-decision` / `invalid-resolution`) and nothing is written.
   */
  decisions?: string;
  /**
   * With `decisions`: ids of items still under review. The merge commits the
   * Workspace's version at their paths and keeps this machine's decided text
   * aside in `.git` (`SYNC_HELD_GIT_PATH`), so a push publishes only theirs.
   */
  hold?: readonly string[];
  /** Settle one held item before committing (see SyncSettleHeld). */
  settleHeld?: SyncSettleHeld;
  /**
   * Ids of decided items of the open review (`SYNC_REVIEW_GIT_PATH`) to put
   * back to the Workspace's version as one local commit, this machine's own
   * text held aside — a disagreed decision stops blocking the push of the rest.
   */
  holdBack?: readonly string[];
  /**
   * A person agreed to the open review: this run may publish it, and the
   * review record is cleared once the push succeeds. Without it, a run that
   * would push while a review is open stops at `merged-local`.
   */
  agreed?: boolean;
  /** Put one intent document back to a chosen text before committing (see SyncPutBack). */
  putBack?: SyncPutBack;
  /**
   * Called with one line as each step and each git call STARTS (and once more
   * when a call took long). The CLI writes it to stderr, which the app keeps
   * even when it kills a run at its time limit, so the last line names the step
   * that hung (user report 2026-11-24: two five-minute syncs, no output at all).
   */
  trace?: (line: string) => void;
  /** Commit only: no fetch, no merge, no push. */
  commitOnly?: boolean;
  /** Where a relative `file:` path is read from. Default: the process's cwd. */
  cwd?: string;
  deps?: Partial<WorkspaceDeps>;
}

// ─── Small helpers ──────────────────────────────────────────────────────────

/**
 * THE NETWORK BUDGET of one sync run. The app gives a whole sync five minutes
 * (`WORKSPACE_SYNC_TIMEOUT_MS`), and one network git call used to be allowed
 * the same five minutes — so a fetch that hung (a sign-in window nobody saw, a
 * stalled connection) let the app kill the run with no answer at all, possibly
 * mid-merge (user report 2026-11-24). Every fetch and push of a run now shares
 * this budget, each call capped, so the run always answers first.
 */
const SYNC_NETWORK_BUDGET_MS = 4 * 60_000;
const SYNC_NETWORK_CALL_MAX_MS = 2 * 60_000;
const SYNC_NETWORK_CALL_MIN_MS = 5_000;

/** The timeout of a run's next network call, from the run's deadline (wall clock). */
export function syncNetworkTimeout(deadline: number, clock: number = Date.now()): number {
  return Math.max(SYNC_NETWORK_CALL_MIN_MS, Math.min(SYNC_NETWORK_CALL_MAX_MS, deadline - clock));
}

/** `network`: false for a local call, or the timeout of a network one. */
function attempt(git: WorkspaceGit, args: string[], cwd: string, network: false | number = false): { ok: true; out: string } | { ok: false; detail: string } {
  try {
    return { ok: true, out: git(args, cwd, network === false ? {} : { network: true, timeoutMs: network }) };
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
}

function errorText(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const stdout = (error as { stdout?: unknown }).stdout;
  const text =
    typeof stderr === 'string' && stderr.trim() !== ''
      ? stderr
      : typeof stdout === 'string' && stdout.trim() !== ''
        ? stdout
        : error instanceof Error
          ? error.message
          : String(error);
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 299)}…` : collapsed;
}

function splitZ(out: string): string[] {
  return out.split('\0').filter((entry) => entry.length > 0);
}

function revParse(git: WorkspaceGit, repo: string, ref: string): string | null {
  const result = attempt(git, ['rev-parse', '--verify', '-q', ref], repo);
  const sha = result.ok ? result.out.trim() : '';
  return sha === '' ? null : sha;
}

function isAncestor(git: WorkspaceGit, repo: string, ancestor: string, of: string): boolean {
  return attempt(git, ['merge-base', '--is-ancestor', ancestor, of], repo).ok;
}

function countRange(git: WorkspaceGit, repo: string, range: string): number {
  const result = attempt(git, ['rev-list', '--count', range], repo);
  return result.ok ? Number.parseInt(result.out.trim(), 10) || 0 : 0;
}

/**
 * A fetch/push failure the remote REFUSED — about access, not reachability.
 * NOT "access rights": git appends "Please make sure you have the correct
 * access rights and the repository exists" to every ssh failure, a DNS one
 * included.
 */
const ACCESS_FAILURE =
  /authentication failed|permission denied|could not read (?:username|password)|terminal prompts disabled|invalid username or password|access denied|denied to |repository not found|returned error: 40[13]|\b40[13]\b/i;
const REJECTED_PUSH = /\[rejected\]|non-fast-forward|fetch first|failed to push some refs|updates were rejected/i;
/** The remote itself declined the update (a hook, a protected branch) — not a moved remote; retrying cannot help. */
const REMOTE_REJECTED = /\[remote rejected\]/i;

/**
 * Was a failed fetch/push refused by the remote (`no-access`) or did it not
 * get through at all (`offline`)? Anything unrecognised is `offline`: a retry
 * costs nothing, while `no-access` waits for a person.
 */
export function classifyRemoteFailure(detail: string): 'no-access' | 'offline' {
  return ACCESS_FAILURE.test(detail) || REMOTE_REJECTED.test(detail) ? 'no-access' : 'offline';
}

const AUTHOR_POLICY = /VS403702|GH007|author email '[^']+' which does not match|would publish a private email/i;
const PULL_REQUEST_POLICY = /TF402455|must use a pull request|must be made through a pull request/i;

/**
 * For a `no-access` failure, name WHAT the remote refused. Policies are checked
 * before access: a refusal a person can act on beats a generic "no access".
 */
export function classifyRejection(detail: string): SyncRejection {
  if (AUTHOR_POLICY.test(detail)) {
    const named = /author email '([^']+)'/i.exec(detail);
    return { kind: 'author-not-allowed', email: named?.[1] ?? null };
  }
  if (PULL_REQUEST_POLICY.test(detail)) return { kind: 'pull-request-required' };
  if (REMOTE_REJECTED.test(detail) && !ACCESS_FAILURE.test(detail)) return { kind: 'declined' };
  return { kind: 'access' };
}

// ─── Workspace lookup ───────────────────────────────────────────────────────

function findWorkspace(flowFolder: string, wanted: string | undefined): LoadedWorkspace {
  const scan = scanWorkspaces(flowFolder);
  const choices = scan.workspaces.map((workspace) => ({ slug: workspace.slug, name: workspace.name }));
  if (wanted === undefined) {
    if (scan.workspaces.length === 1) return scan.workspaces[0];
    if (scan.workspaces.length === 0) {
      throw new WorkspaceRefusal('no-workspace', 'there is no Workspace on this machine yet — create or join one first', { workspaces: [] });
    }
    throw new WorkspaceRefusal('which-workspace', 'there is more than one Workspace on this machine — say which one to sync', { workspaces: choices });
  }
  const broken = scan.unreadable.find((entry) => entry.workspace === wanted);
  if (broken !== undefined) throw new WorkspaceRefusal('malformed-workspace', broken.detail, { workspace: wanted });
  const found =
    scan.workspaces.find((workspace) => workspace.slug === wanted) ??
    scan.workspaces.find((workspace) => workspace.name === wanted) ??
    scan.workspaces.find((workspace) => workspace.slug === slugify(wanted));
  if (found === undefined) {
    throw new WorkspaceRefusal('unknown-workspace', `there is no Workspace called ${wanted} on this machine`, { workspaces: choices });
  }
  return found;
}

/**
 * `findWorkspace`, except when the Workspace's own `workspace.json` is
 * unreadable BECAUSE a sync of Flow's died mid-merge and left conflict markers
 * in it: that merge is undone first (`recoverLeftoverMerge`, under the lock),
 * then the Workspace is read again. Without this, the refusal came before the
 * recovery that would have fixed it, so the Workspace could never sync again
 * (user report 2026-11-24: a sync killed by the app's timeout mid-merge). Any
 * other unreadable file, or a merge Flow did not start, is refused as before.
 */
function findWorkspaceRecovering(
  flowFolder: string,
  wanted: string | undefined,
  git: WorkspaceGit,
  now: () => Date
): { workspace: LoadedWorkspace; early: { lock: LockRecovery | null; merge: boolean } } {
  try {
    return { workspace: findWorkspace(flowFolder, wanted), early: { lock: null, merge: false } };
  } catch (error) {
    if (!(error instanceof WorkspaceRefusal) || error.reason !== 'malformed-workspace' || wanted === undefined) throw error;
    const early = recoverUnreadableWorkspace(flowFolder, wanted, git, now);
    if (early === null) throw error;
    return { workspace: findWorkspace(flowFolder, wanted), early };
  }
}

/**
 * Undo the merge a killed sync of Flow's left in a Workspace folder, so its
 * conflicted `workspace.json` reads again. Null when there is nothing of that
 * kind to undo (not a repository, no merge in progress); throws
 * `merge-in-progress` for a merge Flow may not touch (see recoverLeftoverMerge).
 * Under the sync lock, so it never races a running sync.
 */
export function recoverUnreadableWorkspace(
  flowFolder: string,
  slug: string,
  git: WorkspaceGit = defaultWorkspaceGit,
  now: () => Date = () => new Date()
): { lock: LockRecovery | null; merge: boolean } | null {
  const repo = workspaceDir(flowFolder, slug);
  if (!existsSync(repo)) return null;
  const top = attempt(git, ['rev-parse', '--show-toplevel'], repo);
  if (!top.ok || realOrResolved(top.out.trim()) !== realOrResolved(repo)) return null;
  if (revParse(git, repo, 'MERGE_HEAD') === null) return null;
  const lock = acquireLock(git, repo, now());
  try {
    return { lock: lock.recovered, merge: recoverLeftoverMerge(git, repo, slug) };
  } finally {
    lock.release();
  }
}

/**
 * Run a Workspace verb; when it refuses `malformed-workspace` for a Workspace
 * whose file a killed sync left mid-merge, undo that merge and run it ONCE
 * more. The app's launch migration and promote read the Workspace before any
 * sync can, so without this the repair never got a turn (user report
 * 2026-11-24: the Workspace vanished from Settings and nothing could sync it).
 */
export function withWorkspaceRecovery<T>(flowFolder: string, git: WorkspaceGit | undefined, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof WorkspaceRefusal) || error.reason !== 'malformed-workspace') throw error;
    const slug = error.payload.workspace;
    if (typeof slug !== 'string' || slug === '') throw error;
    if (recoverUnreadableWorkspace(flowFolder, slug, git ?? defaultWorkspaceGit) === null) throw error;
    return run();
  }
}

// ─── The lock ───────────────────────────────────────────────────────────────

/** Is the process alive? EPERM means it exists but belongs to someone else. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The pid recorded on the lock's first line, or null. */
function lockOwner(path: string): number | null {
  try {
    const first = readFileSync(path, 'utf-8').split('\n')[0]?.trim() ?? '';
    const pid = /^\d+$/.test(first) ? Number.parseInt(first, 10) : Number.NaN;
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * Is a lock that exists still held? `null` — held; otherwise why it is not.
 * A recorded owner that is gone frees it at once; a live owner holds it for
 * STALE_LOCK_MS (after that the pid was reused); no readable owner holds it
 * for LOCK_TIMEOUT_MS.
 */
export function staleLock(path: string, now: Date, alive: (pid: number) => boolean = processAlive): LockRecovery | null {
  let age: number;
  try {
    age = now.getTime() - statSync(path).mtimeMs;
  } catch {
    return 'owner-gone';
  }
  const pid = lockOwner(path);
  if (pid !== null) {
    if (pid !== process.pid && !alive(pid)) return 'owner-gone';
    return age > STALE_LOCK_MS ? 'expired' : null;
  }
  return age > LOCK_TIMEOUT_MS ? 'expired' : null;
}

export function syncLockPath(git: WorkspaceGit, repo: string): string {
  return resolve(repo, git(['rev-parse', '--git-path', SYNC_LOCK_GIT_PATH], repo).trim());
}

function acquireLock(git: WorkspaceGit, repo: string, now: Date): { release: () => void; recovered: LockRecovery | null } {
  const path = syncLockPath(git, repo);
  const body = `${process.pid}\n${now.toISOString()}\n`;
  const take = (): boolean => {
    try {
      writeFileSync(path, body, { flag: 'wx' });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return false;
    }
  };
  let recovered: LockRecovery | null = null;
  if (!take()) {
    let judged: string | null = null;
    try {
      judged = readFileSync(path, 'utf-8');
    } catch {
      judged = null;
    }
    recovered = staleLock(path, now);
    // Moved aside ONLY if it is still the lock that was judged stale, then
    // taken exclusively: two runs clearing one stale lock cannot both win,
    // and neither can clear a fresh lock another run took meanwhile.
    const cleared = recovered !== null && (judged === null ? !existsSync(path) : replaceStaleLock(path, judged));
    if (!cleared || !take()) {
      throw new WorkspaceRefusal('sync-busy', 'this Workspace is already being synced — try again in a moment');
    }
  }
  return { release: () => rmSync(path, { force: true }), recovered };
}

/**
 * Take a lock judged stale out of the way, atomically: rename it to a unique
 * name, and keep it gone only if what was moved is the body that was judged.
 * A lock another run took between the judgement and the rename is put back
 * (`link` — never over a lock that exists) and the answer is false.
 */
export function replaceStaleLock(path: string, judgedBody: string): boolean {
  const aside = `${path}.stale-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    renameSync(path, aside);
  } catch (error) {
    // Already gone: someone else cleared it — the exclusive take decides who wins.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
  let moved: string | null = null;
  try {
    moved = readFileSync(aside, 'utf-8');
  } catch {
    moved = null;
  }
  if (moved === judgedBody) {
    rmSync(aside, { force: true });
    return true;
  }
  try {
    linkSync(aside, path);
  } catch {
    // A third run already holds `path`; the moved lock's owner will find its file gone on release, which is harmless.
  }
  rmSync(aside, { force: true });
  return false;
}

// ─── Flow's own merge: the marker, and recovering one left half-done ─────────

interface MergeMarker {
  pid: number;
  head: string;
  incoming: string;
  startedAt: string;
}

function markerPath(git: WorkspaceGit, repo: string): string {
  return resolve(repo, git(['rev-parse', '--git-path', SYNC_MERGE_MARKER_GIT_PATH], repo).trim());
}

function writeMarker(git: WorkspaceGit, repo: string, marker: MergeMarker): void {
  writeFileSync(markerPath(git, repo), `${JSON.stringify(marker)}\n`);
}

function clearMarker(git: WorkspaceGit, repo: string): void {
  const path = attempt(git, ['rev-parse', '--git-path', SYNC_MERGE_MARKER_GIT_PATH], repo);
  if (path.ok) rmSync(resolve(repo, path.out.trim()), { force: true });
}

function readMarker(git: WorkspaceGit, repo: string): MergeMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(markerPath(git, repo), 'utf-8')) as Partial<MergeMarker>;
    if (typeof parsed.head !== 'string' || typeof parsed.incoming !== 'string') return null;
    return { pid: Number(parsed.pid), head: parsed.head, incoming: parsed.incoming, startedAt: String(parsed.startedAt) };
  } catch {
    return null;
  }
}

const CONFLICT_MARKERS = /^<{7}(?: |$)[\s\S]*^>{7}(?: |$)/m;

/**
 * Unmerged paths whose working file is no longer what git left there — a
 * person (or an agent) resolved it by hand. Untouched means: absent (the
 * deleted side), byte-identical to one of its stages, or still carrying
 * conflict markers.
 */
function handResolved(git: WorkspaceGit, repo: string): string[] {
  const listed = attempt(git, ['ls-files', '--unmerged', '-z'], repo);
  if (!listed.ok) return [];
  const stages = new Map<string, Set<string>>();
  for (const entry of splitZ(listed.out)) {
    const match = /^\d+ ([0-9a-f]+) \d\t(.+)$/s.exec(entry);
    if (match === null) continue;
    const blobs = stages.get(match[2]) ?? new Set<string>();
    blobs.add(match[1]);
    stages.set(match[2], blobs);
  }
  const edited: string[] = [];
  for (const [path, blobs] of stages) {
    const full = join(repo, path);
    if (!existsSync(full)) continue;
    let content: Buffer;
    try {
      content = readFileSync(full);
    } catch {
      edited.push(path);
      continue;
    }
    if (CONFLICT_MARKERS.test(content.toString('utf-8'))) continue;
    const blob = createHash('sha1').update(`blob ${content.length}\0`).update(content).digest('hex');
    if (!blobs.has(blob)) edited.push(path);
  }
  return edited.sort();
}

/**
 * Undo a merge Flow's own sync left half-done (see the module header). Answers
 * true when one was undone; throws `merge-in-progress` when a merge is there
 * that Flow may not touch, saying why.
 */
function recoverLeftoverMerge(git: WorkspaceGit, repo: string, workspace: string): boolean {
  const mergeHead = revParse(git, repo, 'MERGE_HEAD');
  if (mergeHead === null) {
    clearMarker(git, repo);
    return false;
  }
  const head = revParse(git, repo, 'HEAD');
  const marker = readMarker(git, repo);
  if (marker === null || marker.head !== head || marker.incoming !== mergeHead) {
    throw new WorkspaceRefusal('merge-in-progress', 'a merge was left half-done in this Workspace folder, so Flow will not sync over it', {
      workspace,
      leftBy: 'someone-else',
    });
  }
  const edited = handResolved(git, repo);
  if (edited.length > 0) {
    throw new WorkspaceRefusal(
      'merge-in-progress',
      "a merge Flow started was left half-done, and some of its files have been changed by hand since, so Flow won't undo it",
      { workspace, leftBy: 'flow', handEdited: edited }
    );
  }
  const aborted = attempt(git, [...NO_SYMLINKS, 'merge', '--abort'], repo);
  if (!aborted.ok || revParse(git, repo, 'MERGE_HEAD') !== null || revParse(git, repo, 'HEAD') !== marker.head) {
    throw new WorkspaceRefusal(
      'merge-in-progress',
      "a merge Flow started was left half-done, and files it touched have been changed since, so Flow won't undo it",
      { workspace, leftBy: 'flow', ...(aborted.ok ? {} : { git: aborted.detail }) }
    );
  }
  clearMarker(git, repo);
  return true;
}

// ─── Step 1: commit ─────────────────────────────────────────────────────────

/**
 * Paths this machine would publish beyond what is staged: every path ANY
 * outgoing commit added or changed — not just the net change, because a
 * personal file committed and then deleted is still in the history a push
 * sends — plus the net change itself (a merge commit lists no files in a log).
 * Without a tracking ref, "outgoing" is everything no remote ref has.
 */
function outgoingPaths(git: WorkspaceGit, repo: string, tracking: string | null): string[] {
  const head = revParse(git, repo, 'HEAD');
  if (head === null) return [];
  // A shared repository with NO history in common with this one (a Workspace
  // connected by hand to a repository that holds another Workspace): nothing
  // can be pushed — the merge step refuses `unrelated-history` and says what
  // to do. Asking git for a three-dot diff here would fail with "no merge
  // base" and bury that answer under a raw git error (user report 2026-11-24).
  if (tracking !== null && !attempt(git, ['merge-base', head, tracking], repo).ok) return [];
  const range = tracking === null ? [head, '--not', '--remotes'] : [`${tracking}..${head}`];
  const log = git(['log', '--name-only', '--no-renames', '--diff-filter=AMTC', '--format=', '-z', ...range], repo);
  const paths = log
    .split(/[\0\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (tracking !== null) {
    paths.push(...splitZ(git(['diff', '--name-only', '--no-renames', '--diff-filter=AMT', '-z', `${tracking}...${head}`], repo)));
  }
  return [...new Set(paths)];
}

/**
 * Tracked files this machine must not keep publishing: the personal and
 * generated classes. They got into the Workspace before they were classified
 * (or by a hand push). Untracked here — the file stays on disk, now ignored —
 * so the next commit carries their removal instead of refusing for ever
 * (personal) or colliding with each machine's rebuilt copy (generated).
 */
function untrackLocalOnly(git: WorkspaceGit, repo: string): string[] {
  const tracked = revParse(git, repo, 'HEAD') === null ? [] : splitZ(git(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], repo));
  const local = tracked.filter((path) => {
    const knowledgeClass = classifyKnowledgePath(path, { root: 'workspace' });
    return knowledgeClass === 'personal' || knowledgeClass === 'generated';
  });
  // A symlink is never published either: every other machine refuses one
  // incoming (`incoming-unsafe`), so it would block the whole team.
  const raw = splitZ(git(['diff', '--cached', '--raw', '-z', '--no-renames', '--no-abbrev'], repo));
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const meta = raw[index].replace(/^:/, '').split(' ');
    if (meta[1] === SYMLINK_MODE && (meta[4] ?? '').charAt(0) !== 'D') local.push(raw[index + 1]);
  }
  if (local.length > 0) git(['rm', '-q', '--cached', '--ignore-unmatch', '--', ...local], repo);
  return [...new Set(local)].sort();
}

/**
 * An archived rounds record leaves this machine only as its summary
 * (FR-17): every project's `archive/rounds_*.jsonl` not yet summarized is
 * rewritten in place, its full text kept under the project's personal
 * `.evidence/rounds/` — the same place `archiveRounds` keeps it.
 */
function summarizeRoundsRecords(repo: string): void {
  const projects = join(repo, WORKSPACE_PROJECTS_DIRNAME);
  if (!existsSync(projects)) return;
  for (const entry of readdirSync(projects)) {
    const folder = join(projects, entry);
    try {
      if (entry.startsWith('.') || !lstatSync(folder).isDirectory()) continue;
    } catch {
      continue;
    }
    summarizeArchivedRounds(folder, { keepFull: true });
  }
}

function unstageAll(git: WorkspaceGit, repo: string): void {
  if (revParse(git, repo, 'HEAD') === null) {
    attempt(git, ['read-tree', '--empty'], repo);
  } else {
    attempt(git, ['reset', '-q'], repo);
  }
}

/** The pre-push guard over a list of paths, as a Workspace refusal. */
function guardPersonal(paths: readonly string[], extra: Record<string, unknown>): void {
  const hits = findPersonalFiles([...new Set(paths)]);
  if (hits.length === 0) return;
  const list = hits.map((hit) => hit.path);
  const sentence =
    hits.length === 1
      ? `${list[0]} belongs to this machine only, so it can't be shared with the Workspace — nothing was synced`
      : `${hits.length} files belong to this machine only, so they can't be shared with the Workspace — nothing was synced: ${list.join(', ')}`;
  throw new WorkspaceRefusal('personal-files', sentence, { paths: list, hits, committed: false, pushed: false, ...extra });
}

function defaultMessage(workspace: LoadedWorkspace): string {
  return `${DEFAULT_MESSAGE_PREFIX} ${workspace.name}`;
}

/**
 * Rebuild the commits this machine has not sent yet without the personal
 * files in them (user, 2026-11-24: sync stuck on "personal files … nothing was
 * sent" for ever). The index already holds what should be shared — personal
 * files are untracked by now and stay on disk — so the unsent commits are
 * folded into one from where this machine and the remote last agreed. Nothing
 * is lost: every file is still in the tree or on disk, and nothing the remote
 * has is rewritten. Returns false when it cannot tell where they agreed (no
 * tracking ref, and part of this history is on some other remote ref).
 */
function dropPersonalHistory(git: WorkspaceGit, repo: string, tracking: string | null, message: string): boolean {
  if (tracking !== null) {
    const base = attempt(git, ['merge-base', 'HEAD', tracking], repo);
    if (!base.ok || base.out.trim() === '') return false;
    git(['reset', '-q', '--soft', base.out.trim()], repo);
    return true;
  }
  const all = countRange(git, repo, 'HEAD');
  const unsent = Number(git(['rev-list', '--count', 'HEAD', '--not', '--remotes'], repo).trim());
  if (all !== unsent) return false;
  const tree = git(['write-tree'], repo).trim();
  const made = attempt(git, ['-c', 'user.useConfigOnly=true', 'commit-tree', tree, '-m', message], repo);
  if (!made.ok) return false;
  git(['reset', '-q', '--soft', made.out.trim()], repo);
  return true;
}

function commitLocal(
  git: WorkspaceGit,
  repo: string,
  message: string,
  tracking: string | null,
  hasRemote: boolean,
  untracked: string[] = []
): SyncCommit | null {
  summarizeRoundsRecords(repo);
  git(['add', '-A', '--', '.'], repo);
  let staged: string[];
  try {
    untracked.push(...untrackLocalOnly(git, repo));
    // A personal file staged by hand (forced past the ignore file) is let go
    // of the same way: it stays on disk, it is just not shared.
    const stagedPersonal = findPersonalFiles(
      splitZ(git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=AMTC', '-z'], repo))
    ).map((hit) => hit.path);
    if (stagedPersonal.length > 0) {
      git(['rm', '-q', '--cached', '--ignore-unmatch', '--', ...stagedPersonal], repo);
      untracked.push(...stagedPersonal);
    }
    // History only matters once there is somewhere to send it: a Workspace
    // with no shared repository sends nothing, so an old commit that once held
    // a personal file must not block it for ever.
    if (hasRemote) {
      const inHistory = findPersonalFiles(outgoingPaths(git, repo, tracking)).map((hit) => hit.path);
      if (inHistory.length > 0 && dropPersonalHistory(git, repo, tracking, message)) untracked.push(...inHistory);
    }
    // Drafts are committed like any knowledge (discovery
    // `workspace_knowledge_draft_solid`, FR-3): the team sees work in progress,
    // tagged with its branch by its provenance, and promotion — not this
    // commit — decides when it is solid. Nothing authored is held back here.
    staged = splitZ(git(['diff', '--cached', '--name-only', '--no-renames', '-z'], repo));
    // A removal publishes nothing of the file; everything else is judged.
    const published = splitZ(git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=AMTC', '-z'], repo));
    guardPersonal([...published, ...(hasRemote ? outgoingPaths(git, repo, tracking) : [])], {});
  } catch (error) {
    unstageAll(git, repo);
    throw error;
  }
  if (staged.length === 0) return null;
  const committed = attempt(git, ['-c', 'user.useConfigOnly=true', 'commit', '-q', '-m', message], repo);
  if (!committed.ok) {
    unstageAll(git, repo);
    if (/user\.useConfigOnly|tell me who you are|empty ident|no email was given|author identity unknown/i.test(committed.detail)) {
      throw new WorkspaceRefusal('no-identity', "git doesn't know who you are on this machine yet, so the knowledge can't be committed in your name", {
        committed: false,
      });
    }
    throw new WorkspaceRefusal('commit-failed', `the knowledge could not be committed: ${committed.detail}`, { committed: false });
  }
  return { sha: git(['rev-parse', 'HEAD'], repo).trim(), message, files: staged.length };
}

// ─── Step 3: merge ──────────────────────────────────────────────────────────

type MergeStep =
  | { kind: 'none' }
  | { kind: 'fast-forward'; pulled: number }
  | {
      kind: 'merged';
      pulled: number;
      sha: string;
      log: string | null;
      resolutions: MergeResolution[];
      decided: string[];
      mergedItems: MergedItem[];
      held: HeldItem[];
    }
  | { kind: 'waiting'; asks: SyncAsk[]; reviews: SyncReview[]; decided: string[] };

interface ResolveRequest {
  path?: string;
  id?: string;
  take: Take;
  content?: string;
}

interface MergeContext {
  git: WorkspaceGit;
  repo: string;
  branch: string;
  now: Date;
  resolve?: ResolveRequest;
  /** `--decisions`: many decisions, each by id, applied in this one merge. */
  batch?: readonly ResolveRequest[];
  /** `--hold`: ids whose decided text is held aside; the merge takes the Workspace's version. */
  hold?: readonly string[];
}

/** What a resolve request is about, for a sentence or a payload. */
function resolveSubject(request: ResolveRequest): string {
  return request.path ?? request.id ?? '';
}

/** A decision run met no merge waiting for it. */
function refuseNothingToResolve(context: MergeContext): never {
  throw new WorkspaceRefusal(
    'nothing-to-resolve',
    'there is no merge waiting for a decision in this Workspace',
    context.resolve !== undefined ? { path: resolveSubject(context.resolve) } : { ids: (context.batch ?? []).map((entry) => entry.id ?? '') }
  );
}

function decidingIn(context: MergeContext): boolean {
  return context.resolve !== undefined || context.batch !== undefined;
}

/**
 * Undo Flow's own merge in progress. `git merge --abort` keeps every edit
 * made to a file the merge did not touch, so it is the only undo used while
 * it works. A HARD reset — which would also wipe such an edit — is the last
 * resort, and only when the abort failed AND the merge in progress is still
 * exactly the one Flow's marker names; anything else is refused
 * (`merge-in-progress`) and the tree is left as it is.
 */
function abortMerge(git: WorkspaceGit, repo: string, head: string, incoming: string): void {
  const aborted = attempt(git, [...NO_SYMLINKS, 'merge', '--abort'], repo);
  const mergeHead = revParse(git, repo, 'MERGE_HEAD');
  if (aborted.ok && mergeHead === null && revParse(git, repo, 'HEAD') === head) {
    clearMarker(git, repo);
    return;
  }
  const marker = readMarker(git, repo);
  const flowsOwn = marker !== null && marker.head === head && marker.incoming === incoming && (mergeHead === null || mergeHead === incoming);
  if (!flowsOwn) {
    throw new WorkspaceRefusal('merge-in-progress', "Flow's merge could not be undone cleanly, so the Workspace folder was left as it is", {
      leftBy: 'flow',
      pushed: false,
      ...(aborted.ok ? {} : { git: aborted.detail }),
    });
  }
  git([...NO_SYMLINKS, 'reset', '-q', '--hard', head], repo);
  clearMarker(git, repo);
}

/** One incoming path that may not be brought in, and why. */
export interface UnsafeIncomingPath {
  path: string;
  why: 'personal' | 'symlink' | 'repo-settings';
}

const REPO_SETTINGS_FILE = /(?:^|\/)\.git(?:attributes|ignore|modules)$/i;

/**
 * What the incoming side changed since the common ancestor that must never be
 * merged on a person's behalf: a personal-class path (any spelling), a
 * symlink, a nested `.gitattributes`/`.gitignore`, or a root one changed
 * outside Flow's generated block (for `.gitattributes`, the block itself too
 * — it decides how THIS merge resolves files; for `.gitignore`, only a change
 * that un-ignores something). Read-only.
 */
function unsafeIncoming(git: WorkspaceGit, repo: string, head: string | null, tracking: string): UnsafeIncomingPath[] {
  let from = EMPTY_TREE;
  if (head !== null) {
    const base = attempt(git, ['merge-base', head, tracking], repo);
    if (base.ok && base.out.trim() !== '') from = base.out.trim();
  }
  const textAt = (rev: string, path: string): string | null => {
    const blob = attempt(git, ['cat-file', 'blob', `${rev}:${path}`], repo);
    return blob.ok ? blob.out : null;
  };
  const parts = splitZ(git(['diff', '--raw', '-z', '--no-renames', '--no-abbrev', from, tracking], repo));
  const unsafe: UnsafeIncomingPath[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    const meta = parts[index].replace(/^:/, '').split(' ');
    const path = parts[index + 1];
    const newMode = meta[1] ?? '';
    const status = (meta[4] ?? '').charAt(0);
    const removed = status === 'D';
    if (!removed && newMode === SYMLINK_MODE) {
      unsafe.push({ path, why: 'symlink' });
      continue;
    }
    // PERSONAL BY A RULE, NOT BY NOBODY CLAIMING IT. `row` is null when the
    // class came from the closed-root default — an unrecognised file at a
    // project's knowledge root (forbidden-pattern #24). Refusing to RECEIVE one
    // is the wrong half of that rule: the harm in a stray deliverable is
    // publishing it, and a Workspace that already shares one would have every
    // later sync refused on a file nobody can now remove, because removing it
    // is itself an incoming change. The named personal classes — credentials,
    // machine state, daemon files — are what this guard is for.
    const incoming = classifyKnowledgePathDetailed(path, { root: 'workspace' });
    if (!removed && incoming.class === 'personal' && incoming.row !== null) {
      unsafe.push({ path, why: 'personal' });
      continue;
    }
    if (REPO_SETTINGS_FILE.test(path)) {
      const root = !path.includes('/') && !/\.gitmodules$/i.test(path);
      if (!root) {
        if (!removed) unsafe.push({ path, why: 'repo-settings' });
        continue;
      }
      const before = splitWorkspaceBlock(textAt(from, path));
      const after = splitWorkspaceBlock(removed ? null : textAt(tracking, path));
      const isIgnore = /^\.gitignore$/i.test(path);
      const outsideChanged =
        before.outside !== after.outside && !(isIgnore && onlyIgnoresMore(before.outside, after.outside));
      const attributesBlockChanged =
        /^\.gitattributes$/i.test(path) && after.block !== before.block && after.block !== workspaceGitattributes();
      if (outsideChanged || attributesBlockChanged) unsafe.push({ path, why: 'repo-settings' });
    }
  }
  return unsafe;
}

/**
 * Whether a root `.gitignore`'s lines outside Flow's block changed ONLY by
 * ignoring more: added comments and plain patterns, removed comments. Ignoring
 * more can never publish a file from this machine, so a teammate's hand-added
 * ignore lines merge like any other change (user report 2026-11-24: lines a
 * member added outside the block on 2026-10-16 refused every sync of a member
 * whose last common commit was older, for ever). Un-ignoring is still refused:
 * a negation (`!pattern`) or a removed pattern.
 */
export function onlyIgnoresMore(beforeOutside: string, afterOutside: string): boolean {
  const lines = (text: string): string[] => (text === '' ? [] : text.split('\n'));
  const before = lines(beforeOutside);
  const after = lines(afterOutside);
  const comment = (line: string): boolean => line.trimStart().startsWith('#');
  const remaining = [...after];
  for (const line of before) {
    const at = remaining.indexOf(line);
    if (at !== -1) {
      remaining.splice(at, 1);
      continue;
    }
    if (!comment(line)) return false;
  }
  return remaining.every((line) => comment(line) || !line.trimStart().startsWith('!'));
}

function refuseUnsafeIncoming(unsafe: readonly UnsafeIncomingPath[]): never {
  const list = unsafe.map((entry) => entry.path);
  throw new WorkspaceRefusal(
    'incoming-unsafe',
    unsafe.length === 1
      ? `the Workspace's latest changes include ${list[0]}, which Flow will not bring onto this machine on its own — nothing was merged or pushed`
      : `the Workspace's latest changes include ${unsafe.length} files Flow will not bring onto this machine on its own — nothing was merged or pushed: ${list.join(', ')}`,
    { paths: unsafe, pushed: false }
  );
}

function mergeIncoming(context: MergeContext, tracking: string | null): MergeStep {
  const { git, repo } = context;
  const head = revParse(git, repo, 'HEAD');
  if (tracking === null || (head !== null && isAncestor(git, repo, tracking, head))) {
    if (decidingIn(context)) refuseNothingToResolve(context);
    return { kind: 'none' };
  }
  // A shared repository whose history has nothing in common with this
  // Workspace's — another Workspace, a repository someone started by hand —
  // is never mixed in: git would refuse the merge anyway, and the person
  // needs to hear WHY in words, not as a failed merge.
  // …UNLESS it is the same work: when both list at least one project in
  // common, two people set up "the same" Workspace on their own (user,
  // 2026-11-24 — "the agent should automatically combine and sync it"). Then
  // the histories are merged in place, every file both wrote goes through the
  // same merge as any sync (the agent combines notes written two ways), and
  // nothing stops for a person unless that merge asks. With no project in
  // common it may be anyone's Workspace — a mistyped address must never send
  // this one's knowledge there — so that still refuses.
  const unrelated = head !== null && !attempt(git, ['merge-base', head, tracking], repo).ok;
  if (unrelated && !sharesAProject(git, repo, head as string, tracking)) {
    if (decidingIn(context)) refuseNothingToResolve(context);
    throw new WorkspaceRefusal(
      'unrelated-history',
      "the shared repository already holds a history that has nothing in common with this Workspace's, so nothing was merged or pushed — connect the Workspace to an empty repository, or join the Workspace that repository holds instead",
      { pushed: false }
    );
  }
  // Judged BEFORE anything is merged or checked out — fast-forward included.
  const unsafe = unsafeIncoming(git, repo, head, tracking);
  if (unsafe.length > 0) refuseUnsafeIncoming(unsafe);
  const pulled = countRange(git, repo, head === null ? tracking : `${head}..${tracking}`);
  if (head === null || isAncestor(git, repo, head, tracking)) {
    if (decidingIn(context)) refuseNothingToResolve(context);
    const ff = attempt(
      git,
      head === null ? [...NO_SYMLINKS, 'reset', '-q', '--hard', tracking] : [...NO_SYMLINKS, 'merge', '--ff-only', '-q', tracking],
      repo
    );
    if (!ff.ok) throw new WorkspaceRefusal('merge-failed', `the Workspace's changes could not be brought in: ${ff.detail}`, { pushed: false });
    return { kind: 'fast-forward', pulled };
  }

  const status = attempt(git, ['status', '--porcelain', '--untracked-files=no'], repo);
  if (!status.ok || status.out.trim() !== '') {
    throw new WorkspaceRefusal('merge-failed', 'the Workspace folder has changes that are not committed, so nothing was merged', { pushed: false });
  }

  const incoming = revParse(git, repo, tracking) ?? tracking;
  writeMarker(git, repo, { pid: process.pid, head, incoming, startedAt: context.now.toISOString() });
  const merge = attempt(
    git,
    [
      ...NO_SYMLINKS,
      '-c',
      'rerere.enabled=false',
      '-c',
      'merge.conflictStyle=merge',
      'merge',
      '--no-ff',
      '--no-commit',
      '-q',
      ...(unrelated ? ['--allow-unrelated-histories'] : []),
      tracking,
    ],
    repo
  );
  if (revParse(git, repo, 'MERGE_HEAD') === null) {
    // git refused outright (unrelated histories, a file in the way…): nothing merged.
    if (revParse(git, repo, 'HEAD') !== head) git([...NO_SYMLINKS, 'reset', '-q', '--hard', head], repo);
    clearMarker(git, repo);
    const detail = merge.ok ? 'git did not start the merge' : merge.detail;
    throw new WorkspaceRefusal('merge-failed', `the Workspace's changes could not be merged: ${detail}`, { pushed: false });
  }

  let heldBefore: HeldItem[] | null = null;
  let held: HeldItem[] = [];
  try {
    const facts = readMergeFacts(git, repo, head, tracking);
    const inspection = inspectMerge(facts);
    const items: (SyncAsk | SyncReview)[] = [...inspection.asks, ...inspection.reviews];

    // Decisions: the stored ones that still match, plus the ones this call brings.
    const stored = readDecisions(git, repo);
    const live = new Map<string, StoredDecision>();
    for (const decision of stored) {
      if (items.some((item) => item.id === decision.id)) live.set(decision.id, decision);
    }
    const waitingList = (): { id: string; path: string }[] => items.map((item) => ({ id: item.id, path: item.path }));
    // Every decision this call brings, matched to its item and checked BEFORE
    // anything is written: one path for a single decision and for a batch.
    const brought: { item: SyncAsk | SyncReview; take: Take; content?: string }[] = [];
    if (context.resolve !== undefined) {
      const wanted = context.resolve;
      let matching: (SyncAsk | SyncReview)[];
      if (wanted.id !== undefined) {
        // BY ID: the decision answers exactly the content it was shown.
        matching = items.filter((item) => item.id === wanted.id && (wanted.path === undefined || item.path === wanted.path));
        if (matching.length === 0) {
          const current = wanted.path === undefined ? undefined : items.find((item) => item.path === wanted.path);
          throw new WorkspaceRefusal(
            'stale-decision',
            'what this decision was about has changed since it was shown, so it was not applied — look at it again',
            { path: wanted.path ?? null, id: wanted.id, current: current?.id ?? null, waiting: waitingList() }
          );
        }
      } else {
        matching = items.filter((item) => item.path === wanted.path);
        if (matching.length === 0) {
          throw new WorkspaceRefusal('nothing-to-resolve', `nothing about ${wanted.path ?? ''} is waiting for a decision`, {
            path: wanted.path ?? null,
            waiting: items.map((item) => item.path),
          });
        }
      }
      const subject = resolveSubject(wanted);
      for (const item of matching) {
        if (!item.options.includes(wanted.take)) {
          throw new WorkspaceRefusal('invalid-resolution', `${subject} can't take '${wanted.take}' — it accepts ${item.options.join(', ')}`, {
            path: item.path,
            options: item.options,
          });
        }
        brought.push({ item, take: wanted.take, ...(wanted.content === undefined ? {} : { content: wanted.content }) });
      }
    }
    if (context.batch !== undefined) {
      // A BATCH is all or nothing: one id that no longer names a current item,
      // or one take its item does not accept, refuses every decision in it.
      const stale: string[] = [];
      const invalid: { id: string; path: string; take: Take; options: Take[] }[] = [];
      for (const wanted of context.batch) {
        const item = items.find((candidate) => candidate.id === wanted.id);
        if (item === undefined) {
          stale.push(wanted.id ?? '');
          continue;
        }
        if (!item.options.includes(wanted.take)) {
          invalid.push({ id: item.id, path: item.path, take: wanted.take, options: item.options });
          continue;
        }
        brought.push({ item, take: wanted.take, ...(wanted.content === undefined ? {} : { content: wanted.content }) });
      }
      if (stale.length > 0) {
        throw new WorkspaceRefusal(
          'stale-decision',
          `${stale.length} of these decisions ${stale.length === 1 ? 'is' : 'are'} about something that changed since it was shown, so none of them was applied — look at them again`,
          { stale, invalid, waiting: waitingList() }
        );
      }
      if (invalid.length > 0) {
        throw new WorkspaceRefusal(
          'invalid-resolution',
          `${invalid.length} of these decisions take${invalid.length === 1 ? 's' : ''} something ${invalid.length === 1 ? 'its item does' : 'their items do'} not accept, so none of them was applied`,
          { invalid, waiting: waitingList() }
        );
      }
    }
    const holding = context.hold ?? [];
    const unknownHeld = holding.filter((id) => !items.some((item) => item.id === id));
    if (unknownHeld.length > 0) {
      throw new WorkspaceRefusal(
        'stale-decision',
        'an item to hold aside is not waiting in this merge (it changed since it was shown), so nothing was applied — look at it again',
        { stale: unknownHeld, invalid: [], waiting: waitingList() }
      );
    }
    const decided: string[] = [];
    if (brought.length > 0) {
      for (const { item, take, content } of brought) {
        live.set(item.id, {
          id: item.id,
          path: item.path,
          take,
          ...(take === 'file' ? { content: content ?? '' } : {}),
          decidedAt: context.now.toISOString(),
        });
        decided.push(item.id);
      }
      const replaced = new Set(brought.map((entry) => entry.item.id));
      writeDecisions(git, repo, [...stored.filter((entry) => !replaced.has(entry.id)), ...[...replaced].map((id) => live.get(id) as StoredDecision)]);
    }

    const settledHere = (id: string): boolean => live.has(id) || holding.includes(id);
    const waitingAsks = inspection.asks.filter((ask) => !settledHere(ask.id));
    const waitingReviews = inspection.reviews.filter((review) => !settledHere(review.id));
    if (waitingAsks.length > 0 || waitingReviews.length > 0) {
      abortMerge(git, repo, head, incoming);
      return { kind: 'waiting', asks: waitingAsks, reviews: waitingReviews, decided };
    }

    // Held items: this machine's text goes aside, the merge takes the Workspace's.
    if (holding.length > 0) {
      heldBefore = readHeld(git, repo);
      held = holdPendingItems(git, repo, holding, context.now, { facts, items, live });
    }

    const resolutions = [...applyResolutions(facts, inspection.resolutions), ...applyDecisions(facts, items, live)];
    const unmerged = attempt(git, ['ls-files', '--unmerged', '-z'], repo);
    if (!unmerged.ok || splitZ(unmerged.out).length > 0) {
      throw new WorkspaceRefusal('merge-failed', 'some files were still unmerged after every resolution, so nothing was merged', { pushed: false });
    }
    const log = writeMergeLog(facts, resolutions, { now: context.now, remoteRef: `${REMOTE_NAME}/${context.branch}` });
    const automatic = resolutions.filter((resolution) => resolution.kind !== 'decision').length;
    const message = `Merge ${REMOTE_NAME}/${context.branch}${automatic === 0 ? '' : ` — ${automatic} settled by Flow`}${log === null ? '' : ` (${log})`}`;
    const heldIds = new Set(held.map((entry) => entry.id));
    const body = decisionsBody(git, repo, resolutions, heldIds);
    const commit = attempt(git, ['-c', 'user.useConfigOnly=true', 'commit', '-q', '--no-edit', '-m', message, ...(body === null ? [] : ['-m', body])], repo);
    if (!commit.ok) {
      throw new WorkspaceRefusal('merge-failed', `the merge could not be committed: ${commit.detail}`, { pushed: false });
    }
    clearMarker(git, repo);
    // Decisions are spent once the merge they answered is committed.
    writeDecisions(git, repo, stored.filter((entry) => !live.has(entry.id)));
    const mergedItems: MergedItem[] = [];
    for (const item of items) {
      const decision = live.get(item.id);
      if (decision === undefined) continue;
      mergedItems.push({ id: item.id, path: item.path, kind: item.kind, take: decision.take, ...(heldIds.has(item.id) ? { held: true as const } : {}) });
    }
    return {
      kind: 'merged',
      pulled,
      sha: git(['rev-parse', 'HEAD'], repo).trim(),
      log,
      resolutions,
      decided: [...new Set([...decided, ...[...live.keys()]])],
      mergedItems,
      held,
    };
  } catch (error) {
    // Only a merge still in progress is undone. A HEAD that moved with no
    // merge in progress is a merge commit already made — never reset away.
    const stillMerging = revParse(git, repo, 'MERGE_HEAD') !== null;
    // Held text written for a merge that is not committed is let go of again.
    if (stillMerging && heldBefore !== null && held.length > 0) writeHeld(git, repo, heldBefore);
    if (stillMerging) abortMerge(git, repo, head, incoming);
    else clearMarker(git, repo);
    throw error;
  }
}

// ─── Held-aside items (inside .git, never committed) ────────────────────────

function heldFile(git: WorkspaceGit, repo: string): string {
  return resolve(repo, git(['rev-parse', '--git-path', SYNC_HELD_GIT_PATH], repo).trim());
}

/** What is held aside on this machine. A damaged store reads as empty — never as a wrong text. */
export function readHeld(git: WorkspaceGit, repo: string): HeldItem[] {
  const path = heldFile(git, repo);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { held?: unknown };
    if (!Array.isArray(parsed.held)) return [];
    return parsed.held.filter(
      (entry): entry is HeldItem =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as HeldItem).id === 'string' &&
        typeof (entry as HeldItem).path === 'string' &&
        typeof (entry as HeldItem).kind === 'string' &&
        typeof (entry as HeldItem).heldAt === 'string' &&
        ((entry as HeldItem).text === null || typeof (entry as HeldItem).text === 'string')
    );
  } catch {
    return [];
  }
}

function writeHeld(git: WorkspaceGit, repo: string, held: readonly HeldItem[]): void {
  const path = heldFile(git, repo);
  if (held.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  atomicWriteFile(path, `${JSON.stringify({ version: 1, held }, null, 2)}\n`);
}

function heldSummaries(held: readonly HeldItem[]): HeldSummary[] {
  return held.map(({ id, path, kind, heldAt }) => ({ id, path, kind, heldAt }));
}

/**
 * Hold items still under review aside, during Flow's merge in progress: each
 * one's text as this machine decided it (its decision's text, or this
 * machine's version when it has none) is written to the held store in `.git`,
 * and the merge is told to take the WORKSPACE's version at its path instead —
 * so the merge commit, and any push after it, carries only what the team
 * already had there. Returns what was held. The caller puts the store back if
 * the merge is not committed.
 */
export function holdPendingItems(
  git: WorkspaceGit,
  repo: string,
  ids: readonly string[],
  now: Date,
  merge: { facts: MergeFacts; items: readonly (SyncAsk | SyncReview)[]; live: Map<string, StoredDecision> }
): HeldItem[] {
  if (ids.length === 0) return [];
  const heldAt = now.toISOString();
  const held: HeldItem[] = [];
  for (const id of new Set(ids)) {
    const item = merge.items.find((candidate) => candidate.id === id);
    if (item === undefined) continue;
    const decision = merge.live.get(id);
    const text = decision === undefined ? textAt(git, repo, merge.facts.ours, item.path) : decidedText(merge.facts, item, decision);
    held.push({ id, path: item.path, kind: item.kind, text, heldAt });
    // The Workspace's version — whatever `options` offers: holding is not a choice of the item's.
    merge.live.set(id, { id, path: item.path, take: 'theirs', decidedAt: heldAt });
  }
  const replaced = new Set(held.map((entry) => entry.path));
  writeHeld(git, repo, [...readHeld(git, repo).filter((entry) => !replaced.has(entry.path)), ...held]);
  return held;
}

/**
 * The body of a merge commit that applied decisions: each decided path with
 * its take (a held one says so), bounded, and who agreed — git's NAME for this
 * machine's person, never the email. Null when the merge applied no decision.
 */
function decisionsBody(git: WorkspaceGit, repo: string, resolutions: readonly MergeResolution[], heldIds: ReadonlySet<string>): string | null {
  const decisions = resolutions.filter((resolution): resolution is Extract<MergeResolution, { kind: 'decision' }> => resolution.kind === 'decision');
  if (decisions.length === 0) return null;
  const lines = decisions
    .slice(0, MAX_BODY_DECISIONS)
    .map((decision) => (heldIds.has(decision.item) ? `- ${decision.path}: held aside, the Workspace's version kept` : `- ${decision.path}: ${decision.take}`));
  if (decisions.length > MAX_BODY_DECISIONS) lines.push(`- and ${decisions.length - MAX_BODY_DECISIONS} more`);
  const name = attempt(git, ['config', 'user.name'], repo);
  const agreedBy = name.ok ? name.out.trim().replace(/\s+/g, ' ').slice(0, MAX_MESSAGE_LENGTH) : '';
  return [`Decided (${decisions.length}):`, ...lines, ...(agreedBy === '' ? [] : ['', `Agreed-by: ${agreedBy}`])].join('\n');
}

// ─── Step 4: indexes ────────────────────────────────────────────────────────

function rebuildIndexes(flowFolder: string, workspace: LoadedWorkspace, now: Date): SyncResult['indexes'] {
  const indexes: SyncResult['indexes'] = { rebuilt: [], failed: [] };
  let slugs: string[];
  try {
    slugs = readWorkspace(flowFolder, workspace.slug).file.projects.map((project) => project.slug);
  } catch {
    const dir = join(workspace.path, WORKSPACE_PROJECTS_DIRNAME);
    slugs = existsSync(dir) ? readdirSync(dir).filter((entry) => !entry.startsWith('.')) : [];
  }
  for (const slug of slugs) {
    const folder = projectFolder(flowFolder, workspace.slug, slug);
    if (!existsSync(folder)) continue;
    try {
      writeBrainIndex(folder, now);
      indexes.rebuilt.push(slug);
    } catch (error) {
      indexes.failed.push({ project: slug, detail: errorText(error) });
    }
  }
  return indexes;
}

// ─── Step 4b: team rules ────────────────────────────────────────────────────

/** Does `<checkout>/flow` lead to this project's folder? */
function linksHere(checkout: string, folder: string): boolean {
  const flow = join(checkout, 'flow');
  try {
    if (!lstatSync(flow).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return realOrResolved(flow) === realOrResolved(folder);
}

/**
 * Mirror each linked project's `rules/` into its checkout's `.claude/rules`
 * (the per-project knowledge repo's `materializeRules`). Only projects with a
 * checkout on this machine (projects.local.json) whose `flow` links here.
 */
export function materializeWorkspaceRules(flowFolder: string, workspaceSlug: string, git: WorkspaceGit): TeamRulesReport {
  const report: TeamRulesReport = { copied: [], skipped: [], failed: [] };
  let projects: { id: string; slug: string }[];
  let local: Record<string, string>;
  try {
    projects = readWorkspace(flowFolder, workspaceSlug).file.projects;
    local = readLocalProjects(flowFolder);
  } catch (error) {
    report.failed.push({ project: '*', detail: errorText(error) });
    return report;
  }
  for (const project of projects) {
    const checkout = local[project.id];
    if (checkout === undefined) continue;
    const folder = projectFolder(flowFolder, workspaceSlug, project.slug);
    const rules = join(folder, TEAM_RULES_DIRNAME);
    try {
      // A `rules` that is a link is not copied: nothing outside the Workspace comes in.
      if (!lstatSync(rules).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!linksHere(checkout, folder)) {
      report.skipped.push({ project: project.slug, reason: 'not-linked-here' });
      continue;
    }
    const tracked = attempt(git, ['ls-files', '-z', '--', '.claude/rules'], checkout);
    if (!tracked.ok || splitZ(tracked.out).length > 0) {
      // Never over files the code repository commits.
      report.skipped.push({ project: project.slug, reason: 'rules-tracked-in-code-repo' });
      continue;
    }
    try {
      const outcome = mirrorTeamRules(rules, checkout, git);
      if (outcome === 'link') report.skipped.push({ project: project.slug, reason: 'rules-folder-is-a-link' });
      else report.copied.push(project.slug);
    } catch (error) {
      report.failed.push({ project: project.slug, detail: errorText(error) });
    }
  }
  return report;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A manifest entry is a plain relative path inside `.claude/rules` — never absolute, never `..`. */
function isSafeRelative(path: string): boolean {
  if (path === '' || isAbsolute(path) || path.includes('\0')) return false;
  return path.split(/[\\/]/).every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Does any folder from `root` down to `path`'s parent exist as a link? Then nothing is written there. */
function crossesLink(root: string, path: string): boolean {
  let current = dirname(path);
  while (current.length >= root.length) {
    if (isLink(current)) return true;
    if (current === root) return false;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

/** Every regular file under `dir`, relative, never following a link. */
function regularFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) out.push(...regularFiles(full, rel));
    else if (stat.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Mirror a Workspace project's `rules/` into `<checkout>/.claude/rules`,
 * WITHOUT owning the folder: a person's own rules there stay. Flow records
 * what it copied (a manifest in the checkout's `.git`), removes only those
 * files when the team retires them, never overwrites a file it did not copy,
 * never copies a link, and never writes through one — a `.claude` or
 * `.claude/rules` that is a link answers `'link'` and nothing is touched.
 */
export function mirrorTeamRules(source: string, checkout: string, git: WorkspaceGit): 'copied' | 'link' {
  const claude = join(checkout, '.claude');
  const dest = join(claude, 'rules');
  if (isLink(claude) || isLink(dest)) return 'link';
  const manifestPath = resolve(checkout, git(['rev-parse', '--git-path', TEAM_RULES_MANIFEST_GIT_PATH], checkout).trim());
  let previous: string[] = [];
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { files?: unknown };
    if (Array.isArray(parsed.files)) previous = parsed.files.filter((entry): entry is string => typeof entry === 'string' && isSafeRelative(entry));
  } catch {
    previous = [];
  }
  const wanted = regularFiles(source);
  const wantedSet = new Set(wanted);
  const owned = new Set(previous);

  for (const rel of previous) {
    if (wantedSet.has(rel)) continue;
    const full = join(dest, rel);
    if (crossesLink(dest, full)) continue;
    try {
      const stat = lstatSync(full);
      if (stat.isFile() || stat.isSymbolicLink()) unlinkSync(full);
    } catch {
      // already gone
    }
  }

  mkdirSync(dest, { recursive: true });
  const copied: string[] = [];
  for (const rel of wanted) {
    const full = join(dest, rel);
    if (crossesLink(dest, full)) continue;
    if (!owned.has(rel)) {
      try {
        lstatSync(full);
        continue; // a file Flow did not put there — the person's, kept
      } catch {
        // absent: Flow's to write
      }
    } else if (isLink(full)) {
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    if (crossesLink(dest, full)) continue;
    copyFileSync(join(source, ...rel.split('/')), full);
    copied.push(rel);
  }
  atomicWriteFile(manifestPath, `${JSON.stringify({ version: 1, files: copied }, null, 2)}\n`);
  return 'copied';
}

// ─── The resolve flag ───────────────────────────────────────────────────────

function parseResolve(resolveOption: SyncResolve, repo: string, cwd: string): ResolveRequest {
  const id = resolveOption.id?.trim() ?? '';
  if (id !== '' && !/^[0-9a-f]{6,64}$/.test(id)) {
    throw new WorkspaceRefusal('invalid-resolution', "that is not the id of a waiting decision", { id });
  }
  const raw = resolveOption.path?.trim() ?? '';
  if (raw === '' && id === '') {
    throw new WorkspaceRefusal('invalid-resolution', 'say which waiting decision this is — its id, or its path', {});
  }
  let path: string | undefined;
  if (raw !== '') {
    const absolute = isAbsolute(raw) ? raw : null;
    path = (absolute === null ? raw : relative(repo, absolute)).replace(/\\/g, '/').replace(/^\.\//, '');
    if (path === '' || path.startsWith('../') || path === '..' || isAbsolute(path)) {
      throw new WorkspaceRefusal('invalid-resolution', 'the path to resolve must be a file inside the Workspace', { path: raw });
    }
  }
  const subject = { ...(path === undefined ? {} : { path }), ...(id === '' ? {} : { id }) };
  const label = path ?? id;
  const take = resolveOption.take.trim();
  if (take === 'ours' || take === 'theirs' || take === 'merged') return { ...subject, take };
  if (take.startsWith('file:')) {
    const source = resolve(cwd, take.slice('file:'.length));
    let content: string;
    try {
      if (statSync(source).size > MAX_DECISION_CONTENT) {
        throw new WorkspaceRefusal('invalid-resolution', 'that merged text is too large to record', { path: label });
      }
      content = readFileSync(source, 'utf-8');
    } catch (error) {
      if (error instanceof WorkspaceRefusal) throw error;
      throw new WorkspaceRefusal('invalid-resolution', `the merged text could not be read: ${errorText(error)}`, { path: label });
    }
    return { ...subject, take: 'file', content };
  }
  throw new WorkspaceRefusal('invalid-resolution', `'${take}' is not a way to settle it — take ours, theirs, merged or file:<path>`, {
    path: label,
    options: ['ours', 'theirs', 'merged', 'file:<path>'],
  });
}

// ─── The put-back flag ──────────────────────────────────────────────────────

interface PutBackRequest {
  path: string;
  expect: string;
  content: string;
}

function parsePutBack(option: SyncPutBack, repo: string, cwd: string): PutBackRequest {
  const raw = option.path.trim();
  const absolute = isAbsolute(raw) ? raw : null;
  const path = (absolute === null ? raw : relative(repo, absolute)).replace(/\\/g, '/').replace(/^\.\//, '');
  if (path === '' || path.startsWith('../') || path === '..' || isAbsolute(path)) {
    throw new WorkspaceRefusal('invalid-resolution', 'the path to put back must be a file inside the Workspace', { path: raw });
  }
  if (!isIntentPath(path)) {
    throw new WorkspaceRefusal('invalid-resolution', 'only a decision, plan or discovery can be put back', { path });
  }
  const expect = option.expect.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expect)) {
    throw new WorkspaceRefusal('invalid-resolution', 'say what the document holds now — the sha256 of its text', { path });
  }
  const take = option.take.trim();
  if (!take.startsWith('file:')) {
    throw new WorkspaceRefusal('invalid-resolution', 'a put-back takes file:<path> — the text to put back', { path });
  }
  const source = resolve(cwd, take.slice('file:'.length));
  let content: string;
  try {
    if (statSync(source).size > MAX_DECISION_CONTENT) {
      throw new WorkspaceRefusal('invalid-resolution', 'that text is too large to record', { path });
    }
    content = readFileSync(source, 'utf-8');
  } catch (error) {
    if (error instanceof WorkspaceRefusal) throw error;
    throw new WorkspaceRefusal('invalid-resolution', `the text to put back could not be read: ${errorText(error)}`, { path });
  }
  return { path, expect, content };
}

/** Write the put-back text, only over exactly the text the caller saw. */
function applyPutBack(repo: string, request: PutBackRequest): void {
  const full = join(repo, ...request.path.split('/'));
  if (crossesLink(repo, full) || isLink(full)) {
    throw new WorkspaceRefusal('invalid-resolution', 'that document is not a plain file inside the Workspace', { path: request.path });
  }
  let current: Buffer;
  try {
    current = readFileSync(full);
  } catch {
    throw new WorkspaceRefusal('stale-decision', 'that document is no longer there, so nothing was put back', { path: request.path });
  }
  if (createHash('sha256').update(current).digest('hex') !== request.expect) {
    throw new WorkspaceRefusal('stale-decision', 'that document changed since it was shown, so nothing was put back — look at it again', {
      path: request.path,
    });
  }
  atomicWriteFile(full, request.content);
}

// ─── The decisions batch ────────────────────────────────────────────────────

const ITEM_ID = /^[0-9a-f]{6,64}$/;
const BATCH_TAKES: readonly Take[] = ['ours', 'theirs', 'merged', 'file'];

/**
 * Read a `--decisions` file. Anything malformed refuses the whole batch
 * (`invalid-resolution`) with every problem found, before any git call.
 */
function parseDecisionsFile(file: string, cwd: string): ResolveRequest[] {
  const source = resolve(cwd, file);
  let raw: string;
  try {
    if (statSync(source).size > MAX_DECISIONS_FILE) {
      throw new WorkspaceRefusal('invalid-resolution', 'that decisions file is too large to read', { file: source });
    }
    raw = readFileSync(source, 'utf-8');
  } catch (error) {
    if (error instanceof WorkspaceRefusal) throw error;
    throw new WorkspaceRefusal('invalid-resolution', `the decisions file could not be read: ${errorText(error)}`, { file: source });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkspaceRefusal('invalid-resolution', 'the decisions file is not JSON', { file: source });
  }
  const list = typeof parsed === 'object' && parsed !== null ? (parsed as { decisions?: unknown }).decisions : undefined;
  if (!Array.isArray(list) || list.length === 0) {
    throw new WorkspaceRefusal('invalid-resolution', 'the decisions file holds no decisions — it needs { "decisions": [ { "id", "take", "content"? } ] }', {
      file: source,
      takes: BATCH_TAKES,
    });
  }
  const problems: { index: number; id: string | null; problem: string }[] = [];
  const requests: ResolveRequest[] = [];
  const seen = new Set<string>();
  list.forEach((entry: unknown, index) => {
    const record = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const take = typeof record.take === 'string' ? record.take.trim() : '';
    const content = record.content;
    const named = id === '' ? null : id;
    if (!ITEM_ID.test(id)) return void problems.push({ index, id: named, problem: 'not the id of a waiting decision' });
    if (seen.has(id)) return void problems.push({ index, id, problem: 'decided twice in this file' });
    seen.add(id);
    if (!(BATCH_TAKES as readonly string[]).includes(take)) {
      return void problems.push({ index, id, problem: `'${take}' is not a take — ${BATCH_TAKES.join(', ')}` });
    }
    if (take === 'file') {
      if (typeof content !== 'string') return void problems.push({ index, id, problem: 'a file take needs its content' });
      if (Buffer.byteLength(content, 'utf-8') > MAX_DECISION_CONTENT) return void problems.push({ index, id, problem: 'that text is too large to record' });
      requests.push({ id, take: 'file', content });
      return;
    }
    if (content !== undefined) return void problems.push({ index, id, problem: `content goes only with a file take, not '${take}'` });
    requests.push({ id, take: take as Take });
  });
  if (problems.length > 0) {
    throw new WorkspaceRefusal('invalid-resolution', `${problems.length} of the decisions in that file can't be read, so none of them was applied`, {
      file: source,
      problems,
      takes: BATCH_TAKES,
    });
  }
  return requests;
}

function parseHold(ids: readonly string[]): string[] {
  const cleaned = ids.map((id) => id.trim()).filter((id) => id !== '');
  const bad = cleaned.filter((id) => !ITEM_ID.test(id));
  if (bad.length > 0) throw new WorkspaceRefusal('invalid-resolution', 'these are not ids of waiting decisions', { hold: bad });
  return [...new Set(cleaned)];
}

// ─── Settling a held item ───────────────────────────────────────────────────

interface SettleRequest {
  id: string;
  take: 'ours' | 'theirs' | 'file';
  content?: string;
}

function parseSettleHeld(option: SyncSettleHeld, cwd: string): SettleRequest {
  const id = option.id.trim();
  if (!ITEM_ID.test(id)) throw new WorkspaceRefusal('invalid-resolution', 'that is not the id of a held item', { id });
  const take = option.take.trim();
  if (take === 'ours' || take === 'theirs') return { id, take };
  if (take.startsWith('file:')) {
    const source = resolve(cwd, take.slice('file:'.length));
    try {
      if (statSync(source).size > MAX_DECISION_CONTENT) {
        throw new WorkspaceRefusal('invalid-resolution', 'that text is too large to record', { id });
      }
      return { id, take: 'file', content: readFileSync(source, 'utf-8') };
    } catch (error) {
      if (error instanceof WorkspaceRefusal) throw error;
      throw new WorkspaceRefusal('invalid-resolution', `the text to settle could not be read: ${errorText(error)}`, { id });
    }
  }
  throw new WorkspaceRefusal('invalid-resolution', `'${take}' is not a way to settle a held item — take ours, theirs or file:<path>`, {
    id,
    options: ['ours', 'theirs', 'file:<path>'],
  });
}

/**
 * Write a held item's agreed text as an ordinary local commit of that one path
 * (`knowledge: settle <path>`), then let go of it. `theirs` writes nothing.
 * The rest of the run commits and syncs as usual.
 */
function settleHeldItem(git: WorkspaceGit, repo: string, request: SettleRequest): NonNullable<SyncResult['settled']> {
  const held = readHeld(git, repo);
  const entry = held.find((candidate) => candidate.id === request.id);
  if (entry === undefined) {
    throw new WorkspaceRefusal('unknown-held', 'nothing with that id is held aside on this machine', { id: request.id, held: heldSummaries(held) });
  }
  const rest = held.filter((candidate) => candidate.id !== request.id);
  if (request.take === 'theirs') {
    writeHeld(git, repo, rest);
    return { id: entry.id, path: entry.path, take: 'theirs', sha: null };
  }
  guardPersonal([entry.path], { id: entry.id });
  const full = join(repo, ...entry.path.split('/'));
  if (!isSafeRelative(entry.path) || crossesLink(repo, full) || isLink(full)) {
    throw new WorkspaceRefusal('invalid-resolution', 'that held item is not a plain file inside the Workspace', { id: entry.id, path: entry.path });
  }
  const text = request.take === 'file' ? (request.content ?? '') : entry.text;
  if (text === null) rmSync(full, { force: true });
  else {
    mkdirSync(dirname(full), { recursive: true });
    atomicWriteFile(full, text);
  }
  attempt(git, ['add', '-A', '--', entry.path], repo);
  let sha: string | null = null;
  if (!attempt(git, ['diff', '--cached', '--quiet', '--', entry.path], repo).ok) {
    const message = `knowledge: settle ${entry.path}`.slice(0, MAX_MESSAGE_LENGTH);
    const committed = attempt(git, ['-c', 'user.useConfigOnly=true', 'commit', '-q', '-m', message, '--', entry.path], repo);
    if (!committed.ok) {
      attempt(git, ['reset', '-q', '--', entry.path], repo);
      throw new WorkspaceRefusal('commit-failed', `the settled text could not be committed: ${committed.detail}`, { committed: false, id: entry.id });
    }
    sha = git(['rev-parse', 'HEAD'], repo).trim();
  }
  writeHeld(git, repo, rest);
  return { id: entry.id, path: entry.path, take: request.take, sha };
}

// ─── The open review (inside .git, never committed) ─────────────────────────

/** One decided item of a merge committed here and not yet agreed: the merge it is in, so it can be held back. */
interface ReviewEntry {
  id: string;
  path: string;
  kind: AskKind | ReviewKind;
  take: Take;
  merge: string;
}

function reviewFile(git: WorkspaceGit, repo: string): string {
  return resolve(repo, git(['rev-parse', '--git-path', SYNC_REVIEW_GIT_PATH], repo).trim());
}

/**
 * What waits for review on this machine. An entry whose merge is no longer in
 * HEAD's history (the branch was moved by hand) is dropped: it cannot be
 * published by this branch any more. A damaged record reads as empty.
 */
export function readReviewRecord(git: WorkspaceGit, repo: string): ReviewEntry[] {
  const path = reviewFile(git, repo);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return [];
    const entries = parsed.items.filter(
      (entry): entry is ReviewEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as ReviewEntry).id === 'string' &&
        typeof (entry as ReviewEntry).path === 'string' &&
        typeof (entry as ReviewEntry).kind === 'string' &&
        typeof (entry as ReviewEntry).take === 'string' &&
        typeof (entry as ReviewEntry).merge === 'string'
    );
    const merges = new Map<string, boolean>();
    return entries.filter((entry) => {
      let inHistory = merges.get(entry.merge);
      if (inHistory === undefined) {
        inHistory = isAncestor(git, repo, entry.merge, 'HEAD');
        merges.set(entry.merge, inHistory);
      }
      return inHistory;
    });
  } catch {
    return [];
  }
}

function writeReviewRecord(git: WorkspaceGit, repo: string, entries: readonly ReviewEntry[]): void {
  const path = reviewFile(git, repo);
  if (entries.length === 0) {
    rmSync(path, { force: true });
    return;
  }
  atomicWriteFile(path, `${JSON.stringify({ version: 1, items: entries }, null, 2)}\n`);
}

/**
 * Add this run's decided, not-held items to the open review when the run
 * keeps its merge here (`keep`), and answer what is open now.
 */
function recordReview(
  git: WorkspaceGit,
  repo: string,
  merge: SyncResult['merge'],
  mergedItems: readonly MergedItem[],
  keep: boolean
): ReviewEntry[] {
  const open = readReviewRecord(git, repo);
  if (!keep || merge === null) return open;
  const fresh = mergedItems
    .filter((item) => item.held !== true)
    .map((item): ReviewEntry => ({ id: item.id, path: item.path, kind: item.kind, take: item.take, merge: merge.sha }));
  if (fresh.length === 0) return open;
  const ids = new Set(fresh.map((entry) => entry.id));
  const next = [...open.filter((entry) => !ids.has(entry.id)), ...fresh];
  writeReviewRecord(git, repo, next);
  return next;
}

/** Every item the open review holds, plus this run's held ones (as the run reported them). */
function mergedItemsOf(open: readonly ReviewEntry[], thisRun: readonly MergedItem[]): MergedItem[] {
  const ids = new Set(open.map((entry) => entry.id));
  return [
    ...open.map(({ id, path, kind, take }): MergedItem => ({ id, path, kind, take })),
    ...thisRun.filter((item) => item.held === true && !ids.has(item.id)),
  ];
}

/**
 * Put decided items of the open review back to the Workspace's version (the
 * merge's incoming side) as ONE ordinary local commit, and hold this
 * machine's own text (the merge's first parent) aside — so a later push
 * carries the Workspace's version there until the item is settled. A path
 * changed since its merge refuses `stale-decision`: never over a later edit.
 */
function holdBackReviewItems(git: WorkspaceGit, repo: string, ids: readonly string[], now: Date): NonNullable<SyncResult['heldBack']> {
  const open = readReviewRecord(git, repo);
  const chosen = ids.map((id) => open.find((entry) => entry.id === id));
  const unknown = ids.filter((_, index) => chosen[index] === undefined);
  if (unknown.length > 0) {
    throw new WorkspaceRefusal('unknown-review-item', 'nothing with that id waits for review on this machine', {
      unknown,
      open: open.map(({ id, path }) => ({ id, path })),
    });
  }
  const entries = chosen as ReviewEntry[];
  guardPersonal(
    entries.map((entry) => entry.path),
    { ids: [...ids] }
  );
  for (const entry of entries) {
    const full = join(repo, ...entry.path.split('/'));
    if (!isSafeRelative(entry.path) || crossesLink(repo, full) || isLink(full)) {
      throw new WorkspaceRefusal('invalid-resolution', 'that review item is not a plain file inside the Workspace', { id: entry.id, path: entry.path });
    }
    const atHead = revParse(git, repo, `HEAD:${entry.path}`);
    const atMerge = revParse(git, repo, `${entry.merge}:${entry.path}`);
    if (atHead !== atMerge) {
      throw new WorkspaceRefusal('stale-decision', 'that item changed since it was merged, so nothing was held back', { id: entry.id, path: entry.path });
    }
  }
  const heldAt = now.toISOString();
  const held: HeldItem[] = [];
  for (const entry of entries) {
    const full = join(repo, ...entry.path.split('/'));
    const theirs = textAt(git, repo, `${entry.merge}^2`, entry.path);
    held.push({ id: entry.id, path: entry.path, kind: entry.kind, text: textAt(git, repo, `${entry.merge}^1`, entry.path), heldAt });
    if (theirs === null) rmSync(full, { force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      atomicWriteFile(full, theirs);
    }
  }
  const paths = entries.map((entry) => entry.path);
  attempt(git, ['add', '-A', '--', ...paths], repo);
  let sha: string | null = null;
  if (!attempt(git, ['diff', '--cached', '--quiet', '--', ...paths], repo).ok) {
    const subject = paths.length === 1 ? `knowledge: hold back ${paths[0]}` : `knowledge: hold back ${paths.length} documents`;
    const committed = attempt(git, ['-c', 'user.useConfigOnly=true', 'commit', '-q', '-m', subject.slice(0, MAX_MESSAGE_LENGTH), '--', ...paths], repo);
    if (!committed.ok) {
      attempt(git, ['reset', '-q', '--', ...paths], repo);
      for (const entry of entries) attempt(git, ['checkout', '-q', 'HEAD', '--', entry.path], repo);
      throw new WorkspaceRefusal('commit-failed', `the held-back items could not be committed: ${committed.detail}`, { committed: false, ids: [...ids] });
    }
    sha = git(['rev-parse', 'HEAD'], repo).trim();
  }
  const replaced = new Set(paths);
  writeHeld(git, repo, [...readHeld(git, repo).filter((entry) => !replaced.has(entry.path)), ...held]);
  const gone = new Set(ids);
  writeReviewRecord(git, repo, open.filter((entry) => !gone.has(entry.id)));
  return { ids: [...ids], sha };
}

// ─── Identity ───────────────────────────────────────────────────────────────

/**
 * The Workspace repository lives outside every project's folder, so a git
 * identity chosen BY FOLDER (`includeIf "gitdir:…"`) never reaches it and its
 * commits fall back to the global email — which a team remote may refuse
 * (Azure DevOps VS403702). When the repository has no email of its own and
 * every linked project checkout on this machine commits as ONE email that
 * differs from it, the repository takes that email (repo-local only).
 * Disagreeing projects, no checkouts, or an email already set: nothing changes.
 */
function adoptProjectIdentity(git: WorkspaceGit, repo: string, flowFolder: string, workspace: LoadedWorkspace): string | null {
  const own = attempt(git, ['config', '--local', '--get', 'user.email'], repo);
  if (own.ok && own.out.trim() !== '') return null;
  const local = readLocalProjects(flowFolder);
  const emails = new Map<string, string>();
  for (const project of workspace.file.projects) {
    const path = local[project.id];
    if (path === undefined || !existsSync(path)) continue;
    const email = attempt(git, ['config', '--get', 'user.email'], path);
    if (email.ok && email.out.trim() !== '') emails.set(email.out.trim().toLowerCase(), email.out.trim());
  }
  if (emails.size !== 1) return null;
  const [email] = [...emails.values()] as [string];
  const effective = attempt(git, ['config', '--get', 'user.email'], repo);
  if (effective.ok && effective.out.trim().toLowerCase() === email.toLowerCase()) return null;
  return attempt(git, ['config', '--local', 'user.email', email], repo).ok ? email : null;
}

// ─── The verb ───────────────────────────────────────────────────────────────

/** Sync one Workspace. See the module header for the steps. */
const TRACE_SLOW_CALL_MS = 2_000;
const TRACE_MAX_ARGS = 10;

/** A git runner that announces each call before it runs, and a long one after. */
function tracingGit(git: WorkspaceGit, say: (what: string) => void): WorkspaceGit {
  return (args, cwd, gitOptions) => {
    const shown = args.length > TRACE_MAX_ARGS ? [...args.slice(0, TRACE_MAX_ARGS), `… ${args.length - TRACE_MAX_ARGS} more`] : args;
    const where = basename(cwd);
    say(`git ${shown.join(' ')} (in ${where}${gitOptions?.network === true ? `, network, up to ${gitOptions.timeoutMs ?? 'default'} ms` : ''})`);
    const started = Date.now();
    try {
      return git(args, cwd, gitOptions);
    } finally {
      const took = Date.now() - started;
      if (took >= TRACE_SLOW_CALL_MS) say(`  … that git call took ${took} ms`);
    }
  };
}

export function syncWorkspace(options: SyncOptions): SyncResult {
  const flowFolder = resolve(options.flowFolder);
  const runStarted = Date.now();
  const say = (what: string): void => options.trace?.(`[sync] +${((Date.now() - runStarted) / 1000).toFixed(1)}s ${what}`);
  const baseGit = options.deps?.git ?? defaultWorkspaceGit;
  const git = options.trace === undefined ? baseGit : tracingGit(baseGit, say);
  const now = options.deps?.now ?? (() => new Date());
  const { workspace, early } = findWorkspaceRecovering(flowFolder, options.workspace, git, now);
  const repo = workspaceDir(flowFolder, workspace.slug);

  const top = attempt(git, ['rev-parse', '--show-toplevel'], repo);
  if (!top.ok || realOrResolved(top.out.trim()) !== realOrResolved(repo)) {
    throw new WorkspaceRefusal('not-a-git-repo', `the ${workspace.name} Workspace folder is not a git repository`, { workspace: workspace.slug });
  }
  const resolveRequest = options.resolve === undefined ? undefined : parseResolve(options.resolve, repo, options.cwd ?? process.cwd());

  const putBackRequest = options.putBack === undefined ? undefined : parsePutBack(options.putBack, repo, options.cwd ?? process.cwd());
  if (putBackRequest !== undefined && (resolveRequest !== undefined || options.commitOnly === true)) {
    throw new WorkspaceRefusal('invalid-resolution', 'a put-back is its own sync — it takes neither a decision nor --commit-only', {
      path: putBackRequest.path,
    });
  }

  const cwd = options.cwd ?? process.cwd();
  const batchRequest = options.decisions === undefined ? undefined : parseDecisionsFile(options.decisions, cwd);
  const holdRequest = options.hold === undefined ? undefined : parseHold(options.hold);
  const settleRequest = options.settleHeld === undefined ? undefined : parseSettleHeld(options.settleHeld, cwd);
  if (batchRequest !== undefined && (resolveRequest !== undefined || putBackRequest !== undefined || options.commitOnly === true)) {
    throw new WorkspaceRefusal('invalid-resolution', 'a decisions file is its own sync — it takes no single decision, no put-back and no --commit-only', {
      file: options.decisions,
    });
  }
  if (holdRequest !== undefined && holdRequest.length > 0 && batchRequest === undefined) {
    throw new WorkspaceRefusal('invalid-resolution', 'holding items aside goes with a decisions file — the merge it applies to', { hold: holdRequest });
  }
  if (settleRequest !== undefined && (resolveRequest !== undefined || putBackRequest !== undefined || batchRequest !== undefined)) {
    throw new WorkspaceRefusal('invalid-resolution', 'settling a held item is its own sync — it takes no decision and no put-back', { id: settleRequest.id });
  }
  const holdBackRequest = options.holdBack === undefined ? undefined : parseHold(options.holdBack);
  if (
    holdBackRequest !== undefined &&
    (holdBackRequest.length === 0 || resolveRequest !== undefined || putBackRequest !== undefined || batchRequest !== undefined || settleRequest !== undefined)
  ) {
    throw new WorkspaceRefusal('invalid-resolution', 'holding review items back is its own sync — it takes ids, and no decision, put-back or settle', {
      holdBack: holdBackRequest ?? [],
    });
  }

  if (options.commitOnly === true && resolveRequest !== undefined) {
    throw new WorkspaceRefusal('invalid-resolution', 'a decision needs the merge it answers, so it cannot be made by a commit-only run', {
      path: resolveSubject(resolveRequest),
    });
  }

  const networkDeadline = Date.now() + SYNC_NETWORK_BUDGET_MS;
  say(`step: lock (Workspace ${workspace.slug})`);
  const lock = acquireLock(git, repo, now());
  // A sync never changes what THIS machine calls the Workspace: when the
  // merged file brings another shared name (two Workspaces combined, an older
  // client's rename), the name this machine showed is kept as its own.
  const nameBefore = workspace.name;
  try {
    const recoveredMerge = recoverLeftoverMerge(git, repo, workspace.slug);
    const branchOut = attempt(git, ['symbolic-ref', '--short', '-q', 'HEAD'], repo);
    let branch = branchOut.ok ? branchOut.out.trim() : '';
    if (branch === '') {
      throw new WorkspaceRefusal('detached-head', 'the Workspace folder is not on a branch, so there is nothing to sync from', { workspace: workspace.slug });
    }

    const origin = attempt(git, ['config', '--get', `remote.${REMOTE_NAME}.url`], repo);
    const remote = origin.ok && origin.out.trim() !== '' ? origin.out.trim() : null;
    if (remote !== null && !parseGitRemote(remote).ok) {
      throw new WorkspaceRefusal('invalid-remote', "the Workspace's remote is not a repository address Flow can use", { remote: redactRemote(remote) });
    }
    let trackingRef = `refs/remotes/${REMOTE_NAME}/${branch}`;

    const result: SyncResult = {
      action: 'sync',
      workspace: { name: workspace.name, slug: workspace.slug, path: repo },
      branch,
      remote: remote === null ? null : redactRemote(remote),
      state: 'nothing-to-do',
      committed: null,
      pulled: 0,
      pushed: false,
      ahead: 0,
      merge: null,
      resolutions: [],
      asks: [],
      reviews: [],
      decided: [],
      // Nothing is skipped any more: a project that kept its own knowledge
      // repository is migrated into the Workspace with --import (decision 2026-10-06).
      skipped: [],
      indexes: { rebuilt: [], failed: [] },
      rules: { copied: [], skipped: [], failed: [] },
      mode: options.commitOnly === true ? 'commit-only' : 'full',
      recovered: { lock: lock.recovered ?? early.lock, merge: recoveredMerge || early.merge },
      untracked: [],
      mergedItems: [],
      heldAside: heldSummaries(readHeld(git, repo)),
    };

    // ── 1. Commit ──
    say('step: commit');
    const adopted = adoptProjectIdentity(git, repo, flowFolder, workspace);
    if (adopted !== null) result.identity = { email: adopted, source: 'projects' };
    writeWorkspaceRepoFiles(repo);
    if (settleRequest !== undefined) {
      result.settled = settleHeldItem(git, repo, settleRequest);
      result.heldAside = heldSummaries(readHeld(git, repo));
    }
    if (holdBackRequest !== undefined) {
      result.heldBack = holdBackReviewItems(git, repo, holdBackRequest, now());
      result.heldAside = heldSummaries(readHeld(git, repo));
    }
    if (putBackRequest !== undefined) {
      applyPutBack(repo, putBackRequest);
      result.putBack = { path: putBackRequest.path };
    }
    const message = (options.message?.trim() || defaultMessage(workspace)).replace(/\s+/g, ' ').slice(0, MAX_MESSAGE_LENGTH);
    result.committed = commitLocal(
      git,
      repo,
      message,
      remote === null ? null : revParse(git, repo, trackingRef),
      remote !== null,
      result.untracked
    );

    if (options.commitOnly === true) {
      // Nothing leaves the machine and nothing comes in: the next full sync exchanges it.
      result.state = result.committed === null ? 'nothing-to-do' : 'committed';
      const tracking = remote === null ? null : revParse(git, repo, trackingRef);
      result.ahead = countRange(git, repo, tracking === null ? 'HEAD' : `${trackingRef}..HEAD`);
      return result;
    }

    // ── 2. Remote ──
    say('step: remote');
    if (remote === null) {
      if (resolveRequest !== undefined || batchRequest !== undefined) {
        throw new WorkspaceRefusal(
          'nothing-to-resolve',
          'this Workspace has no remote, so nothing is waiting to be merged',
          resolveRequest !== undefined ? { path: resolveSubject(resolveRequest) } : { ids: (batchRequest ?? []).map((entry) => entry.id ?? '') }
        );
      }
      result.state = 'local-only';
      result.ahead = countRange(git, repo, 'HEAD');
      return result;
    }

    const fetchOnce = (): { ok: true } | { ok: false; detail: string } => {
      const before = revParse(git, repo, trackingRef);
      const refspecs = [`+refs/heads/${branch}:${trackingRef}`];
      // A glob matches nothing without failing: this is how a member still on
      // the old branch learns, in the same fetch, that the Workspace moved.
      if (branch !== WORKSPACE_FALLBACK_BRANCH) {
        refspecs.push(`+refs/heads/${WORKSPACE_FALLBACK_BRANCH}*:refs/remotes/${REMOTE_NAME}/${WORKSPACE_FALLBACK_BRANCH}*`);
      }
      const fetched = attempt(git, [...NO_SYMLINKS, 'fetch', '-q', '--no-tags', '--', REMOTE_NAME, ...refspecs], repo, syncNetworkTimeout(networkDeadline));
      if (!fetched.ok) {
        // A remote that does not have this branch yet is not an error: the first push creates it.
        if (/couldn't find remote ref/i.test(fetched.detail)) return { ok: true };
        return { ok: false, detail: fetched.detail };
      }
      const after = revParse(git, repo, trackingRef);
      if (before !== null && after !== null && before !== after && !isAncestor(git, repo, before, after)) {
        // The remote's history was REWRITTEN, not added to. Put the tracking
        // ref back, so every later run asks the same question instead of
        // merging the rewritten history as if it were news.
        attempt(git, ['update-ref', trackingRef, before], repo);
        throw new WorkspaceRefusal(
          'remote-rewritten',
          "the Workspace's history on its remote was rewritten rather than added to, so nothing was merged or pushed — someone needs to look at it before this machine syncs again",
          { previous: before, current: after, pushed: false, committed: result.committed !== null }
        );
      }
      return { ok: true };
    };

    const offline = (detail: string): SyncResult => {
      result.state = classifyRemoteFailure(detail);
      if (result.state === 'no-access') result.rejection = classifyRejection(detail);
      result.ahead = countRange(git, repo, revParse(git, repo, trackingRef) === null ? 'HEAD' : `${trackingRef}..HEAD`);
      result.detail =
        result.state === 'no-access'
          ? `The Workspace's repository refused this machine's access, so nothing was exchanged; the knowledge is kept on this machine (${detail}).`
          : `The Workspace's repository could not be reached, so nothing was exchanged; the knowledge is kept on this machine (${detail}).`;
      return result;
    };

    /**
     * Put the Workspace on the fallback branch, AT the current commit: the
     * working tree is untouched and every local commit comes along; the next
     * merge brings in what the remote holds there. Refused (false) when a local
     * branch of that name already holds commits HEAD does not.
     */
    // A branch a PERSON chose is never moved away from, nor left to follow
    // another member: a refusal there is reported, so they can choose again.
    const chosen = chosenBranchOf(repo, git) === branch;
    const moveTo = (reason: 'pull-request-required' | 'followed'): boolean => {
      if (chosen) return false;
      const target = WORKSPACE_FALLBACK_BRANCH;
      // Only ever AT the current commit: a local branch that diverged is left alone.
      const existing = revParse(git, repo, `refs/heads/${target}`);
      if (existing !== null && !isAncestor(git, repo, existing, 'HEAD')) return false;
      try {
        switchWorkspaceBranch(git, repo, target, workspace.name);
      } catch {
        return false;
      }
      result.moved = { from: branch, to: target, reason };
      recordBranchMove(repo, git, { from: branch, to: target, reason, at: now().toISOString() });
      branch = target;
      trackingRef = `refs/remotes/${REMOTE_NAME}/${target}`;
      result.branch = target;
      return true;
    };

    // A decision is made about the remote state the question was put about — no new fetch.
    if (resolveRequest === undefined && batchRequest === undefined) {
      const fetched = fetchOnce();
      if (!fetched.ok) return offline(fetched.detail);
      // Another member already moved the Workspace: follow it (one merge brings
      // in their work; this machine's own commits ride along).
      if (branch !== WORKSPACE_FALLBACK_BRANCH && revParse(git, repo, `refs/remotes/${REMOTE_NAME}/${WORKSPACE_FALLBACK_BRANCH}`) !== null) {
        moveTo('followed');
      }
    }

    // ── 3. Merge ──
    say('step: merge');
    const mergeContext: MergeContext = {
      git,
      repo,
      branch,
      now: now(),
      ...(resolveRequest === undefined ? {} : { resolve: resolveRequest }),
      ...(batchRequest === undefined ? {} : { batch: batchRequest }),
      ...(holdRequest === undefined || holdRequest.length === 0 ? {} : { hold: holdRequest }),
    };
    const settle = (step: MergeStep): boolean => {
      switch (step.kind) {
        case 'none':
          return true;
        case 'fast-forward':
          result.pulled += step.pulled;
          return true;
        case 'merged':
          result.pulled += step.pulled;
          result.merge = { sha: step.sha, log: step.log };
          result.resolutions.push(...step.resolutions);
          result.decided.push(...step.decided);
          result.mergedItems.push(...step.mergedItems);
          if (step.held.length > 0) result.heldAside = heldSummaries(readHeld(git, repo));
          return true;
        case 'waiting':
          result.asks = step.asks;
          result.reviews = step.reviews;
          result.decided.push(...step.decided);
          result.state = step.asks.length > 0 ? 'ask' : 'review';
          result.detail =
            step.asks.length > 0
              ? `${step.asks.length} change${step.asks.length === 1 ? '' : 's'} collide${step.asks.length === 1 ? 's' : ''} with what the Workspace already says and need${step.asks.length === 1 ? 's' : ''} a decision; nothing was merged or pushed.`
              : `${step.reviews.length} file${step.reviews.length === 1 ? '' : 's'} changed on both sides need${step.reviews.length === 1 ? 's' : ''} a merged version; nothing was merged or pushed.`;
          result.ahead = countRange(git, repo, `${trackingRef}..HEAD`);
          return false;
      }
    };
    if (!settle(mergeIncoming(mergeContext, revParse(git, repo, trackingRef)))) return result;
    const afterResolve: MergeContext = { git, repo, branch, now: mergeContext.now };

    // ── 5. Push ── (4. runs once, after every pull this run made)
    const finish = (): SyncResult => {
      if (result.pulled > 0) {
        say('step: rebuild project indexes');
        result.indexes = rebuildIndexes(flowFolder, workspace, mergeContext.now);
        say('step: team rules');
        result.rules = materializeWorkspaceRules(flowFolder, workspace.slug, git);
      }
      const tracking = revParse(git, repo, trackingRef);
      result.ahead = countRange(git, repo, tracking === null ? 'HEAD' : `${trackingRef}..HEAD`);
      if (result.state === 'nothing-to-do' && (result.committed !== null || result.pulled > 0 || result.pushed)) result.state = 'synced';
      return result;
    };

    // Decided items of a merge kept here wait for a person: they are recorded,
    // and while ANY is recorded a run publishes only when told a person agreed.
    const gated = options.push && options.agreed !== true && readReviewRecord(git, repo).length > 0;
    const openReview = recordReview(git, repo, result.merge, result.mergedItems, !options.push || gated);
    if (!options.push || gated) {
      // A merge committed here and not published waits for a person's review.
      if (result.merge !== null || openReview.length > 0) {
        result.state = 'merged-local';
        result.awaitingReview = true;
        result.mergedItems = mergedItemsOf(openReview, result.mergedItems);
        result.detail = "The Workspace's changes were merged on this machine and not published; the merge waits for review.";
      }
      return finish();
    }
    const clearReviewIfAgreed = (): void => {
      if (options.agreed === true) writeReviewRecord(git, repo, []);
    };
    let movedForPush = false;
    for (let round = 0; round < 2; round += 1) {
      const tracking = revParse(git, repo, trackingRef);
      const ahead = countRange(git, repo, tracking === null ? 'HEAD' : `${trackingRef}..HEAD`);
      if (ahead === 0) {
        clearReviewIfAgreed();
        return finish();
      }
      guardPersonal(outgoingPaths(git, repo, tracking), { committed: result.committed !== null, merged: result.merge !== null });
      const pushed = attempt(git, ['push', '-q', '--', REMOTE_NAME, `HEAD:refs/heads/${branch}`], repo, syncNetworkTimeout(networkDeadline));
      if (pushed.ok) {
        result.pushed = true;
        // Record what the remote now holds, so `ahead` reads true without a fetch.
        attempt(git, ['update-ref', trackingRef, 'HEAD'], repo);
        clearReviewIfAgreed();
        return finish();
      }
      if (!REJECTED_PUSH.test(pushed.detail) || REMOTE_REJECTED.test(pushed.detail)) {
        // The branch only takes pull requests: move to the fallback branch ONCE,
        // bring in whatever is already there, and push again. This does not
        // spend a round.
        const pullRequestsOnly = classifyRejection(pushed.detail).kind === 'pull-request-required';
        // Remembered on this machine, so the branch list can say so the next time someone picks a branch.
        if (pullRequestsOnly) markPullRequestOnly(repo, git, branch);
        if (!movedForPush && branch !== WORKSPACE_FALLBACK_BRANCH && pullRequestsOnly && moveTo('pull-request-required')) {
          movedForPush = true;
          const fetched = fetchOnce();
          if (!fetched.ok) {
            finish();
            return offline(fetched.detail);
          }
          if (!settle(mergeIncoming({ ...afterResolve, branch }, revParse(git, repo, trackingRef)))) return result;
          round -= 1;
          continue;
        }
        // Not a moved remote: unreachable, or the remote itself declined it — retrying cannot help.
        finish();
        return offline(pushed.detail);
      }
      if (round === 1) break;
      // The remote moved meanwhile: fetch and merge once more, then try again.
      const fetched = fetchOnce();
      if (!fetched.ok) {
        finish();
        return offline(fetched.detail);
      }
      if (!settle(mergeIncoming({ ...afterResolve, branch }, revParse(git, repo, trackingRef)))) return result;
    }
    finish();
    result.state = 'behind';
    result.detail = "The Workspace's repository kept moving while this machine was syncing, so its changes were not published yet; the next sync tries again.";
    return result;
  } finally {
    lock.release();
    keepLocalName(flowFolder, workspace.slug, nameBefore);
  }
}

function keepLocalName(flowFolder: string, slug: string, nameBefore: string): void {
  try {
    if (readLocalWorkspaceNames(flowFolder)[slug] !== undefined) return;
    if (readWorkspace(flowFolder, slug).file.name !== nameBefore) writeLocalWorkspaceName(flowFolder, slug, nameBefore);
  } catch {
    // A name is never a reason for a sync to fail.
  }
}

/** Project ids a commit's workspace.json lists. */
function projectIdsAt(git: WorkspaceGit, repo: string, rev: string): Set<string> {
  const text = textAt(git, repo, rev, 'workspace.json');
  if (text === null) return new Set();
  try {
    const parsed = JSON.parse(text) as { projects?: unknown };
    if (!Array.isArray(parsed.projects)) return new Set();
    return new Set(
      parsed.projects
        .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : undefined))
        .filter((id): id is string => typeof id === 'string' && id !== '')
    );
  } catch {
    return new Set();
  }
}

/** Whether two histories' Workspaces list at least one project in common — "the same work". */
function sharesAProject(git: WorkspaceGit, repo: string, ours: string, theirs: string): boolean {
  const mine = projectIdsAt(git, repo, ours);
  for (const id of projectIdsAt(git, repo, theirs)) if (mine.has(id)) return true;
  return false;
}

/** Sync every Workspace on this machine, one after another. One refusal never stops the others. */
export function syncAllWorkspaces(options: Omit<SyncOptions, 'workspace' | 'resolve'>): SyncAllResult {
  const scan = scanWorkspaces(resolve(options.flowFolder));
  const results: SyncAllResult['results'] = [];
  for (const workspace of scan.workspaces) {
    try {
      results.push(syncWorkspace({ ...options, workspace: workspace.slug }));
    } catch (error) {
      if (error instanceof WorkspaceRefusal) {
        results.push({
          action: 'sync',
          workspace: { slug: workspace.slug },
          ...error.payload,
          refused: error.reason,
          detail: error.sentence,
        });
        continue;
      }
      // One Workspace failing outright never stops the others either.
      results.push({ action: 'sync', workspace: { slug: workspace.slug }, refused: 'failed', detail: errorText(error) });
    }
  }
  return { action: 'sync', all: true, results, unreadable: scan.unreadable };
}

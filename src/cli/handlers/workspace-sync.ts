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
 *      generated block refuses `incoming-unsafe` (fast-forward included).
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
 *      (`[remote rejected]` — a hook, a protected branch) is `no-access`.
 *
 * Deciding an ask or review: `--id <item id> [--resolve <path>] --take ours|theirs|merged|file:<file>`
 * (the id applies the decision only to exactly the content it was shown —
 * otherwise `stale-decision`; `--resolve <path>` alone still works)
 * re-runs the merge against the ALREADY-FETCHED remote state (the one the
 * question was put about — no new fetch), records the decision in `.git`
 * (never committed; keyed to both sides' exact content, see workspace-merge.ts)
 * and completes the merge when nothing else is waiting.
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
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

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
import { type HeldKnowledge, heldKnowledgePaths } from './knowledge-landing.js';
import { parseGitRemote, redactRemote } from './knowledge-migration.js';
import {
  applyDecisions,
  applyResolutions,
  inspectMerge,
  MAX_DECISION_CONTENT,
  readDecisions,
  readMergeFacts,
  writeDecisions,
  writeMergeLog,
  type MergeResolution,
  type StoredDecision,
  type SyncAsk,
  type SyncReview,
  type Take,
} from './workspace-merge.js';
import {
  defaultWorkspaceGit,
  projectFolder,
  readLocalProjects,
  readWorkspace,
  realOrResolved,
  scanWorkspaces,
  slugify,
  WORKSPACE_PROJECTS_DIRNAME,
  WorkspaceRefusal,
  workspaceDir,
  writeWorkspaceRepoFiles,
  type LoadedWorkspace,
  type WorkspaceDeps,
  type WorkspaceGit,
} from './workspace-model.js';

// ─── Names ──────────────────────────────────────────────────────────────────

const REMOTE_NAME = 'origin';
export const SYNC_LOCK_GIT_PATH = 'plan-flow-sync.lock';
/** Written right before Flow's own merge starts, removed once it is committed or undone. */
export const SYNC_MERGE_MARKER_GIT_PATH = 'plan-flow-sync-merge.json';
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
  | 'committed';

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
  /**
   * Documents this run kept out of the commit, and why. Reported, never
   * silent: a gate that quietly stops publishing is indistinguishable from a
   * gate that is broken, and the person holding the draft is the only one who
   * can finish it.
   */
  held: HeldKnowledge[];
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
  /** One sentence for `offline` / `no-access` / `behind` / `ask` / `review`. */
  detail?: string;
}

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

export interface SyncOptions {
  /** REQUIRED — there is no default Flow folder here (forbidden-pattern #15). */
  flowFolder: string;
  /** REQUIRED — whether this run may publish. */
  push: boolean;
  /** Which Workspace (slug or name). Optional when the machine has exactly one. */
  workspace?: string;
  message?: string;
  resolve?: SyncResolve;
  /** Commit only: no fetch, no merge, no push. */
  commitOnly?: boolean;
  /** Where a relative `file:` path is read from. Default: the process's cwd. */
  cwd?: string;
  deps?: Partial<WorkspaceDeps>;
}

/**
 * The held documents among `staged`, with everything the selector needs read
 * off `repo` itself: a Workspace directory knows its own project list
 * (`workspace.json`) and sits two levels under the Flow folder that holds
 * `projects.local.json`. No new plumbing through the sync's call chain, and no
 * second place that derives a Workspace path (allowed-pattern #14).
 *
 * Any failure here answers "nothing is held". The gate exists to stop a draft
 * reaching a team, not to stop a sync: a Workspace whose local map is
 * unreadable must still publish the documents nobody marked.
 */
function holdUnlandedKnowledge(git: WorkspaceGit, repo: string, staged: readonly string[]): HeldKnowledge[] {
  try {
    const file = JSON.parse(readFileSync(join(repo, 'workspace.json'), 'utf-8')) as {
      projects?: { slug?: unknown; id?: unknown }[];
    };
    const projects = (file.projects ?? [])
      .filter((entry) => typeof entry.slug === 'string' && typeof entry.id === 'string')
      .map((entry) => ({ slug: entry.slug as string, id: entry.id as string }));
    return heldKnowledgePaths(git, staged, (path) => classifyKnowledgePath(path, { root: 'workspace' }), {
      readText: (relPath) => {
        try {
          return readFileSync(join(repo, relPath), 'utf-8');
        } catch {
          return null;
        }
      },
      localProjects: readLocalProjects(dirname(dirname(repo))),
      projects,
    });
  } catch {
    return [];
  }
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function attempt(git: WorkspaceGit, args: string[], cwd: string, network = false): { ok: true; out: string } | { ok: false; detail: string } {
  try {
    return { ok: true, out: git(args, cwd, network ? { network: true } : {}) };
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

// ─── Workspace lookup ───────────────────────────────────────────────────────

function findWorkspace(flowFolder: string, wanted: string | undefined): LoadedWorkspace {
  const scan = scanWorkspaces(flowFolder);
  const choices = scan.workspaces.map((workspace) => ({ slug: workspace.slug, name: workspace.file.name }));
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
    scan.workspaces.find((workspace) => workspace.file.name === wanted) ??
    scan.workspaces.find((workspace) => workspace.slug === slugify(wanted));
  if (found === undefined) {
    throw new WorkspaceRefusal('unknown-workspace', `there is no Workspace called ${wanted} on this machine`, { workspaces: choices });
  }
  return found;
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
  return `${DEFAULT_MESSAGE_PREFIX} ${workspace.file.name}`;
}

function commitLocal(
  git: WorkspaceGit,
  repo: string,
  message: string,
  tracking: string | null,
  untracked: string[] = [],
  held: HeldKnowledge[] = []
): SyncCommit | null {
  summarizeRoundsRecords(repo);
  git(['add', '-A', '--', '.'], repo);
  let staged: string[];
  try {
    untracked.push(...untrackLocalOnly(git, repo));
    staged = splitZ(git(['diff', '--cached', '--name-only', '--no-renames', '-z'], repo));
    // A document that says it is not ready, or whose work has not reached its
    // project's default branch, is UNSTAGED rather than excluded earlier: the
    // file keeps its place in the working tree untouched, and a version the
    // team already has stays as it was until the new one lands. Held, not lost.
    held.push(...holdUnlandedKnowledge(git, repo, staged));
    if (held.length > 0) {
      git(['restore', '--staged', '--', ...held.map((entry) => entry.path)], repo);
      staged = splitZ(git(['diff', '--cached', '--name-only', '--no-renames', '-z'], repo));
    }
    // A removal publishes nothing of the file; everything else is judged.
    const published = splitZ(git(['diff', '--cached', '--name-only', '--no-renames', '--diff-filter=AMTC', '-z'], repo));
    guardPersonal([...published, ...outgoingPaths(git, repo, tracking)], {});
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
  | { kind: 'merged'; pulled: number; sha: string; log: string | null; resolutions: MergeResolution[]; decided: string[] }
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
}

/** What a resolve request is about, for a sentence or a payload. */
function resolveSubject(request: ResolveRequest): string {
  return request.path ?? request.id ?? '';
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
 * — it decides how THIS merge resolves files). Read-only.
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
      const outsideChanged = before.outside !== after.outside;
      const attributesBlockChanged =
        /^\.gitattributes$/i.test(path) && after.block !== before.block && after.block !== workspaceGitattributes();
      if (outsideChanged || attributesBlockChanged) unsafe.push({ path, why: 'repo-settings' });
    }
  }
  return unsafe;
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
    if (context.resolve !== undefined) {
      throw new WorkspaceRefusal('nothing-to-resolve', 'there is no merge waiting for a decision in this Workspace', { path: resolveSubject(context.resolve) });
    }
    return { kind: 'none' };
  }
  // A shared repository whose history has nothing in common with this
  // Workspace's — another Workspace, a repository someone started by hand —
  // is never mixed in: git would refuse the merge anyway, and the person
  // needs to hear WHY in words, not as a failed merge.
  if (head !== null && !attempt(git, ['merge-base', head, tracking], repo).ok) {
    if (context.resolve !== undefined) {
      throw new WorkspaceRefusal('nothing-to-resolve', 'there is no merge waiting for a decision in this Workspace', { path: resolveSubject(context.resolve) });
    }
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
    if (context.resolve !== undefined) {
      throw new WorkspaceRefusal('nothing-to-resolve', 'there is no merge waiting for a decision in this Workspace', { path: resolveSubject(context.resolve) });
    }
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
    [...NO_SYMLINKS, '-c', 'rerere.enabled=false', '-c', 'merge.conflictStyle=merge', 'merge', '--no-ff', '--no-commit', '-q', tracking],
    repo
  );
  if (revParse(git, repo, 'MERGE_HEAD') === null) {
    // git refused outright (unrelated histories, a file in the way…): nothing merged.
    if (revParse(git, repo, 'HEAD') !== head) git([...NO_SYMLINKS, 'reset', '-q', '--hard', head], repo);
    clearMarker(git, repo);
    const detail = merge.ok ? 'git did not start the merge' : merge.detail;
    throw new WorkspaceRefusal('merge-failed', `the Workspace's changes could not be merged: ${detail}`, { pushed: false });
  }

  try {
    const facts = readMergeFacts(git, repo, head, tracking);
    const inspection = inspectMerge(facts);
    const items: (SyncAsk | SyncReview)[] = [...inspection.asks, ...inspection.reviews];

    // Decisions: the stored ones that still match, plus the one this call brings.
    const stored = readDecisions(git, repo);
    const live = new Map<string, StoredDecision>();
    for (const decision of stored) {
      if (items.some((item) => item.id === decision.id)) live.set(decision.id, decision);
    }
    const decided: string[] = [];
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
            { path: wanted.path ?? null, id: wanted.id, current: current?.id ?? null, waiting: items.map((item) => ({ id: item.id, path: item.path })) }
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
        const decision: StoredDecision = {
          id: item.id,
          path: item.path,
          take: wanted.take,
          ...(wanted.take === 'file' ? { content: wanted.content ?? '' } : {}),
          decidedAt: context.now.toISOString(),
        };
        live.set(item.id, decision);
        decided.push(item.id);
      }
      writeDecisions(git, repo, [...stored.filter((entry) => !matching.some((item) => item.id === entry.id)), ...matching.map((item) => live.get(item.id) as StoredDecision)]);
    }

    const waitingAsks = inspection.asks.filter((ask) => !live.has(ask.id));
    const waitingReviews = inspection.reviews.filter((review) => !live.has(review.id));
    if (waitingAsks.length > 0 || waitingReviews.length > 0) {
      abortMerge(git, repo, head, incoming);
      return { kind: 'waiting', asks: waitingAsks, reviews: waitingReviews, decided };
    }

    const resolutions = [...applyResolutions(facts, inspection.resolutions), ...applyDecisions(facts, items, live)];
    const unmerged = attempt(git, ['ls-files', '--unmerged', '-z'], repo);
    if (!unmerged.ok || splitZ(unmerged.out).length > 0) {
      throw new WorkspaceRefusal('merge-failed', 'some files were still unmerged after every resolution, so nothing was merged', { pushed: false });
    }
    const log = writeMergeLog(facts, resolutions, { now: context.now, remoteRef: `${REMOTE_NAME}/${context.branch}` });
    const automatic = resolutions.filter((resolution) => resolution.kind !== 'decision').length;
    const message = `Merge ${REMOTE_NAME}/${context.branch}${automatic === 0 ? '' : ` — ${automatic} settled by Flow`}${log === null ? '' : ` (${log})`}`;
    const commit = attempt(git, ['-c', 'user.useConfigOnly=true', 'commit', '-q', '--no-edit', '-m', message], repo);
    if (!commit.ok) {
      throw new WorkspaceRefusal('merge-failed', `the merge could not be committed: ${commit.detail}`, { pushed: false });
    }
    clearMarker(git, repo);
    // Decisions are spent once the merge they answered is committed.
    writeDecisions(git, repo, stored.filter((entry) => !live.has(entry.id)));
    return {
      kind: 'merged',
      pulled,
      sha: git(['rev-parse', 'HEAD'], repo).trim(),
      log,
      resolutions,
      decided: [...new Set([...decided, ...[...live.keys()]])],
    };
  } catch (error) {
    // Only a merge still in progress is undone. A HEAD that moved with no
    // merge in progress is a merge commit already made — never reset away.
    if (revParse(git, repo, 'MERGE_HEAD') !== null) abortMerge(git, repo, head, incoming);
    else clearMarker(git, repo);
    throw error;
  }
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

// ─── The verb ───────────────────────────────────────────────────────────────

/** Sync one Workspace. See the module header for the steps. */
export function syncWorkspace(options: SyncOptions): SyncResult {
  const flowFolder = resolve(options.flowFolder);
  const git = options.deps?.git ?? defaultWorkspaceGit;
  const now = options.deps?.now ?? (() => new Date());
  const workspace = findWorkspace(flowFolder, options.workspace);
  const repo = workspaceDir(flowFolder, workspace.slug);

  const top = attempt(git, ['rev-parse', '--show-toplevel'], repo);
  if (!top.ok || realOrResolved(top.out.trim()) !== realOrResolved(repo)) {
    throw new WorkspaceRefusal('not-a-git-repo', `the ${workspace.file.name} Workspace folder is not a git repository`, { workspace: workspace.slug });
  }
  const resolveRequest = options.resolve === undefined ? undefined : parseResolve(options.resolve, repo, options.cwd ?? process.cwd());

  if (options.commitOnly === true && resolveRequest !== undefined) {
    throw new WorkspaceRefusal('invalid-resolution', 'a decision needs the merge it answers, so it cannot be made by a commit-only run', {
      path: resolveSubject(resolveRequest),
    });
  }

  const lock = acquireLock(git, repo, now());
  try {
    const recoveredMerge = recoverLeftoverMerge(git, repo, workspace.slug);
    const branchOut = attempt(git, ['symbolic-ref', '--short', '-q', 'HEAD'], repo);
    const branch = branchOut.ok ? branchOut.out.trim() : '';
    if (branch === '') {
      throw new WorkspaceRefusal('detached-head', 'the Workspace folder is not on a branch, so there is nothing to sync from', { workspace: workspace.slug });
    }

    const origin = attempt(git, ['config', '--get', `remote.${REMOTE_NAME}.url`], repo);
    const remote = origin.ok && origin.out.trim() !== '' ? origin.out.trim() : null;
    if (remote !== null && !parseGitRemote(remote).ok) {
      throw new WorkspaceRefusal('invalid-remote', "the Workspace's remote is not a repository address Flow can use", { remote: redactRemote(remote) });
    }
    const trackingRef = `refs/remotes/${REMOTE_NAME}/${branch}`;

    const result: SyncResult = {
      action: 'sync',
      workspace: { name: workspace.file.name, slug: workspace.slug, path: repo },
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
      recovered: { lock: lock.recovered, merge: recoveredMerge },
      untracked: [],
      held: [],
    };

    // ── 1. Commit ──
    writeWorkspaceRepoFiles(repo);
    const message = (options.message?.trim() || defaultMessage(workspace)).replace(/\s+/g, ' ').slice(0, MAX_MESSAGE_LENGTH);
    result.committed = commitLocal(
      git,
      repo,
      message,
      remote === null ? null : revParse(git, repo, trackingRef),
      result.untracked,
      result.held
    );

    if (options.commitOnly === true) {
      // Nothing leaves the machine and nothing comes in: the next full sync exchanges it.
      result.state = result.committed === null ? 'nothing-to-do' : 'committed';
      const tracking = remote === null ? null : revParse(git, repo, trackingRef);
      result.ahead = countRange(git, repo, tracking === null ? 'HEAD' : `${trackingRef}..HEAD`);
      return result;
    }

    // ── 2. Remote ──
    if (remote === null) {
      if (resolveRequest !== undefined) {
        throw new WorkspaceRefusal('nothing-to-resolve', 'this Workspace has no remote, so nothing is waiting to be merged', { path: resolveSubject(resolveRequest) });
      }
      result.state = 'local-only';
      result.ahead = countRange(git, repo, 'HEAD');
      return result;
    }

    const fetchOnce = (): { ok: true } | { ok: false; detail: string } => {
      const before = revParse(git, repo, trackingRef);
      const fetched = attempt(git, [...NO_SYMLINKS, 'fetch', '-q', '--no-tags', '--', REMOTE_NAME, `+refs/heads/${branch}:${trackingRef}`], repo, true);
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
      result.ahead = countRange(git, repo, revParse(git, repo, trackingRef) === null ? 'HEAD' : `${trackingRef}..HEAD`);
      result.detail =
        result.state === 'no-access'
          ? `The Workspace's repository refused this machine's access, so nothing was exchanged; the knowledge is kept on this machine (${detail}).`
          : `The Workspace's repository could not be reached, so nothing was exchanged; the knowledge is kept on this machine (${detail}).`;
      return result;
    };

    // A decision is made about the remote state the question was put about — no new fetch.
    if (resolveRequest === undefined) {
      const fetched = fetchOnce();
      if (!fetched.ok) return offline(fetched.detail);
    }

    // ── 3. Merge ──
    const mergeContext: MergeContext = { git, repo, branch, now: now(), ...(resolveRequest === undefined ? {} : { resolve: resolveRequest }) };
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
        result.indexes = rebuildIndexes(flowFolder, workspace, mergeContext.now);
        result.rules = materializeWorkspaceRules(flowFolder, workspace.slug, git);
      }
      const tracking = revParse(git, repo, trackingRef);
      result.ahead = countRange(git, repo, tracking === null ? 'HEAD' : `${trackingRef}..HEAD`);
      if (result.state === 'nothing-to-do' && (result.committed !== null || result.pulled > 0 || result.pushed)) result.state = 'synced';
      return result;
    };

    if (!options.push) return finish();
    for (let round = 0; round < 2; round += 1) {
      const tracking = revParse(git, repo, trackingRef);
      const ahead = countRange(git, repo, tracking === null ? 'HEAD' : `${trackingRef}..HEAD`);
      if (ahead === 0) return finish();
      guardPersonal(outgoingPaths(git, repo, tracking), { committed: result.committed !== null, merged: result.merge !== null });
      const pushed = attempt(git, ['push', '-q', '--', REMOTE_NAME, `HEAD:refs/heads/${branch}`], repo, true);
      if (pushed.ok) {
        result.pushed = true;
        // Record what the remote now holds, so `ahead` reads true without a fetch.
        attempt(git, ['update-ref', trackingRef, 'HEAD'], repo);
        return finish();
      }
      if (!REJECTED_PUSH.test(pushed.detail) || REMOTE_REJECTED.test(pushed.detail)) {
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
      if (!settle(mergeIncoming(afterResolve, revParse(git, repo, trackingRef)))) return result;
    }
    finish();
    result.state = 'behind';
    result.detail = "The Workspace's repository kept moving while this machine was syncing, so its changes were not published yet; the next sync tries again.";
    return result;
  } finally {
    lock.release();
  }
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

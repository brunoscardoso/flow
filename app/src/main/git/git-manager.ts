// GitManager — READ-ONLY git viewer backend, one repo per project root.
//
// Everything goes through the system `git` CLI via child_process.execFile —
// no libgit2 / native dependency. Three operations back the contract's git
// channels (src/shared/ipc-contract.ts):
//
//   status(rootPath)  → GitStatus | null   `git status --porcelain=v2 --branch -z`
//   log(rootPath)     → GitCommit[]        `git log --format=…` (+ pagination cursor)
//   diff(rootPath, …) → GitDiff            before/after CONTENTS, not a patch:
//     · working tree vs HEAD: before = `git show HEAD:<path>`, after = disk
//     · commit vs parent:     before = `git show <commit>^:<path>`,
//                             after  = `git show <commit>:<path>`
//     · whole commit (filePath === ''): concatenated per-file before/after
//       snapshots with aligned `───── <path> ─────` headers, so a Monaco
//       diff editor shows the full commit as one navigable diff.
//
// Change detection: chokidar on `.git/HEAD`, `.git/index`, `.git/refs` and
// `.git/packed-refs` per root, debounced into a single 'git-changed' event
// (rootId === absolute rootPath, matching the flow domain's convention).
// Working-tree edits are NOT watched here — ProjectRegistry already watches
// the tree and the renderer refreshes status off `project:fileChanged`.
//
// Electron is never imported by this module, so it stays loadable from plain
// Node (harnesses/tests). IPC registration lives in src/main/git/index.ts.

import { EventEmitter } from 'events'
import { execFile } from 'child_process'
import { existsSync, statSync, promises as fsPromises } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { watch, type FSWatcher } from 'chokidar'

import { runInCliHost } from '../cli-host/client'
import { recordSlow } from '../ipc/slow-handler'

import type {
  GitBranchRenameResult,
  GitCommit,
  GitConflictResolution,
  GitDiff,
  GitFileChange,
  GitFileState,
  GitMergeState,
  GitReadConflictedResult,
  GitStatus,
} from '../../shared/ipc-contract'
import { branchNameProblem } from '../../shared/thread-branch'
import type { ConflictHunkChoice, ConflictHunkOrder } from '../../shared/conflict-hunks'
import type { SideIdentity } from '../../shared/side-identity'
import {
  parseConflictHunks,
  spliceAllConflictHunks,
  spliceConflictHunk,
  spliceConflictHunkWithText,
} from '../../shared/conflict-hunks'
import {
  conflictTypeFromStages,
  conflictTypeFromXY,
  parsePorcelainStates,
} from './porcelain-states'
import {
  CONFLICT_MARKER_GREP,
  commitConflictRefusal,
  containsConflictMarkers,
  stageConflictRefusal,
} from './conflict-markers'
import {
  assembleConflictContext,
  defaultConflictContextDeps,
  type ConflictContextDeps,
} from './conflict-context'

/** Quiet window before a burst of .git events collapses into one emission. */
const GIT_CHANGE_DEBOUNCE_MS = 300
/** Default page size for `log` when the caller names none. */
export const DEFAULT_LOG_LIMIT = 100
/**
 * Ceiling for an explicit `log` limit (#1439).
 *
 * This used to be DEFAULT_LOG_LIMIT, which silently capped the app's OWN
 * re-read at one page: the renderer asks for `max(LOG_PAGE_SIZE, loadedCommits)`
 * so a paged-in window survives the next git event, and the clamp threw the
 * extra pages away every time. A clamp is here to bound untrusted input, not to
 * overrule a caller that knows how many rows it is holding — so the ceiling is
 * now a separate, much larger number (50 pages of paging).
 */
export const MAX_LOG_LIMIT = 5000
/** Whole-commit diffs stop concatenating after this many files. */
const WHOLE_COMMIT_FILE_CAP = 50
/** git can print large file contents — be generous before failing. */
const GIT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * How long a hosted git command may run before the host kills it.
 *
 * Generous: a first `status` on a cold, huge repo legitimately takes seconds,
 * and a timeout that fires on real work reads as a git failure.
 */
const GIT_HOST_TIMEOUT_MS = 120_000

/**
 * …except the ones that talk to a remote, which have no business being bounded
 * by a local patience budget. In-process `execFile` had NO timeout at all, and
 * a pull of a large repository over a slow link legitimately runs for minutes;
 * killing it at two would be a regression dressed as a safety net. Six hours is
 * "this process is stuck", not "this network is slow".
 */
const GIT_NETWORK_TIMEOUT_MS = 6 * 60 * 60 * 1_000
const NETWORK_VERBS = new Set(['pull', 'push', 'fetch', 'clone', 'remote', 'submodule'])

function gitTimeoutFor(args: readonly string[]): number {
  return NETWORK_VERBS.has(args[0] ?? '') ? GIT_NETWORK_TIMEOUT_MS : GIT_HOST_TIMEOUT_MS
}

// The three git merge stages, addressed as `git show :<stage>:<path>`.
/** Merge base — the common ancestor side. */
const CONFLICT_STAGE_BASE = 1
/** Our side — the branch being merged INTO (current HEAD). */
const CONFLICT_STAGE_OURS = 2
/** Their side — the incoming branch being merged in. */
const CONFLICT_STAGE_THEIRS = 3

export const GIT_CHANGED_EVENT = 'git-changed'

export interface GitChangedEvent {
  /** Absolute rootPath of the repo whose .git state changed. */
  rootId: string
}

/**
 * Project roots provider — structurally identical to the flow domain's
 * RootsProvider so the same ProjectRegistry adapter fits both.
 */
export interface GitRootsProvider {
  getRoots(): ReadonlyArray<{ rootPath: string }>
  /** Subscribe to root list changes; returns an unsubscribe function. */
  onRootsChanged(listener: () => void): () => void
}

/**
 * Adapter over an EventEmitter-style manager (e.g. ProjectRegistry, which
 * emits 'roots-changed'). Structural — no import of the manager needed.
 */
export function gitRootsProviderFrom(
  manager: {
    getRoots(): Array<{ rootPath: string }>
    on(event: string, listener: (...args: unknown[]) => void): unknown
    off(event: string, listener: (...args: unknown[]) => void): unknown
  },
  rootsChangedEvent = 'roots-changed',
): GitRootsProvider {
  return {
    getRoots: () => manager.getRoots(),
    onRootsChanged: (listener) => {
      const wrapped = (): void => listener()
      manager.on(rootsChangedEvent, wrapped)
      return () => {
        manager.off(rootsChangedEvent, wrapped)
      }
    },
  }
}

export interface GitLogOptions {
  /** Page size; defaults to DEFAULT_LOG_LIMIT, clamped to [1, MAX_LOG_LIMIT]. */
  limit?: number
  /**
   * Pagination cursor: return commits strictly OLDER than this hash
   * (i.e. the last hash of the previous page). Omit for the first page.
   */
  before?: string
}

/**
 * SEC-2: renderer-supplied revisions are untrusted — anything that is not a
 * plain hex hash or a strict HEAD form (HEAD, HEAD~N, HEAD^N) is rejected
 * before it reaches git argv, closing option-injection (e.g. `--output=…`).
 */
const REVISION_PATTERN = /^(?:[0-9a-fA-F]{4,40}|HEAD(?:[~^]\d{1,6})?)$/

/** True when `revision` is a safe, well-formed commit reference. */
export function isValidRevision(revision: string): boolean {
  return REVISION_PATTERN.test(revision)
}

function assertValidRevision(revision: string): void {
  if (!isValidRevision(revision)) {
    throw new Error(`[Git] Invalid commit reference: ${revision}`)
  }
}

/**
 * SEC-2: a branch/ref name for merge (Phase 9) — more permissive than
 * REVISION_PATTERN (slashes, dots, dashes for names like `feature/foo`), but
 * still closes option-injection: no leading `-` (would parse as a flag), no
 * whitespace, no `..` (also git's own ref-name restriction).
 */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/

/** True when `ref` is a safe, well-formed branch/ref name for argv. */
export function isValidBranchRef(ref: string): boolean {
  if (typeof ref !== 'string' || ref.length === 0) return false
  if (ref.includes('..')) return false
  if (ref.endsWith('.lock') || ref.endsWith('/') || ref.endsWith('.')) return false
  return BRANCH_NAME_PATTERN.test(ref)
}

function assertValidBranchRef(ref: string): void {
  if (!isValidBranchRef(ref)) {
    throw new Error(`[Git] Invalid branch reference: ${ref}`)
  }
}

// ── Pure parsers (exported for harnesses/tests) ─────────────────────────

export interface ParsedPorcelainStatus {
  branch: string
  ahead: number
  behind: number
  changes: GitFileChange[]
  /** #1382: HEAD points at a commit, not a branch. `branch` is empty then —
   *  git's `(detached)` placeholder is not a branch name, and rendering it in
   *  the slot that otherwise says `main` hid the state entirely. */
  detached?: boolean
  /** The commit HEAD is on — what a detached state has instead of a branch. */
  headCommit?: string
}

/**
 * Flow's own internal artifacts, living inside the user's repo but managed BY
 * Flow, never by the user: the vault symlink, the graphify graph output, the
 * knowledge DB (+ its sqlite WAL/SHM sidecars), and the plan-flow config/env.
 * The user's `.gitignore` is the first line of defense (added on `plan-flow
 * init`, see src/cli/handlers/shared.ts), but it is fragile — a fresh clone, a
 * project init'd before these entries existed, or a hand-edited ignore file all
 * leak these into the Review/commit list. This predicate is the architectural
 * backstop that makes hiding them Flow's responsibility, not the repo's (#310).
 */
export function isFlowInternalPath(filePath: string): boolean {
  const path = filePath.replace(/^\.\//, '')
  if (path === 'flow' || path === '.plan-flow.yml' || path === '.plan.flow.env') return true
  // .brain.sqlite plus its sidecars (.brain.sqlite-wal, -shm, -journal, …).
  if (path === '.brain.sqlite' || path.startsWith('.brain.sqlite-')) return true
  return path.startsWith('flow/') || path.startsWith('graphify-out/')
}

/**
 * Parse `git status --porcelain=v2 --branch -z` output. With `-z` every
 * record is NUL-terminated and rename records (`2 …`) are followed by one
 * extra NUL-separated field carrying the ORIGINAL path. Flow-internal artifacts
 * (see isFlowInternalPath) are dropped so they never surface for commit (#310).
 */
export function parsePorcelainV2Status(output: string): ParsedPorcelainStatus {
  const result: ParsedPorcelainStatus = {
    branch: '',
    ahead: 0,
    behind: 0,
    changes: [],
  }

  const tokens = output.split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue

    if (token.startsWith('# branch.head ')) {
      const head = token.slice('# branch.head '.length)
      // #1382: `(detached)` is git's PLACEHOLDER, not a branch name. It flowed
      // verbatim into the same slot that otherwise says `main`, and every
      // mutating action stayed enabled and reported ordinary success — a
      // commit made on a detached HEAD is reachable from no branch, so the
      // panel said "clean" about work that is one checkout from being
      // unreferenced.
      result.detached = head === '(detached)'
      result.branch = result.detached ? '' : head
    } else if (token.startsWith('# branch.oid ')) {
      result.headCommit = token.slice('# branch.oid '.length)
    } else if (token.startsWith('# branch.ab ')) {
      const match = token.match(/^# branch\.ab \+(\d+) -(\d+)$/)
      if (match) {
        result.ahead = Number(match[1])
        result.behind = Number(match[2])
      }
    } else if (token.startsWith('1 ')) {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const parts = token.split(' ')
      const xy = parts[1] ?? '..'
      const filePath = parts.slice(8).join(' ')
      if (filePath) {
        result.changes.push({
          filePath,
          state: stateFromXY(xy),
          staged: xy[0] !== '.' && xy[0] !== undefined,
          ...(isSubmoduleField(parts[2]) ? { submodule: true } : {}),
          ...parsePorcelainStates(xy),
        })
      }
    } else if (token.startsWith('2 ')) {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
      const parts = token.split(' ')
      const xy = parts[1] ?? '..'
      const filePath = parts.slice(9).join(' ')
      // #1182: KEEP the original path instead of only consuming it. Without it,
      // a rename was just "the new path": the path-scoped commit (#1051) left
      // the staged deletion of the old path out, so HEAD ended up holding BOTH
      // files and a `D old` stayed pending — permanently un-committable (#1181).
      const origPath = tokens[i + 1] ?? ''
      i += 1 // consume the NUL-separated original path field
      if (filePath) {
        result.changes.push({
          filePath,
          state: 'renamed',
          staged: xy[0] !== '.' && xy[0] !== undefined,
          ...(origPath ? { renamedFrom: origPath } : {}),
          ...(isSubmoduleField(parts[2]) ? { submodule: true } : {}),
          ...parsePorcelainStates(xy),
        })
      }
    } else if (token.startsWith('u ')) {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = token.split(' ')
      const xy = parts[1] ?? '..'
      const filePath = parts.slice(10).join(' ')
      if (filePath) {
        // A conflicted file is neither cleanly staged nor a plain worktree change —
        // it lives in the Merge Changes section, so both sub-states are null. The
        // XY code additively refines it into a conflict sub-type (#66; conflict-UX).
        const conflictType = conflictTypeFromXY(xy)
        result.changes.push({
          filePath,
          state: 'conflicted',
          staged: false,
          indexState: null,
          worktreeState: null,
          ...(conflictType ? { conflictType } : {}),
        })
      }
    } else if (token.startsWith('? ')) {
      result.changes.push({
        filePath: token.slice(2),
        state: 'untracked',
        staged: false,
        indexState: null,
        worktreeState: 'untracked',
      })
    }
    // '! ' (ignored entries) and other headers are deliberately skipped.
  }

  // Backstop: drop Flow's own artifacts even when the repo's .gitignore misses
  // them, so the Review/commit list only ever shows the user's own files (#310).
  result.changes = result.changes.filter((change) => !isFlowInternalPath(change.filePath))

  return result
}

/**
 * Porcelain v2's `<sub>` field (#1478, #1479): `N...` for an ordinary path, or
 * `S<c><m><u>` for a submodule. It sits in every `1 `/`2 ` record and was simply
 * skipped over — which is how a `160000` gitlink reached the panel wearing a
 * text file's clothes.
 */
function isSubmoduleField(sub: string | undefined): boolean {
  return sub !== undefined && sub.startsWith('S')
}

/** Map a porcelain v2 XY pair to the contract's GitFileState. */
function stateFromXY(xy: string): GitFileState {
  const index = xy[0] ?? '.'
  const worktree = xy[1] ?? '.'
  // Worktree letter wins for display (what the user sees on disk right now);
  // fall back to the index letter for staged-only changes.
  const letter = worktree !== '.' ? worktree : index
  switch (letter) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'U':
      return 'conflicted'
    default:
      // M (modified), T (type change), C (copied) and anything unexpected
      // all render as a modification.
      return 'modified'
  }
}

/** Field separator used in the log format (unit separator, never in text). */
const LOG_FIELD_SEP = ''
/** Record separator between commits. */
const LOG_RECORD_SEP = ''
const LOG_FORMAT = `%H${LOG_FIELD_SEP}%s${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%aI${LOG_RECORD_SEP}`

/**
 * Single-file author lookup format (`git log -1 -- <path>`): commit hash,
 * author name, author email, author date. Same unit-separator discipline as
 * LOG_FORMAT (the separator never appears in commit text), no record separator
 * since only one commit is ever emitted.
 */
const FILE_AUTHOR_FORMAT = `%H${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%ae${LOG_FIELD_SEP}%aI`

/** Marks a commit record inside the one-walk author read; a path can never
 *  start with it, so the two kinds of token are told apart by their first
 *  character rather than by counting. */
const AUTHOR_WALK_MARKER = '\u0001'
/** How far back one walk looks. Deep enough that a project's live files are
 *  nearly all covered, shallow enough to stay one cheap process. */
const AUTHOR_WALK_COMMITS = 2_000
/** How many stragglers may still be asked for one at a time. The unbounded
 *  version of this fan-out is what pegged the main process. */
const AUTHOR_LOOKUP_BUDGET = 40

/**
 * Parse `git for-each-ref --format=%(refname:short) refs/heads` output into a
 * local-branch name list, excluding `current` (the branch already checked
 * out — not a valid merge/pull target). Exported pure for Phase 10 tests.
 */
export function parseBranchList(output: string, current: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((name) => name.length > 0 && name !== current)
}

/** Parse `git log --format=<LOG_FORMAT>` output into contract GitCommits. */
export function parseLogOutput(output: string): GitCommit[] {
  const commits: GitCommit[] = []
  for (const record of output.split(LOG_RECORD_SEP)) {
    const trimmed = record.replace(/^\n+/, '')
    if (!trimmed) continue
    const [hash, subject, author, date] = trimmed.split(LOG_FIELD_SEP)
    if (hash && date !== undefined) {
      commits.push({ hash, subject: subject ?? '', author: author ?? '', date })
    }
  }
  return commits
}

/**
 * The last commit that touched a file: its author (name + optional email),
 * short-of-nothing full hash, and author date. Drift classification (#drift
 * phase 2) uses `email` to tell an external author's committed change from the
 * current user's own. `email` is omitted when git recorded an empty author
 * email (rare, but possible with a bare `git config`).
 */
export interface FileAuthor {
  author: string
  email?: string
  hash: string
  date: string
}

/**
 * Inputs to {@link GitManager.synthesizeClashConflict} (conflict-UX Phase 6):
 * the file plus the three commits whose blobs reconstruct a 3-way agent clash.
 * `baseCommit` is the two phases' merge-base (or null → an empty base blob, an
 * add/add-style clash). `sideALabel`/`sideBLabel` become the marker labels and
 * default to `ours`/`theirs` when the caller omits the phase ids.
 */
export interface SynthesizeClashInput {
  /** Root-relative path of the clashed file. */
  filePath: string
  /** Merge-base commit of the two sides, or null (empty base blob). */
  baseCommit: string | null
  /** Side A's commit — the lower-numbered phase. */
  sideACommit: string
  /** Side B's commit — the higher-numbered phase. */
  sideBCommit: string
  /** Marker label for side A (e.g. `phase-3`). Defaults to `ours`. */
  sideALabel?: string
  /** Marker label for side B (e.g. `phase-4`). Defaults to `theirs`. */
  sideBLabel?: string
}

// ── GitManager ───────────────────────────────────────────────────────────

interface GitExecError extends Error {
  code?: number | string
  stderr?: string
}

/**
 * #1040: the anchor pair for one project root. `git status --porcelain`
 * always reports paths relative to the REPOSITORY root, so a project root
 * that is a SUBDIRECTORY of its repo (the normal monorepo-package shape) must
 * not be treated as the repo root — staging/diffing the reported paths against
 * the project root resolves `app/app/…` and breaks. Every git operation runs
 * with `gitCwd` (the repo toplevel) as cwd and speaks repo-relative paths;
 * the public API keeps speaking project-root-relative paths, translated at
 * the boundary via {@link GitManager.anchorPath} / {@link projectPathFromRepoPath}.
 * A project root that IS the repo root (or is not in a repo at all) gets the
 * degenerate context (`gitCwd === root`, `prefix === ''`) — byte-identical to
 * the pre-#1040 behavior.
 */
interface RepoContext {
  /** Resolved project root — the path the public API is anchored on. */
  root: string
  /** Absolute repo toplevel (`rev-parse --show-toplevel`); `root` when the
   *  root is the toplevel or not a repository. Every git cwd/fs join uses this. */
  gitCwd: string
  /** Repo-relative prefix of the project root inside the repo, `''` when the
   *  root is the toplevel; always empty or slash-terminated (`app/`). */
  prefix: string
  /** Absolute `.git` directory — read from the SAME rev-parse that anchors the
   *  repo, because every merge-state read needs it and asking git again is a
   *  process spawn from the thread every window waits behind (#19). Empty when
   *  the root is not a repository. */
  gitDir: string
}

/**
 * Translate a repo-root-relative path to a project-root-relative one, or
 * `null` when the path lies outside the project subtree (#1040). The
 * degenerate `prefix === ''` case is the identity. Exported pure for tests.
 */
export function projectPathFromRepoPath(prefix: string, repoPath: string): string | null {
  if (!prefix) return repoPath
  if (!repoPath.startsWith(prefix)) return null
  const wsPath = repoPath.slice(prefix.length)
  return wsPath.length > 0 ? wsPath : null
}

/**
 * Scope a repo-relative change list to the project root (#1040): drop
 * entries outside the project subtree and re-express the survivors
 * project-root-relative. The flow-internal backstop (#310) is re-applied to
 * the translated paths — the parser filtered REPO-relative paths, which cannot
 * see a subdirectory project's own `flow/`. `prefix === ''` returns the input
 * unchanged (byte-identical degenerate case). Exported pure for tests.
 */
export function scopeChangesToProject(
  changes: GitFileChange[],
  prefix: string,
): GitFileChange[] {
  if (!prefix) return changes
  const scoped: GitFileChange[] = []
  for (const change of changes) {
    const wsPath = projectPathFromRepoPath(prefix, change.filePath)
    if (wsPath === null || isFlowInternalPath(wsPath)) continue
    scoped.push({ ...change, filePath: wsPath })
  }
  return scoped
}

/**
 * Thrown when a conflict side exceeds the git exec buffer BEFORE spawning git
 * (the working-tree file is stat-checked up front). execFile's own maxBuffer
 * overflow is a separate signal; both funnel through isBufferOverflowError so
 * readConflicted can answer `{ oversize: true }` instead of throwing.
 */
class GitOversizeError extends Error {
  constructor() {
    super('[Git] Conflict side exceeds the maximum readable size')
    this.name = 'GitOversizeError'
  }
}

/**
 * A census of git subprocesses, because spawning is what main is actually
 * doing.
 *
 * A CPU profile of the main process while one project was added found 26
 * SECONDS inside `posix_spawn` — 93% of everything main did in that minute.
 * Spawning is not free from a process with a large address space, and a count
 * is the difference between "git is slow" and "git ran four hundred times".
 *
 * A window's worth of counts, then one line naming the busiest subcommands.
 * Costs a map lookup per spawn.
 */
const gitSpawnCounts = new Map<string, number>()
let gitCensusStartedAt = Date.now()
/** How long a census window runs before it reports. */
const GIT_CENSUS_WINDOW_MS = 10_000
/** Below this the window is ordinary traffic, not a finding. */
const GIT_CENSUS_MIN_SPAWNS = 20

/** Every git child this process has started, since it started. Read by the
 *  spawn-budget test, which guards the COUNT rather than the answer — the
 *  per-file fan-out it exists to catch produced a perfectly correct answer. */
let gitSpawnTotal = 0

function countGitSpawn(args: readonly string[]): void {
  gitSpawnTotal += 1
  const verb = args[0] ?? 'git'
  gitSpawnCounts.set(verb, (gitSpawnCounts.get(verb) ?? 0) + 1)
  const elapsed = Date.now() - gitCensusStartedAt
  if (elapsed < GIT_CENSUS_WINDOW_MS) return
  let total = 0
  for (const count of gitSpawnCounts.values()) total += count
  if (total >= GIT_CENSUS_MIN_SPAWNS) {
    const top = [...gitSpawnCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([verb, count]) => `${verb} ×${String(count)}`)
      .join(', ')
    recordSlow(
      `[git] ${String(total)} processes in ${String(Math.round(elapsed / 1000))}s — ${top}`,
    )
  }
  gitSpawnCounts.clear()
  gitCensusStartedAt = Date.now()
}

export class GitManager extends EventEmitter {
  /** Test-only: how many git processes this process has spawned in total. */
  gitProcessesSpawnedForTests(): number {
    return gitSpawnTotal
  }

  /** One chokidar watcher per RESOLVED git dir (PERF: N project roots
   *  anchored in the same repo share ONE watcher; events fan out per root
   *  via watcherRoots). Keyed by the absolute `.git` directory path. */
  private readonly watchers = new Map<string, FSWatcher>()
  /** gitDir → the project roots its watcher serves (fan-out set). */
  private readonly watcherRoots = new Map<string, Set<string>>()
  /** rootPath → its resolved gitDir (reverse index for stopWatching). */
  private readonly rootGitDirs = new Map<string, string>()
  private readonly changeTimers = new Map<string, NodeJS.Timeout>()
  /** #1040: resolved repo anchor per project root (successes only — a
   *  non-repo is re-probed so a later `git init` is picked up). Invalidated
   *  when the root is removed (syncRoots) and on dispose. */
  private readonly repoContexts = new Map<string, RepoContext>()
  private unsubscribeRoots: (() => void) | null = null
  private started = false
  private disposed = false

  constructor(private readonly roots: GitRootsProvider) {
    super()
  }

  /**
   * The repo anchor for a project root (#1040): resolve
   * `git rev-parse --show-toplevel --show-prefix` once per root and cache it.
   * Fail-soft: a non-repo (or any rev-parse failure) yields the degenerate
   * context (`gitCwd = root`, `prefix = ''`) — uncached, so a repository
   * created later is picked up — and the actual git operation re-reports
   * "not a git repository" through its own error path, keeping today's
   * behavior exactly.
   */
  private async repoContext(rootPath: string): Promise<RepoContext> {
    const root = resolve(rootPath)
    const cached = this.repoContexts.get(root)
    if (cached) return cached
    let output: string
    try {
      output = await this.git(root, [
        'rev-parse',
        '--show-toplevel',
        '--show-prefix',
        '--absolute-git-dir',
      ])
    } catch {
      return { root, gitCwd: root, prefix: '', gitDir: '' }
    }
    const [toplevelLine = '', prefixLine = '', gitDirLine = ''] = output.split('\n')
    const toplevel = toplevelLine.trim()
    const prefix = prefixLine.trim()
    const gitDir = gitDirLine.trim()
    const context: RepoContext = toplevel
      ? { root, gitCwd: resolve(toplevel), prefix, gitDir }
      : { root, gitCwd: root, prefix: '', gitDir }
    this.repoContexts.set(root, context)
    return context
  }

  /**
   * Validate one API-supplied (project-root-relative) path and produce its
   * anchor pair (#1040): `wsPath` — the validated project-relative path the
   * API keeps speaking — and `repoPath` — the repo-relative path git speaks
   * (`prefix + wsPath`). The ONE ws→repo translation code path; throws when
   * the path escapes the project folder (SEC-2, unchanged).
   */
  private anchorPath(ctx: RepoContext, filePath: string): { wsPath: string; repoPath: string } {
    const wsPath = ensureInsideRoot(ctx.root, filePath)
    return { wsPath, repoPath: ctx.prefix ? ctx.prefix + wsPath : wsPath }
  }

  /** Start .git watchers for current roots and follow root list changes. */
  start(): void {
    if (this.started || this.disposed) return
    this.started = true
    this.syncRoots()
    this.unsubscribeRoots = this.roots.onRootsChanged(() => this.syncRoots())
  }

  /**
   * Repo status for a root: branch, ahead/behind, changed files.
   * Returns null when the root is not a git repository.
   */
  /**
   * The working tree's state.
   *
   * COALESCED PER ROOT. `git status` is the most expensive read this class
   * makes — a full scan of every file (measured: 145ms on 4,182 files) — and at
   * startup three surfaces ask for it inside the same breath: the panel, the
   * merge banner, and review:list, which runs its own. Measured on a warm
   * launch: six calls, ~500ms each, all describing the same instant.
   *
   * A second caller that arrives while a scan is running gets THAT scan's
   * answer, not a second scan. Not a cache — nothing is held after it settles,
   * so a caller that arrives one millisecond later still gets fresh truth, and
   * a commit is never answered with a stale tree.
   */
  async status(rootPath: string): Promise<GitStatus | null> {
    const key = resolve(rootPath)
    const running = this.statusInFlight.get(key)
    if (running) return running
    const call = this.#status(rootPath).finally(() => {
      this.statusInFlight.delete(key)
    })
    this.statusInFlight.set(key, call)
    return call
  }

  /** In-flight status scans, by resolved root. Emptied as each settles. */
  private readonly statusInFlight = new Map<string, Promise<GitStatus | null>>()

  async #status(rootPath: string): Promise<GitStatus | null> {
    const ctx = await this.repoContext(rootPath)
    let output: string
    try {
      // NO OPTIONAL LOCKS. A plain `git status` takes `.git/index.lock` to
      // write back refreshed stat info — and this scan runs in the background
      // on every change. Any write the person starts at that moment (stage,
      // take a side of a conflict, commit) then failed with "Unable to create
      // '.git/index.lock': File exists". GIT_OPTIONAL_LOCKS=0 is git's own
      // switch for exactly this caller: a read that must not contend.
      output = await this.git(ctx.gitCwd, ['status', '--porcelain=v2', '--branch', '-z'], {
        GIT_OPTIONAL_LOCKS: '0',
      })
    } catch (error) {
      if (isNotARepoError(error)) return null
      throw error
    }
    const parsed = parsePorcelainV2Status(output)
    // #1040: porcelain paths are REPO-relative — scope to the project subtree
    // and re-express project-relative (identity when root == repo toplevel).
    const changes = scopeChangesToProject(parsed.changes, ctx.prefix)
    return {
      rootId: ctx.root,
      branch: parsed.branch,
      dirty: changes.length > 0,
      ahead: parsed.ahead,
      behind: parsed.behind,
      changes,
      // #1382: carry the detached state to the panel, which otherwise renders
      // git's `(detached)` placeholder as though it were a branch name.
      ...(parsed.detached === true ? { detached: true } : {}),
      ...(parsed.headCommit !== undefined ? { headCommit: parsed.headCommit } : {}),
    }
  }

  /**
   * Lines added/deleted vs HEAD for every changed file, in ONE `git diff
   * --numstat HEAD` call (staged + unstaged combined) — file-count-independent,
   * never one spawn per file (allowed-pattern #19). Keyed by the SAME
   * project-relative path `status().changes[].filePath` uses, so the change
   * review can join the two without re-deriving paths. A binary file reports
   * `binary: true` with null counts (git prints `-\t-`). Fail-soft: a non-repo,
   * an error, or an untracked-only tree yields whatever it could read (an empty
   * map at worst) — counts are informational and must never block the review.
   */
  async changeCounts(
    rootPath: string,
  ): Promise<Map<string, { added: number | null; deleted: number | null; binary: boolean }>> {
    const counts = new Map<string, { added: number | null; deleted: number | null; binary: boolean }>()
    const ctx = await this.repoContext(rootPath)
    let raw: string
    try {
      raw = await this.git(ctx.gitCwd, ['diff', '--numstat', 'HEAD'])
    } catch (error) {
      if (isNotARepoError(error)) return counts
      return counts // informational — a numstat failure never fails the review
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const second = line.indexOf('\t', tab + 1)
      if (second < 0) continue
      const addedRaw = line.slice(0, tab)
      const deletedRaw = line.slice(tab + 1, second)
      let pathPart = line.slice(second + 1)
      // A rename prints `old => new` (optionally with `{a => b}` braces); the new
      // path is what status reports, so resolve to it — a mismatch just drops the
      // counts, never the file.
      if (pathPart.includes(' => ')) {
        pathPart = pathPart.replace(/\{[^{}]*? => ([^{}]*?)\}/g, '$1')
        const arrow = pathPart.indexOf(' => ')
        if (arrow >= 0) pathPart = pathPart.slice(arrow + 4)
      }
      // Re-express repo-relative → project-relative (identity when the root is
      // the repo toplevel, which a thread worktree always is).
      const rel = projectPathFromRepoPath(ctx.prefix, pathPart)
      if (rel === null) continue
      const binary = addedRaw === '-' || deletedRaw === '-'
      counts.set(rel, {
        added: binary ? null : Number.parseInt(addedRaw, 10),
        deleted: binary ? null : Number.parseInt(deletedRaw, 10),
        binary,
      })
    }
    return counts
  }

  /**
   * The files carried by commits this branch has and its upstream does not —
   * work that IS committed and is NOT yet anywhere else.
   *
   * The review's second state. A commit does not make the work disappear; it
   * moves it from "uncommitted" to "committed, unpushed", and until it is
   * pushed that is still the most interesting thing about the checkout. The
   * review used to have no way to say this: after a commit the file list simply
   * emptied, which reads as "nothing happened here".
   *
   * Empty whenever there is no upstream to compare against — with nothing to be
   * ahead OF, "unpushed" is not a fact this can establish, and it says nothing
   * rather than guessing a base (the same rule the push binding rests on).
   * Fail-soft in every direction: a broken revision, a detached HEAD or a
   * non-repo yields [], never a throw.
   *
   * One git call, whatever the file count (allowed-pattern #19).
   */
  async aheadFiles(
    rootPath: string,
  ): Promise<Array<{ filePath: string; added: number | null; deleted: number | null; binary: boolean }>> {
    const out: Array<{ filePath: string; added: number | null; deleted: number | null; binary: boolean }> = []
    let ctx: Awaited<ReturnType<GitManager['repoContext']>>
    try {
      ctx = await this.repoContext(rootPath)
    } catch {
      return out
    }
    let raw: string
    try {
      // THREE DOTS, NOT TWO — and the difference is the whole function.
      //
      // In `git log`, `A..B` means "commits in B that A lacks", which is what
      // "ahead" means. In `git diff` the same spelling means `git diff A B`:
      // compare the two ENDPOINTS. So a checkout that is merely BEHIND — 378
      // commits behind, on a `main` nobody had touched — was shown the inverse
      // of everything it was missing: 566 files, +8010 −49572, reported as
      // work this conversation had committed, in a thread that had done
      // nothing at all.
      //
      // `A...HEAD` diffs from the MERGE BASE, which is the question being
      // asked: what have MY commits changed. A behind-but-clean checkout
      // answers nothing, because it has committed nothing.
      raw = await this.git(ctx.gitCwd, ['diff', '--numstat', '@{upstream}...HEAD'])
    } catch {
      // No upstream, detached, or not a repo — all "cannot say", not an error.
      return out
    }
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const second = line.indexOf('\t', tab + 1)
      if (second < 0) continue
      const addedRaw = line.slice(0, tab)
      const deletedRaw = line.slice(tab + 1, second)
      let pathPart = line.slice(second + 1)
      // A rename prints `old => new` (optionally with `{a => b}` braces); the
      // new path is the one that exists now.
      if (pathPart.includes(' => ')) {
        pathPart = pathPart.replace(/\{[^{}]*? => ([^{}]*?)\}/g, '$1')
        const arrow = pathPart.indexOf(' => ')
        if (arrow >= 0) pathPart = pathPart.slice(arrow + 4)
      }
      const rel = projectPathFromRepoPath(ctx.prefix, pathPart)
      if (rel === null) continue
      const binary = addedRaw === '-' || deletedRaw === '-'
      out.push({
        filePath: rel,
        added: binary ? null : Number.parseInt(addedRaw, 10),
        deleted: binary ? null : Number.parseInt(deletedRaw, 10),
        binary,
      })
    }
    return out
  }

  /**
   * The upstream ref this checkout's branch is aimed at (`origin/main`), or
   * null when nobody has aimed it.
   *
   * WHAT IT SEPARATES. A branch that has never been published reports `ahead:
   * 0`, because with no upstream there is nothing to be ahead OF — the same
   * number a fully published branch reports. "Nothing to push" and "never
   * pushed" are opposite facts wearing the same zero, and this read is what
   * tells them apart.
   *
   * This is GIT's own configuration for this checkout (`branch.<name>.remote` /
   * `.merge`), not Flow's mirror of a thread's binding. The two can disagree,
   * and when they do git is the one that decides where a push lands.
   *
   * Fail-soft in every direction, exactly as `aheadFiles` is: no upstream, a
   * detached HEAD and a non-repo all read as null. Cannot-say is not an error,
   * and a review must never fail over one.
   *
   * One git call (allowed-pattern #19).
   */
  async upstreamOf(rootPath: string): Promise<string | null> {
    let ctx: Awaited<ReturnType<GitManager['repoContext']>>
    try {
      ctx = await this.repoContext(rootPath)
    } catch {
      return null
    }
    let raw: string
    try {
      raw = await this.git(ctx.gitCwd, [
        'rev-parse',
        '--abbrev-ref',
        '--symbolic-full-name',
        '@{upstream}',
      ])
    } catch {
      // No upstream, detached, or not a repo — all "cannot say", not an error.
      return null
    }
    const ref = raw.trim()
    return ref === '' ? null : ref
  }

  /**
   * Commit log page (newest first). `options.before` is a pagination cursor:
   * pass the last hash of the previous page to get the next page — the
   * cursor's ancestors in git's own log order, excluding the cursor itself
   * (`--skip=1 <cursor>`, which stays correct across merge history where
   * `<cursor>^` would not).
   * Non-repos and repos without any commit yield [].
   */
  /**
   * Rename the branch this checkout is on.
   *
   * ANY BRANCH, ANY CHECKOUT — which is a reversal. Renaming used to be
   * offered only on a thread's OWN checkout, and refused on a project's branch
   * on the grounds that it "belongs to the project, not the thread". The person
   * looking at the panel cannot see that distinction: they saw a pencil on one
   * branch line and none on the next, with nothing to explain the difference,
   * and said so — "the only thing that matters is have a way to rename any
   * branch when needed". They are right. `git branch -m` is a local move of a
   * local ref; it publishes nothing and deletes nothing.
   *
   * `confirmed` HAS NO DEFAULT (forbidden-pattern #15): this moves a ref, so a
   * call with no options runs no git that writes.
   *
   * Three refusals, each a different fact: a name a branch cannot have, a name
   * something already answers to (never a silent `-2`), and a detached HEAD,
   * which has no branch to rename. A branch already PUSHED is renamed anyway
   * and the answer says so — the remote keeps the old name, and learning that
   * from a pull request pointing at a ref nothing answers to is worse.
   */
  async renameBranch(
    rootPath: string,
    name: string,
    options: { confirmed?: boolean } = {},
  ): Promise<GitBranchRenameResult> {
    if (options.confirmed !== true) {
      return { status: 'refused', detail: 'Renaming a branch needs someone to ask for it.' }
    }
    const problem = branchNameProblem(name)
    if (problem !== null) return { status: 'refused', detail: problem }
    const wanted = name.trim()
    const ctx = await this.repoContext(rootPath)
    const current = (await this.git(ctx.gitCwd, ['branch', '--show-current'])).trim()
    if (current === '') {
      return {
        status: 'refused',
        detail: 'This checkout is on a commit rather than a branch, so there is no name to change.',
      }
    }
    if (current === wanted) {
      return { status: 'unchanged', branch: current, detail: 'That is already what it is called.' }
    }
    const taken = await this.git(ctx.gitCwd, [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${wanted}`,
    ]).catch(() => '')
    if (taken.trim() !== '') {
      return {
        status: 'refused',
        detail: 'Something already works under that name. Pick another one.',
      }
    }
    // Asked BEFORE the move, while the old name still resolves.
    const upstream = await this.git(ctx.gitCwd, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      `${current}@{upstream}`,
    ]).catch(() => '')
    const staleOnRemote = upstream.trim() !== ''
    try {
      await this.git(ctx.gitCwd, ['branch', '-m', current, wanted])
    } catch {
      return {
        status: 'failed',
        detail: 'Flow couldn\u2019t rename that branch. It is exactly where it was.',
      }
    }
    return {
      status: 'renamed',
      branch: wanted,
      detail: staleOnRemote
        ? `This work is on \u2018${wanted}\u2019 now. It had already been shared under its old name, and that copy keeps it.`
        : `This work is on \u2018${wanted}\u2019 now.`,
      ...(staleOnRemote ? { staleOnRemote: true } : {}),
    }
  }

  async log(rootPath: string, options: GitLogOptions = {}): Promise<GitCommit[]> {
    const root = resolve(rootPath)
    const limit = clampLimit(options.limit)
    const args = ['log', `--max-count=${limit}`, `--format=${LOG_FORMAT}`]
    if (options.before) {
      assertValidRevision(options.before) // SEC-2: untrusted cursor → argv
      args.push('--skip=1', options.before)
    }
    args.push('--') // no pathspec — nothing after the revision parses as an option
    let output: string
    try {
      output = await this.git(root, args)
    } catch (error) {
      // Not a repo, unborn branch (no commits yet), or cursor at the root
      // commit (`<hash>^` doesn't exist) — all legitimately mean "no page".
      if (isNotARepoError(error) || isUnknownRevisionError(error)) return []
      throw error
    }
    return parseLogOutput(output)
  }

  /**
   * The last commit that touched each of `filePaths` (`git log -1 -- <path>`
   * per file — NOT blame, so it is one cheap commit lookup, not a per-line
   * walk). Returns a map keyed by the caller's original path; a file that is
   * untracked, never committed, or escapes the root is simply OMITTED — the
   * lookup is fully fail-soft and never throws (a non-repo yields an empty
   * map). Powers drift classification's external-vs-yours split (#drift phase
   * 2). SEC-2: each path is validated inside the root and sits after `--`.
   */
  async fileAuthors(
    rootPath: string,
    filePaths: string[],
  ): Promise<Map<string, FileAuthor>> {
    const ctx = await this.repoContext(rootPath)
    const result = new Map<string, FileAuthor>()
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return result
    }
    // Repo-relative path → the caller's original spelling. A path outside the
    // root can carry no in-repo author, so it is dropped here and simply
    // omitted from the answer.
    const wanted = new Map<string, string>()
    for (const filePath of filePaths) {
      try {
        wanted.set(toGitPath(this.anchorPath(ctx, filePath).repoPath), filePath)
      } catch {
        // escapes the root — omit
      }
    }
    if (wanted.size === 0) return result

    // ONE WALK, NOT ONE PROCESS PER FILE.
    //
    // This used to spawn `git log -1 -- <path>` for every path, all at once
    // through Promise.all. A CPU profile of the main process while this repo
    // was added found 26 SECONDS inside posix_spawn — 93% of everything main
    // did in that minute — and the spawn census named it outright: `1145
    // processes in 10s — log ×1130`, with the process reporting itself blocked
    // for 10.7 seconds while it happened. Spawning is not free from a process
    // with a large address space, and this is the thread that draws the UI.
    //
    // One walk of recent history answers nearly all of them: each path takes
    // the first (newest) commit that names it.
    try {
      const output = await this.git(ctx.gitCwd, [
        'log',
        `--format=${AUTHOR_WALK_MARKER}${FILE_AUTHOR_FORMAT}`,
        '--name-only',
        '-z',
        `-n`,
        String(AUTHOR_WALK_COMMITS),
        '--',
      ])
      let current: FileAuthor | null = null
      for (const token of output.split('\0')) {
        if (token.length === 0) continue
        if (token.startsWith(AUTHOR_WALK_MARKER)) {
          const [hash, author, email, date] = token
            .slice(AUTHOR_WALK_MARKER.length)
            .replace(/\n+$/, '')
            .split(LOG_FIELD_SEP)
          current =
            hash && date !== undefined
              ? {
                  author: author ?? '',
                  ...(email && email.length > 0 ? { email } : {}),
                  hash,
                  date,
                }
              : null
          continue
        }
        // A file line. `--name-only -z` puts the newline that ends the format
        // line at the head of the first path of each commit.
        const repoPath = token.replace(/^\n+/, '')
        const original = wanted.get(repoPath)
        if (original === undefined || current === null || result.has(original)) continue
        result.set(original, current)
      }
    } catch {
      // non-repo / git failure — fall through to the per-path lookups
    }

    // Whatever the walk did not cover — a file untouched in the last
    // AUTHOR_WALK_COMMITS commits — is asked for directly, and only up to a
    // BOUND: an unbounded fan-out is the bug this replaced, and a stragglers
    // list long enough to matter is a project whose drift list nobody reads.
    const missing = [...wanted.entries()]
      .filter(([, original]) => !result.has(original))
      .slice(0, AUTHOR_LOOKUP_BUDGET)
    for (const [repoPath, original] of missing) {
      let output: string
      try {
        output = await this.git(ctx.gitCwd, [
          'log',
          '-1',
          `--format=${FILE_AUTHOR_FORMAT}`,
          '--',
          repoPath,
        ])
      } catch {
        continue // non-repo / git failure — omit this file, never throw
      }
      // An untracked or never-committed path makes `git log` print nothing
      // (exit 0, empty stdout) — legitimately "no committed author".
      const trimmed = output.replace(/^\n+/, '').trimEnd()
      if (!trimmed) continue
      const [hash, author, email, date] = trimmed.split(LOG_FIELD_SEP)
      if (!hash || date === undefined) continue
      result.set(original, {
        author: author ?? '',
        ...(email && email.length > 0 ? { email } : {}),
        hash,
        date,
      })
    }
    return result
  }

  /**
   * The repo's configured commit identity (`git config user.name` /
   * `user.email`) — the "who am I" side of drift classification's
   * external-vs-yours split (#drift phase 2). Fail-soft: an unset key or a
   * non-repo yields `undefined` for that field (never throws), and the
   * classifier falls back to committed-vs-uncommitted when identity is absent.
   */
  async currentUser(rootPath: string): Promise<{ name?: string; email?: string }> {
    const root = resolve(rootPath)
    const [name, email] = await Promise.all([
      this.gitConfigValue(root, 'user.name'),
      this.gitConfigValue(root, 'user.email'),
    ])
    return { name, email }
  }

  /** Read one `git config` value, or `undefined` when unset / not a repo. */
  private async gitConfigValue(root: string, key: string): Promise<string | undefined> {
    try {
      const value = (await this.git(root, ['config', '--get', key])).trim()
      return value.length > 0 ? value : undefined
    } catch {
      return undefined // unset key exits non-zero; a non-repo errors — both mean "unknown"
    }
  }

  /**
   * Diff sources as before/after CONTENTS for a Monaco diff editor.
   *
   *   · no commit:            working tree vs HEAD for `filePath`
   *   · commit + filePath:    that file, commit's parent vs commit
   *   · commit + '' filePath: whole commit — per-file snapshots concatenated
   *     with aligned `───── <path> ─────` headers on both sides
   *     (capped at WHOLE_COMMIT_FILE_CAP files)
   *
   * Missing sides (added/deleted/untracked files, root commits) come back as
   * empty strings, which the diff editor renders as pure insert/delete.
   */
  async diff(
    rootPath: string,
    filePath: string,
    commit?: string,
    against?: 'upstream',
  ): Promise<GitDiff> {
    const ctx = await this.repoContext(rootPath)

    if (commit) {
      assertValidRevision(commit) // SEC-2: untrusted revision → argv
    }
    if (commit && filePath === '') {
      return this.wholeCommitDiff(ctx.gitCwd, commit)
    }
    if (!filePath) {
      throw new Error('[Git] diff requires a filePath (or a commit for whole-commit diffs)')
    }
    const { wsPath, repoPath } = this.anchorPath(ctx, filePath)

    // A brand-new untracked DIRECTORY is rolled up by git into one `dir/` entry
    // (no single file to diff). Reading it as a file throws EISDIR, so instead
    // show a listing of the folder's files — a sensible preview, mirroring how
    // commit (#176) and revert (#136) already special-case this entry (#247).
    if (!commit && filePath.endsWith('/')) {
      return this.directoryDiff(ctx, wsPath, repoPath)
    }

    // Read both sides as RAW BYTES so a binary file (NUL byte) is detected
    // before any lossy UTF-8 decode (#98) — matching git's own heuristic.
    if (commit) {
      const [before, after] = await Promise.all([
        this.showFileBytes(ctx.gitCwd, `${commit}^`, repoPath),
        this.showFileBytes(ctx.gitCwd, commit, repoPath),
      ])
      return buildGitDiff(wsPath, before, after)
    }

    // COMMITTED AND UNPUSHED: everything this branch has that its upstream does
    // not, for one file. The working-tree diff below would show nothing at all
    // for a file whose change is already in a commit — which is exactly the
    // state the review's read-only mode exists to let a person read.
    //
    // `@{upstream}` is written HERE, from an enum the caller passed, never from
    // a revision the renderer chose. A file that does not exist upstream reads
    // as empty on that side (showFileBytes), so a new file renders as all-added.
    if (against === 'upstream') {
      const [before, after] = await Promise.all([
        this.showFileBytes(ctx.gitCwd, '@{upstream}', repoPath),
        this.showFileBytes(ctx.gitCwd, 'HEAD', repoPath),
      ])
      return buildGitDiff(wsPath, before, after)
    }

    // A submodule is a COMMIT POINTER, not content (#1479). Reading it as bytes
    // failed twice over — `HEAD:<path>` names a commit object living in the
    // submodule's own store (`fatal: bad object`), and the worktree side is a
    // directory (EISDIR) — and the first of those raw plumbing errors was what
    // reached the user's toast, on the one row whose change git can describe in
    // one line.
    const subproject = await this.#subprojectDiff(ctx, wsPath, repoPath)
    if (subproject) return subproject

    const [before, after] = await Promise.all([
      this.showFileBytes(ctx.gitCwd, 'HEAD', repoPath),
      readWorkingTreeFileBytes(ctx.gitCwd, repoPath),
    ])
    const diff = buildGitDiff(wsPath, before, after)
    // #1185: a chmod is a real change that the two CONTENT sides cannot show.
    // Without this the diff opened byte-identical under a header still claiming
    // "Working tree vs HEAD" — indistinguishable from a diff that failed to
    // load (#192's class), with the panel insisting the file changed and the
    // diff insisting it didn't. Only asked when the content really is identical,
    // so the common path costs nothing.
    if (diff.beforeContent === diff.afterContent && diff.binary !== true) {
      const note = await this.#modeChangeNote(ctx, repoPath)
      if (note !== null) return { ...diff, note }
    }
    return diff
  }

  /**
   * Whether `repoPath` is a `160000` gitlink in the index — i.e. a submodule.
   * Read from the index rather than the status line so any caller of `diff`
   * gets the branch, not just one that happened to carry the flag (#1479).
   */
  async #isGitlink(ctx: RepoContext, repoPath: string): Promise<boolean> {
    try {
      const raw = await this.git(ctx.gitCwd, ['ls-files', '--stage', '--', repoPath])
      return /^160000 /.test(raw.trimStart())
    } catch {
      return false // never let the probe itself break a diff
    }
  }

  /**
   * The two sides of a submodule's change, or null when the path isn't one.
   *
   * `git diff HEAD -- <path>` already prints exactly what a pointer move IS —
   * `-Subproject commit <old>` / `+Subproject commit <new>` — so the existing
   * side-by-side view renders it with no new surface, the same way the
   * chmod-only case is carried by a `note` (#1185). The note also names it as a
   * submodule, because two 40-char shas alone do not say why the file "has no
   * content".
   */
  async #subprojectDiff(
    ctx: RepoContext,
    wsPath: string,
    repoPath: string,
  ): Promise<GitDiff | null> {
    if (!(await this.#isGitlink(ctx, repoPath))) return null
    let recorded = ''
    let current = ''
    try {
      const raw = await this.git(ctx.gitCwd, ['diff', 'HEAD', '--', repoPath])
      recorded = /^-Subproject commit ([0-9a-f]+)/m.exec(raw)?.[1] ?? ''
      current = /^\+Subproject commit ([0-9a-f]+)/m.exec(raw)?.[1] ?? ''
    } catch {
      // Fall through to the empty-sha shape below: a submodule we can't read is
      // still better described as a submodule than as `fatal: bad object`.
    }
    const side = (sha: string): string => (sha ? `Subproject commit ${sha}\n` : '')
    const short = (sha: string): string => (sha ? sha.slice(0, 7) : 'unknown')
    return {
      ...buildGitDiff(wsPath, Buffer.from(side(recorded)), Buffer.from(side(current))),
      note: `Submodule ${wsPath}: ${short(recorded)} → ${short(current)} (pointer moved; the changes themselves live in the submodule's own history)`,
    }
  }

  /**
   * "Mode changed: 100644 → 100755" for a path whose only difference is its
   * file mode, or null when the mode is unchanged / unknown. Reads git's own
   * `old mode` / `new mode` header, which the content-only diff never looked at.
   */
  async #modeChangeNote(ctx: RepoContext, repoPath: string): Promise<string | null> {
    try {
      const raw = await this.git(ctx.gitCwd, ['diff', 'HEAD', '--', repoPath])
      const oldMode = /^old mode (\d+)$/m.exec(raw)?.[1]
      const newMode = /^new mode (\d+)$/m.exec(raw)?.[1]
      if (oldMode === undefined || newMode === undefined || oldMode === newMode) return null
      return `Mode changed: ${oldMode} → ${newMode} (no content changes)`
    } catch {
      return null // never let a note lookup break the diff itself
    }
  }

  /**
   * HEAD-vs-INDEX (staged) before/after content for one file — the diff of what a
   * commit would ACTUALLY contain (`git diff --cached <file>`), not the working
   * tree. The staged side is the index blob at stage 0, read as `git show :<path>`
   * (empty when the path isn't staged, e.g. a staged deletion). Powers the AI
   * commit-message generator so its suggestion matches exactly the staged changes,
   * even for partially-staged or staged-then-re-edited files (#694).
   */
  async stagedDiff(rootPath: string, filePath: string): Promise<GitDiff> {
    const ctx = await this.repoContext(rootPath)
    if (!filePath) {
      throw new Error('[Git] stagedDiff requires a filePath')
    }
    const { wsPath, repoPath } = this.anchorPath(ctx, filePath)
    // A rolled-up untracked directory has no single blob to diff — reuse the
    // listing preview, matching the working-tree diff's #247 handling.
    if (filePath.endsWith('/')) {
      return this.directoryDiff(ctx, wsPath, repoPath)
    }
    const [before, after] = await Promise.all([
      this.showFileBytes(ctx.gitCwd, 'HEAD', repoPath),
      this.showFileBytes(ctx.gitCwd, '', repoPath), // `:<path>` = the staged (index, stage 0) blob
    ])
    return buildGitDiff(wsPath, before, after)
  }

  /** Preview a new untracked directory as a listing of its files (#247) — there
   *  is no single file to diff, so both sides carry the listing (before empty).
   *  Lists via `git ls-files --others --exclude-standard` so it shows exactly the
   *  files a commit would stage — respecting .gitignore, not a raw disk walk that
   *  would include node_modules/ / *.log the changeset never contains (#253). */
  private async directoryDiff(ctx: RepoContext, wsPath: string, repoPath: string): Promise<GitDiff> {
    const files = await this.#untrackedUnder(ctx, repoPath)
    const count = files.length === 1 ? '1 file' : `${files.length} files`
    const listing = `New folder — ${count}:\n\n${files.join('\n')}\n`
    return { filePath: `${wsPath}/`, beforeContent: '', afterContent: listing }
  }

  /**
   * The untracked files under `dirPath` (repo-relative), the ones a rolled-up
   * `dir/` change stands in for. Lists via `git ls-files --others
   * --exclude-standard` so it shows exactly what a commit would stage —
   * respecting .gitignore, not a raw disk walk that would include node_modules/
   * / *.log (#253). Sorted, repo-relative paths. Powers the expandable
   * untracked-folder rows in Source Control (#615) and the #247 directory diff.
   * Fail-soft: a non-repo / listing error yields an empty array.
   */
  async listUntrackedInDir(rootPath: string, dirPath: string): Promise<string[]> {
    try {
      const ctx = await this.repoContext(rootPath)
      const { repoPath } = this.anchorPath(ctx, dirPath)
      return await this.#untrackedUnder(ctx, repoPath)
    } catch (error) {
      console.warn('[Git] listUntrackedInDir failed', { rootPath, dirPath, error })
      return []
    }
  }

  /** `git ls-files --others` under one repo-relative dir, answered back in the
   *  API's project-relative shape (#1040). Fail-soft: errors yield []. */
  async #untrackedUnder(ctx: RepoContext, repoPath: string): Promise<string[]> {
    try {
      const out = await this.git(ctx.gitCwd, [
        'ls-files',
        '--others', // untracked
        '--exclude-standard', // honor .gitignore / .git/info/exclude / global excludes
        '-z',
        '--',
        toGitPath(repoPath), // pathspec scopes the listing to this folder
      ])
      return out
        .split('\0')
        .filter((path) => path.length > 0)
        .map((path) => projectPathFromRepoPath(ctx.prefix, path))
        .filter((path): path is string => path !== null)
        .sort((a, b) => a.localeCompare(b))
    } catch (error) {
      console.warn('[Git] untracked listing failed', { root: ctx.root, repoPath, error })
      return []
    }
  }

  /** Stop all watchers and listeners. Safe to call twice. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribeRoots?.()
    this.unsubscribeRoots = null
    for (const timer of this.changeTimers.values()) {
      clearTimeout(timer)
    }
    this.changeTimers.clear()
    this.repoContexts.clear()
    const closing = [...this.watchers.values()].map((watcher) => watcher.close())
    this.watchers.clear()
    this.watcherRoots.clear()
    this.rootGitDirs.clear()
    await Promise.all(closing)
    this.removeAllListeners()
  }

  // ── Internals ──────────────────────────────────────────────────────────

  /** Run git in `root`, resolving stdout. Rejects with stderr attached. */
  /**
   * Stage and commit exactly the given files with a message; returns the new
   * commit's short hash. Whole-file (the working-tree content of each path is
   * committed). SEC-2: everything is argv (no shell), the message rides
   * `-m <message>` as a single element (a leading `-` is the message value,
   * not a flag), and pathspecs sit after `--` so they cannot parse as options;
   * each path is validated inside the root.
   */
  async commit(rootPath: string, message: string, filePaths: string[]): Promise<string> {
    const ctx = await this.repoContext(rootPath)
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('[Git] commit requires a non-empty message')
    }
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error('[Git] commit requires at least one file path')
    }
    const anchored = filePaths.map((filePath) => this.anchorPath(ctx, filePath))
    const repoPaths = anchored.map((entry) => entry.repoPath)
    await this.#refuseConflictedCommit(ctx)
    // Only `git add` the paths that still EXIST: `git add -- <path>` is fatal
    // for a path in neither the worktree nor the index, which is a rename's old
    // side (#1182) and an already-approved deletion (#1181) — and that fatal
    // aborted the entire commit. Neither needs an add: `git commit -- <paths>`
    // records the removal from the worktree state, and naming BOTH sides of a
    // rename is what makes git record it as a rename at all.
    const toAdd = anchored
      .filter((entry) => existsSync(join(ctx.root, entry.wsPath)))
      .map((entry) => entry.repoPath)
    if (toAdd.length > 0) {
      await this.git(ctx.gitCwd, ['add', '--', ...toAdd])
    }
    await this.git(ctx.gitCwd, ['commit', '-m', message, '--', ...repoPaths])
    const hash = await this.git(ctx.gitCwd, ['rev-parse', '--short', 'HEAD'])
    return hash.trim()
  }

  /**
   * Commit the staged index (#335) — `git commit -m <message>` with NO pathspec,
   * so exactly what the user staged (via stage()/unstage()) is committed and
   * nothing else. Returns the new commit's short hash. Distinct from commit(),
   * which stages+commits a specific file set; commitIndex trusts the index.
   * SEC-2: the message rides `-m <message>` as a single argv element.
   */
  async commitIndex(rootPath: string, message: string): Promise<string> {
    const ctx = await this.repoContext(rootPath)
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('[Git] commitIndex requires a non-empty message')
    }
    await this.#refuseConflictedCommit(ctx)
    // #1209: scope the commit to the PROJECT. The listing has been scoped to the
    // project subtree since #1040, but this ran at the repo toplevel with no
    // pathspec — so everything in the shared index went in, including files the
    // panel never showed, under the message written for this project. Two
    // ordinary shapes hit it: a package folder opened inside a bigger repo, and
    // two projects open in one repo, where one group's Commit consumed the
    // other group's deliberately-staged work.
    //
    // Review had this exact defect and fixed it by scoping (#1051). This scopes
    // to the STAGED paths under the prefix rather than to the prefix itself:
    // `git commit -- <dir>` would sweep in unstaged siblings under the project,
    // breaking "commit exactly what I staged" in the other direction.
    const scoped = ctx.prefix ? await this.#stagedPathsUnderPrefix(ctx) : null
    if (scoped !== null && scoped.length === 0) {
      throw new Error('[Git] Nothing staged in this project to commit')
    }
    const pathspec = scoped === null ? [] : ['--', ...scoped]
    await this.git(ctx.gitCwd, ['commit', '-m', message, ...pathspec])
    const hash = await this.git(ctx.gitCwd, ['rev-parse', '--short', 'HEAD'])
    return hash.trim()
  }

  /** Repo-relative staged paths inside this project root's subtree (#1209). */
  async #stagedPathsUnderPrefix(ctx: RepoContext): Promise<string[]> {
    const raw = await this.git(ctx.gitCwd, ['diff', '--cached', '--name-only', '-z'])
    const prefix = ctx.prefix
    return raw
      .split('\0')
      .map((path) => path.trim())
      .filter((path) => path.length > 0 && path.startsWith(prefix))
  }

  /**
   * Stage files into the index (#335) — `git add -- <paths>`. SEC-2: each path is
   * validated inside the root and sits after `--` so it can't parse as an option.
   */
  async stage(rootPath: string, filePaths: string[]): Promise<void> {
    const ctx = await this.repoContext(rootPath)
    const repoPaths = this.#safeNonEmptyPaths(ctx, filePaths, 'stage')
    // #986: `git add` on an unmerged path tells git the conflict is RESOLVED —
    // the review tab's ✓ used to silently flip `UU` to staged with the raw
    // markers still in the file. Refuse while the markers are unresolved; a
    // manually-resolved file (unmerged but marker-free) stays stageable, which
    // IS git's resolution gesture.
    const conflicted = await this.#unresolvedRepoPaths(ctx, repoPaths, {
      scanStagedBlobs: false,
    })
    if (conflicted.length > 0) {
      throw new Error(
        stageConflictRefusal(
          conflicted.map((path) => projectPathFromRepoPath(ctx.prefix, path) ?? path),
        ),
      )
    }
    // #1182: `-A` so a path that no longer exists on disk stages as a REMOVAL
    // rather than being fatal. Re-approving a rename passes both of its paths,
    // and the old one is gone from the worktree by definition — plain `git add`
    // aborted there, which is what wedged a shattered rename at "Approve all
    // (1/2)" with no way back. For paths that do exist, `-A` stages exactly
    // what `add` did.
    await this.git(ctx.gitCwd, ['add', '-A', '--', ...repoPaths])
  }

  /**
   * The subset of `filePaths` (repo-relative; the whole tree when omitted) that
   * still carries an UNRESOLVED merge conflict (#986). This is the ONE
   * detection code path (allowed-pattern #14) shared by the stage/approve gate
   * and both commit gates, so the review surface can never `git add` a conflict
   * away or land marker-laden content in history while the sibling Changes tab
   * refuses the same thing.
   *
   * Detection prefers git's own knowledge over raw text scanning:
   * - A path git reports UNMERGED is unresolved when its WORKING copy still
   *   holds a line-start conflict marker. Unmerged but marker-free (the user
   *   resolved the file by hand, or a binary/delete conflict) is NOT flagged —
   *   staging that is exactly how a conflict is legitimately marked resolved.
   * - With `scanStagedBlobs` (the commit gates), while an integration op
   *   (merge/rebase/cherry-pick) is in progress, an already-STAGED path whose
   *   staged blob still holds markers is also unresolved — `git add` clears the
   *   unmerged flag even when the markers were never removed, which is exactly
   *   the corruption this guards against.
   *
   * Outside an in-progress op nothing is content-scanned unless git itself
   * flags the path, so files that merely QUOTE marker lines (test fixtures,
   * docs) never false-positive. Scan failures are fail-soft toward git's
   * knowledge: an unreadable unmerged file stays flagged; an unreadable staged
   * blob is skipped.
   */
  async unresolvedConflictPaths(
    rootPath: string,
    filePaths?: string[],
    options: { scanStagedBlobs?: boolean } = {},
  ): Promise<string[]> {
    const ctx = await this.repoContext(rootPath)
    const wantedRepoPaths =
      filePaths === undefined
        ? undefined
        : filePaths.map((filePath) => this.anchorPath(ctx, filePath).repoPath)
    const flagged = await this.#unresolvedRepoPaths(ctx, wantedRepoPaths, options)
    // #1040: the API answers project-relative. A conflict OUTSIDE the
    // project subtree (repo-wide commit gate) keeps its repo-relative path —
    // still a truthful name for the refusal message, never a wrong file.
    return flagged.map((path) => projectPathFromRepoPath(ctx.prefix, path) ?? path)
  }

  /** Repo-relative core of {@link unresolvedConflictPaths} — the ONE detection
   *  code path (#986, allowed-pattern #14), anchored on the repo root (#1040). */
  async #unresolvedRepoPaths(
    ctx: RepoContext,
    wantedRepoPaths?: string[],
    options: { scanStagedBlobs?: boolean } = {},
  ): Promise<string[]> {
    const { scanStagedBlobs = true } = options
    const state = await this.#mergeStateRepoRelative(ctx)
    const unmerged = new Set(state.unmergedPaths)
    const wanted =
      wantedRepoPaths === undefined
        ? null
        : new Set(wantedRepoPaths.map((filePath) => normalizeRepoRelativePath(filePath)))

    const flagged: string[] = []
    for (const path of state.unmergedPaths) {
      if (wanted !== null && !wanted.has(path)) continue
      let working: string
      try {
        working = await this.readWorkingTreeText(ctx.gitCwd, path)
      } catch {
        // Can't verify the markers are gone (oversize/unreadable) — git says
        // unmerged, so stay conservative and keep the gate closed.
        flagged.push(path)
        continue
      }
      if (containsConflictMarkers(working)) flagged.push(path)
    }

    if (!scanStagedBlobs || state.op === 'none') return flagged

    // Mid-op: a staged blob may still carry markers even though git no longer
    // reports the path unmerged (`git add` cleared the flag). ONE `git grep
    // --cached` over the index, intersected with the staged change-set — no
    // per-file subprocess fan-out on large merges, and unchanged tracked files
    // that legitimately quote marker lines can never trip the gate.
    const [indexMatches, stagedChanges] = await Promise.all([
      this.#indexMarkerMatches(ctx.gitCwd),
      this.#stagedChangedPaths(ctx.gitCwd),
    ])
    const staged = new Set(stagedChanges)
    for (const path of indexMatches) {
      if (!staged.has(path)) continue // not part of the staged change-set
      if (unmerged.has(path)) continue // already judged via the working copy
      if (wanted !== null && !wanted.has(path)) continue
      flagged.push(path)
    }
    return flagged
  }

  /** Index paths whose STAGED content holds a line-start conflict marker — one
   *  `git grep --cached` subprocess (#986). `-I` skips binaries. No match (exit
   *  1) or any failure → [] — fail-soft toward the unmerged-set authority. */
  async #indexMarkerMatches(root: string): Promise<string[]> {
    try {
      const output = await this.git(root, [
        'grep',
        '-I',
        '-l',
        '-z',
        '--cached',
        '-E',
        CONFLICT_MARKER_GREP,
      ])
      return output.split('\0').filter((path) => path.length > 0)
    } catch {
      return []
    }
  }

  /** Paths staged with changes vs HEAD (`git diff --cached --name-only`) —
   *  fail-soft [] (e.g. no HEAD yet). */
  async #stagedChangedPaths(root: string): Promise<string[]> {
    try {
      const output = await this.git(root, ['diff', '--cached', '--name-only', '-z'])
      return output.split('\0').filter((path) => path.length > 0)
    } catch {
      return []
    }
  }

  /** Shared commit gate (#986): refuse `git commit` while unresolved conflict
   *  markers remain anywhere in the tree or the staged index. Repo-wide by
   *  design — a commit lands in the whole repository, so a conflict outside a
   *  subdirectory project still refuses (#1040). */
  async #refuseConflictedCommit(ctx: RepoContext): Promise<void> {
    const conflicted = await this.#unresolvedRepoPaths(ctx)
    if (conflicted.length > 0) {
      throw new Error(
        commitConflictRefusal(
          conflicted.map((path) => projectPathFromRepoPath(ctx.prefix, path) ?? path),
        ),
      )
    }
  }

  /**
   * Unstage files from the index (#335) — `git restore --staged -- <paths>`, with
   * a fallback to `git reset -q HEAD -- <paths>` when the repo has no HEAD yet
   * (initial commit), where `restore --staged` can't resolve HEAD.
   */
  async unstage(rootPath: string, filePaths: string[]): Promise<void> {
    const ctx = await this.repoContext(rootPath)
    const repoPaths = this.#safeNonEmptyPaths(ctx, filePaths, 'unstage')
    try {
      await this.git(ctx.gitCwd, ['restore', '--staged', '--', ...repoPaths])
    } catch {
      // No HEAD yet (nothing committed) — `git reset` unstages back to an empty tree.
      await this.git(ctx.gitCwd, ['reset', '-q', 'HEAD', '--', ...repoPaths])
    }
  }

  /** Validate a non-empty file-path list against the project root (SEC-2)
   *  and answer the repo-relative paths git speaks (#1040). */
  #safeNonEmptyPaths(ctx: RepoContext, filePaths: string[], op: string): string[] {
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      throw new Error(`[Git] ${op} requires at least one file path`)
    }
    return filePaths.map((filePath) => this.anchorPath(ctx, filePath).repoPath)
  }

  /**
   * Revert a file's working-tree changes back to HEAD (the review panel's
   * "reject"). A file that isn't in HEAD (untracked/newly added) is removed
   * from disk instead. SEC-2: the path is validated inside the root and sits
   * after `--` so it cannot parse as an option.
   */
  async revertFile(rootPath: string, filePath: string): Promise<void> {
    const ctx = await this.repoContext(rootPath)
    const { repoPath } = this.anchorPath(ctx, filePath)
    try {
      await this.git(ctx.gitCwd, ['checkout', 'HEAD', '--', repoPath])
    } catch (error) {
      // ONLY an untracked/newly-added path (not known at HEAD) is discarded by
      // deleting it. Any OTHER checkout failure — an `.git/index.lock` collision
      // (our own index watcher makes this plausible), a permission error, repo
      // corruption — must NOT delete the user's uncommitted work. Rethrow so the
      // review coordinator surfaces it via a toast, mirroring the commit path.
      if (!isPathUnknownAtHeadError(error)) throw error
      // A STAGED-new file is tracked from `git clean`'s point of view, so drop
      // its index entries first — reverting to HEAD means the path exists in
      // neither the index nor the worktree. `--cached` touches only the index;
      // `--ignore-unmatch` makes this a no-op for the common pure-untracked case.
      await this.git(ctx.gitCwd, [
        'rm',
        '-r',
        '-f',
        '-q',
        '--cached',
        '--ignore-unmatch',
        '--',
        toGitPath(repoPath),
      ])
      await this.#cleanUntracked(ctx, repoPath)
    }
  }

  /**
   * Remove an UNTRACKED path with `git clean`'s semantics — deliberately
   * WITHOUT `-x`, so `.gitignore`d files are never touched (#1054). A rolled-up
   * new directory (`dir/`) previously fell back to a blanket `fs.rm -rf`, which
   * silently destroyed ignored files (`.env`, `*.local`, `node_modules/`) the
   * panel never listed and git itself would never remove. Delegating to
   * `git clean -fd -- <path>` keeps the three surfaces consistent by
   * construction: the #253 preview, the #176/#247 commit contents, and the
   * discard scope are all "what `--exclude-standard` sees". `-d` recurses into
   * the directory (and prunes it only when nothing ignored remains inside),
   * fixing the #136 EISDIR case without the rm blast radius. A pathspec that
   * matches nothing exits 0, so an already-gone path stays a quiet no-op.
   */
  async #cleanUntracked(ctx: RepoContext, repoPath: string): Promise<void> {
    await this.git(ctx.gitCwd, ['clean', '-fd', '--', toGitPath(repoPath)])
  }

  /**
   * Discard a file's WORKING-TREE changes back to the INDEX — the Source Control
   * panel's per-file "Discard" on a Changes row (#598). `git checkout -- <path>`
   * restores from the index, so a file that was staged and then re-edited returns
   * to its STAGED snapshot (not HEAD), keeping the staged work — VS Code parity.
   * When the file has no index entry (== HEAD), this is equivalent to a HEAD
   * revert, so the common single-state case is unchanged. An untracked/newly-added
   * path (unknown to git) is removed from disk; any other failure rethrows so the
   * user's uncommitted work is never silently deleted (mirrors revertFile, #136).
   */
  async discardWorktreeChanges(rootPath: string, filePath: string): Promise<void> {
    const ctx = await this.repoContext(rootPath)
    const { repoPath } = this.anchorPath(ctx, filePath)
    // A submodule is a gitlink, and `git checkout -- <gitlink>` exits 0 having
    // done nothing at all (#1478). That zero flowed back as success, so the user
    // confirmed "this can't be undone", saw no toast, no error and an unchanged
    // row, and was left believing the submodule had been reset. Putting it back
    // on the recorded commit is what the button says it does.
    //
    // Deliberately WITHOUT --force: plain `submodule update` refuses rather than
    // overwrite uncommitted work inside the submodule, and the refusal surfaces
    // as an error the panel toasts. The user confirmed discarding a pointer
    // move; they did not confirm destroying work in another repository.
    if (await this.#isGitlink(ctx, repoPath)) {
      await this.git(ctx.gitCwd, ['submodule', 'update', '--', repoPath])
      return
    }
    try {
      await this.git(ctx.gitCwd, ['checkout', '--', repoPath])
    } catch (error) {
      if (!isPathUnknownAtHeadError(error)) throw error
      // Unknown to the index → pure untracked. Remove it the way `git clean`
      // would (no `-x`): a rolled-up new folder loses only the files the panel
      // listed — never the `.gitignore`d ones living alongside them (#1054).
      await this.#cleanUntracked(ctx, repoPath)
    }
  }

  // ── Merge / rebase conflict resolution ───────────────────────────────────

  /**
   * The repo's in-progress integration state (merge or rebase) plus the set of
   * still-unresolved paths. Fail-soft: a non-repo (or a clean tree) yields
   * `{ op: 'none', unmergedPaths: [] }`. Git dir is resolved via
   * `rev-parse --absolute-git-dir` so linked worktrees/submodules work too.
   */
  async getMergeState(rootPath: string): Promise<GitMergeState> {
    const ctx = await this.repoContext(rootPath)
    const state = await this.#mergeStateRepoRelative(ctx)
    if (!ctx.prefix) return state
    // #1040: the API answers project-relative; a conflict outside the
    // project subtree keeps its repo-relative name (gates stay repo-wide).
    return {
      ...state,
      unmergedPaths: state.unmergedPaths.map(
        (path) => projectPathFromRepoPath(ctx.prefix, path) ?? path,
      ),
    }
  }

  /** Repo-relative core of {@link getMergeState} — internal callers (conflict
   *  gates, identity assembly) need git's own repo-relative paths (#1040). */
  async #mergeStateRepoRelative(ctx: RepoContext): Promise<GitMergeState> {
    // The git dir came with the repo anchor — one cached rev-parse for both,
    // where this used to spawn its own on every call.
    const gitDir = ctx.gitDir
    if (!gitDir) return { op: 'none', unmergedPaths: [] }

    const unmergedPaths = await this.unmergedPaths(ctx.gitCwd)

    // A rebase keeps its state under one of these dirs (interactive/merge vs am).
    const rebaseMergeDir = join(gitDir, 'rebase-merge')
    const rebaseApplyDir = join(gitDir, 'rebase-apply')
    if (isDirectory(rebaseMergeDir) || isDirectory(rebaseApplyDir)) {
      const stateDir = isDirectory(rebaseMergeDir) ? rebaseMergeDir : rebaseApplyDir
      const headName = await readGitStateFile(join(stateDir, 'head-name'))
      const onto = await readGitStateFile(join(stateDir, 'onto'))
      // `orig-head` is the tip of the branch being replayed — the INVERTED
      // `theirs` side of a rebase (the commits git is replaying), distinct from
      // `onto` (the base HEAD sits on, the `ours` side).
      const origHead = firstLine(await readGitStateFile(join(stateDir, 'orig-head')))
      return {
        op: 'rebase',
        ontoBranch: shortenRef(headName) || undefined,
        incomingRef: onto || undefined,
        rebaseHead: origHead || undefined,
        unmergedPaths,
      }
    }

    // A cherry-pick (and revert) records its incoming commit here, never a
    // MERGE_HEAD — check it before the merge branch so the op is classified right.
    const cherryPickHead = firstLine(await readGitStateFile(join(gitDir, 'CHERRY_PICK_HEAD')))
    if (cherryPickHead) {
      return {
        op: 'cherry-pick',
        cherryPickHead,
        incomingRef: cherryPickHead,
        unmergedPaths,
      }
    }

    const mergeHead = firstLine(await readGitStateFile(join(gitDir, 'MERGE_HEAD')))
    if (mergeHead) {
      const mergeMsg = await readGitStateFile(join(gitDir, 'MERGE_MSG'))
      return {
        op: 'merge',
        mergeHead,
        mergeMsg: mergeMsg || undefined,
        incomingBranch: parseIncomingBranch(mergeMsg) || undefined,
        incomingRef: mergeHead,
        unmergedPaths,
      }
    }

    // Note: a stash-apply-in-progress with conflicts leaves unmerged index
    // entries but NO dedicated state file (no MERGE_HEAD / CHERRY_PICK_HEAD /
    // rebase dir) — it is indistinguishable from a plain unmerged tree, so we
    // never fabricate `op: 'stash'` here. The union member exists for a later
    // provider that has out-of-band knowledge it is inside a `git stash apply`.
    return { op: 'none', unmergedPaths }
  }

  /**
   * The three conflict sides of a file plus the marker-laden working copy.
   * Each staged side is empty when that stage is absent (e.g. add/add has no
   * base). Returns `{ oversize: true }` when any side blows the exec buffer.
   * SEC-2: the path is validated inside the root.
   */
  async readConflicted(rootPath: string, filePath: string): Promise<GitReadConflictedResult> {
    const ctx = await this.repoContext(rootPath)
    const { repoPath } = this.anchorPath(ctx, filePath)
    try {
      // Read each stage as RAW BYTES (null = that stage is absent) so we can
      // detect binary content and distinguish an ABSENT side from an empty one
      // BEFORE any lossy UTF-8 decode (#246; conflict-UX Phase 2).
      const [oursBytes, theirsBytes, baseBytes] = await Promise.all([
        this.showStageBytes(ctx.gitCwd, CONFLICT_STAGE_OURS, repoPath),
        this.showStageBytes(ctx.gitCwd, CONFLICT_STAGE_THEIRS, repoPath),
        this.showStageBytes(ctx.gitCwd, CONFLICT_STAGE_BASE, repoPath),
      ])

      const oursPresent = oursBytes !== null
      const theirsPresent = theirsBytes !== null
      const basePresent = baseBytes !== null
      const conflictType = conflictTypeFromStages({
        ours: oursPresent,
        theirs: theirsPresent,
        base: basePresent,
      })
      const sizes = {
        oursSize: oursBytes?.length ?? 0,
        theirsSize: theirsBytes?.length ?? 0,
        baseSize: baseBytes?.length ?? 0,
      }
      const presence = { oursPresent, theirsPresent, basePresent }
      const renameRaw = await this.detectConflictRename(ctx.gitCwd, repoPath)
      // Rename lineage is displayed by the renderer — answer it in the API's
      // project-relative shape where the pair lies inside the project (#1040).
      const rename = {
        ...(renameRaw.renameFrom !== undefined
          ? {
              renameFrom:
                projectPathFromRepoPath(ctx.prefix, renameRaw.renameFrom) ?? renameRaw.renameFrom,
            }
          : {}),
        ...(renameRaw.renameTo !== undefined
          ? {
              renameTo:
                projectPathFromRepoPath(ctx.prefix, renameRaw.renameTo) ?? renameRaw.renameTo,
            }
          : {}),
      }
      // LIVE per-side identity (conflict-UX Phase 5, Task 1) — op-aware branch +
      // author for stage 2/3, so the editor labels each pane truthfully instead
      // of the "Side A/B" fallback. Fail-soft: a throwing assembly degrades to no
      // identity, never breaks readConflicted.
      const identity = await this.assembleFileIdentity(ctx, repoPath)
      const refinements = {
        ...presence,
        ...sizes,
        ...(conflictType ? { conflictType } : {}),
        ...rename,
        ...identity,
      }

      // Binary: NUL byte on ANY side. Return sizes/metadata, never mojibake text.
      const anyBinary =
        (oursBytes !== null && hasNulByte(oursBytes)) ||
        (theirsBytes !== null && hasNulByte(theirsBytes)) ||
        (baseBytes !== null && hasNulByte(baseBytes))
      if (anyBinary) {
        return {
          ours: '',
          theirs: '',
          base: '',
          markered: '',
          binary: true,
          ...refinements,
        }
      }

      const markered = await this.readWorkingTreeText(ctx.gitCwd, repoPath)
      return {
        ours: oursBytes ? oursBytes.toString('utf8') : '',
        theirs: theirsBytes ? theirsBytes.toString('utf8') : '',
        base: baseBytes ? baseBytes.toString('utf8') : '',
        markered,
        ...refinements,
      }
    } catch (error) {
      if (isBufferOverflowError(error)) return { oversize: true }
      throw error
    }
  }

  /**
   * Assemble the LIVE per-side identity (branch + author, op-aware) for a single
   * conflicted file by driving {@link assembleConflictContext} over a mergeState
   * scoped to just this path. The `currentUser`/`fileAuthors` seams are bound to
   * this manager's own methods so the "is this me?" flag and the HEAD-author
   * fallback use the real repo; the remaining seams (git log, rounds, brain)
   * stay on their fail-soft defaults.
   *
   * Fail-soft by contract: any failure (non-repo, no MERGE_HEAD, throwing seam)
   * degrades to `{}` — readConflicted must never break because identity could
   * not be recovered.
   */
  private async assembleFileIdentity(
    ctx: RepoContext,
    repoPath: string,
  ): Promise<{ oursIdentity?: SideIdentity; theirsIdentity?: SideIdentity }> {
    try {
      const mergeState = await this.#mergeStateRepoRelative(ctx)
      // assembleConflictContext logs each unmergedPath; scope it to this one
      // file. Everything here is REPO-anchored (#1040): the context runs
      // against the repo toplevel with git's own repo-relative path, so the
      // fileAuthors/currentUser seams (called back with that root) resolve the
      // degenerate prefix-less context and line up exactly.
      const scoped: GitMergeState = { ...mergeState, unmergedPaths: [repoPath] }
      const deps: ConflictContextDeps = {
        ...defaultConflictContextDeps(),
        currentUser: (rp) => this.currentUser(rp),
        fileAuthors: (rp, filePaths) => this.fileAuthors(rp, filePaths),
      }
      const contexts = await assembleConflictContext(ctx.gitCwd, scoped, deps)
      const fileContext = contexts[0]
      if (!fileContext) return {}
      const identity: { oursIdentity?: SideIdentity; theirsIdentity?: SideIdentity } = {}
      if (fileContext.oursIdentity) identity.oursIdentity = fileContext.oursIdentity
      if (fileContext.theirsIdentity) identity.theirsIdentity = fileContext.theirsIdentity
      return identity
    } catch {
      return {}
    }
  }

  /**
   * Best-effort rename lineage for a conflicted path. Porcelain v2 `u` records
   * don't carry the old→new pair for rename/rename or rename/modify conflicts,
   * so we ask `git diff -M` between our HEAD and the incoming MERGE_HEAD for a
   * rename touching this path. Fail-soft by design: any error (no MERGE_HEAD
   * during a rebase/cherry-pick, detached HEAD, …) yields no lineage rather
   * than failing the whole read — the pair is advisory, the conflict is not.
   */
  private async detectConflictRename(
    root: string,
    filePath: string,
  ): Promise<{ renameFrom?: string; renameTo?: string }> {
    try {
      const out = await this.git(root, [
        'diff',
        '-M',
        '--diff-filter=RC',
        '--name-status',
        '-z',
        'HEAD',
        'MERGE_HEAD',
        '--',
      ])
      // -z name-status renames arrive as three NUL-separated fields:
      //   "R<score>" NUL <from> NUL <to>
      const tokens = out.split('\0')
      for (let i = 0; i < tokens.length; i += 1) {
        const status = tokens[i]
        if (!status) continue
        if (status.startsWith('R') || status.startsWith('C')) {
          const renameFrom = tokens[i + 1]
          const renameTo = tokens[i + 2]
          i += 2
          if (renameFrom === filePath || renameTo === filePath) {
            return { renameFrom, renameTo }
          }
        }
      }
    } catch {
      // Advisory: no MERGE_HEAD (rebase/cherry-pick) or a non-merge state — the
      // conflict is still fully readable without rename lineage.
    }
    return {}
  }

  /**
   * Resolve one conflicted file, then `git add` it so it drops out of the
   * unmerged set. `content` writes the caller's merged text; `ours`/`theirs`
   * take that whole side.
   *
   * `ours`/`theirs` are re-expressed as "splice EVERY hunk with this choice"
   * (conflict-UX Phase 3), so the whole-file and per-hunk APIs share the one
   * splice code path (allowed-pattern #14) and non-conflicted working edits are
   * preserved. When the file carries no parseable markers (binary side, whole
   * delete/modify — nothing to splice) we fall back to the classic
   * `git checkout --ours|--theirs`, which still handles those cases correctly.
   * SEC-2: the path is validated inside the root and sits after `--`.
   */
  async resolveConflict(
    rootPath: string,
    filePath: string,
    resolution: GitConflictResolution,
  ): Promise<void> {
    const ctx = await this.repoContext(rootPath)
    const { wsPath, repoPath } = this.anchorPath(ctx, filePath)
    await this.assertWriteInsideRoot(ctx.root, wsPath) // L2: refuse a symlinked escape

    switch (resolution.kind) {
      case 'content':
        if (typeof resolution.text !== 'string') {
          throw new Error('[Git] resolveConflict content requires a string `text`')
        }
        await fsPromises.writeFile(join(ctx.gitCwd, repoPath), resolution.text, 'utf8')
        break
      case 'ours':
      case 'theirs': {
        const spliced = await this.resolveAllHunksInWorkingFile(
          ctx.gitCwd,
          repoPath,
          resolution.kind,
        )
        if (!spliced) {
          // No markers to splice (binary / whole delete/modify) — take the side
          // wholesale the classic way.
          await this.git(ctx.gitCwd, ['checkout', `--${resolution.kind}`, '--', repoPath])
        }
        break
      }
      default: {
        // Exhaustiveness guard — a new resolution kind must be handled here.
        const unhandled: never = resolution
        throw new Error(`[Git] Unknown conflict resolution: ${JSON.stringify(unhandled)}`)
      }
    }

    await this.git(ctx.gitCwd, ['add', '--', repoPath])
  }

  /**
   * Resolve a SINGLE conflict hunk (conflict-UX Phase 3). Splices only the hunk
   * identified by `hunkId` in the working file with `choice` (or an explicit
   * `content` body), leaving every sibling hunk's marker region intact. The file
   * is re-staged (`git add`) ONLY when it becomes fully conflict-free — otherwise
   * it is left unmerged so the remaining hunks can still be resolved. Modeled on
   * `editor:resolveHunk`. SEC-2: the path is validated inside the root.
   */
  async resolveConflictHunk(
    rootPath: string,
    filePath: string,
    hunkId: string,
    choice: ConflictHunkChoice,
    order: ConflictHunkOrder = 'ours-first',
    content?: string,
  ): Promise<{ matched: boolean; remainingConflicts: number; staged: boolean }> {
    const ctx = await this.repoContext(rootPath)
    const { wsPath, repoPath } = this.anchorPath(ctx, filePath)
    await this.assertWriteInsideRoot(ctx.root, wsPath) // L2: refuse a symlinked escape
    const absolute = join(ctx.gitCwd, repoPath)

    const original = await this.readWorkingTreeText(ctx.gitCwd, repoPath)
    const spliced =
      typeof content === 'string'
        ? spliceConflictHunkWithText(original, hunkId, content)
        : spliceConflictHunk(original, hunkId, choice, order)

    if (!spliced.matched) {
      // Nothing changed — report the current conflict count without touching disk.
      return { matched: false, remainingConflicts: spliced.remainingConflicts, staged: false }
    }

    await fsPromises.writeFile(absolute, spliced.text, 'utf8')

    // Re-stage only once the file is fully clean; a partially-resolved file must
    // stay unmerged so `completeMerge`'s gate still sees it.
    const staged = spliced.remainingConflicts === 0
    if (staged) {
      await this.git(ctx.gitCwd, ['add', '--', repoPath])
    }
    return { matched: true, remainingConflicts: spliced.remainingConflicts, staged }
  }

  /**
   * Splice every conflict hunk in the working file with one choice and write it
   * back. Returns false when the file has no parseable conflict markers (so the
   * caller can fall back to `git checkout --ours|--theirs`), true otherwise.
   */
  private async resolveAllHunksInWorkingFile(
    root: string,
    safePath: string,
    choice: 'ours' | 'theirs',
  ): Promise<boolean> {
    const original = await this.readWorkingTreeText(root, safePath)
    const spliced = spliceAllConflictHunks(original, choice)
    if (!spliced.matched) return false
    await fsPromises.writeFile(join(root, safePath), spliced.text, 'utf8')
    return true
  }

  /**
   * L2: {@link ensureInsideRoot} neutralizes `..`/absolute paths LEXICALLY, but
   * an in-repo symlink (possible in an untrusted cloned repo) whose target lies
   * outside the root would let a `writeFile` FOLLOW it and write outside the root.
   * Before any resolve/reconcile write, realpath the deepest EXISTING path
   * component (the target itself when it exists — resolving a symlinked leaf — or
   * else the nearest existing ancestor for a not-yet-created file) and re-assert
   * it is still inside the repo root; refuse otherwise. Read paths are untouched.
   * Fail-soft for the normal (non-symlink) case: a brand-new nested path simply
   * resolves the nearest existing ancestor and passes.
   */
  private async assertWriteInsideRoot(root: string, safePath: string): Promise<void> {
    let realRoot: string
    try {
      realRoot = await fsPromises.realpath(root)
    } catch {
      return // root itself unresolvable — no meaningful symlink escape to check
    }
    let probe = join(root, safePath)
    let realTarget: string | null = null
    while (realTarget === null) {
      try {
        realTarget = await fsPromises.realpath(probe)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
        const parent = dirname(probe)
        if (parent === probe) return // reached the fs root with no existing ancestor
        probe = parent
      }
    }
    const rel = relative(realRoot, realTarget)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`[Git] Path escapes the project folder via symlink: ${safePath}`)
    }
  }

  /**
   * Synthesize a plan-flow AGENT CLASH (conflict-UX Phase 6) as an ordinary
   * 3-way conflict so it flows through the very same per-hunk resolver a git
   * conflict does. Two wave phases each committed an edit to the SAME file; there
   * is no git merge to surface it, so we reconstruct one: extract each side's blob
   * (`git show <commit>:<path>`) plus the base blob, and `git merge-file --diff3`
   * them into marker text the {@link parseConflictHunks} grammar reads. The marker
   * LABELS carry the phase ids (side A = phase A, side B = phase B).
   *
   * Returns the same {@link GitReadConflictedResult} shape `readConflicted` does —
   * the three sides plus the markered text — but WITHOUT identity (git-manager
   * stays free of the review layer; the IPC layer overlays the wave identities).
   * `binary: true` when any side has a NUL byte (no text 3-way merge is possible);
   * `{ oversize: true }` when a side blows the exec buffer. SEC-2: the path is
   * validated inside the root and each commit ref is validated before argv.
   */
  async synthesizeClashConflict(
    rootPath: string,
    input: SynthesizeClashInput,
  ): Promise<GitReadConflictedResult> {
    const ctx = await this.repoContext(rootPath)
    const { repoPath } = this.anchorPath(ctx, input.filePath)
    if (!isValidRevision(input.sideACommit) || !isValidRevision(input.sideBCommit)) {
      throw new Error('[Git] synthesizeClashConflict requires valid side commits')
    }
    if (input.baseCommit !== null && !isValidRevision(input.baseCommit)) {
      throw new Error('[Git] synthesizeClashConflict base commit is invalid')
    }
    try {
      // Read each side's blob (and the base, when present) as RAW BYTES so a
      // binary side is detected before any lossy UTF-8 decode — same discipline
      // as readConflicted. A null base yields empty bytes (add/add-style clash).
      const [oursBytes, theirsBytes, baseBytes] = await Promise.all([
        this.showFileBytes(ctx.gitCwd, input.sideACommit, repoPath),
        this.showFileBytes(ctx.gitCwd, input.sideBCommit, repoPath),
        input.baseCommit
          ? this.showFileBytes(ctx.gitCwd, input.baseCommit, repoPath)
          : Promise.resolve(Buffer.alloc(0)),
      ])

      const basePresent = input.baseCommit !== null
      const conflictType = conflictTypeFromStages({ ours: true, theirs: true, base: basePresent })
      const refinements = {
        oursPresent: true,
        theirsPresent: true,
        basePresent,
        oursSize: oursBytes.length,
        theirsSize: theirsBytes.length,
        baseSize: baseBytes.length,
        ...(conflictType ? { conflictType } : {}),
      }

      const anyBinary =
        hasNulByte(oursBytes) || hasNulByte(theirsBytes) || hasNulByte(baseBytes)
      if (anyBinary) {
        return { ours: '', theirs: '', base: '', markered: '', binary: true, ...refinements }
      }

      const markered = await this.mergeFileMarkers(
        ctx.gitCwd,
        oursBytes,
        baseBytes,
        theirsBytes,
        input.sideALabel ?? 'ours',
        input.sideBLabel ?? 'theirs',
      )
      // M3: with a correctly-derived base the two sides normally diverge into
      // conflict hunks. If they DON'T (e.g. a base still collapsed to side A, or
      // side B is a linear descendant that already subsumes side A's edit), the
      // 3-way merged cleanly and the marker text carries zero hunks — opening it
      // as a resolver would present an empty, confusing surface silently. Surface
      // it with a clear one-line warning instead of failing silently; the result
      // is still returned so the caller stays fail-soft.
      if (parseConflictHunks(markered).length === 0) {
        console.warn(
          `[Git] Agent clash for ${input.filePath} produced no conflict hunks — ` +
            'the two sides did not diverge; not surfacing an empty resolver.',
        )
      }
      return {
        ours: oursBytes.toString('utf8'),
        theirs: theirsBytes.toString('utf8'),
        base: baseBytes.toString('utf8'),
        markered,
        ...refinements,
      }
    } catch (error) {
      if (isBufferOverflowError(error)) return { oversize: true }
      throw error
    }
  }

  /**
   * Write the resolved content of an agent clash to the working tree and stage
   * it — the clash's "completion" (conflict-UX Phase 6). There is NO git
   * `--continue` here: an agent clash is not a real git merge state, so we simply
   * write the merged bytes deterministically and `git add` the path so it surfaces
   * as a normal staged change. Staging failures are swallowed (the content is on
   * disk regardless, which is what "reconciled" means); a write failure surfaces.
   * SEC-2: the path is validated inside the root.
   */
  async reconcileClash(rootPath: string, filePath: string, content: string): Promise<void> {
    const ctx = await this.repoContext(rootPath)
    if (typeof content !== 'string') {
      throw new Error('[Git] reconcileClash requires string content')
    }
    const { wsPath, repoPath } = this.anchorPath(ctx, filePath)
    await this.assertWriteInsideRoot(ctx.root, wsPath) // L2: refuse a symlinked escape
    await fsPromises.writeFile(join(ctx.gitCwd, repoPath), content, 'utf8')
    try {
      await this.git(ctx.gitCwd, ['add', '--', repoPath])
    } catch (error) {
      // A non-repo / untracked-path add is non-fatal — the reconciled bytes are
      // already on disk. The clash is defined by the working-tree content, not
      // the index, so staging is a best-effort convenience, never a gate.
      console.warn('[Git] reconcileClash: staging failed (content written)', { repoPath, error })
    }
  }

  /**
   * Run `git merge-file -p --diff3` over the three sides written to temp files,
   * returning the marker text on stdout. merge-file exits with the CONFLICT COUNT
   * (1-127) rather than 0 for a conflicted merge — which is the expected case for
   * a clash — so {@link mergeFile} treats that exit code as success. The temp dir
   * is always cleaned up.
   */
  private async mergeFileMarkers(
    root: string,
    oursBytes: Buffer,
    baseBytes: Buffer,
    theirsBytes: Buffer,
    oursLabel: string,
    theirsLabel: string,
  ): Promise<string> {
    const dir = await fsPromises.mkdtemp(join(tmpdir(), 'flow-clash-'))
    try {
      const oursFile = join(dir, 'ours')
      const baseFile = join(dir, 'base')
      const theirsFile = join(dir, 'theirs')
      await Promise.all([
        fsPromises.writeFile(oursFile, oursBytes),
        fsPromises.writeFile(baseFile, baseBytes),
        fsPromises.writeFile(theirsFile, theirsBytes),
      ])
      // -p prints the merge to stdout; --diff3 keeps the base section between
      // `|||||||` and `=======`; the three -L labels name ours/base/theirs in
      // the emitted markers (positional: file1=ours, file2=base, file3=theirs).
      const { stdout } = await this.mergeFile(root, [
        '-p',
        '--diff3',
        '-L',
        oursLabel,
        '-L',
        'base',
        '-L',
        theirsLabel,
        oursFile,
        baseFile,
        theirsFile,
      ])
      return stdout
    } finally {
      await fsPromises.rm(dir, { recursive: true, force: true })
    }
  }

  /**
   * `git merge-file` runner tolerating its conflict-count exit convention: a
   * clean integer exit in [1,127] is the number of remaining conflicts (git caps
   * it at 127), NOT a failure — so we resolve stdout with that count. Only a
   * genuine error (spawn failure, buffer overflow with a string error code, a
   * code outside that range) rejects, so the caller's overflow handling still
   * fires. Mirrors the argv-only, cwd=root discipline of `git()`.
   */
  private mergeFile(root: string, args: string[]): Promise<{ stdout: string; conflicts: number }> {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile(
        'git',
        ['merge-file', ...args],
        { cwd: root, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
        (error, stdout, stderr) => {
          if (!error) {
            resolvePromise({ stdout, conflicts: 0 })
            return
          }
          const code = (error as { code?: unknown }).code
          if (typeof code === 'number' && code >= 1 && code <= 127) {
            resolvePromise({ stdout, conflicts: code })
            return
          }
          const failure = error as GitExecError
          failure.stderr = stderr
          rejectPromise(failure)
        },
      )
    })
  }

  /**
   * Finalize an in-progress merge with a commit message — refuses (throws) while
   * any conflict remains unresolved. Uses the MERGE_HEAD git already recorded, so
   * a plain `git commit -m <message>` produces the merge commit. Returns the new
   * commit's short hash. SEC-2: the message rides `-m <message>` as one argv
   * element (mirrors commit()).
   */
  async completeMerge(rootPath: string, message: string): Promise<string> {
    const ctx = await this.repoContext(rootPath)
    if (typeof message !== 'string' || message.trim().length === 0) {
      throw new Error('[Git] completeMerge requires a non-empty message')
    }
    const state = await this.#mergeStateRepoRelative(ctx)
    if (state.unmergedPaths.length > 0) {
      throw new Error(
        `[Git] Cannot complete merge — ${state.unmergedPaths.length} unresolved conflict(s): ` +
          state.unmergedPaths.join(', '),
      )
    }
    // #986: even with the unmerged set clear, a marker-laden blob may have been
    // staged (an external `git add` on a `UU` file clears the flag) — the same
    // shared gate the review commit path uses refuses landing it in history.
    await this.#refuseConflictedCommit(ctx)
    // #1287: `--cleanup=strip`. The prepared message comes from MERGE_MSG,
    // which carries git's own `# Conflicts:` comment block. `commit -m`
    // defaults to cleanup=whitespace, so those `#` lines were committed
    // VERBATIM — native git's editor path (cleanup=strip) drops them, and
    // every Flow merge commit carried the stray comments.
    await this.git(ctx.gitCwd, ['commit', '--cleanup=strip', '-m', message])
    const hash = await this.git(ctx.gitCwd, ['rev-parse', '--short', 'HEAD'])
    return hash.trim()
  }

  /**
   * Continue an in-progress rebase after conflicts are resolved. GIT_EDITOR=true
   * makes git accept the existing commit message(s) without opening an editor
   * (which would hang a headless subprocess).
   */
  /**
   * `git rebase --continue`. Advancing a multi-commit rebase into the NEXT
   * commit's conflict exits non-zero but is a NORMAL step, not a failure (#590):
   * mirror mergeBranch/pull — a post-continue working tree with unmerged paths is
   * reported as `{ conflicted: true }` (never thrown); a genuine failure rethrows.
   */
  async continueRebase(rootPath: string): Promise<{ conflicted: boolean }> {
    const root = resolve(rootPath)
    try {
      await this.git(root, ['rebase', '--continue'], { GIT_EDITOR: 'true' })
      return { conflicted: false }
    } catch (error) {
      if ((await this.unmergedPaths(root)).length > 0) return { conflicted: true }
      throw error
    }
  }

  /** Abort an in-progress merge — `git merge --abort` (restores pre-merge HEAD). */
  async abortMerge(rootPath: string): Promise<void> {
    const root = resolve(rootPath)
    await this.git(root, ['merge', '--abort'])
  }

  /** Abort an in-progress rebase — `git rebase --abort` (restores the original branch). */
  async abortRebase(rootPath: string): Promise<void> {
    const root = resolve(rootPath)
    await this.git(root, ['rebase', '--abort'])
  }

  // ── In-app merge/pull actions (minimal) ──────────────────────────────────

  /**
   * Local branch names (excludes the current branch — not a valid merge/pull
   * target), for the "Merge branch…" picker. Fail-soft: a non-repo yields [].
   */
  async listBranches(rootPath: string): Promise<string[]> {
    const root = resolve(rootPath)
    let output: string
    try {
      output = await this.git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])
    } catch (error) {
      if (isNotARepoError(error)) return []
      throw error
    }
    const current = await this.currentBranch(root)
    return parseBranchList(output, current)
  }

  /**
   * Merge `ref` into the current branch — `git merge --no-edit <ref>` (--no-edit
   * skips the commit-message editor for a clean non-fast-forward merge, mirroring
   * `continueRebase`'s GIT_EDITOR=true guard against a hanging headless editor).
   * A merge CONFLICT is not an error here: git exits non-zero, but the failure
   * is distinguished from a real error by checking for unresolved (unmerged)
   * paths afterward — a conflict always leaves some, a genuine failure (bad ref,
   * unrelated histories, local changes would be overwritten) never does. On
   * conflict, the repo is left in the normal git conflicted-merge state (MERGE_HEAD
   * set, markers on disk) for the existing resolver to take over. SEC-2: `ref`
   * is validated before it reaches argv.
   */
  async mergeBranch(rootPath: string, ref: string): Promise<{ conflicted: boolean }> {
    const root = resolve(rootPath)
    assertValidBranchRef(ref)
    try {
      await this.git(root, ['merge', '--no-edit', ref])
      return { conflicted: false }
    } catch (error) {
      if ((await this.unmergedPaths(root)).length > 0) return { conflicted: true }
      throw error
    }
  }

  /**
   * `git pull --no-edit` for the current branch's tracked upstream. Same
   * conflict-vs-real-error distinction as mergeBranch: a conflict leaves
   * unmerged paths and is reported as `{ conflicted: true }`, never thrown; a
   * genuine failure (no upstream configured, network error, diverged with no
   * merge attempted) rethrows with git's own message.
   */
  /**
   * `git pull`, reporting WHAT MOVED (#1336). It used to answer only
   * `{ conflicted }`, so the toast said "Pulled / Up to date" byte-identically
   * whether it fast-forwarded twenty commits or did nothing at all — and
   * "Up to date" is an outright false claim about the first case.
   *
   * `received` is measured, not inferred: HEAD before vs after. Fail-soft —
   * an unreadable HEAD reports `null` (unknown) rather than guessing zero,
   * because "nothing arrived" is exactly the claim that was wrong before.
   */
  async pull(
    rootPath: string,
  ): Promise<{ conflicted: boolean; received: number | null; branch: string }> {
    const root = resolve(rootPath)
    const before = await this.headHash(root)
    const branch = await this.currentBranch(root)
    try {
      // --autostash: KEEP THE PERSON'S OWN WORK ACROSS THE PULL.
      //
      // A plain `git pull` aborts the moment a dirty tracked file is also
      // touched by the incoming commits, and the surface above this promised
      // the opposite — "You have uncommitted changes in N files. They are
      // kept." — then offered the button anyway. Worse, the files are often
      // Flow's OWN: the provisioner edits `.gitignore` and a Tailwind entry
      // stylesheet in place and never commits them, so every managed project
      // is permanently dirty and every pull on one refused, blaming the person
      // for edits they did not make.
      //
      // Autostash stashes, merges, and re-applies, so the promise is now true.
      // A re-apply that conflicts leaves unmerged paths and is reported as a
      // conflict — which is exactly what it is, and the commits really did
      // arrive.
      await this.git(root, ['pull', '--no-edit', '--autostash'])
      const after = await this.headHash(root)
      // EXIT 0 IS NOT "CLEAN". Measured on git 2.54: when the autostash
      // re-apply conflicts, git prints "Applying autostash resulted in
      // conflicts" and exits 0, leaving the file unmerged with markers on
      // disk. Trusting the exit code reported that as a clean pull — "Pulled
      // 1 commit" over a folder that needed resolving.
      const conflicted = (await this.unmergedPaths(root)).length > 0
      return { conflicted, received: await this.countBetween(root, before, after), branch }
    } catch (error) {
      if ((await this.unmergedPaths(root)).length > 0) {
        // MEASURED, EVEN HERE. This reported `null` — "how many arrived is
        // unknown" — but a conflict means the merge got far enough to clash,
        // so the commits are in. Saying nothing about them made a successful
        // pull read as a failed one.
        const after = await this.headHash(root)
        return { conflicted: true, received: await this.countBetween(root, before, after), branch }
      }
      throw error
    }
  }

  /** HEAD's hash, or null when it can't be read (unborn branch, not a repo). */
  private async headHash(root: string): Promise<string | null> {
    try {
      return (await this.git(root, ['rev-parse', 'HEAD'])).trim()
    } catch {
      return null
    }
  }

  /** How many commits `after` is ahead of `before`; null when unknowable. */
  private async countBetween(
    root: string,
    before: string | null,
    after: string | null,
  ): Promise<number | null> {
    if (before === null || after === null) return null
    if (before === after) return 0
    try {
      const out = await this.git(root, ['rev-list', '--count', `${before}..${after}`])
      const count = Number.parseInt(out.trim(), 10)
      return Number.isFinite(count) ? count : null
    } catch {
      return null
    }
  }

  /** `git branch --show-current` — empty string on any failure (fail-soft). */
  private async currentBranch(root: string): Promise<string> {
    try {
      return (await this.git(root, ['branch', '--show-current'])).trim()
    } catch {
      return ''
    }
  }

  /**
   * Paths git currently reports as unmerged (`u` records of porcelain v2). Kept
   * separate from status()'s parse so it does NOT drop flow-internal paths — the
   * completeMerge gate must see every path git still considers unresolved.
   */
  private async unmergedPaths(root: string): Promise<string[]> {
    let output: string
    try {
      // THE INDEX, NOT THE WORKING TREE. This asked `git status` — a full scan
      // of every file in the repo (measured: 130ms on 4,182 files, 160ms for
      // the whole mergeState call) to answer a question the index alone holds.
      // `ls-files -u` reads the index: 10ms, and it is the definition of
      // unmerged (any entry at stage > 0), not an inference from a status code.
      output = await this.git(root, ['ls-files', '-u', '-z'])
    } catch (error) {
      if (isNotARepoError(error)) return []
      throw error
    }
    const paths: string[] = []
    // `<mode> <sha> <stage>\t<path>` per STAGE — a conflicted file appears up
    // to three times, so the same path must not be reported three times.
    const seen = new Set<string>()
    for (const token of output.split('\0')) {
      if (!token) continue
      const tab = token.indexOf('\t')
      if (tab === -1) continue
      const filePath = token.slice(tab + 1)
      if (filePath.length === 0 || seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    }
    return paths
  }

  /**
   * `git show :<stage>:<path>` as RAW BYTES, or `null` when that stage is absent
   * (git reports `bad revision` for a missing stage, caught here). The bytes
   * variant of {@link showStage} — lets readConflicted detect binary content and
   * a genuinely-absent side (delete/modify) that an empty string cannot express.
   * A buffer overflow propagates so readConflicted maps it to `{ oversize: true }`.
   */
  private async showStageBytes(
    root: string,
    stage: number,
    filePath: string,
  ): Promise<Buffer | null> {
    try {
      return await this.gitBytes(root, ['show', `:${stage}:${toGitPath(filePath)}`, '--'])
    } catch (error) {
      if (isBufferOverflowError(error)) throw error
      if (isMissingAtRevisionError(error)) return null
      throw error
    }
  }

  /**
   * The working-tree file as UTF-8 (carries conflict markers during a merge).
   * A genuinely-missing file (delete/delete conflict) reads as empty; a file
   * larger than the exec buffer throws GitOversizeError so readConflicted can
   * answer `{ oversize: true }` instead of buffering 64MB+ into a string.
   */
  private async readWorkingTreeText(root: string, filePath: string): Promise<string> {
    const absolutePath = join(root, filePath)
    let fileStat
    try {
      fileStat = await fsPromises.stat(absolutePath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT' || code === 'ENOTDIR') return ''
      throw error
    }
    if (fileStat.size > GIT_MAX_BUFFER) throw new GitOversizeError()
    return await fsPromises.readFile(absolutePath, 'utf8')
  }

  private git(
    root: string,
    args: string[],
    envOverride?: Record<string, string>,
  ): Promise<string> {
    countGitSpawn(args)
    // SPAWNED FROM THE HOST, NOT FROM HERE.
    //
    // A V8 profile of the main process while one project was added found 93% of
    // its CPU inside posix_spawn, and git is what it was spawning: 1,145
    // processes in ten seconds. Creating a child from a process with a large
    // address space is expensive, and this is the process that draws the UI.
    //
    // The host answers ok/stdout/stderr rather than an exec error, so failures
    // are rebuilt into the shape every caller here already reads: an Error with
    // `.stderr`, and the maxBuffer message for a read that blew the budget
    // (`isBufferOverflowError` matches on it, which is why the host reports the
    // overflow instead of handing back a truncated string).
    //
    // A null answer means the host is unavailable — a build without it, a dead
    // utility process — and then this spawns in-process exactly as before.
    const hosted = runInCliHost({
      execPath: 'git',
      args,
      cwd: root,
      ...(envOverride === undefined ? {} : { env: { ...process.env, ...envOverride } }),
      captureStdout: true,
      timeoutMs: gitTimeoutFor(args),
      maxStdoutBytes: GIT_MAX_BUFFER,
    })
    if (hosted !== null) {
      return hosted.then((result) => {
        if (result.error === 'cli host exited' || result.error === 'cli host unreachable') {
          return this.gitInProcess(root, args, envOverride)
        }
        if (result.ok) return result.stdout
        const failure = new Error(
          result.error ?? result.stderr.trim() ?? 'git failed',
        ) as GitExecError
        failure.stderr = result.stderr
        throw failure
      })
    }
    return this.gitInProcess(root, args, envOverride)
  }

  /** The original in-process spawn — the fallback, and the only path when no
   *  host is configured (every unit test, and any build without the script). */
  private gitInProcess(
    root: string,
    args: string[],
    envOverride?: Record<string, string>,
  ): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      execFile(
        'git',
        args,
        {
          cwd: root,
          maxBuffer: GIT_MAX_BUFFER,
          encoding: 'utf8',
          // Default (undefined) inherits the parent env; only merge when an
          // override is supplied (e.g. GIT_EDITOR=true for `rebase --continue`).
          env: envOverride ? { ...process.env, ...envOverride } : undefined,
        },
        (error, stdout, stderr) => {
          if (error) {
            const failure = error as GitExecError
            failure.stderr = stderr
            rejectPromise(failure)
            return
          }
          resolvePromise(stdout)
        },
      )
    })
  }

  /** Like `git()` but returns raw stdout bytes (for binary-safe reads). */
  private gitBytes(root: string, args: string[]): Promise<Buffer> {
    countGitSpawn(args)
    return new Promise((resolvePromise, rejectPromise) => {
      execFile(
        'git',
        args,
        { cwd: root, maxBuffer: GIT_MAX_BUFFER, encoding: 'buffer' },
        (error, stdout, stderr) => {
          if (error) {
            const failure = error as GitExecError
            failure.stderr = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr ?? '')
            rejectPromise(failure)
            return
          }
          resolvePromise(stdout as Buffer)
        },
      )
    })
  }

  /** `git show <rev>:<path>` as raw bytes — empty buffer when path/rev absent. */
  private async showFileBytes(root: string, rev: string, filePath: string): Promise<Buffer> {
    try {
      return await this.gitBytes(root, ['show', `${rev}:${toGitPath(filePath)}`, '--'])
    } catch (error) {
      if (isMissingAtRevisionError(error)) return Buffer.alloc(0)
      throw error
    }
  }

  /** Whole-commit diff: concatenated per-file before/after snapshots. */
  private async wholeCommitDiff(root: string, commit: string): Promise<GitDiff> {
    // `--format=` suppresses the commit header, leaving only name-status
    // rows. `-m --first-parent` makes merge commits diff against their first
    // parent (plain `git show <merge>` prints NO file list at all); both
    // flags are no-ops for ordinary commits and keep this consistent with
    // the per-file path, which also compares against `<commit>^`.
    const nameStatus = await this.git(root, [
      'show',
      commit,
      '--name-status',
      '--format=',
      '-z',
      '-m',
      '--first-parent',
      '--', // no pathspec — closes option parsing after the revision
    ])

    interface CommitFile {
      beforePath: string | null
      afterPath: string | null
      displayPath: string
    }

    // Parse EVERY file first (cheap — no I/O) so we know the true total, then
    // cap the expensive per-file snapshot reads. Truncation is surfaced, never
    // silent (#121).
    const allFiles: CommitFile[] = []
    const tokens = nameStatus.split('\0')
    for (let i = 0; i < tokens.length; i += 1) {
      const status = tokens[i]
      if (!status) continue
      const kind = status[0]
      if (kind === 'R' || kind === 'C') {
        const from = tokens[i + 1]
        const to = tokens[i + 2]
        i += 2
        if (from && to) {
          allFiles.push({ beforePath: from, afterPath: to, displayPath: to })
        }
      } else {
        const path = tokens[i + 1]
        i += 1
        if (!path) continue
        if (kind === 'A') {
          allFiles.push({ beforePath: null, afterPath: path, displayPath: path })
        } else if (kind === 'D') {
          allFiles.push({ beforePath: path, afterPath: null, displayPath: path })
        } else {
          allFiles.push({ beforePath: path, afterPath: path, displayPath: path })
        }
      }
    }

    const files = allFiles.slice(0, WHOLE_COMMIT_FILE_CAP)
    const beforeParts: string[] = []
    const afterParts: string[] = []
    for (const file of files) {
      // Read RAW BYTES so a binary file (NUL byte) is detected before any lossy
      // UTF-8 decode — #98 fixed the single-file path but left this one dumping
      // binary bytes as mojibake (#246).
      const [before, after] = await Promise.all([
        file.beforePath
          ? this.showFileBytes(root, `${commit}^`, file.beforePath)
          : Promise.resolve(Buffer.alloc(0)),
        file.afterPath
          ? this.showFileBytes(root, commit, file.afterPath)
          : Promise.resolve(Buffer.alloc(0)),
      ])
      // Identical headers on both sides keep the diff aligned per file.
      const header = `───── ${file.displayPath} ─────\n`
      if (hasNulByte(before) || hasNulByte(after)) {
        // Binary: identical placeholder both sides — never decoded content (#246).
        const placeholder = `${header}[Binary file]\n`
        beforeParts.push(placeholder)
        afterParts.push(placeholder)
      } else {
        beforeParts.push(header + before.toString('utf8'))
        afterParts.push(header + after.toString('utf8'))
      }
    }

    const truncated = allFiles.length > WHOLE_COMMIT_FILE_CAP
    if (truncated) {
      // Identical notice on both sides (stays aligned, no spurious diff) so the
      // reviewer sees the commit is only partially shown.
      const hidden = allFiles.length - WHOLE_COMMIT_FILE_CAP
      const notice = `───── … ${hidden} more file(s) not shown — showing the first ${WHOLE_COMMIT_FILE_CAP} of ${allFiles.length} ─────\n`
      beforeParts.push(notice)
      afterParts.push(notice)
    }

    return {
      filePath: '',
      beforeContent: beforeParts.join('\n'),
      afterContent: afterParts.join('\n'),
      totalFiles: allFiles.length,
      truncated,
    }
  }

  /**
   * The currently-known repository roots (absolute, resolved) from the roots
   * provider. Exposed so the IPC layer can allow-list a renderer-supplied
   * `rootId` before a mutating operation trusts it as a git cwd. May throw if the
   * provider itself fails — the caller decides how to degrade.
   */
  knownRootPaths(): string[] {
    return this.roots.getRoots().map((root) => resolve(root.rootPath))
  }

  // ── .git watching ──────────────────────────────────────────────────────

  private syncRoots(): void {
    if (this.disposed) return
    const alive = new Set(this.roots.getRoots().map((root) => resolve(root.rootPath)))

    for (const rootPath of [...this.rootGitDirs.keys()]) {
      if (!alive.has(rootPath)) {
        this.stopWatching(rootPath)
      }
    }
    // #1040: a removed root's repo anchor must not survive a re-add at a
    // different repo shape — drop cached contexts for departed roots.
    for (const rootPath of [...this.repoContexts.keys()]) {
      if (!alive.has(rootPath)) {
        this.repoContexts.delete(rootPath)
      }
    }
    for (const rootPath of alive) {
      this.startWatching(rootPath)
    }
  }

  /** Anchor the watcher on the REPOSITORY's `.git` (#1040): a project root
   *  that is a subdirectory of its repo has no `.git` of its own, but its git
   *  state still changes under the repo toplevel. Async resolution is
   *  fire-and-forget; the degenerate case watches `<root>/.git` as before. */
  private startWatching(rootPath: string): void {
    if (this.rootGitDirs.has(rootPath)) return
    void this.repoContext(rootPath)
      .then((ctx) => this.startWatchingGitDir(rootPath, ctx.gitCwd))
      .catch(() => undefined)
  }

  private startWatchingGitDir(rootPath: string, gitCwd: string): void {
    if (this.disposed || this.rootGitDirs.has(rootPath)) return

    const gitDir = join(gitCwd, '.git')
    // A `.git` FILE (linked worktree/submodule) is not watched in v1 — status
    // still works via the CLI; only auto-refresh is lost for that root.
    if (!existsSync(gitDir) || !isDirectory(gitDir)) return

    // PERF: roots sharing a repo toplevel join the existing watcher instead of
    // stacking a duplicate on the same .git files — the change event fans out
    // to every mapped root below.
    const sharedRoots = this.watcherRoots.get(gitDir)
    if (sharedRoots !== undefined) {
      sharedRoots.add(rootPath)
      this.rootGitDirs.set(rootPath, gitDir)
      return
    }

    const targets = [
      join(gitDir, 'HEAD'),
      join(gitDir, 'index'),
      join(gitDir, 'packed-refs'),
      join(gitDir, 'refs'),
    ]
    const watcher = watch(targets, {
      ignoreInitial: true,
      persistent: true,
      // The index is rewritten atomically and often — a small settle window
      // avoids firing on half-written lock shuffles.
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    })
    // Fan the .git change out to EVERY root mapped to this gitDir — each root
    // keeps its own debounce timer and emits its own GitChangedEvent, so
    // consumers keyed on rootId observe exactly what they did before.
    const queue = (): void => {
      for (const mappedRoot of this.watcherRoots.get(gitDir) ?? []) {
        this.queueChange(mappedRoot)
      }
    }
    watcher.on('add', queue)
    watcher.on('change', queue)
    watcher.on('unlink', queue)
    watcher.on('error', (error) => {
      console.error(`[Git] Watcher error for ${basename(rootPath)}:`, error)
    })
    this.watchers.set(gitDir, watcher)
    this.watcherRoots.set(gitDir, new Set([rootPath]))
    this.rootGitDirs.set(rootPath, gitDir)
  }

  private stopWatching(rootPath: string): void {
    const gitDir = this.rootGitDirs.get(rootPath)
    if (gitDir === undefined) return
    this.rootGitDirs.delete(rootPath)
    const timer = this.changeTimers.get(rootPath)
    if (timer) {
      clearTimeout(timer)
      this.changeTimers.delete(rootPath)
    }
    const sharedRoots = this.watcherRoots.get(gitDir)
    sharedRoots?.delete(rootPath)
    if (sharedRoots !== undefined && sharedRoots.size > 0) return // still serving other roots
    this.watcherRoots.delete(gitDir)
    const watcher = this.watchers.get(gitDir)
    if (!watcher) return
    this.watchers.delete(gitDir)
    watcher.close().catch((error) => {
      console.error(`[Git] Failed to close watcher for ${rootPath}:`, error)
    })
  }

  /** Collapse bursts of .git file events into one debounced emission. */
  private queueChange(rootPath: string): void {
    if (this.disposed) return
    const existing = this.changeTimers.get(rootPath)
    if (existing) clearTimeout(existing)
    this.changeTimers.set(
      rootPath,
      setTimeout(() => {
        this.changeTimers.delete(rootPath)
        const event: GitChangedEvent = { rootId: rootPath }
        this.emit(GIT_CHANGED_EVENT, event)
      }, GIT_CHANGE_DEBOUNCE_MS),
    )
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LOG_LIMIT
  }
  return Math.min(Math.floor(limit), MAX_LOG_LIMIT)
}

/** Renderer input is untrusted — reject paths that escape the root. */
function ensureInsideRoot(root: string, filePath: string): string {
  const target = resolve(join(root, filePath))
  const relativeToRoot = relative(root, target)
  if (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot)) {
    throw new Error(`[Git] Path escapes the project folder: ${filePath}`)
  }
  return relativeToRoot.split('\\').join('/')
}

/** git revision paths always use forward slashes. */
function toGitPath(filePath: string): string {
  return filePath.split('\\').join('/')
}

/**
 * Normalize a renderer-supplied repo-relative path for comparison against
 * git's porcelain paths (#986): forward slashes, no trailing slash (the
 * review/git panels roll a wholly-new directory up as `dir/`).
 */
function normalizeRepoRelativePath(filePath: string): string {
  const forward = toGitPath(filePath)
  return forward.endsWith('/') ? forward.slice(0, -1) : forward
}

export async function readWorkingTreeFileBytes(root: string, filePath: string): Promise<Buffer> {
  try {
    return await fsPromises.readFile(join(root, filePath))
  } catch (error) {
    // LOG-14: only a genuinely-missing file (deleted in the working tree, or
    // a deleted parent directory) is an empty "after" side. Permission and
    // I/O errors must surface, not masquerade as an empty file.
    //
    // EISDIR: the path is a DIRECTORY (a submodule gitlink, or a directory entry
    // git reported without a trailing slash) — it has no plain-file working-tree
    // bytes, so treat it as an empty side instead of crashing the git:diff
    // handler with `EISDIR: illegal operation on a directory, read`.
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return Buffer.alloc(0)
    throw error
  }
}

/** git's binary-detection window — a NUL in the first 8 KB marks a file binary. */
const BINARY_SCAN_BYTES = 8000

/** True when `buf` contains a NUL byte within the first `BINARY_SCAN_BYTES`. */
function hasNulByte(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SCAN_BYTES).indexOf(0) !== -1
}

/**
 * Build a GitDiff from the two sides' raw bytes: if either side is binary,
 * flag it and leave the content empty (the diff view shows a "Binary file"
 * notice); otherwise decode both to UTF-8 (#98).
 */
function buildGitDiff(filePath: string, before: Buffer, after: Buffer): GitDiff {
  if (hasNulByte(before) || hasNulByte(after)) {
    return { filePath, beforeContent: '', afterContent: '', binary: true }
  }
  return {
    filePath,
    beforeContent: before.toString('utf8'),
    afterContent: after.toString('utf8'),
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isNotARepoError(error: unknown): boolean {
  const stderr = (error as GitExecError | null)?.stderr ?? ''
  return stderr.includes('not a git repository')
}

function isUnknownRevisionError(error: unknown): boolean {
  const stderr = (error as GitExecError | null)?.stderr ?? ''
  return (
    stderr.includes('unknown revision') ||
    stderr.includes('bad revision') ||
    stderr.includes('does not have any commits yet') ||
    stderr.includes('bad default revision')
  )
}

/**
 * LOG-14: expected `git show <rev>:<path>` failures that legitimately mean
 * "this side of the diff is empty" (exported for tests):
 *   · `path '…' does not exist in '<rev>'`            — file absent at rev
 *   · `path '…' exists on disk, but not in '<rev>'`   — untracked at rev
 *   · `invalid object name '<rev>'`                   — root commit's `^`,
 *     or HEAD on an unborn branch
 *   · unknown/bad revision variants                   — same class as log()
 *   · not a git repository                            — same grace as status()
 * Everything else (spawn failure, repo corruption, I/O) is a real error.
 */
export function isMissingAtRevisionError(error: unknown): boolean {
  const stderr = (error as GitExecError | null)?.stderr ?? ''
  return (
    stderr.includes('does not exist') ||
    stderr.includes('exists on disk, but not in') ||
    stderr.includes('invalid object name') ||
    isUnknownRevisionError(error) ||
    isNotARepoError(error)
  )
}

/**
 * A `git checkout HEAD -- <path>` failure meaning the path is not tracked at
 * HEAD (untracked or newly added) — the ONLY revert failure for which deleting
 * the working file is correct. git reports this as
 * `pathspec '…' did not match any file(s) known to git`.
 *
 * An UNBORN HEAD (`git init`, nothing committed — #1091) fails as
 * `fatal: invalid reference: HEAD` instead. With no commits, HEAD is the empty
 * tree, so EVERY path is by definition unknown at HEAD and the same fallback
 * (drop index entries + `git clean` the worktree copy) IS the correct revert —
 * without this the review panel's Discard/Reject can never revert anything in
 * a freshly-initialized repo.
 *
 * Every other failure (index.lock contention, permissions, corruption) must
 * NOT delete the file.
 */
export function isPathUnknownAtHeadError(error: unknown): boolean {
  const stderr = (error as GitExecError | null)?.stderr ?? ''
  return stderr.includes('did not match any file') || stderr.includes('invalid reference: HEAD')
}

/** Node's execFile code when stdout exceeds `maxBuffer`. */
const MAXBUFFER_ERROR_CODE = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

/**
 * True when a read blew the size budget — either the up-front GitOversizeError
 * (working-tree file) or execFile's own maxBuffer overflow (a git stage). Both
 * map to readConflicted's `{ oversize: true }`, never to an empty side.
 */
export function isBufferOverflowError(error: unknown): boolean {
  if (error instanceof GitOversizeError) return true
  const err = error as GitExecError | null
  if (err?.code === MAXBUFFER_ERROR_CODE) return true
  return typeof err?.message === 'string' && err.message.includes('maxBuffer length exceeded')
}

/**
 * Read a `.git` state file (MERGE_HEAD, MERGE_MSG, rebase head-name/onto),
 * trimmed. A missing file — the common "not in that state" case — is empty.
 */
async function readGitStateFile(filePath: string): Promise<string> {
  try {
    return (await fsPromises.readFile(filePath, 'utf8')).trim()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return ''
    throw error
  }
}

/** First non-empty line of a multi-line state file (MERGE_HEAD may be octopus). */
function firstLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? ''
}

/** Strip a `refs/heads/` prefix so `head-name` reads as a plain branch name. */
function shortenRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

/**
 * The incoming branch name from a prepared merge message — git writes
 * `Merge branch 'X'` / `Merge remote-tracking branch 'origin/X'` as the first
 * line of `MERGE_MSG`. Returns the quoted name, or '' when the message is empty
 * or non-standard (e.g. `Merge commit '<sha>'`, a hand-written subject).
 */
function parseIncomingBranch(mergeMsg: string): string {
  const match = /^Merge (?:remote-tracking )?branch '([^']+)'/m.exec(mergeMsg)
  return match ? match[1] : ''
}

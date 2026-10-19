// Conflict context assembler (AI merge-conflict-resolution, Phase 3) — maps
// each conflicting side's commits back to the plan/thread that produced them,
// so the resolver can explain "why this conflict happened" at the INTENT level
// (which plan phase/feature each side came from) rather than only at the diff
// level.
//
// The mapping degrades gracefully in three tiers, per side:
//   1. `plan`   — the newest commit touching the file follows execute-plan's
//                 atomic-commit convention (`feat(phase-N.task-M): … — <feature>`),
//                 so we recover the phase/task/feature that authored the change.
//   2. `commit` — the side has commits touching the file, but none map to a plan;
//                 the commit subjects are still the best available intent signal.
//   3. `diff`   — no commits recovered for that side; only the raw diff remains.
//
// Every external lookup (git log, rounds read, brain query) is injectable via
// the optional `deps` param so `assembleConflictContext` is unit-testable with
// no real repo (Phase 10), and `parsePlanFromCommit` is a pure function tested
// independently. All lookups are fail-soft: a failing sub-lookup degrades that
// one field (empty commits / null blueprint / `source: 'diff'`), never throws.
//
// No Electron import — plain-Node loadable, same discipline as git-manager.ts.

import { execFile } from 'child_process'
import { promises as fsPromises } from 'fs'
import { join, resolve } from 'path'

import type { GitMergeState } from '../../shared/ipc-contract'
import type { SideIdentity } from '../../shared/side-identity'
import { parseRoundsLine, type RelevantRoundsEntry } from '../learn/learn-run-triggers'
import { searchBrain } from '../brain/query'
import type { FileAuthor } from './git-manager'

// ── parsePlanFromCommit (pure, independently testable) ─────────────────────

/** The plan coordinates recovered from a commit subject. `task`/`feature` are
 *  null when the subject omits them (a `feat(phase-N): …` with no `.task-M`, or
 *  no trailing ` — <feature>`); `phase` is always present when this is non-null. */
export interface ParsedCommitPlan {
  phase: number | null
  task: number | null
  feature: string | null
}

/**
 * execute-plan's atomic-commit convention:
 *   `<type>(phase-N.task-M): <subject> — <feature>`
 * where `<type>` (feat/fix/…) and `.task-M` are both tolerated-optional and the
 * ` — <feature>` suffix (em-dash separated) is optional. Groups:
 *   1 = phase (digits, required)   2 = task (digits, optional)
 *   3 = subject                    4 = feature (optional)
 * The non-greedy subject lets the optional em-dash suffix peel the feature off
 * the tail. Anchored both ends so a stray "phase-N" mid-message never matches.
 */
const PLAN_COMMIT_PATTERN =
  /^[A-Za-z]*\(phase-(\d+)(?:\.task-(\d+))?\)\s*:\s*(.*?)(?:\s+—\s+(.+?))?\s*$/

/**
 * Parse a commit subject into its plan coordinates, or `null` when the subject
 * does not follow the `(phase-N[.task-M]): …` shape. Pure and deterministic.
 */
export function parsePlanFromCommit(message: string): ParsedCommitPlan | null {
  if (typeof message !== 'string') return null
  const match = PLAN_COMMIT_PATTERN.exec(message.trim())
  if (!match) return null

  const phase = Number.parseInt(match[1], 10)
  if (!Number.isFinite(phase)) return null
  const task = match[2] !== undefined ? Number.parseInt(match[2], 10) : null
  const feature = match[4] !== undefined && match[4].length > 0 ? match[4].trim() : null

  return {
    phase,
    task: task !== null && Number.isFinite(task) ? task : null,
    feature,
  }
}

// ── assembleConflictContext ────────────────────────────────────────────────

/** One commit touching a conflicted file on a given side. `author`/`email`/`when`
 *  are additive (populated by the enriched log format); older callers/doubles
 *  that emit only `hash`+`subject` stay valid. */
export interface CommitRef {
  hash: string
  subject: string
  /** Commit author display name (`%an`), when captured. */
  author?: string
  /** Commit author email (`%ae`), when captured — drives `isCurrentUser`. */
  email?: string
  /** ISO-8601 author date (`%aI`), when captured. */
  when?: string
}

/** Where a conflicting side's change came from — the recovered intent, plus the
 *  evidence tier (`source`) it was recovered at. `plan` is populated only when
 *  the newest commit maps to the execute-plan convention. */
export interface SideIntent {
  /** The ref this side's commits were collected from (e.g. `HEAD`, a MERGE_HEAD hash). */
  ref: string
  /** Commits on this side touching the file, newest first; empty when none recovered. */
  commits: CommitRef[]
  /** Plan coordinates from the newest commit, or null when it doesn't map. */
  plan: ParsedCommitPlan | null
  /** Evidence tier the intent was recovered at (plan > commit > diff). */
  source: 'plan' | 'commit' | 'diff'
}

/** The assembled intent context for one conflicted file: both sides plus a
 *  best-effort blueprint/feature note for the file. */
export interface ConflictFileContext {
  /** Root-relative path of the conflicted file. */
  file: string
  /** Our side — git stage 2 (HEAD). The intent commits recovered for it. */
  ours: SideIntent
  /** Their side — git stage 3 (the incoming/replayed change). Its intent commits. */
  theirs: SideIntent
  /** Best-effort blueprint/feature context for the file, or null. */
  blueprint: string | null
  /** Concrete identity of the `ours` side, derived from the operation (never the
   *  hardcoded "ours" label). Undefined only when identity could not be built. */
  oursIdentity?: SideIdentity
  /** Concrete identity of the `theirs` side — carries the merge↔rebase inversion. */
  theirsIdentity?: SideIdentity
}

/**
 * Injectable external-call seams. Every method is fail-soft in its default
 * implementation and MUST stay so in test doubles — `assembleConflictContext`
 * relies on degradation, not exceptions. Defaults hit the real repo / brain.
 */
export interface ConflictContextDeps {
  /**
   * Commits reachable from `includeRef` but NOT from `excludeRef` that touch
   * `file`, newest first (`git log <includeRef> [--not <excludeRef>] -- <file>`).
   * `excludeRef: null` omits the `--not` exclusion. Returns [] on any failure.
   */
  logSideCommits(
    rootPath: string,
    includeRef: string,
    excludeRef: string | null,
    file: string,
  ): Promise<CommitRef[]>
  /** Act-on-able rounds entries (via `parseRoundsLine`); [] when absent/unreadable. */
  readRoundsEntries(rootPath: string): Promise<RelevantRoundsEntry[]>
  /** Brain retrieval of blueprint/feature context for `file`; null on miss/failure. */
  queryBlueprint(rootPath: string, file: string): Promise<string | null>
  /**
   * The repo's configured commit identity — used to flag a side's author as the
   * current user. Optional: falls back to a git-backed, fail-soft default.
   * Wire to `GitManager.currentUser` in production.
   */
  currentUser?(rootPath: string): Promise<{ name?: string; email?: string }>
  /**
   * Last committed author per file (HEAD side) — the `ours` fallback when no
   * side commits were recovered. Optional: falls back to a git-backed, fail-soft
   * default. Wire to `GitManager.fileAuthors` in production.
   */
  fileAuthors?(rootPath: string, filePaths: string[]): Promise<Map<string, FileAuthor>>
}

/** Field separator inside the `git log` format — unit separator, never in text. */
const LOG_FIELD_SEP = '\x1f'
/** hash · subject · author name · author email · ISO author date. */
const LOG_COMMIT_FORMAT = `%H${LOG_FIELD_SEP}%s${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%ae${LOG_FIELD_SEP}%aI`
/** `git log -1` author format for the `ours`-side fallback (matches git-manager). */
const FILE_AUTHOR_FORMAT = `%H${LOG_FIELD_SEP}%an${LOG_FIELD_SEP}%ae${LOG_FIELD_SEP}%aI`
/** git can emit large logs — be generous before failing. */
const GIT_MAX_BUFFER = 16 * 1024 * 1024
/** Only the single best brain hit backs the blueprint note. */
const BLUEPRINT_HIT_LIMIT = 1
const ROUNDS_FILE = '.rounds.jsonl'

/**
 * Refs handed to `git log` here originate from git itself (`HEAD`, `MERGE_HEAD`,
 * or a MERGE_HEAD hash) — never renderer input — but we still gate them to safe
 * forms so nothing parses as a git option, mirroring git-manager's SEC-2 stance.
 */
const SAFE_REF_PATTERN = /^(?:[0-9a-fA-F]{4,40}|HEAD|MERGE_HEAD|CHERRY_PICK_HEAD)$/

function isSafeRef(ref: string): boolean {
  return SAFE_REF_PATTERN.test(ref)
}

/** Run git in `root`, resolving stdout; rejects with stderr attached. Mirrors
 *  git-manager's private `git()` helper (argv-only, no shell, cwd = root). */
function runGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      'git',
      args,
      { cwd: root, maxBuffer: GIT_MAX_BUFFER, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as Error & { stderr?: string }
          failure.stderr = stderr
          rejectPromise(failure)
          return
        }
        resolvePromise(stdout)
      },
    )
  })
}

/** Parse the enriched `git log` format into CommitRefs (newest first). Extra
 *  author fields are optional — a torn/short line still yields hash+subject. */
function parseSideCommits(output: string): CommitRef[] {
  const commits: CommitRef[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    const [hash, subject = '', author, email, when] = line.split(LOG_FIELD_SEP)
    if (!hash) continue
    commits.push({
      hash,
      subject,
      author: author || undefined,
      email: email || undefined,
      when: when || undefined,
    })
  }
  return commits
}

/** Real-repo default for `logSideCommits` — fail-soft to [] on any git error. */
async function defaultLogSideCommits(
  rootPath: string,
  includeRef: string,
  excludeRef: string | null,
  file: string,
): Promise<CommitRef[]> {
  if (!includeRef || !isSafeRef(includeRef)) return []
  if (excludeRef !== null && !isSafeRef(excludeRef)) return []
  const args = ['log', `--format=${LOG_COMMIT_FORMAT}`, includeRef]
  if (excludeRef !== null) {
    args.push('--not', excludeRef)
  }
  // `--` closes option parsing; the file pathspec cannot be read as a flag.
  args.push('--', file)
  try {
    return parseSideCommits(await runGit(resolve(rootPath), args))
  } catch {
    // Not a repo, unknown ref (rebase/none has no MERGE_HEAD), path unknown at
    // ref — all legitimately mean "no commits recovered for this side".
    return []
  }
}

/** Real default for `readRoundsEntries` — reuses `parseRoundsLine`, never a
 *  second parser. Missing/unreadable file or torn lines fail soft to []. */
async function defaultReadRoundsEntries(rootPath: string): Promise<RelevantRoundsEntry[]> {
  const roundsPath = join(resolve(rootPath), 'flow', ROUNDS_FILE)
  let raw: string
  try {
    raw = await fsPromises.readFile(roundsPath, 'utf8')
  } catch {
    return []
  }
  const entries: RelevantRoundsEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const entry = parseRoundsLine(trimmed)
    if (entry) entries.push(entry)
  }
  return entries
}

/** Real default for `queryBlueprint` — top brain hit's title+snippet, or null. */
async function defaultQueryBlueprint(rootPath: string, file: string): Promise<string | null> {
  try {
    const result = await searchBrain(rootPath, file, BLUEPRINT_HIT_LIMIT)
    const hit = result.hits[0]
    if (!hit) return null
    const snippet = hit.snippet?.trim()
    return snippet ? `${hit.title}: ${snippet}` : hit.title
  } catch {
    return null
  }
}

/** Real-repo default for `currentUser` — `git config user.name/email`, fail-soft. */
async function defaultCurrentUser(rootPath: string): Promise<{ name?: string; email?: string }> {
  const read = async (key: string): Promise<string | undefined> => {
    try {
      const value = (await runGit(resolve(rootPath), ['config', '--get', key])).trim()
      return value.length > 0 ? value : undefined
    } catch {
      return undefined // unset key exits non-zero; a non-repo errors — both "unknown"
    }
  }
  const [name, email] = await Promise.all([read('user.name'), read('user.email')])
  return { name, email }
}

/** Real-repo default for `fileAuthors` — last HEAD author per file, fail-soft to
 *  an empty map. Mirrors `GitManager.fileAuthors`' shape so the production wiring
 *  can hand that method straight through. */
async function defaultFileAuthors(
  rootPath: string,
  filePaths: string[],
): Promise<Map<string, FileAuthor>> {
  const root = resolve(rootPath)
  const result = new Map<string, FileAuthor>()
  await Promise.all(
    filePaths.map(async (file) => {
      let output: string
      try {
        output = await runGit(root, ['log', '-1', `--format=${FILE_AUTHOR_FORMAT}`, '--', file])
      } catch {
        return // non-repo / unknown path — omit, never throw
      }
      const [hash, author, email, date] = output.trim().split(LOG_FIELD_SEP)
      if (!hash || date === undefined) return
      result.set(file, {
        author: author ?? '',
        email: email && email.length > 0 ? email : undefined,
        hash,
        date,
      })
    }),
  )
  return result
}

/**
 * The real-repo default seams. Exported so production wiring (git-manager's
 * readConflicted identity population) can spread these and override only the
 * `currentUser`/`fileAuthors` seams with live GitManager methods, keeping the
 * remaining lookups (git log, rounds, brain) on their fail-soft defaults.
 */
export function defaultConflictContextDeps(): ConflictContextDeps {
  return {
    logSideCommits: defaultLogSideCommits,
    readRoundsEntries: defaultReadRoundsEntries,
    queryBlueprint: defaultQueryBlueprint,
    currentUser: defaultCurrentUser,
    fileAuthors: defaultFileAuthors,
  }
}

function defaultDeps(): ConflictContextDeps {
  return defaultConflictContextDeps()
}

/**
 * Classify one side from its recovered commits: `plan` when the newest commit
 * maps to the execute-plan convention (spec: parse the NEWEST commit), else
 * `commit` when any commit was recovered, else `diff`.
 */
function classifySide(ref: string, commits: CommitRef[]): SideIntent {
  const newest = commits[0]
  const plan = newest ? parsePlanFromCommit(newest.subject) : null
  const source: SideIntent['source'] = plan ? 'plan' : commits.length > 0 ? 'commit' : 'diff'
  return { ref, commits, plan, source }
}

/**
 * The run_id of the most recent `phase_result` whose module anchors cover
 * `file` (anchor is a path prefix of the file) — the "which thread produced
 * this" cross-reference, read from the same rounds entries via `parseRoundsLine`.
 * Used only as a blueprint fallback when brain has nothing for the file.
 */
function runTouchingFile(entries: readonly RelevantRoundsEntry[], file: string): string | null {
  const normalized = file.replace(/^\.\//, '')
  let match: string | null = null
  for (const entry of entries) {
    if (entry.type !== 'phase_result') continue
    for (const anchor of entry.moduleAnchors) {
      const anchorPath = anchor.replace(/^\.\//, '').replace(/\/+$/, '')
      if (normalized === anchorPath || normalized.startsWith(`${anchorPath}/`)) {
        // Last writer wins — rounds are append-only, so later entries are newer.
        match = entry.run_id
      }
    }
  }
  return match
}

/**
 * Assemble the intent context for every unmerged path in `mergeState`. For a
 * merge, `ours` = commits on HEAD not on MERGE_HEAD touching the file, `theirs`
 * = the reverse; for rebase/none (no MERGE_HEAD) the theirs side degrades to
 * empty commits (`source: 'diff'`) and ours is a best-effort HEAD log.
 *
 * Fail-soft throughout: any sub-lookup failure degrades that one field, never
 * throws. External calls are injectable via `deps` for unit testing.
 */
export async function assembleConflictContext(
  rootPath: string,
  mergeState: GitMergeState,
  deps: ConflictContextDeps = defaultDeps(),
): Promise<ConflictFileContext[]> {
  const paths = mergeState.unmergedPaths ?? []
  if (paths.length === 0) return []

  // Rounds are read once for the whole assembly (they cover the run, not a file).
  let roundsEntries: RelevantRoundsEntry[]
  try {
    roundsEntries = await deps.readRoundsEntries(rootPath)
  } catch {
    roundsEntries = []
  }

  // Derive the ours/theirs ref mapping from the ACTUAL operation, not a
  // hardcoded assumption — the mapping inverts on rebase (see planSideRefs).
  const plan = planSideRefs(mergeState)
  // The ref string surfaced on each SideIntent/identity for display when the
  // concrete side ref is absent (e.g. a non-merge with no incoming ref).
  const theirsIntentRef = plan.theirsRef ?? mergeState.incomingRef ?? 'incoming'

  // Author identity is repo-wide (currentUser) and per-file (HEAD authors);
  // gather each once, fail-soft, before the per-file loop.
  const currentUser = await safeCurrentUser(deps, rootPath)
  const headAuthors = await safeFileAuthors(deps, rootPath, paths)

  const contexts: ConflictFileContext[] = []
  for (const file of paths) {
    const [oursCommits, theirsCommits] = await Promise.all([
      safeLog(deps, rootPath, plan.oursRef, plan.oursExclude, file),
      plan.theirsRef
        ? safeLog(deps, rootPath, plan.theirsRef, plan.theirsExclude, file)
        : Promise.resolve<CommitRef[]>([]),
    ])

    const ours = classifySide(plan.oursRef, oursCommits)
    const theirs = classifySide(theirsIntentRef, theirsCommits)

    let blueprint: string | null = null
    try {
      blueprint = await deps.queryBlueprint(rootPath, file)
    } catch {
      blueprint = null
    }
    if (!blueprint) {
      const runId = runTouchingFile(roundsEntries, file)
      if (runId) blueprint = `Touched by plan run ${runId}`
    }

    // `ours` maps to git stage 2 (HEAD): its last committed author is the
    // fallback when no side commits were recovered. `theirs` has no HEAD-side
    // fallback — its author comes only from the recovered incoming commit.
    const oursIdentity = buildSideIdentity(
      'ours',
      plan.oursRef,
      plan.oursBranch,
      oursCommits,
      currentUser,
      headAuthors.get(file),
    )
    const theirsIdentity = buildSideIdentity(
      'theirs',
      theirsIntentRef,
      plan.theirsBranch,
      theirsCommits,
      currentUser,
      undefined,
    )

    contexts.push({ file, ours, theirs, blueprint, oursIdentity, theirsIdentity })
  }

  return contexts
}

/** The concrete ref mapping for a side, derived per operation. */
interface SideRefPlan {
  /** `ours` = git stage 2 (HEAD) for every operation. */
  oursRef: string
  /** Commits reachable from `oursRef` are excluded by this ref (null = no exclusion). */
  oursExclude: string | null
  /** Human branch label for the ours side, when the operation names one. */
  oursBranch?: string
  /** `theirs` ref, or null when the operation exposes no incoming ref (side degrades to diff). */
  theirsRef: string | null
  theirsExclude: string | null
  /** Human branch label for the theirs side, when the operation names one. */
  theirsBranch?: string
}

/** Strip a leading `refs/heads/` so a raw onto ref reads as a plain branch label
 *  (mirrors git-manager's `shortenRef`); non-branch refs pass through unchanged. */
function shortenOntoRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '')
}

/**
 * Map the two conflict sides to concrete refs from the in-progress operation.
 *
 * `ours` is git stage 2 — always HEAD. The INVERSION lives in what `theirs`
 * points at and what each side MEANS:
 *   - merge:       theirs = MERGE_HEAD (the incoming branch).
 *   - cherry-pick: theirs = CHERRY_PICK_HEAD (the picked commit).
 *   - rebase:      INVERTED — HEAD sits on the `onto` base (ours), while the
 *                  branch being replayed (`rebaseHead`/head-name) is theirs.
 *   - none/stash:  best-effort ours = HEAD, no theirs ref (side degrades to diff).
 */
function planSideRefs(mergeState: GitMergeState): SideRefPlan {
  switch (mergeState.op) {
    case 'merge':
      if (mergeState.mergeHead) {
        return {
          oursRef: 'HEAD',
          oursExclude: 'MERGE_HEAD',
          theirsRef: 'MERGE_HEAD',
          theirsExclude: 'HEAD',
          theirsBranch: mergeState.incomingBranch,
        }
      }
      break
    case 'cherry-pick':
      if (mergeState.cherryPickHead) {
        return {
          oursRef: 'HEAD',
          oursExclude: 'CHERRY_PICK_HEAD',
          theirsRef: 'CHERRY_PICK_HEAD',
          theirsExclude: 'HEAD',
        }
      }
      break
    case 'rebase': {
      const replayed = mergeState.rebaseHead ?? null // orig-head — the theirs side
      const onto = mergeState.incomingRef ?? null // onto base — the ours side
      return {
        oursRef: 'HEAD', // HEAD is detached on the onto base during replay
        oursExclude: replayed,
        // The onto base IS the ours side during a rebase — surface its shortened
        // ref as the ours branch label (fail-soft: no label when onto is absent).
        ...(onto ? { oursBranch: shortenOntoRef(onto) } : {}),
        theirsRef: replayed,
        theirsExclude: onto,
        theirsBranch: mergeState.ontoBranch, // head-name = the branch being replayed
      }
    }
    default:
      break
  }
  // none, stash, or a merge/cherry-pick missing its head file: best-effort ours.
  return { oursRef: 'HEAD', oursExclude: null, theirsRef: null, theirsExclude: null }
}

/** Build a side's concrete identity from its newest commit, with an optional
 *  HEAD-author fallback (ours side only). `isCurrentUser` compares the resolved
 *  author against the repo's configured identity. */
function buildSideIdentity(
  kind: 'ours' | 'theirs',
  ref: string,
  branch: string | undefined,
  commits: CommitRef[],
  currentUser: { name?: string; email?: string },
  fallback: FileAuthor | undefined,
): SideIdentity {
  const newest = commits[0]
  const author = newest?.author ?? fallback?.author
  const email = newest?.email ?? fallback?.email
  const hash = newest?.hash ?? fallback?.hash
  const when = newest?.when ?? fallback?.date
  return {
    kind,
    ref,
    branch: branch || undefined,
    hash: hash || undefined,
    subject: newest?.subject || undefined,
    author: author || undefined,
    when: when || undefined,
    isCurrentUser: matchesCurrentUser(author, email, currentUser),
  }
}

/** True when a side's author matches the repo's configured user — email first
 *  (authoritative), then display name. Absent identity on either part → false. */
function matchesCurrentUser(
  author: string | undefined,
  email: string | undefined,
  currentUser: { name?: string; email?: string },
): boolean {
  const cuEmail = currentUser.email?.trim().toLowerCase()
  if (cuEmail && email && email.trim().toLowerCase() === cuEmail) return true
  const cuName = currentUser.name?.trim().toLowerCase()
  if (cuName && author && author.trim().toLowerCase() === cuName) return true
  return false
}

/** `currentUser` dep (or default) guarded so a throwing lookup degrades to {}. */
async function safeCurrentUser(
  deps: ConflictContextDeps,
  rootPath: string,
): Promise<{ name?: string; email?: string }> {
  try {
    return await (deps.currentUser ?? defaultCurrentUser)(rootPath)
  } catch {
    return {}
  }
}

/** `fileAuthors` dep (or default) guarded so a throwing lookup degrades to empty. */
async function safeFileAuthors(
  deps: ConflictContextDeps,
  rootPath: string,
  filePaths: string[],
): Promise<Map<string, FileAuthor>> {
  try {
    return await (deps.fileAuthors ?? defaultFileAuthors)(rootPath, filePaths)
  } catch {
    return new Map()
  }
}

/** `logSideCommits` guarded so a throwing test double still degrades to []. */
async function safeLog(
  deps: ConflictContextDeps,
  rootPath: string,
  includeRef: string,
  excludeRef: string | null,
  file: string,
): Promise<CommitRef[]> {
  try {
    return await deps.logSideCommits(rootPath, includeRef, excludeRef, file)
  } catch {
    return []
  }
}

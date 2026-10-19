// Agent-clash detection (conflict-UX Phase 6) — reconstructs plan-flow
// PARALLEL-AGENT file clashes as ordinary 3-way conflicts so they flow through
// the exact same per-hunk resolver git conflicts use. When two wave phases each
// commit an edit to the SAME file (per-task commit mode), there is no git merge
// to surface the clash; this module finds the two phase/task commits that
// touched the file plus their common base, and Task 2 (`synthesizeClashConflict`)
// turns that triple into marker text the existing `conflict-hunks` parser reads.
//
// Attribution is REUSED, never re-implemented (allowed-pattern #14): candidate
// files come from `phase-map.ts` (a file claimed by >1 phase in
// flow/.wave-context.jsonl), and each side's plan coordinates come from the SAME
// `parsePlanFromCommit` the conflict-context assembler uses. The sides are
// grounded in real commits — the phase-map only nominates candidates.
//
// Gated on commit availability + fail-soft by contract: when per-task commits
// are absent (commit mode off), attribution is missing, or fewer than two phase
// commits touch a file, the file yields NO clash rather than a fabricated one.
// Every git seam is injectable so detection unit-tests against temp-repo
// fixtures with no mocking. No Electron import — plain-Node loadable, same
// discipline as git-manager.ts / conflict-context.ts.

import { execFile } from 'child_process'
import { resolve } from 'path'

import type { AgentClashInfo, AgentClashSide } from '../../shared/ipc-contract'
import { readPhaseMap, type FileToPhases } from '../review/phase-map'
import { parsePlanFromCommit, type CommitRef } from './conflict-context'

/** A file is a clash candidate only when this many distinct phases claim/commit it. */
const MIN_CLASH_SIDES = 2

/** git can print large logs — be generous before failing (mirrors conflict-context). */
const GIT_MAX_BUFFER = 16 * 1024 * 1024
/** Field separator inside the `git log` format — unit separator, never in text. */
const LOG_FIELD_SEP = '\x1f'
/** hash · subject — the minimal per-commit shape clash reconstruction needs. */
const LOG_COMMIT_FORMAT = `%H${LOG_FIELD_SEP}%s`

/**
 * Injectable git/attribution seams. Every method is fail-soft in its default
 * implementation and MUST stay so in test doubles — detection relies on
 * degradation (empty results), not exceptions. Defaults hit the real repo.
 */
export interface AgentClashDeps {
  /** File→phases attribution from flow/.wave-context.jsonl. Empty when absent. */
  readPhaseMap(rootPath: string): Promise<FileToPhases>
  /** Commits touching `file`, newest first (`git log -- <file>`). [] on any error. */
  logFileCommits(rootPath: string, file: string): Promise<CommitRef[]>
  /** `git merge-base <a> <b>` — the common ancestor, or null on unrelated/error. */
  mergeBase(rootPath: string, a: string, b: string): Promise<string | null>
  /**
   * Resolve `rev` to a full commit hash (`git rev-parse --verify <rev>`), or null
   * when it cannot be resolved — the ROOT-COMMIT edge (a `<hash>^` with no parent)
   * and any error both yield null. Powers the M3 parents-based base derivation.
   */
  resolveRev(rootPath: string, rev: string): Promise<string | null>
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

/** Parse the `hash \x1f subject` log format into CommitRefs (newest first). */
function parseFileCommits(output: string): CommitRef[] {
  const commits: CommitRef[] = []
  for (const line of output.split('\n')) {
    if (!line) continue
    const sep = line.indexOf(LOG_FIELD_SEP)
    if (sep === -1) continue
    const hash = line.slice(0, sep)
    if (!hash) continue
    commits.push({ hash, subject: line.slice(sep + 1) })
  }
  return commits
}

/** Real-repo default for `logFileCommits` — fail-soft to [] on any git error. */
async function defaultLogFileCommits(rootPath: string, file: string): Promise<CommitRef[]> {
  if (typeof file !== 'string' || file.length === 0) return []
  try {
    // `--` closes option parsing so the pathspec cannot be read as a flag.
    const out = await runGit(resolve(rootPath), [
      'log',
      `--format=${LOG_COMMIT_FORMAT}`,
      '--',
      file,
    ])
    return parseFileCommits(out)
  } catch {
    return [] // non-repo, no commits, unknown path — all "no commits recovered"
  }
}

/** Only 4-40 hex chars parse as a commit for merge-base (never renderer input). */
const SAFE_HASH_PATTERN = /^[0-9a-fA-F]{4,40}$/

/**
 * A rev safe to hand to `git rev-parse`: a bare hex hash, optionally with a
 * SINGLE trailing `^` (the first parent). Nothing else — no `~N`, no `..`, no
 * leading `-` — so a `<hash>^` cannot smuggle an option into argv. The resolved
 * output is still re-validated as a bare hash before it reaches merge-base.
 */
const SAFE_REV_PATTERN = /^[0-9a-fA-F]{4,40}\^?$/

/** Real-repo default for `mergeBase` — the common ancestor, null on error. */
async function defaultMergeBase(
  rootPath: string,
  a: string,
  b: string,
): Promise<string | null> {
  if (!SAFE_HASH_PATTERN.test(a) || !SAFE_HASH_PATTERN.test(b)) return null
  try {
    const out = (await runGit(resolve(rootPath), ['merge-base', a, b])).trim()
    return out.length > 0 ? out : null
  } catch {
    return null // unrelated histories / unknown ref — no common base
  }
}

/**
 * Real-repo default for `resolveRev` — `git rev-parse --verify <rev>` to a full
 * hash, null on the root-commit `^` edge or any error. The INPUT rev is guarded
 * by SAFE_REV_PATTERN (hex hash + optional single `^`) and the OUTPUT is
 * re-validated as a bare hash before any caller feeds it to merge-base.
 */
async function defaultResolveRev(rootPath: string, rev: string): Promise<string | null> {
  if (!SAFE_REV_PATTERN.test(rev)) return null
  try {
    const out = (await runGit(resolve(rootPath), ['rev-parse', '--verify', rev])).trim()
    return SAFE_HASH_PATTERN.test(out) ? out : null
  } catch {
    return null // root commit (no parent), unknown rev, non-repo — no resolvable hash
  }
}

/** The real-repo default seams. Exported so production wiring can spread + override. */
export function defaultAgentClashDeps(): AgentClashDeps {
  return {
    readPhaseMap,
    logFileCommits: defaultLogFileCommits,
    mergeBase: defaultMergeBase,
    resolveRev: defaultResolveRev,
  }
}

/**
 * Build the clash for ONE file from the commits touching it. Groups the file's
 * commits by the plan phase that authored them (via the shared
 * `parsePlanFromCommit`), keeps the NEWEST commit per phase (commits arrive
 * newest-first), and — when at least two distinct phases committed — reconstructs
 * a two-sided clash plus the phases' merge-base. Returns null when fewer than two
 * phase commits exist (commit mode off / sequential run): the fail-soft gate.
 *
 * For >2 phases the two lowest-numbered phases become sides A/B and the rest are
 * recorded in `extraPhases` + a `note` (and logged) — pairwise-first-two with a
 * logged note, per the phase spec.
 */
export async function buildClashForFile(
  rootPath: string,
  file: string,
  deps: AgentClashDeps = defaultAgentClashDeps(),
): Promise<AgentClashInfo | null> {
  let commits: CommitRef[]
  try {
    commits = await deps.logFileCommits(rootPath, file)
  } catch {
    return null
  }
  // Newest commit per phase — the version that phase left in the file.
  const byPhase = new Map<number, AgentClashSide>()
  for (const commit of commits) {
    const plan = parsePlanFromCommit(commit.subject)
    if (!plan) continue
    // `parsePlanFromCommit` types phase as `number | null` (task/feature can be
    // absent); a null phase carries no side to attribute, so skip it rather than
    // non-null-asserting — the Map key and `AgentClashSide.phase` are both `number`.
    if (plan.phase === null) continue
    if (byPhase.has(plan.phase)) continue // commits are newest-first → first wins
    byPhase.set(plan.phase, {
      phase: plan.phase,
      task: plan.task,
      feature: plan.feature,
      commit: commit.hash,
      subject: commit.subject,
    })
  }
  if (byPhase.size < MIN_CLASH_SIDES) return null // gate: needs ≥2 committed phase sides

  // Deterministic ordering: lowest phase number is side A.
  const sides = [...byPhase.values()].sort((a, b) => a.phase - b.phase)
  const [sideA, sideB, ...rest] = sides
  // M3: derive the clash base from the PARENTS of each side, not the sides
  // themselves. In the real per-task-commit workflow the phases commit
  // sequentially on ONE branch, so side B descends from side A and
  // merge-base(A, B) collapses to A itself — the 3-way then has ours == base and
  // `git merge-file` yields a clean take-theirs with ZERO markers, silently
  // opening an empty resolver. merge-base(A^, B^) restores a common ancestor that
  // PRECEDES each side's edit, so genuine divergence surfaces as conflict hunks.
  // Root-commit edge (a side whose `^` has no parent): fall back to the plain
  // merge-base — today's behavior — rather than erroring. Parents are resolved to
  // full hashes and re-validated inside `resolveRev`/`mergeBase` before argv.
  let base: string | null = null
  try {
    const [parentA, parentB] = await Promise.all([
      deps.resolveRev(rootPath, `${sideA.commit}^`),
      deps.resolveRev(rootPath, `${sideB.commit}^`),
    ])
    base =
      parentA !== null && parentB !== null
        ? await deps.mergeBase(rootPath, parentA, parentB)
        : await deps.mergeBase(rootPath, sideA.commit, sideB.commit)
  } catch {
    base = null
  }

  const clash: AgentClashInfo = { filePath: file, base, sideA, sideB }
  if (rest.length > 0) {
    const extraPhases = rest.map((side) => side.phase)
    clash.extraPhases = extraPhases
    clash.note =
      `File touched by ${sides.length} phases; reconstructing the first two ` +
      `(phase-${sideA.phase}, phase-${sideB.phase}). ` +
      `Ignored: ${extraPhases.map((phase) => `phase-${phase}`).join(', ')}.`
    // Surfaced so a >2-phase clash is never silently narrowed to a pair.
    console.warn(`[AgentClash] ${clash.note} (${file})`)
  }
  return clash
}

/**
 * Detect every same-file agent clash in the project. Candidates are files the
 * phase-map attributes to more than one phase; each is confirmed (and its sides
 * reconstructed) from real per-task commits. Fail-soft throughout: missing
 * attribution or commits yields an empty list, never throws.
 */
export async function detectAgentClashes(
  rootPath: string,
  deps: AgentClashDeps = defaultAgentClashDeps(),
): Promise<AgentClashInfo[]> {
  let phaseMap: FileToPhases
  try {
    phaseMap = await deps.readPhaseMap(rootPath)
  } catch {
    return [] // no attribution → nothing to reconcile
  }
  const candidates: string[] = []
  for (const [file, phases] of phaseMap) {
    if (phases.size >= MIN_CLASH_SIDES) candidates.push(file)
  }
  const clashes: AgentClashInfo[] = []
  for (const file of candidates) {
    const clash = await buildClashForFile(rootPath, file, deps)
    if (clash) clashes.push(clash)
  }
  return clashes
}

/**
 * Reconstruct the clash for a SINGLE known-clashed file (the open path). Unlike
 * {@link detectAgentClashes} this does NOT require live phase-map attribution —
 * the commits themselves gate it (≥2 phase commits touching the file) — so a
 * clash stays openable after flow/.wave-context.jsonl is cleaned up. Returns
 * null (fail-soft) when the file is not a reconstructable clash.
 */
export async function detectClashForPath(
  rootPath: string,
  file: string,
  deps: AgentClashDeps = defaultAgentClashDeps(),
): Promise<AgentClashInfo | null> {
  return buildClashForFile(rootPath, file, deps)
}

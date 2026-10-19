// ReviewService — lists a project's uncommitted changes grouped by the plan
// phase that produced them, for the phase-grouped review & commit panel.
//
// Change source is GIT (working-tree status), so it captures every on-disk
// edit regardless of which thread/sub-agent made it. Phase attribution comes
// from PhaseMap (flow/.wave-context.jsonl files_modified). A file with no phase
// falls into the "Other changes" group; a file claimed by several phases
// appears under each (a plan-flow file conflict). The per-root phase snapshot
// is accumulated so grouping survives wave-context.jsonl being deleted.

import type { GitFileChange, GitStatus } from '../../shared/ipc-contract'
import type { ReviewFile, ReviewGroup, ReviewListResult } from '../../shared/review-types'
import {
  mergePhaseMap,
  normalizeRel,
  readPhaseMap,
  readRoundsPhaseMap,
  readPlanPhaseMap,
  type FileToPhases,
  type PhaseMeta,
} from './phase-map'

/** Minimal git surface the service needs (a structural slice of GitManager). */
export interface ReviewGit {
  status(rootPath: string): Promise<GitStatus | null>
  revertFile(rootPath: string, filePath: string): Promise<void>
}

/**
 * Group key → panel label. A plan-scoped key `<feature>#phase-2` renders as
 * "Phase 2 · <feature>" so two different plans' Phase 2 are distinguishable
 * (#144); a bare `phase-2` (wave-context, no plan) stays "Phase 2"; anything
 * unexpected passes through unchanged.
 */
export function phaseLabel(phase: string): string {
  const scoped = /^(.+)#phase-(\d+)$/.exec(phase)
  if (scoped) return `Phase ${scoped[2]} · ${scoped[1]}`
  const bare = /^phase-(\d+)$/.exec(phase)
  return bare ? `Phase ${bare[1]}` : phase
}

/**
 * Drop a bare `phase-N` from a file's attribution set when a plan-scoped
 * `<feature>#phase-N` for the SAME phase number is also present. The scoped key
 * carries the plan's title/feature; keeping the bare duplicate would split one
 * change into two identical-numbered groups during an active run (wave-context
 * emits bare ids, the plan emits scoped ones) — #144.
 */
export function dedupeBarePhases(phases: Set<string>): Set<string> {
  const scopedNumbers = new Set<string>()
  for (const phase of phases) {
    const match = /#(phase-\d+)$/.exec(phase)
    if (match) scopedNumbers.add(match[1])
  }
  if (scopedNumbers.size === 0) return phases
  const result = new Set<string>()
  for (const phase of phases) {
    if (/^phase-\d+$/.test(phase) && scopedNumbers.has(phase)) continue
    result.add(phase)
  }
  return result
}

export class ReviewService {
  /** Accumulated file→phases snapshot per project root (survives cleanup). */
  private readonly snapshots = new Map<string, FileToPhases>()

  constructor(private readonly git: ReviewGit) {}

  /** Reject a file — revert its working-tree changes back to HEAD. */
  reject(projectRoot: string, filePath: string): Promise<void> {
    return this.git.revertFile(projectRoot, filePath)
  }

  /** Group the project's current working-tree changes by phase. */
  async list(projectRoot: string): Promise<ReviewListResult> {
    // THREE attribution sources, in the order they became necessary:
    //
    //   1. the ephemeral wave-context, accumulated into a snapshot so it
    //      survives its own cleanup — wave runs only;
    //   2. the plan's `Files:` lines, durable but only present when the plan
    //      actually declared them, which real plans mostly do not;
    //   3. the EXECUTION RECORD (flow/.rounds.jsonl + its archived per-plan
    //      copies), which says what each phase really touched.
    //
    // The third is what makes phase-by-phase commit work on a finished plan at
    // all: with only the first two, a sequential run of a plan without `Files:`
    // sections attributed nothing, and every change landed in "Other changes"
    // — which read as "the phases feature is broken" and effectively was.
    const snapshot = mergePhaseMap(
      this.snapshots.get(projectRoot) ?? new Map<string, Set<string>>(),
      await readPhaseMap(projectRoot),
    )
    this.snapshots.set(projectRoot, snapshot)
    const plan = await readPlanPhaseMap(projectRoot)
    const record = await readRoundsPhaseMap(projectRoot)

    const status = await this.git.status(projectRoot)
    // #1332: `null` here means NOT A REPOSITORY (GitManager.status returns null
    // only for that error; everything else throws). Folding it into an empty
    // change list is what let the panel claim a clean tree for a folder git
    // cannot read at all.
    const gitState: 'ok' | 'no-repo' = status === null ? 'no-repo' : 'ok'
    const changes = status?.changes ?? []

    // Prune snapshot entries whose file is no longer a live change (committed or
    // reverted). The accumulated snapshot is union-only, so without this a phase
    // attribution outlives the change it described — an unrelated re-edit of the
    // same file in the same session would inherit the old phase group + a
    // misleading suggested commit message (#250). Attribution lasts only while
    // the change is uncommitted.
    const changedPaths = new Set(changes.map((change) => normalizeRel(change.filePath)))
    for (const file of [...snapshot.keys()]) {
      if (!changedPaths.has(file)) snapshot.delete(file)
    }

    const byPhase = new Map<string | null, ReviewFile[]>()
    for (const change of changes) {
      const key = normalizeRel(change.filePath)
      const phases = new Set<string>()
      for (const phase of snapshot.get(key) ?? []) phases.add(phase)
      for (const phase of plan.exact.get(key) ?? []) phases.add(phase)
      for (const phase of record.exact.get(key) ?? []) phases.add(phase)
      for (const pattern of plan.patterns) if (pattern.test(key)) phases.add(pattern.phase)
      const deduped = dedupeBarePhases(phases)
      const targets: Array<string | null> = deduped.size > 0 ? [...deduped] : [null]
      for (const phase of targets) {
        const list = byPhase.get(phase) ?? []
        list.push(toReviewFile(change))
        byPhase.set(phase, list)
      }
    }

    const groups: ReviewGroup[] = []
    const phaseIds = [...byPhase.keys()]
      .filter((key): key is string => key !== null)
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    for (const phase of phaseIds) {
      const files = byPhase.get(phase) ?? []
      groups.push({
        phase,
        label: phaseLabel(phase),
        files,
        // The plan's own heading wins the title; the execution record answers
        // for a phase the plan never described (or never declared files for).
        suggestedMessage: suggestCommitMessage(
          phase,
          files,
          plan.meta.get(phase) ?? record.meta.get(phase),
        ),
      })
    }
    const other = byPhase.get(null)
    if (other && other.length > 0) {
      groups.push({
        phase: null,
        label: 'Other changes',
        files: other,
        suggestedMessage: suggestCommitMessage(null, other, undefined),
      })
    }
    return { groups, gitState }
  }
}

/**
 * Project a git status change into the review panel's file shape. A file that
 * is staged AND still carries worktree edits (porcelain `MM`-class — the index
 * holds the content the user approved, the disk holds newer content they never
 * saw) is flagged `unreviewedSinceApproval` (#1052), so the panel can downgrade
 * the ✓ instead of rendering stale approval as reviewed. Conflicted entries
 * report `staged: false` (both sub-states null), so they never flag; statuses
 * from sources that omit the sub-states (no `worktreeState`) never flag either.
 */
export function toReviewFile(change: GitFileChange): ReviewFile {
  const diverged = change.staged && (change.worktreeState ?? null) !== null
  return {
    filePath: change.filePath,
    state: change.state,
    staged: change.staged,
    // #1182: a rename is TWO paths. Carrying the old one lets the commit
    // pathspec cover both (recording the rename intact instead of half of it)
    // and lets approve/un-approve move the pair together.
    ...(change.renamedFrom !== undefined ? { renamedFrom: change.renamedFrom } : {}),
    ...(diverged ? { unreviewedSinceApproval: true } : {}),
  }
}

/**
 * Build a conventional-commit message for a group from the plan's phase title +
 * feature slug: `<type>(<scope>): <description>`. Editable in the UI.
 */
export function suggestCommitMessage(
  phase: string | null,
  files: ReviewFile[],
  meta: PhaseMeta | undefined,
): string {
  // "Other changes" has no plan phase — a neutral chore message the user edits.
  if (phase === null) {
    const type = inferCommitType('', files)
    return `${type}: update files`
  }
  const type = inferCommitType(meta?.title ?? '', files)
  const scope = meta?.feature ? `(${meta.feature})` : ''
  const description = normalizeDescription(meta?.title, type)
  return `${type}${scope}: ${description}`
}

function inferCommitType(title: string, files: ReviewFile[]): string {
  const lc = title.toLowerCase()
  const paths = files.map((f) => f.filePath.toLowerCase())
  if (/\btests?\b/.test(lc) || (paths.length > 0 && paths.every((p) => /\.(test|spec)\./.test(p)))) {
    return 'test'
  }
  if (paths.length > 0 && paths.every((p) => p.endsWith('.md'))) return 'docs'
  if (/\bfix|bug|patch\b/.test(lc)) return 'fix'
  if (/\brefactor|cleanup|rename\b/.test(lc)) return 'refactor'
  return 'feat'
}

/** Lowercase the phase title into a description; add a verb for bare titles. */
function normalizeDescription(title: string | undefined, type: string): string {
  const clean = (title ?? '').trim().toLowerCase()
  if (clean.length === 0) return type === 'test' ? 'add tests' : 'apply changes'
  if (type === 'test' && /^tests?$/.test(clean)) return 'add tests'
  return clean
}

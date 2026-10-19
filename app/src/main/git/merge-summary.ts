// Merge-resolution summary writer (AI merge-conflict-resolution, Phase 8).
//
// After a merge's conflicts are resolved, this renders a DETERMINISTIC summary
// of the resolution set into two artifacts:
//   1. a `flow/merges/merge_<branch>_<stamp>.md` markdown doc (human record), and
//   2. a condensed `commitBody` folded into the merge commit message.
//
// `buildMergeSummary` is PURE — the same `MergeSummaryInput` always renders the
// byte-identical `{ doc, commitBody }`. It NEVER reads a clock or randomness:
// the doc carries no timestamp (the only clock, the filename stamp, is passed
// into `writeMergeSummaryDoc` from the caller, never read here). This keeps the
// summary fully unit-testable and reproducible from the recorded resolution set.
//
// No Electron import — plain-Node loadable, same discipline as git-manager.ts /
// merge-verify.ts, so it unit-tests without the app harness.

import { promises as fsPromises } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

import type { MergeSummaryConflict, MergeSummaryInput } from '../../shared/ipc-contract'

// The canonical shapes live in the shared IPC contract (the wire boundary the
// renderer builds against); re-export them so this module's public API — the
// task's declared exports — reads from one source of truth, never a drifting
// duplicate.
export type { MergeSummaryConflict, MergeSummaryInput, MergeSummaryVerify } from '../../shared/ipc-contract'

/** The two rendered artifacts: the full markdown doc + the condensed commit body. */
export interface MergeSummary {
  doc: string
  commitBody: string
}

/** Directory under a root's `flow/` that merge summaries are written into. */
export const MERGE_SUMMARY_DIR = join('flow', 'merges')
/** Placeholder rendered for an empty/unknown text field — keeps output stable. */
const EMPTY_PLACEHOLDER = '—'
/** Max per-file lines embedded in the (condensed) commit body. */
const MAX_COMMIT_BODY_FILES = 20
/** Percent scale for confidence (0..1 → 0..100). */
const CONFIDENCE_SCALE = 100
/** Any char outside this set is replaced by `-` when sanitizing the branch for a filename. */
const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]+/g
/** Collapsed leading/trailing dashes after sanitizing. */
const EDGE_DASHES = /^-+|-+$/g
/** Fallback filename branch token when a branch sanitizes to nothing. */
const DEFAULT_BRANCH_TOKEN = 'merge'

/** Trim a value to a display string, or the stable placeholder when empty. */
function display(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? trimmed : EMPTY_PLACEHOLDER
}

/** A backtick-wrapped inline code span, or the bare placeholder when empty. */
function code(value: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed.length > 0 ? `\`${trimmed}\`` : EMPTY_PLACEHOLDER
}

/**
 * Overall risk, worst-first: `risky` if anything is risky, else `unassessed` if
 * anything went unexamined (or there is nothing recorded at all), else `safe`.
 *
 * #1287: this used to collapse to `safe` for both of the honest-unknown cases,
 * so a manually-resolved merge — and even a merge with NO recorded resolutions
 * — asserted `risk: safe` in the summary doc and in the commit trailer that
 * lands in history forever. `safe` is a claim; it now requires that something
 * actually assessed every resolution.
 */
function overallRisk(
  conflicts: readonly MergeSummaryConflict[],
): 'safe' | 'risky' | 'unassessed' {
  if (conflicts.some((conflict) => conflict.finalRisk === 'risky')) return 'risky'
  if (conflicts.length === 0) return 'unassessed'
  if (conflicts.some((conflict) => conflict.finalRisk !== 'safe')) return 'unassessed'
  return 'safe'
}

/** Confidence as a whole-percent string (deterministic rounding). */
function confidencePercent(confidence: number): string {
  const value = Number.isFinite(confidence) ? confidence : 0
  const clamped = value < 0 ? 0 : value > 1 ? 1 : value
  return `${Math.round(clamped * CONFIDENCE_SCALE)}%`
}

/** One human-readable line describing the verification outcome. */
function describeVerify(verify: MergeSummaryInput['verify']): string {
  if (!verify) return 'not run'
  const ran = verify.ran.length > 0 ? verify.ran.join(', ') : 'no checks'
  if (verify.ok) return `passed (ran: ${ran})`
  const at = verify.firstFailure ? verify.firstFailure : 'unknown'
  return `failed at ${at} (ran: ${ran})`
}

/**
 * Render the full markdown doc + the condensed commit body from a resolution
 * set. PURE and DETERMINISTIC — output is a function of `input` alone (no clock,
 * no randomness), so the same recorded set always produces byte-identical text.
 */
export function buildMergeSummary(input: MergeSummaryInput): MergeSummary {
  const conflicts = input.conflicts ?? []
  const risk = overallRisk(conflicts)
  const verifyLine = describeVerify(input.verify)

  const docLines: string[] = [
    '# Merge Resolution Summary',
    '',
    `**Branch:** ${code(input.branch)}`,
    `**Merging from:** ${code(input.ontoBranch)}`,
    `**Conflicts resolved:** ${conflicts.length}`,
    `**Overall risk:** ${risk}`,
    `**Verification:** ${verifyLine}`,
    '',
    '## Conflicts',
    '',
  ]

  if (conflicts.length === 0) {
    docLines.push('_No recorded conflict resolutions._', '')
  } else {
    conflicts.forEach((conflict, index) => {
      docLines.push(
        `### ${index + 1}. ${code(conflict.file)}`,
        '',
        `- **Our intent:** ${display(conflict.oursIntent)}`,
        `- **Their intent:** ${display(conflict.theirsIntent)}`,
        `- **Choice:** ${display(conflict.choice)}`,
        `- **Risk:** ${conflict.finalRisk} · **Confidence:** ${confidencePercent(conflict.confidence)}`,
        `- **Why:** ${display(conflict.why)}`,
        `- **How:** ${display(conflict.how)}`,
        '',
      )
    })
  }

  const commitLines: string[] = [
    `Merge resolution: ${conflicts.length} conflict(s) resolved, risk: ${risk}.`,
    `Verification: ${verifyLine}.`,
  ]
  conflicts.slice(0, MAX_COMMIT_BODY_FILES).forEach((conflict) => {
    const choice = conflict.choice.trim() || EMPTY_PLACEHOLDER
    commitLines.push(`- ${conflict.file}: ${choice} (${conflict.finalRisk})`)
  })
  if (conflicts.length > MAX_COMMIT_BODY_FILES) {
    commitLines.push(`- … and ${conflicts.length - MAX_COMMIT_BODY_FILES} more`)
  }

  return { doc: docLines.join('\n'), commitBody: commitLines.join('\n') }
}

/** Injectable filesystem seam for `writeMergeSummaryDoc` (tests never touch disk). */
export interface WriteMergeSummaryDeps {
  mkdir?: (dirPath: string) => Promise<void>
  writeFile?: (filePath: string, data: string) => Promise<void>
}

const defaultWriteDeps: Required<WriteMergeSummaryDeps> = {
  mkdir: (dirPath) => fsPromises.mkdir(dirPath, { recursive: true }).then(() => undefined),
  writeFile: (filePath, data) => fsPromises.writeFile(filePath, data, 'utf8'),
}

/** Sanitize a branch name into a safe filename token (never empty). */
export function sanitizeBranchForFilename(branch: string): string {
  const cleaned = (typeof branch === 'string' ? branch : '')
    .replace(UNSAFE_FILENAME_CHARS, '-')
    .replace(EDGE_DASHES, '')
  return cleaned.length > 0 ? cleaned : DEFAULT_BRANCH_TOKEN
}

/** True when `target` resolves to `root` or a path lexically nested inside it. */
function isInside(root: string, target: string): boolean {
  const rel = relative(resolve(root), target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Write the rendered `doc` to `flow/merges/merge_<sanitized-branch>_<stamp>.md`
 * under `rootPath` (mkdir -p the dir first), returning the absolute path. The
 * `stamp` is supplied by the caller — this function reads NO clock. The target
 * is asserted to stay lexically inside `rootPath` (the `flow/` symlink is inside
 * the root lexically, mirroring path-containment's stance), so a hostile branch
 * name can never escape the project. fs is injectable for tests.
 */
export async function writeMergeSummaryDoc(
  rootPath: string,
  branch: string,
  stamp: string,
  doc: string,
  deps: WriteMergeSummaryDeps = {},
): Promise<string> {
  const mkdir = deps.mkdir ?? defaultWriteDeps.mkdir
  const writeFile = deps.writeFile ?? defaultWriteDeps.writeFile

  const root = resolve(rootPath)
  const dir = join(root, MERGE_SUMMARY_DIR)
  const fileName = `merge_${sanitizeBranchForFilename(branch)}_${stamp}.md`
  const filePath = join(dir, fileName)

  if (!isInside(root, filePath)) {
    // Defense in depth: sanitize already strips separators, but never write a
    // path that escaped the root — fail loudly rather than corrupt a sibling.
    throw new Error(`merge summary path escapes root: ${filePath}`)
  }

  await mkdir(dir)
  await writeFile(filePath, doc)
  return filePath
}

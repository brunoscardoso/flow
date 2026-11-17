// The Problems list — pure, DOM-free rules shared by the two sides that need
// them.
//
// MAIN owns the diagnostic state: it keeps the latest publishDiagnostics per
// file (main/lsp/index.ts) and answers `editor:problems` with a BOUNDED
// snapshot built by `problemsSnapshot` (allowed-pattern #18 — the renderer
// cannot un-send a thousand warnings). The RENDERER draws that snapshot and
// turns a press of "Fix with agent" into one message with `fixMessage`.
//
// Hints are not problems. TypeScript publishes "unused" and "could be
// converted" suggestions at hint level; the editor fades them in place, and a
// list of them would bury the errors a person came here for.

import type { Diagnostic, DiagnosticSeverity, DiagnosticsEvent } from './ipc-contract'

/** Severities the Problems list shows, most important first. */
export const PROBLEM_SEVERITIES = ['error', 'warning', 'info'] as const
export type ProblemSeverity = (typeof PROBLEM_SEVERITIES)[number]

/** The most problems one snapshot carries when the caller names no limit. */
export const DEFAULT_PROBLEMS_LIMIT = 500

/** The most problems one agent message lists. */
export const MAX_PROBLEMS_PER_MESSAGE = 40

export interface ProblemCounts {
  errors: number
  warnings: number
  infos: number
  /** errors + warnings + infos. */
  total: number
}

export interface Problem {
  severity: ProblemSeverity
  message: string
  source?: string
  code?: string
  /** One-based, for people and for the editor's reveal. */
  line: number
  /** One-based. */
  column: number
}

export interface ProblemFile {
  /** Absolute project root. */
  rootId: string
  /** Root-relative path, '/' separators. */
  filePath: string
  /** Every problem this file has — even the ones the bound left out. */
  counts: ProblemCounts
  /** The problems sent, most important first. May be fewer than counts.total. */
  problems: Problem[]
}

export interface ProblemsSnapshot {
  files: ProblemFile[]
  counts: ProblemCounts
  /** Problems counted but not sent (the bound). Withheld is not "none". */
  withheld: number
}

const RANK: Record<ProblemSeverity, number> = { error: 0, warning: 1, info: 2 }

export function isProblemSeverity(severity: DiagnosticSeverity): severity is ProblemSeverity {
  return severity === 'error' || severity === 'warning' || severity === 'info'
}

export function emptyCounts(): ProblemCounts {
  return { errors: 0, warnings: 0, infos: 0, total: 0 }
}

function addTo(counts: ProblemCounts, severity: ProblemSeverity): void {
  if (severity === 'error') counts.errors += 1
  else if (severity === 'warning') counts.warnings += 1
  else counts.infos += 1
  counts.total += 1
}

function toProblem(diagnostic: Diagnostic & { severity: ProblemSeverity }): Problem {
  return {
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.source ? { source: diagnostic.source } : {}),
    ...(diagnostic.code ? { code: diagnostic.code } : {}),
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
  }
}

function compareProblems(a: Problem, b: Problem): number {
  return RANK[a.severity] - RANK[b.severity] || a.line - b.line || a.column - b.column
}

/** Worst severity first, then by project and path — a file with errors leads. */
function compareFiles(a: ProblemFile, b: ProblemFile): number {
  const worst = (file: ProblemFile): number =>
    file.counts.errors > 0 ? 0 : file.counts.warnings > 0 ? 1 : 2
  return (
    worst(a) - worst(b) ||
    a.rootId.localeCompare(b.rootId) ||
    a.filePath.localeCompare(b.filePath)
  )
}

/**
 * The snapshot main sends: files ordered worst-first, problems inside a file
 * ordered by severity then position, at most `limit` problems in all.
 *
 * The bound is filled BY SEVERITY ACROSS FILES, not file by file: one file
 * with a thousand warnings must not push another file's errors out. Counts are
 * always the full counts, so the view can say how many it was not sent.
 */
export function problemsSnapshot(
  events: Iterable<DiagnosticsEvent>,
  limit: number = DEFAULT_PROBLEMS_LIMIT,
): ProblemsSnapshot {
  const counts = emptyCounts()
  const files: ProblemFile[] = []
  const all: Problem[][] = []
  for (const event of events) {
    const fileCounts = emptyCounts()
    const problems: Problem[] = []
    for (const diagnostic of event.diagnostics) {
      if (!isProblemSeverity(diagnostic.severity)) continue
      const problem = toProblem(diagnostic as Diagnostic & { severity: ProblemSeverity })
      addTo(fileCounts, problem.severity)
      addTo(counts, problem.severity)
      problems.push(problem)
    }
    if (problems.length === 0) continue
    problems.sort(compareProblems)
    files.push({ rootId: event.rootId, filePath: event.filePath, counts: fileCounts, problems: [] })
    all.push(problems)
  }

  // Order files first, carrying each file's sorted problems alongside.
  const order = files.map((_, index) => index).sort((a, b) => compareFiles(files[a]!, files[b]!))
  const orderedFiles = order.map((index) => files[index]!)
  const orderedProblems = order.map((index) => all[index]!)

  // Fill the bound one severity at a time, across every file.
  const room = Math.max(0, Math.floor(limit))
  let sent = 0
  for (const severity of PROBLEM_SEVERITIES) {
    for (let index = 0; index < orderedFiles.length && sent < room; index += 1) {
      for (const problem of orderedProblems[index]!) {
        if (sent >= room) break
        if (problem.severity !== severity) continue
        orderedFiles[index]!.problems.push(problem)
        sent += 1
      }
    }
  }
  // Problems were appended severity by severity, which is already each
  // file's own order (sorted by severity first).
  return { files: orderedFiles, counts, withheld: counts.total - sent }
}

// ── Presentation (renderer) ────────────────────────────────────────────────

/** The tab's label: "Problems" alone when there are none, else with the count. */
export function problemsTabLabel(counts: ProblemCounts): string {
  return counts.total > 0 ? `Problems ${counts.total}` : 'Problems'
}

/** File name and its folder, split for a group header. */
export function fileLabel(filePath: string): { name: string; folder: string } {
  const slash = filePath.lastIndexOf('/')
  return slash < 0
    ? { name: filePath, folder: '' }
    : { name: filePath.slice(slash + 1), folder: filePath.slice(0, slash) }
}

/** "ts 2322", "eslint", "2322", or '' — the row's source/code chip. */
export function sourceLabel(problem: Pick<Problem, 'source' | 'code'>): string {
  return [problem.source, problem.code].filter((part) => part !== undefined && part !== '').join(' ')
}

/** A short count line for a file group or the panel: "2 errors, 1 warning". */
export function countSummary(counts: ProblemCounts): string {
  const parts: string[] = []
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
  if (counts.errors > 0) parts.push(plural(counts.errors, 'error'))
  if (counts.warnings > 0) parts.push(plural(counts.warnings, 'warning'))
  if (counts.infos > 0) parts.push(plural(counts.infos, 'info message'))
  return parts.join(', ')
}

/** Shown when the list is empty — in the terms a person sees, not the server's. */
export const NO_PROBLEMS_TEXT =
  'No problems in open files. Problems appear here for the files you have open in the editor.'

/** Why Fix with agent cannot act, or null when it can. */
export function fixDisabledReason(threadId: string | null): string | null {
  return threadId === null ? 'Open a conversation first. The agent in it fixes the problems.' : null
}

/** One problem the agent is asked to fix, with the file it is in. */
export interface ProblemRef {
  rootId: string
  filePath: string
  problem: Problem
}

/** Every problem the snapshot carries, as refs, in the snapshot's order. */
export function refsOf(files: readonly ProblemFile[]): ProblemRef[] {
  return files.flatMap((file) =>
    file.problems.map((problem) => ({ rootId: file.rootId, filePath: file.filePath, problem })),
  )
}

/** The path the agent reads: root-relative in its own project, absolute outside it. */
export function pathForAgent(rootId: string, filePath: string, threadRoot: string | null): string {
  if (threadRoot !== null && trimSlash(threadRoot) === trimSlash(rootId)) return filePath
  return `${trimSlash(rootId)}/${filePath}`
}

function trimSlash(path: string): string {
  return path.endsWith('/') ? path.slice(0, -1) : path
}

/** A diagnostic message on one line: TypeScript chains its explanations over several. */
function oneLine(message: string): string {
  return message.replace(/\s*\n\s*/g, ' ').trim()
}

/**
 * The ONE message a press of Fix with agent sends. Plain steps for the agent:
 * what to fix, where (path:line:column), and what the editor said.
 *
 * `notSent` counts problems that exist but are not in `refs` (the snapshot's
 * bound); together with the message's own cap they are named, never dropped
 * silently, so the agent knows the list is not the whole picture.
 */
export function fixMessage(
  refs: readonly ProblemRef[],
  threadRoot: string | null,
  notSent = 0,
): string | null {
  if (refs.length === 0) return null
  const listed = refs.slice(0, MAX_PROBLEMS_PER_MESSAGE)
  const more = refs.length - listed.length + Math.max(0, notSent)
  const total = refs.length + Math.max(0, notSent)
  const head =
    total === 1
      ? 'Fix this problem. The editor reports it in a file that is open.'
      : `Fix these ${total} problems. The editor reports them in files that are open.`
  const lines = listed.map(({ rootId, filePath, problem }) => {
    const where = `${pathForAgent(rootId, filePath, threadRoot)}:${problem.line}:${problem.column}`
    const chip = sourceLabel(problem)
    return `- ${where} — ${problem.severity}: ${oneLine(problem.message)}${chip ? ` (${chip})` : ''}`
  })
  if (more > 0) lines.push(`- ${more} more ${more === 1 ? 'problem is' : 'problems are'} not listed here.`)
  return [head, '', ...lines, '', 'Change only what fixes these problems. Then check that they are gone.'].join('\n')
}

// The Problems list's Terminals section — pure, DOM-free presentation rules:
// filters, the row's meta line, the group heading, the counter tooltip, what
// Copy puts on the clipboard and what Fix with agent sends. The panel
// (problems-panel.ts) only draws what these return.

import type { ProblemCounts, ProblemFile } from '../../shared/problems-model'
import type {
  TerminalProblem,
  TerminalProblemCounts,
  TerminalProblemGroup,
} from '../../shared/terminal-problems'

/** Every fixed string the Terminals section shows. Scanned by a test (#12). */
export const TERMINAL_PROBLEMS_STRINGS = {
  filterAll: 'All',
  filterTerminals: 'Terminals',
  filterFiles: 'Files',
  filterErrors: 'Errors',
  filterWarnings: 'Warnings',
  sectionTerminals: 'Terminals',
  sectionFiles: 'Files',
  launchpad: 'Launchpad',
  copy: 'Copy',
  copyAll: 'Copy all',
  copyAllTitle: 'Copy every problem shown, with what was printed before it',
  copied: 'Copied.',
  copyFailed: 'Could not copy to the clipboard.',
  clearTerminals: 'Clear terminal problems',
  clearTerminalsTitle: 'Empty the Terminals section. The terminals keep running.',
  showInTerminal: 'Show in terminal',
  fixWithAgent: 'Fix with agent',
  fixTitle: 'Send this problem to the agent in this conversation',
  toggleTitle: 'Problems in open files and terminals',
  noTerminalProblems: 'No errors or warnings from terminals. Flow reads what every open terminal prints.',
  noFileProblems: 'No problems in open files. Problems appear here for the files you have open in the editor.',
  noProblems:
    'No problems. Errors and warnings from open files and from every open terminal appear here.',
  filteredOut: 'Nothing matches these filters.',
} as const

export type ProblemsSource = 'all' | 'terminals' | 'files'

export interface ProblemsFilter {
  source: ProblemsSource
  errors: boolean
  warnings: boolean
}

export const DEFAULT_PROBLEMS_FILTER: ProblemsFilter = { source: 'all', errors: true, warnings: true }

export function showsTerminals(filter: ProblemsFilter): boolean {
  return filter.source !== 'files'
}

export function showsFiles(filter: ProblemsFilter): boolean {
  return filter.source !== 'terminals'
}

/** Terminal groups with only the severities the toggles allow; empty groups go. */
export function filterTerminalGroups(groups: readonly TerminalProblemGroup[], filter: ProblemsFilter): TerminalProblemGroup[] {
  if (!showsTerminals(filter)) return []
  return groups
    .map((group) => ({
      ...group,
      problems: group.problems.filter((problem) => (problem.severity === 'error' ? filter.errors : filter.warnings)),
    }))
    .filter((group) => group.problems.length > 0)
}

/** File groups the same way. Info messages go with warnings. */
export function filterFiles(files: readonly ProblemFile[], filter: ProblemsFilter): ProblemFile[] {
  if (!showsFiles(filter)) return []
  if (filter.errors && filter.warnings) return [...files]
  return files
    .map((file) => ({
      ...file,
      problems: file.problems.filter((problem) => (problem.severity === 'error' ? filter.errors : filter.warnings)),
    }))
    .filter((file) => file.problems.length > 0)
}

/** `20:55:14`, in this computer's time. */
export function clockTime(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** The line under a row's message: the logger and the last time, or the first and last times. */
export function problemMetaLine(problem: Pick<TerminalProblem, 'meta' | 'count' | 'firstSeen' | 'lastSeen'>): string {
  const last = `last ${clockTime(problem.lastSeen)}`
  if (problem.meta !== null && problem.meta !== '') return `${problem.meta} · ${last}`
  if (problem.count > 1) return `First ${clockTime(problem.firstSeen)} · ${last}`
  return last
}

/** The ×N pill. */
export function timesLabel(count: number): string {
  return `×${count}`
}

/** A group's heading: its label, then "project · Launchpad". */
export function groupHeading(group: Pick<TerminalProblemGroup, 'label' | 'projectName' | 'launchpad'>): {
  label: string
  detail: string
} {
  return {
    label: group.label,
    detail: group.launchpad ? `${group.projectName} · ${TERMINAL_PROBLEMS_STRINGS.launchpad}` : group.projectName,
  }
}

function seenText(problem: Pick<TerminalProblem, 'count' | 'firstSeen' | 'lastSeen'>): string {
  if (problem.count === 1) return `seen once, at ${clockTime(problem.lastSeen)}`
  return `seen ${problem.count} times, ${clockTime(problem.firstSeen)} to ${clockTime(problem.lastSeen)}`
}

/**
 * What Copy puts on the clipboard:
 *   core-dev (jupiter-core) — seen 14 times, 20:55:14 to 20:56:06
 *   ConnectionRefusedError: [Errno 61] Connection refused
 *
 *     File ".../asyncpg/connect_utils.py", line 969, in …
 */
export function problemCopyText(
  group: Pick<TerminalProblemGroup, 'label' | 'projectName'>,
  problem: Pick<TerminalProblem, 'message' | 'count' | 'firstSeen' | 'lastSeen' | 'context'>,
): string {
  const head = `${group.label} (${group.projectName}) — ${seenText(problem)}`
  const lines = [head, problem.message]
  if (problem.context.length > 0) lines.push('', ...problem.context)
  return lines.join('\n')
}

/** Copy all: every problem shown, in the order shown, a blank line between. */
export function copyAllText(groups: readonly TerminalProblemGroup[]): string {
  return groups.flatMap((group) => group.problems.map((problem) => problemCopyText(group, problem))).join('\n\n')
}

/** The open row's context block: what came before, then the problem line itself. */
export function contextBlock(problem: Pick<TerminalProblem, 'context' | 'line' | 'message'>): {
  before: string[]
  line: string
} {
  return { before: [...problem.context], line: problem.line !== '' ? problem.line : problem.message }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

/** The counters: editor problems plus terminal problems. */
export function combinedCounts(files: ProblemCounts, terminals: TerminalProblemCounts): { errors: number; warnings: number } {
  return { errors: files.errors + terminals.errors, warnings: files.warnings + terminals.warnings }
}

/** Where the counts come from: "3 errors: 1 in files, 2 from terminals. No warnings." */
export function countsTooltip(files: ProblemCounts, terminals: TerminalProblemCounts): string {
  const part = (word: string, inFiles: number, fromTerminals: number): string => {
    const total = inFiles + fromTerminals
    if (total === 0) return `No ${word}s.`
    const where: string[] = []
    if (inFiles > 0) where.push(`${inFiles} in files`)
    if (fromTerminals > 0) where.push(`${fromTerminals} from terminals`)
    return `${plural(total, word)}: ${where.join(', ')}.`
  }
  return `${part('error', files.errors, terminals.errors)} ${part('warning', files.warnings, terminals.warnings)}`
}

/** What the toggle says to a screen reader. */
export function combinedToggleLabel(files: ProblemCounts, terminals: TerminalProblemCounts): string {
  const counts = combinedCounts(files, terminals)
  return `Problems: ${plural(counts.errors, 'error')}, ${plural(counts.warnings, 'warning')}`
}

/** The empty state, in the terms of what the filters show. */
export function emptyText(filter: ProblemsFilter, anyFiles: boolean, anyTerminals: boolean): string {
  if ((filter.source === 'all' && (anyFiles || anyTerminals)) || (filter.source === 'files' && anyFiles) || (filter.source === 'terminals' && anyTerminals)) {
    return TERMINAL_PROBLEMS_STRINGS.filteredOut
  }
  if (filter.source === 'terminals') return TERMINAL_PROBLEMS_STRINGS.noTerminalProblems
  if (filter.source === 'files') return TERMINAL_PROBLEMS_STRINGS.noFileProblems
  return TERMINAL_PROBLEMS_STRINGS.noProblems
}

/** The ONE message Fix with agent sends for a terminal problem. */
export function terminalFixMessage(
  group: Pick<TerminalProblemGroup, 'label' | 'projectName' | 'launchpad'>,
  problem: Pick<TerminalProblem, 'severity' | 'message' | 'meta' | 'count' | 'firstSeen' | 'lastSeen' | 'context' | 'line'>,
): string {
  const word = problem.severity === 'error' ? 'error' : 'warning'
  const where = group.launchpad
    ? `the Launchpad step "${group.label}" in ${group.projectName}`
    : `the terminal "${group.label}" in ${group.projectName}`
  const lines = [
    `Fix this ${word}. It was printed by ${where}, ${seenText(problem)}.`,
    '',
    `${word === 'error' ? 'Error' : 'Warning'}: ${problem.message}`,
  ]
  if (problem.meta !== null && problem.meta !== '') lines.push(`From: ${problem.meta}`)
  const block = contextBlock(problem)
  lines.push('', 'What the terminal printed, ending with the problem line:', '', ...block.before.map((line) => `    ${line}`), `    ${block.line}`)
  lines.push('', 'Find the cause and change only what fixes it. Then check that it is no longer printed.')
  return lines.join('\n')
}

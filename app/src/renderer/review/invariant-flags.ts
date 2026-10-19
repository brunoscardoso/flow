// Per-file invariant flags (#898 FR10) — the pure rollup the Phases list and
// the board share to summarize advisory checker verdicts for one file.
// DOM-free so it runs under the CJS node jest.

import type { InvariantVerdict } from '../../shared/ipc-contract'

export interface InvariantFlag {
  /** Number of violates/touches findings for the file. */
  count: number
  /** Worst verdict — `violates` outranks `touches`. */
  worst: 'violates' | 'touches'
  /** Tooltip text: one line per finding. */
  title: string
}

/**
 * Roll advisory verdicts up per file. `clear` verdicts never flag; a file with
 * any `violates` reads as worst `violates`. Advisory only — callers must never
 * gate approval on a flag.
 */
export function invariantFlagsByFile(
  verdicts: readonly InvariantVerdict[],
): Map<string, InvariantFlag> {
  const flags = new Map<string, InvariantFlag>()
  for (const verdict of verdicts) {
    if (verdict.verdict === 'clear' || verdict.filePath === '') continue
    const line = `${verdict.verdict}: ${verdict.invariant}`
    const existing = flags.get(verdict.filePath)
    if (existing === undefined) {
      flags.set(verdict.filePath, {
        count: 1,
        worst: verdict.verdict,
        title: line,
      })
    } else {
      existing.count += 1
      if (verdict.verdict === 'violates') existing.worst = 'violates'
      existing.title += `\n${line}`
    }
  }
  return flags
}

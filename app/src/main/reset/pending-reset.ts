/**
 * A RESET IS CARRIED ACROSS A RESTART.
 *
 * Flow cannot delete its own database, its browser profile or its caches while
 * it is running on them. So confirming a reset only writes a small file into
 * the app's data folder and restarts; the next launch reads that file before
 * it opens anything, and does the deleting there.
 *
 * TAKEN, NOT READ. `takePendingReset` removes the file before it returns its
 * contents, so a reset that crashes half way does not run again on every
 * launch after it. The outcome is written the same way and taken once by the
 * settings page that reports it.
 *
 * Every function takes its folder explicitly: there is no default, so no call
 * can reach the real app data by forgetting an argument (forbidden-pattern #15).
 */
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseResetItems, type ResetItem, type ResetOutcome, isResetItem } from '../../shared/reset-items'

export const PENDING_RESET_FILE = 'reset-pending.json'
export const RESET_OUTCOME_FILE = 'reset-outcome.json'

interface PendingReset {
  items: ResetItem[]
  at: string
}

function writeAtomic(path: string, text: string): void {
  const temp = `${path}.tmp`
  writeFileSync(temp, text, 'utf8')
  renameSync(temp, path)
}

/** Record the reset the next launch performs. Refuses an empty or unknown list. */
export function writePendingReset(dataDir: string, items: readonly ResetItem[], now: Date): void {
  const parsed = parseResetItems(items)
  if (parsed === null) throw new Error('A reset needs at least one known kind of data.')
  const body: PendingReset = { items: parsed, at: now.toISOString() }
  writeAtomic(join(dataDir, PENDING_RESET_FILE), `${JSON.stringify(body, null, 2)}\n`)
}

/**
 * The pending reset, removed as it is read. Null when there is none, and null
 * (with the file removed) when the file cannot be read — a damaged request is
 * never guessed at.
 */
export function takePendingReset(dataDir: string): ResetItem[] | null {
  const path = join(dataDir, PENDING_RESET_FILE)
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } finally {
    rmSync(path, { force: true })
  }
  try {
    const parsed = JSON.parse(text) as Partial<PendingReset>
    return parseResetItems(parsed.items)
  } catch {
    return null
  }
}

export function writeResetOutcome(dataDir: string, outcome: ResetOutcome): void {
  writeAtomic(join(dataDir, RESET_OUTCOME_FILE), `${JSON.stringify(outcome, null, 2)}\n`)
}

/** The last reset's outcome, removed as it is read. */
export function takeResetOutcome(dataDir: string): ResetOutcome | null {
  const path = join(dataDir, RESET_OUTCOME_FILE)
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } finally {
    rmSync(path, { force: true })
  }
  try {
    const parsed = JSON.parse(text) as Partial<ResetOutcome>
    if (typeof parsed.at !== 'string' || !Array.isArray(parsed.done) || !Array.isArray(parsed.failed)) return null
    return {
      at: parsed.at,
      done: parsed.done.filter(isResetItem),
      failed: parsed.failed.filter(
        (entry): entry is { item: ResetItem; detail: string } =>
          typeof entry === 'object' && entry !== null && isResetItem(entry.item) && typeof entry.detail === 'string',
      ),
    }
  } catch {
    return null
  }
}

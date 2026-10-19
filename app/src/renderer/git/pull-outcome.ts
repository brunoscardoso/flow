/**
 * What a Pull actually did, said out loud (#1336) — pure, DOM-free.
 *
 * The success branch notified a literal string: `Pulled` / `Up to date`,
 * identical whether it fast-forwarded twenty commits of your teammate's work
 * or did nothing at all. Nothing about the real result reached the message —
 * and "Up to date" is not merely uninformative in the first case, it is an
 * outright false claim about what just happened.
 */

export interface PullToast {
  title: string
  body: string
  level: 'info'
}

export interface PullResult {
  conflicted: boolean
  /** Commits that arrived; null when it could not be measured. */
  received: number | null
  branch: string
}

/**
 * The toast for a completed pull.
 *
 * `received: null` means unknown — an unborn branch, an unreadable HEAD, or
 * the conflicted path. It is reported as "check the log", never as zero:
 * claiming nothing arrived is precisely the wrong answer this fixes.
 */
export function pullToast(result: PullResult): PullToast {
  if (result.conflicted) {
    return {
      title: 'Pull has conflicts',
      body: 'Resolve the conflicts in Merge Changes.',
      level: 'info',
    }
  }
  const where = result.branch.trim() === '' ? '' : ` on ${result.branch.trim()}`
  if (result.received === null) {
    return { title: 'Pulled', body: `Finished${where} — check the log for what arrived.`, level: 'info' }
  }
  if (result.received === 0) {
    return { title: 'Already up to date', body: `Nothing new${where}.`, level: 'info' }
  }
  return {
    title: 'Pulled',
    body: `${result.received} new commit${result.received === 1 ? '' : 's'}${where}.`,
    level: 'info',
  }
}

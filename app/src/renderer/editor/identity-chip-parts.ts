/**
 * Identity-chip label logic (conflict-UX Phase 4) — the PURE, DOM-free core of
 * the identity chip. Split out from the `identity-chip.ts` DOM adapter so it
 * unit-tests under plain Node (the app jest env has no DOM lib) and so the
 * labelling rule lives in exactly one place.
 *
 * Given a {@link SideIdentity} (branch / author / commit time), or a graceful
 * fallback when identity wiring has not populated it yet, it resolves the pieces
 * a chip renders. It DELIBERATELY never emits the words ours / theirs / current
 * / incoming — those invert between merge and rebase and mislead the reader.
 */
import type { SideIdentity } from '../../shared/side-identity'

/** Which visual accent a chip carries. `a` = the ours stage, `b` = the theirs stage. */
export type ConflictSide = 'a' | 'b'

/** Options that steer label resolution independent of the DOM. */
export interface IdentityChipOptions {
  /** Which two-side accent to use, and the neutral fallback label to derive. */
  side: ConflictSide
  /** A last-resort label (marker label / branch from merge state) when identity is absent. */
  fallbackLabel?: string
  /** Injected clock for deterministic relative-time tests. Defaults to now. */
  now?: Date
}

/** The resolved, DOM-free pieces a chip renders. */
export interface IdentityChipParts {
  /** Branch / ref / short-hash / fallback / neutral — never a stage word. */
  primary: string
  /** Author display name, or "you" for the current user; absent when unknown. */
  author?: string
  /** Relative commit time (e.g. "3d ago"); absent when the time is unknown. */
  relativeTime?: string
  /** True when this side's author is the repo's current user. */
  isYou: boolean
}

const SHORT_HASH_LEN = 7
const RECENT_THRESHOLD_SEC = 45
const SECONDS_PER_MINUTE = 60
const MINUTES_PER_HOUR = 60
const HOURS_PER_DAY = 24
const DAYS_PER_MONTH = 30
const MONTHS_PER_YEAR = 12

/** First seven characters of a commit hash, or undefined when absent/blank. */
function shortHash(hash?: string): string | undefined {
  const trimmed = hash?.trim()
  return trimmed ? trimmed.slice(0, SHORT_HASH_LEN) : undefined
}

/** The neutral, stage-word-free fallback for a side with no resolvable label. */
function neutralLabel(side: ConflictSide): string {
  return side === 'a' ? 'Side A' : 'Side B'
}

/**
 * A coarse "N<unit> ago" relative time from an ISO-8601 instant. Pure and
 * DOM-free. Returns undefined for a missing/unparseable timestamp; a future
 * instant (clock skew) collapses to "just now" rather than a negative delta.
 */
export function relativeTimeFrom(iso?: string, now: Date = new Date()): string | undefined {
  if (!iso) return undefined
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return undefined

  const deltaSec = Math.round((now.getTime() - then) / 1000)
  if (deltaSec < RECENT_THRESHOLD_SEC) return 'just now'

  const minutes = Math.round(deltaSec / SECONDS_PER_MINUTE)
  if (minutes < MINUTES_PER_HOUR) return `${minutes}m ago`

  const hours = Math.round(minutes / MINUTES_PER_HOUR)
  if (hours < HOURS_PER_DAY) return `${hours}h ago`

  const days = Math.round(hours / HOURS_PER_DAY)
  if (days < DAYS_PER_MONTH) return `${days}d ago`

  const months = Math.round(days / DAYS_PER_MONTH)
  if (months < MONTHS_PER_YEAR) return `${months}mo ago`

  const years = Math.round(months / MONTHS_PER_YEAR)
  return `${years}y ago`
}

/**
 * Resolve the DOM-free display pieces for one conflict side. The primary label
 * walks a fallback chain — branch, then ref, then short hash, then the caller's
 * fallback, then a neutral "Side A/B" — so a chip is always renderable and never
 * leaks a stage word. Pure; the single source of truth for chip labelling.
 */
export function identityChipParts(
  identity: SideIdentity | undefined,
  options: IdentityChipOptions,
): IdentityChipParts {
  const primary =
    identity?.branch?.trim() ||
    identity?.ref?.trim() ||
    shortHash(identity?.hash) ||
    options.fallbackLabel?.trim() ||
    neutralLabel(options.side)

  const isYou = identity?.isCurrentUser ?? false
  const author = isYou ? 'you' : identity?.author?.trim() || undefined
  const relativeTime = relativeTimeFrom(identity?.when, options.now)

  return { primary, author, relativeTime, isYou }
}

/** The primary side label alone — the label the Keep-<side> controls display. */
export function sideDisplayLabel(
  identity: SideIdentity | undefined,
  options: IdentityChipOptions,
): string {
  return identityChipParts(identity, options).primary
}

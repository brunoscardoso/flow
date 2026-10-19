/**
 * Per-side conflict identity annotation (conflict-UX v2, Phase 1) — the PURE,
 * DOM-free string logic for the dimmed marker-line annotation the REAL editor
 * renders over each conflict hunk.
 *
 * On the `<<<<<<<` line the editor shows side A's identity tagged `(Current)`; on
 * the `>>>>>>>` line, side B's identity tagged `(Incoming)`. The identity reads
 *   `<branch/ref> · <you|author> · <relative time>   (Current)`
 * reusing the identity-chip labelling core so the annotation, the chips, and the
 * merge tab all speak with one voice. The `(Current)`/`(Incoming)` stage tags are
 * permitted HERE — and only here — because they are always paired with the
 * concrete branch/author/time identity (the v2 decision), never shown alone as a
 * bare stage word.
 *
 * Graceful degradation: with no resolvable identity and no fallback label the
 * annotation collapses to just the stage tag (e.g. `(Current)`), never inventing
 * a neutral placeholder. This module is Monaco-free and DOM-free so it unit-tests
 * under plain Node; the editor turns the returned string into an inline decoration.
 */
import { identityChipParts, type ConflictSide } from './identity-chip-parts'
import type { SideIdentity } from '../../shared/side-identity'

/** Options steering the annotation text, independent of the DOM. */
export interface ConflictAnnotationOptions {
  /** Which side this annotation labels: `a` (Current) or `b` (Incoming). */
  side: ConflictSide
  /** Marker label / incoming branch used when identity is absent. */
  fallbackLabel?: string
  /** Injected clock for deterministic relative-time tests. Defaults to now. */
  now?: Date
}

/** The stage tag for a side — paired with identity, never shown bare. */
function stageTag(side: ConflictSide): string {
  return side === 'a' ? '(Current)' : '(Incoming)'
}

/** True when a real primary label is derivable (identity ref/branch/hash or a
 *  caller fallback), so the neutral "Side A/B" placeholder is never emitted. */
function hasPrimarySource(
  identity: SideIdentity | undefined,
  fallbackLabel: string | undefined,
): boolean {
  return Boolean(
    identity?.branch?.trim() ||
      identity?.ref?.trim() ||
      identity?.hash?.trim() ||
      fallbackLabel?.trim(),
  )
}

/**
 * Build the dimmed marker-line annotation for one conflict side. Reuses the
 * identity-chip parts for the branch/author/time pieces, joins them with ` · `,
 * and appends the side's `(Current)`/`(Incoming)` stage tag. When nothing about
 * the side is known the result is the stage tag alone. Pure and DOM-free.
 */
export function conflictAnnotationText(
  identity: SideIdentity | undefined,
  options: ConflictAnnotationOptions,
): string {
  const tag = stageTag(options.side)
  const parts = identityChipParts(identity, {
    side: options.side,
    fallbackLabel: options.fallbackLabel,
    ...(options.now ? { now: options.now } : {}),
  })

  const primary = hasPrimarySource(identity, options.fallbackLabel) ? parts.primary : undefined
  const body = [primary, parts.author, parts.relativeTime].filter(Boolean).join(' · ')

  return body ? `${body}   ${tag}` : tag
}

// Friendly display name for a Claude model id or alias (#129). Pure so the
// composer's "using <model>" indicator is unit-testable.

/**
 * Turn a model id/alias into a short human label:
 *   'claude-opus-4-8'            → 'Opus 4.8'
 *   'claude-sonnet-5'            → 'Sonnet 5'
 *   'claude-haiku-4-5-20251001'  → 'Haiku 4.5'  (trailing date snapshot dropped)
 *   'claude-opus-4-20250514'     → 'Opus 4'     (date snapshot is NOT a minor version)
 *   'claude-3-5-sonnet-20241022' → 'Sonnet 3.5' (older ids put the version first)
 *   'opus' / 'sonnet' / 'haiku'  → 'Opus' / 'Sonnet' / 'Haiku'  (aliases, no version)
 *   'claude-fable-5-1[1m]'       → 'Fable 5.1 (1M)'  (a variant, not a version)
 *   'auto' / null / ''           → 'Auto'
 *   anything unrecognized        → the raw id (never hide what's really running)
 */
export function modelLabel(model: string | null | undefined): string {
  if (!model) return 'Auto'
  const lower = model.toLowerCase()
  if (lower === 'auto') return 'Auto'
  // A TRAILING `[…]` IS A VARIANT, NOT A VERSION. `claude-fable-5-1[1m]` is the
  // 1M-context Fable 5.1, and feeding the bracket to the version parser made
  // `1[1m]` a non-numeric segment — so the minor was dropped and the model read
  // as "Fable 5", one release behind what was actually running. The variant is
  // then said out loud, because "Opus 5" and "Opus 5 (1M)" are different models
  // to anyone choosing between them.
  const variant = /\[([a-z0-9]+)\]$/.exec(lower)?.[1] ?? null
  const base = variant === null ? lower : lower.slice(0, lower.length - variant.length - 2)
  const suffix = variant === null ? '' : ` (${variant.toUpperCase()})`
  for (const family of ['Opus', 'Sonnet', 'Haiku', 'Fable']) {
    if (base.includes(family.toLowerCase())) return withVersion(family, base) + suffix
  }
  return model
}

/**
 * Derive the `major[.minor]` version around the family word:
 *   `opus-4-8` → `4.8`, `opus-4-20250514` → `4`, `3-5-sonnet` → `3.5`.
 * The version usually follows the family word; older ids put it before it. An
 * 8-digit `YYYYMMDD` release snapshot is never a version — dropped so it can't
 * masquerade as one (#1126).
 */
function withVersion(family: string, lowerId: string): string {
  const familyLower = family.toLowerCase()
  const idx = lowerId.indexOf(familyLower)
  // Numeric `-`-separated segments, minus any 8-digit YYYYMMDD release snapshot.
  const versionParts = (segment: string): string[] =>
    segment.split('-').filter((s) => /^\d+$/.test(s) && !/^\d{8}$/.test(s))

  // Prefer the version after the family word (`opus-4-8`); fall back to before
  // it for older ids that lead with the version (`claude-3-5-sonnet`).
  const after = versionParts(lowerId.slice(idx + familyLower.length))
  const parts = after.length > 0 ? after : versionParts(lowerId.slice(0, idx))

  if (parts.length === 0) return family
  const [major, minor] = parts
  return minor ? `${family} ${major}.${minor}` : `${family} ${major}`
}

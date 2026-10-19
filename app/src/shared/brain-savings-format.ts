/**
 * Token-savings display formatting — the ONE code path (allowed-pattern #14)
 * that turns an estimated saved-token count into UI text. Used by the
 * conversation pane (per-turn stats segment + per-thread chip) and the
 * Learning panel's Brain retrieval line, so every surface renders the same
 * number the same way.
 *
 * Rules (brain-savings estimation contract):
 *   - Always an estimate → always prefixed with `~`.
 *   - Thousands render as `Nk`, one decimal below 10k (`~8.2k`), trailing
 *     `.0` stripped (`~12k`, never `~12.0k`); sub-1000 renders raw (`~640`).
 *   - Zero (or negative/invalid) savings render NOTHING — callers hide the
 *     segment/chip entirely (`null` here means "no chrome").
 *
 * Pure and dependency-free — plain-Node loadable from main, renderer, and
 * both jest runners alike.
 */

/** Format an estimated saved-token count, or null when there is nothing to
 *  show (callers render no segment/chip then). */
export function formatSavedTokens(savedTokens: number): string | null {
  if (!Number.isFinite(savedTokens) || savedTokens <= 0) return null
  const rounded = Math.round(savedTokens)
  if (rounded <= 0) return null
  if (rounded < 1000) return `~${rounded}`
  const thousands = (rounded / 1000).toFixed(1).replace(/\.0$/, '')
  return `~${thousands}k`
}

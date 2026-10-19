/**
 * Conversation savings display models (brain-first-retrieval) — pure, DOM-free
 * text builders for the two conversation surfaces of the token-savings
 * estimate:
 *
 *   - the per-turn stats-line SEGMENT appended after the model name
 *     ("↑ 4674 · ↓ 3257 tokens · Opus 4.8 · [brain] ~12.4k saved" — the icon
 *     is an fl-icon 'brain' glyph rendered by the pane, never an emoji), and
 *   - the per-thread cumulative CHIP ("~Nk") with its explanatory tooltip.
 *
 * Both reuse the ONE formatting code path (shared/brain-savings-format.ts,
 * allowed-pattern #14): always `~`-prefixed (it is an estimate), `Nk`
 * thousands, and NOTHING at zero — callers hide the segment/chip entirely
 * when these return null. The CHIP additionally keeps itself visible with the
 * root's cumulative total when the thread alone has none (savingsChipView).
 */

import { formatSavedTokens } from '../../shared/brain-savings-format'

/** `4059`, `7.4k` — thousands only once the number is long enough that the
 *  exact digits stop being readable. */
export function formatTokens(count: number): string {
  const safe = Number.isFinite(count) && count > 0 ? count : 0
  return safe >= 10000 ? `${(safe / 1000).toFixed(1)}k` : String(safe)
}

/**
 * The stats line's token half: `↑ 7.4k (7.4k cached) · ↓ 47 tokens`.
 *
 * `inputTokens` is the turn's WHOLE input and `cachedInputTokens` the cached
 * portion OF it (#1136) — the parenthetical says how much of the total was
 * served from / written to the prompt cache, and is omitted entirely when
 * nothing was cached (turn 1, or a provider that doesn't report it) so the
 * common line stays as short as it was before.
 */
export function turnTokensLabel(
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
): string {
  const input = formatTokens(inputTokens)
  const cached =
    Number.isFinite(cachedInputTokens) && cachedInputTokens > 0
      ? ` (${formatTokens(cachedInputTokens)} cached)`
      : ''
  return `↑ ${input}${cached} · ↓ ${formatTokens(outputTokens)} tokens`
}

/** Per-turn stats-line segment text (`~12.4k saved`), or null to render no
 *  segment (zero/invalid savings — never 0-savings chrome).
 *
 *  #1280: `calibrated: false` means the per-hit price is still the flat
 *  default, so the segment reports the hits rather than a fixed 8k each. */
export function turnSavedSegmentLabel(
  savedTokens: number,
  options: { calibrated?: boolean; hits?: number } = {},
): string | null {
  if (options.calibrated === false) {
    return knowledgeHitsLabel(options.hits ?? 0)
  }
  const formatted = formatSavedTokens(savedTokens)
  return formatted === null ? null : `${formatted} saved`
}

/** The savings segment's tooltip — states the estimation model honestly. */
export const THREAD_SAVINGS_TOOLTIP =
  'Estimated tokens saved by knowledge search — a successful search replaces a ' +
  'measured code-exploration burst (median of this project’s own bursts). ' +
  'Estimate, not a meter.'

/** Shown while the price per hit is still the flat default (#1280): the chip
 *  reports the hits it counted and says why there is no token figure yet. */
export const UNCALIBRATED_SAVINGS_TOOLTIP =
  'Knowledge searches that answered without falling back to code exploration. ' +
  'A token estimate needs this project’s own exploration bursts to price ' +
  'against, and there aren’t enough measured yet — so the count is shown ' +
  'instead of a number that would just be a fixed 8k per hit.'

/** The hit-count label used while uncalibrated (`3 knowledge hits`), or null
 *  when there is nothing to report. */
export function knowledgeHitsLabel(hits: number): string | null {
  if (!Number.isFinite(hits) || hits <= 0) return null
  const whole = Math.round(hits)
  if (whole <= 0) return null
  return `${whole} knowledge ${whole === 1 ? 'hit' : 'hits'}`
}


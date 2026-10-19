/**
 * Turn usage accounting — the ONE place that decides what "this turn's input"
 * means (#1136).
 *
 * The SDK splits a turn's input across THREE buckets, and `input_tokens` is
 * only the third of them:
 *
 *   - `cache_creation_input_tokens` — new text written into the prompt cache
 *   - `cache_read_input_tokens`     — prompt prefix served from the cache
 *   - `input_tokens`                — the uncached remainder
 *
 * Prompt caching is on from turn 2 onward, so forwarding `input_tokens` alone
 * reports the remainder — a number that SHRINKS as the conversation grows
 * (a 13KB follow-up read "↑ 929", the next turn "↑ 2"). All three are real
 * input the turn sent and was billed for, so the total is their sum; the
 * cached portion is carried alongside so the UI can say how much of it was
 * cheap rather than hiding the distinction.
 */

/** The usage shape SDK result messages carry (fields optional — a provider or
 *  a non-cached turn may omit the cache buckets entirely). */
export interface SdkUsageLike {
  input_tokens?: number | null
  output_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export interface TurnUsageTotals {
  /** Everything the turn sent: uncached + cache-read + cache-creation. */
  inputTokens: number
  /** The portion of `inputTokens` that came from / went into the cache. */
  cachedInputTokens: number
  outputTokens: number
}

/** A missing/negative/non-finite count is 0 — never NaN in a token readout. */
function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

export function turnUsageTotals(usage: SdkUsageLike | null | undefined): TurnUsageTotals {
  const cachedInputTokens =
    count(usage?.cache_read_input_tokens) + count(usage?.cache_creation_input_tokens)
  return {
    inputTokens: count(usage?.input_tokens) + cachedInputTokens,
    cachedInputTokens,
    outputTokens: count(usage?.output_tokens),
  }
}

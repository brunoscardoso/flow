/**
 * How full the conversation's context window is, and how to say it (#1955).
 *
 * Flow measured the number and knew the window, and joined neither: a thread
 * grew to a million tokens with nothing on screen saying so. Measured over
 * 7,521 recorded API calls, 97% of every token ever consumed was context being
 * re-read, and the top 10 sessions of 2,357 were 72.9% of the spend — so the
 * one fact nobody could see was the one driving the bill.
 *
 * THE WINDOW IS NOT GUESSED HERE. `maxTokens` comes from the SDK's own
 * `getContextUsage()`, which resolves it against the model actually answering
 * (and against a smaller compaction-policy window where one applies). A
 * provider that cannot answer gives no reading at all — see `readContext`
 * returning null — rather than a number measured against an invented
 * denominator. That is the failure this fixes, not a shape to repeat: the
 * compaction hook had a hardcoded 200K against real ~1M windows, so 44% of all
 * calls tripped its red line and it was ignored (#1956).
 */

/**
 * The runtime command that shortens a conversation, WITHOUT its leading slash
 * — the spelling `supportedCommands()` reports.
 *
 * One constant, two readers: main asks the runtime whether it has this
 * command, and the renderer sends exactly it. Two spellings would let the
 * button appear for a command nothing sends (allowed-pattern #14).
 */
export const SHORTEN_COMMAND = 'compact'

/** Share of the window at which the reading stops being background detail. */
export const FILLING_AT = 0.7
/** Share of the window at which it is worth interrupting someone over. */
export const NEARLY_FULL_AT = 0.85

/**
 * The same two thresholds the `suggest-compact` hook uses for its warn line
 * (0.70) — deliberately, because two surfaces disagreeing about what "nearly
 * full" means is a defect a user experiences as the app contradicting itself.
 * The upper one is higher here (0.85 vs the hook's 0.80): a terminal warning
 * that scrolls past has to fire early to be seen at all, while a bar that is
 * permanently on screen does not.
 */
export type ContextPressure = 'healthy' | 'filling' | 'nearly-full'

export interface ContextReading {
  totalTokens: number
  maxTokens: number
  /** The runtime offers shortening; the panel shows the control only then. */
  canShorten: boolean
  /** 0–100, rounded, clamped for display — a window can be exceeded. */
  percentage: number
  pressure: ContextPressure
  /** `74% of 1M` — what the control says. */
  label: string
  /** The model the window belongs to, when the reading named one. */
  model: string | null
}

export interface ContextUsageSnapshot {
  totalTokens: number
  maxTokens: number
  model: string | null
  /**
   * Whether this runtime offers a way to shorten the conversation.
   *
   * Asked of the runtime, never assumed. A button that sends a command the
   * session does not have is a control that silently does nothing — the exact
   * shape of forbidden-pattern #12, with a button instead of a sentence.
   */
  canShorten: boolean
}

/** `1M`, `200K`, `64K` — a window is a round number, so say it roundly. */
export function formatWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`
  return String(tokens)
}

/** `112.4k`, `640` — the measured side, where the exact digits matter more. */
export function formatUsed(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`
  if (tokens >= 10_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(Math.max(0, Math.round(tokens)))
}

function usable(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * The reading to draw, or **null when there is nothing honest to draw**.
 *
 * Null is a real answer and the caller must render it as one: no bar, no
 * percentage, the token counts alone exactly as they appear today. A missing
 * window means a provider did not tell us, and the alternative — falling back
 * to some default denominator — produces a percentage that looks like a
 * measurement and is not one.
 */
export function readContext(snapshot: ContextUsageSnapshot | null | undefined): ContextReading | null {
  if (!snapshot) return null
  const { totalTokens, maxTokens } = snapshot
  if (!usable(maxTokens)) return null
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens) || totalTokens < 0) return null

  const ratio = totalTokens / maxTokens
  const pressure: ContextPressure =
    ratio >= NEARLY_FULL_AT ? 'nearly-full' : ratio >= FILLING_AT ? 'filling' : 'healthy'

  return {
    totalTokens,
    maxTokens,
    // Clamped: over-limit is a real state the SDK reports, but "112% of 1M" in
    // a 64px bar reads as a bug in the bar rather than a fact about the thread.
    percentage: Math.min(100, Math.round(ratio * 100)),
    pressure,
    label: `${Math.min(100, Math.round(ratio * 100))}% of ${formatWindow(maxTokens)}`,
    canShorten: snapshot.canShorten === true,
    model: typeof snapshot.model === 'string' && snapshot.model.length > 0 ? snapshot.model : null,
  }
}

/** The accessible name for the meter — a control needs words, not a bar. */
export function contextMeterLabel(reading: ContextReading): string {
  const head = `Context ${reading.percentage}% full — ${formatUsed(reading.totalTokens)} of ${formatWindow(reading.maxTokens)} tokens`
  return reading.pressure === 'healthy' ? `${head}.` : `${head}. Open context controls.`
}

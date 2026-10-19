// Token-savings estimator (brain-first-retrieval) — HOW MANY tokens did
// knowledge search save? The estimation model, implemented exactly and
// honestly (it is an estimate, never a meter):
//
//   - Each brain search in a window of tool calls is classified HIT or MISS
//     using the SAME definitions as the brain-usage analyzer (one code path,
//     allowed-pattern #14): a MISS is a search followed by an exploration
//     burst (Grep/Glob tool calls, or Bash grep/rg/find) before the next
//     search; a HIT has no such burst — the answer sufficed.
//   - MEASURED BURST COST: for each MISS, the burst's exploration outputs are
//     summed as output chars / 4 ≈ tokens, each call capped at 50k chars so
//     one giant dump cannot skew the sample.
//   - PER-ROOT BASELINE: the median of that project's own measured burst
//     costs (a rolling list of the last 50 samples, persisted in
//     brain-usage.json; median recomputed on read). With fewer than 3 samples
//     the baseline falls back to a documented conservative default of 8,000
//     tokens.
//   - SAVINGS: each HIT saves one baseline (the exploration it replaced).
//     A MISS saves 0 — it cost a search AND the burst. Per-turn savings =
//     hits-in-turn × baseline; per-thread = the same classification over the
//     thread's full persisted tool-call list, sliced at USER-message turn
//     boundaries so the two paths price identically (parity-tested).
//
// This module is PURE (no fs, no Electron) — it owns the low-level tool-call
// inspection helpers (bashCommand / outputText / isExplorationCall) so both
// the brain-usage analyzer and this estimator share one definition, and the
// import graph stays one-directional: brain-usage → brain-savings → shared.

import { isBrainSearchCommand } from '../../shared/brain-search-command'

/** The slice of a persisted tool call the estimator needs (ToolCallRecord fits). */
export interface BrainSavingsToolCall {
  toolName: string
  inputJson: string | null
  outputJson: string | null
}

// ── Estimation constants (the documented model above) ──────────────────────

/**
 * Fallback baseline when fewer than MIN_BASELINE_SAMPLES exist.
 *
 * #1419: this is NO LONGER A PRICE. Nothing is banked or displayed from it —
 * `estimateSavedTokens` returns 0 for an unmeasured baseline — because
 * measured medians on real stores (678, 66, 861 tokens) put this constant at
 * roughly 12× reality. It survives only as the `tokens` field of an
 * unmeasured `SavingsBaseline`, so existing shapes and tests keep their
 * meaning; `measured` is what decides whether a number exists at all.
 */
export const DEFAULT_BASELINE_TOKENS = 8_000
/** Minimum measured samples before the project's own median is trusted. */
export const MIN_BASELINE_SAMPLES = 3
/** Per-call cap on measured burst output (chars) — one giant dump must not skew. */
export const BURST_CALL_CHAR_CAP = 50_000
/** chars / 4 ≈ tokens. */
export const CHARS_PER_TOKEN = 4
/** Rolling burst-cost sample list length (persisted per root). */
export const MAX_BURST_SAMPLES = 50

// ── Tool-call inspection (shared with the brain-usage analyzer) ────────────

/** Bash commands that read as an exploration fallback: grep/rg/find as a
 *  command word (start of command or after a separator). */
const EXPLORATION_BASH_PATTERN = /(?:^|[\s;|&(`])(?:rg|grep|find)\s/

/** Tool names that are exploration on their own. */
const EXPLORATION_TOOLS = new Set(['Grep', 'Glob'])

/** The `command` string of a Bash tool call, or null. */
export function bashCommand(call: BrainSavingsToolCall): string | null {
  if (call.toolName !== 'Bash' || !call.inputJson) return null
  try {
    const input = JSON.parse(call.inputJson) as unknown
    if (input && typeof input === 'object') {
      const command = (input as Record<string, unknown>).command
      if (typeof command === 'string') return command
    }
  } catch {
    // Malformed input — not a countable command. Best-effort, never a fail.
  }
  return null
}

/** True when the call is an exploration step (Grep/Glob, or Bash grep/rg/find). */
export function isExplorationCall(call: BrainSavingsToolCall): boolean {
  if (EXPLORATION_TOOLS.has(call.toolName)) return true
  const command = bashCommand(call)
  if (command === null || isBrainSearchCommand(command)) return false
  return EXPLORATION_BASH_PATTERN.test(command)
}

/** Flatten a persisted tool output (safeStringify of the SDK tool_result
 *  content — a string, a content-block array, or an object) into plain text.
 *
 *  PERF: every consumer caps what it reads at BURST_CALL_CHAR_CAP (burst
 *  measurement caps the length; hit-count regexes only ever match search
 *  output, which is top-k small), so the RAW json is sliced to the cap BEFORE
 *  parsing — a multi-MB blob is never materialized just to be capped. The
 *  truncated slice no longer parses as JSON and falls through to the raw-text
 *  branch, which is exactly the capped text the consumers need. */
export function outputText(outputJson: string | null): string {
  if (!outputJson) return ''
  if (outputJson.length > BURST_CALL_CHAR_CAP) {
    return outputJson.slice(0, BURST_CALL_CHAR_CAP)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(outputJson)
  } catch {
    return outputJson // Not JSON — treat the raw string as the text.
  }
  if (typeof parsed === 'string') return parsed
  if (Array.isArray(parsed)) {
    return parsed
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          return (block as { text: string }).text
        }
        return ''
      })
      .join('\n')
  }
  if (parsed && typeof parsed === 'object' && typeof (parsed as { text?: unknown }).text === 'string') {
    return (parsed as { text: string }).text
  }
  return outputJson
}

// ── Burst measurement ──────────────────────────────────────────────────────

/** Measured cost of ONE exploration call: output chars (capped) / 4 ≈ tokens. */
export function burstCallTokens(call: BrainSavingsToolCall): number {
  const chars = Math.min(outputText(call.outputJson).length, BURST_CALL_CHAR_CAP)
  return Math.round(chars / CHARS_PER_TOKEN)
}

/** Per-search classification over one window of tool calls. */
export interface BrainSavingsAnalysis {
  /** Searches with NO exploration burst in their window — the answer sufficed. */
  hits: number
  /** Searches followed by an exploration burst before the next search. */
  misses: number
  /** One measured burst cost (tokens) per miss, in order of occurrence. */
  burstCosts: number[]
}

/**
 * Classify every brain search in `toolCalls` (persisted order) as HIT or
 * MISS and measure each miss's burst. A search's window runs until the next
 * search (or the end of the list); ALL exploration calls inside the window
 * form the burst — non-exploration calls in between (Read etc.) neither
 * close nor extend it. Same hit/miss semantics as analyzeBrainUsage (miss ⇔
 * ≥1 exploration call in the window); this adds the burst measurement. Pure.
 */
export function classifyBrainSearches(
  toolCalls: readonly BrainSavingsToolCall[],
): BrainSavingsAnalysis {
  const analysis: BrainSavingsAnalysis = { hits: 0, misses: 0, burstCosts: [] }
  let windowOpen = false
  let windowBurst = 0
  let windowBurstCalls = 0

  const closeWindow = (): void => {
    if (!windowOpen) return
    if (windowBurstCalls > 0) {
      analysis.misses += 1
      analysis.burstCosts.push(windowBurst)
    } else {
      analysis.hits += 1
    }
    windowOpen = false
    windowBurst = 0
    windowBurstCalls = 0
  }

  for (const call of toolCalls) {
    const command = bashCommand(call)
    if (command !== null && isBrainSearchCommand(command)) {
      closeWindow()
      windowOpen = true
      continue
    }
    if (windowOpen && isExplorationCall(call)) {
      windowBurst += burstCallTokens(call)
      windowBurstCalls += 1
    }
  }
  closeWindow()
  return analysis
}

// ── Baseline (median of the project's own burst costs) ─────────────────────

/** Median of a non-empty list (mean of the middle two for even lengths). */
export function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid] as number
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/**
 * The per-root baseline WITH its provenance (#1280).
 *
 * The default is a stand-in, not a measurement: with fewer than
 * MIN_BASELINE_SAMPLES the price of a hit is a flat 8,000 tokens, so one hit
 * reports exactly "~8k saved", two report "~16k", and a project that mostly
 * HITS never produces the miss-bursts the median is built from — so it stays
 * on the default forever. Surfacing that as a token figure presents a constant
 * as an estimate. Callers now get `measured` and can say what they actually
 * know instead.
 */
export interface SavingsBaseline {
  /** Tokens priced per hit. */
  tokens: number
  /** True when this is the project's OWN measured median, not the default. */
  measured: boolean
  /** How many burst samples back it. */
  samples: number
}

export function resolveBaseline(burstSamples: readonly number[]): SavingsBaseline {
  if (burstSamples.length < MIN_BASELINE_SAMPLES) {
    return { tokens: DEFAULT_BASELINE_TOKENS, measured: false, samples: burstSamples.length }
  }
  return {
    tokens: Math.round(medianOf(burstSamples)),
    measured: true,
    samples: burstSamples.length,
  }
}

/** The per-root baseline: median of the rolling burst samples, or the
 *  documented conservative default when fewer than MIN_BASELINE_SAMPLES. */
export function baselineTokens(burstSamples: readonly number[]): number {
  return resolveBaseline(burstSamples).tokens
}

/** Fold new burst costs into the rolling sample list (last MAX_BURST_SAMPLES
 *  kept, oldest dropped). Returns a new array — never mutates. */
export function appendBurstSamples(
  existing: readonly number[],
  incoming: readonly number[],
): number[] {
  return [...existing, ...incoming].slice(-MAX_BURST_SAMPLES)
}

// ── Savings ────────────────────────────────────────────────────────────────

/** Savings for one analyzed window: each HIT saves one baseline; misses save 0. */
export function estimateSavedTokens(
  analysis: Pick<BrainSavingsAnalysis, 'hits'>,
  baseline: number | SavingsBaseline,
): number {
  // #1419: AN UNMEASURED BASELINE IS WORTH NOTHING, not 8,000 per hit.
  //
  // #1280 stopped DISPLAYING an uncalibrated figure, and that was only half
  // the problem: the number was still computed and BANKED into the project's
  // cumulative `savedTokens`. So a project accumulated `hits × 8_000` while
  // uncalibrated and then, the moment its third burst sample landed, started
  // adding `hits × median` — on this machine's real store, 678. The banked
  // total is a mix of two scales and reads as a measurement.
  //
  // The measured medians here (678, 66, 861) put the constant at roughly 12×
  // reality, so the old default was not conservative — it was wrong, and
  // wrong in the flattering direction.
  //
  // An absent number beats a wrong one: with no measured baseline, savings are
  // 0 and only the hit count is reported (which is what the surfaces show
  // while uncalibrated anyway). Nothing is lost that was ever true.
  const resolved = typeof baseline === 'number' ? baseline : baseline.tokens
  const measured = typeof baseline === 'number' ? true : baseline.measured
  if (!measured) return 0
  return Math.max(0, Math.round(analysis.hits * resolved))
}

/** A tool call with its persisted start time — what the thread recompute
 *  needs to bound search windows at turn boundaries (ToolCallSlimRecord fits). */
export interface TurnBoundedToolCall extends BrainSavingsToolCall {
  /** ISO 8601 start timestamp (`tool_calls.started_at`) — ISO strings compare
   *  lexically, so plain `<=` ordering against message timestamps is exact. */
  startedAt: string
}

/**
 * Split a thread's tool calls (persisted order) into per-turn slices at the
 * given boundary timestamps — the thread's USER message `createdAt` times.
 * A boundary at-or-before a call's `startedAt` starts a new turn (the user
 * message always precedes the turn's tool calls). Empty slices are dropped;
 * with no boundaries the whole list is one turn. Pure.
 */
export function splitByTurnBoundaries<T extends { startedAt: string }>(
  toolCalls: readonly T[],
  boundaries: readonly string[],
): T[][] {
  const sorted = [...boundaries].sort()
  const turns: T[][] = []
  let current: T[] = []
  let boundaryIndex = 0
  for (const call of toolCalls) {
    let crossed = false
    while (boundaryIndex < sorted.length && (sorted[boundaryIndex] as string) <= call.startedAt) {
      boundaryIndex += 1
      crossed = true
    }
    if (crossed && current.length > 0) {
      turns.push(current)
      current = []
    }
    current.push(call)
  }
  if (current.length > 0) turns.push(current)
  return turns
}

/**
 * Per-thread savings, recomputable post-hoc from the thread's full persisted
 * tool-call list plus the root's current burst samples. Pure. Each search's
 * miss-window is BOUNDED BY THE NEXT USER MESSAGE (`userMessageTimes` — the
 * thread's user-message `createdAt` timestamps): classification runs per turn
 * slice, the SAME semantics as the BrainUsageTracker's per-turn cursor, so a
 * turn-1 hit search never reads as a miss just because a LATER turn explored
 * (that discrepancy zeroed real threads' chips while the cumulative store said
 * 8k — observed live on orbit-app).
 */
export function estimateThreadSavedTokens(
  toolCalls: readonly TurnBoundedToolCall[],
  userMessageTimes: readonly string[],
  burstSamples: readonly number[],
): number {
  return estimateThreadSavings(toolCalls, userMessageTimes, burstSamples).savedTokens
}

/** What one thread's savings estimate is MADE OF (#1280): the figure, the hit
 *  count behind it, and whether the price per hit was measured or defaulted.
 *  The hit count is the honest thing to show while the baseline is a stand-in. */
export interface ThreadSavings {
  savedTokens: number
  hits: number
  baseline: SavingsBaseline
}

export function estimateThreadSavings(
  toolCalls: readonly TurnBoundedToolCall[],
  userMessageTimes: readonly string[],
  burstSamples: readonly number[],
): ThreadSavings {
  const baseline = resolveBaseline(burstSamples)
  let hits = 0
  for (const turn of splitByTurnBoundaries(toolCalls, userMessageTimes)) {
    hits += classifyBrainSearches(turn).hits
  }
  return { savedTokens: estimateSavedTokens({ hits }, baseline), hits, baseline }
}

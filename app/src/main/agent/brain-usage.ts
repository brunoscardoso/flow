// Brain-usage counters (brain-first-retrieval, Phase 4) — the savings become
// a number. A pure analyzer walks a turn's persisted tool calls and counts:
//
//   - SEARCH   — a Bash call invoking `planflow-ai brain search` (any spelling
//                that reaches the CLI: the PATH shim, the bundled .mjs, or
//                `node dist/cli/index.js`).
//   - HITS     — fresh/stale counts parsed from the search's captured output
//                (the human `● fresh` / `○ stale` markers or the --json
//                `"freshness"` fields). Missing output is tolerated: the
//                search still counts, hits read zero.
//   - MISS     — within the same turn, a search followed by an exploration
//                burst (Grep/Glob tool calls, or Bash invoking grep/rg/find)
//                before the next search — counted at most once per search.
//
// TOKEN SAVINGS: the same pass estimates tokens saved by knowledge search
// (see brain-savings.ts for the full estimation model): a HIT search (no
// exploration burst followed) saves one per-root baseline — the median of
// the project's own measured burst costs — while a MISS saves 0 and feeds
// its measured burst cost into the rolling sample list.
//
// TURN BOUNDARY: tool calls don't carry a turn id, so the tracker defines a
// turn as "everything persisted since the previous onTurnComplete for this
// thread" (a per-thread cursor, applied as the SQL OFFSET of
// ThreadStore.listToolCallsSlim, which is ordered by started_at). That is
// exactly the window between two user messages, which is the honest reading
// of "same turn".
//
// PERSISTENCE (deliberate v1 choice): per-project cumulative totals (counters
// + savedTokens + the rolling burstSamples list) live in
// `flow/brain/.structure/brain-usage.json` (atomic tmp+rename write, same
// directory as learning-state.jsonl — small, precious-ish, never rebuilt by
// derive). The file IS the state — main keeps only per-thread cursors in
// memory, so totals survive app restarts and the IPC read path has no dual
// source. Each counting turn also appends one `brain_usage` entry (the turn's
// delta) to the primary root's `flow/.rounds.jsonl` — same append-only
// discipline as review-verdict-writer.ts, fail-soft, never rewritten.
//
// This module touches only node:fs/path (no Electron) — plain-Node loadable,
// same discipline as capture.ts / review-verdict-writer.ts.

import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { isBrainSearchCommand } from '../../shared/brain-search-command'
import type { BrainUsageTotals } from '../../shared/ipc-contract'
import {
  appendBurstSamples,
  bashCommand,
  classifyBrainSearches,
  estimateSavedTokens,
  isExplorationCall,
  outputText,
  resolveBaseline,
  type BrainSavingsAnalysis,
} from './brain-savings'

// Re-exported so existing consumers/tests keep one import site; the matcher
// lives in shared/brain-search-command.ts (the ONE code path shared with the
// renderer's Knowledge-search tool card) and the call-inspection helpers in
// brain-savings.ts (shared with the savings estimator) — allowed-pattern #14.
export { isBrainSearchCommand, isExplorationCall }

// ── Pure analyzer ──────────────────────────────────────────────────────────

/** The slice of a persisted tool call the analyzer needs (ToolCallRecord fits). */
export interface BrainUsageToolCall {
  toolName: string
  inputJson: string | null
  outputJson: string | null
}

/** One turn's brain-usage tally. */
export interface BrainUsageTally {
  searches: number
  freshHits: number
  staleHits: number
  misses: number
}

/**
 * Parse fresh/stale hit counts from a brain-search's captured output. Handles
 * both output shapes: the human renderer's `● fresh` / `○ stale` markers and
 * the --json `"freshness": "fresh|stale"` fields (`unknown` counts as
 * neither). The two shapes never co-occur, so summing both counts is safe.
 * Missing/uncaptured output → zeros.
 */
export function parseHitCounts(outputJson: string | null): { fresh: number; stale: number } {
  const text = outputText(outputJson)
  if (text === '') return { fresh: 0, stale: 0 }
  const fresh =
    (text.match(/●\s*fresh/g)?.length ?? 0) + (text.match(/"freshness"\s*:\s*"fresh"/g)?.length ?? 0)
  const stale =
    (text.match(/○\s*stale/g)?.length ?? 0) + (text.match(/"freshness"\s*:\s*"stale"/g)?.length ?? 0)
  return { fresh, stale }
}

/**
 * Analyze one turn's tool calls (in persisted order). Pure and DB-free. A
 * miss window opens at each search and closes at the first exploration call
 * (counting one miss) or at the next search — so each search contributes at
 * most one miss, and exploration with no preceding search counts nothing.
 */
export function analyzeBrainUsage(toolCalls: readonly BrainUsageToolCall[]): BrainUsageTally {
  const tally: BrainUsageTally = { searches: 0, freshHits: 0, staleHits: 0, misses: 0 }
  let missWindowOpen = false
  for (const call of toolCalls) {
    const command = bashCommand(call)
    if (command !== null && isBrainSearchCommand(command)) {
      tally.searches += 1
      const hits = parseHitCounts(call.outputJson)
      tally.freshHits += hits.fresh
      tally.staleHits += hits.stale
      missWindowOpen = true
      continue
    }
    if (missWindowOpen && isExplorationCall(call)) {
      tally.misses += 1
      missWindowOpen = false
    }
  }
  return tally
}

// ── Cumulative totals store (flow/brain/.structure/brain-usage.json) ───────

const USAGE_FILE_RELPATH = join('flow', 'brain', '.structure', 'brain-usage.json')
const ROUNDS_FILE_RELPATH = join('flow', '.rounds.jsonl')

const ZERO_TOTALS: BrainUsageTotals = {
  searches: 0,
  freshHits: 0,
  staleHits: 0,
  misses: 0,
  savedTokens: 0,
  calibrated: false,
  updatedAt: null,
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** The full persisted store: cumulative totals + the rolling burst-cost
 *  sample list feeding the savings baseline (see brain-savings.ts). */
export interface BrainUsageStore {
  totals: BrainUsageTotals
  /** Measured miss-burst costs (tokens), most recent last, capped at 50. */
  burstSamples: number[]
}

/**
 * Read a root's full brain-usage store. Missing or corrupt file → zeros with
 * no samples (fail-soft — the counters are informational, never load-bearing).
 */
export async function readBrainUsageStore(rootPath: string): Promise<BrainUsageStore> {
  try {
    const raw = await readFile(join(rootPath, USAGE_FILE_RELPATH), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const burstSamples = Array.isArray(parsed.burstSamples)
      ? parsed.burstSamples.filter(
          (sample): sample is number =>
            typeof sample === 'number' && Number.isFinite(sample) && sample >= 0,
        )
      : []
    return {
      totals: {
        searches: asCount(parsed.searches),
        freshHits: asCount(parsed.freshHits),
        staleHits: asCount(parsed.staleHits),
        misses: asCount(parsed.misses),
        savedTokens: asCount(parsed.savedTokens),
        // #1280: DERIVED from the samples, never persisted — calibration is a
        // property of the measurements on hand, so an old store (or one whose
        // samples were rewritten) reports the truth on the next read instead
        // of a stale flag.
        calibrated: resolveBaseline(burstSamples).measured,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
      },
      burstSamples,
    }
  } catch {
    return { totals: { ...ZERO_TOTALS }, burstSamples: [] }
  }
}

/** Read only the cumulative totals (the `learn:brainUsage` IPC shape). */
export async function readBrainUsageTotals(rootPath: string): Promise<BrainUsageTotals> {
  return (await readBrainUsageStore(rootPath)).totals
}

/** Atomic write (tmp + rename) so a crash mid-write never corrupts the store. */
async function writeBrainUsageStore(rootPath: string, store: BrainUsageStore): Promise<void> {
  const target = join(rootPath, USAGE_FILE_RELPATH)
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  const payload = { ...store.totals, burstSamples: store.burstSamples }
  await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

// ── Rounds entry (append-only flow/.rounds.jsonl) ──────────────────────────

/** A `brain_usage` rounds entry — one turn's delta, same append-only
 *  discipline as `review_verdict` (see review-verdict-writer.ts). */
export interface BrainUsageRoundsEntry {
  ts: string
  run_id: string
  type: 'brain_usage'
  thread_id: string
  searches: number
  fresh_hits: number
  stale_hits: number
  misses: number
  /** Estimated tokens saved this turn (hit-searches × per-root baseline). */
  saved_tokens: number
}

/** Per-day run id `brain-usage-<YYYYMMDD>` (UTC — stable across timezones,
 *  mirrors boardReviewRunId). */
export function brainUsageRunId(date: Date): string {
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0')
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const dd = date.getUTCDate().toString().padStart(2, '0')
  return `brain-usage-${yyyy}${mm}${dd}`
}

/** Build one `brain_usage` rounds entry. Pure — the caller supplies the clock. */
export function buildBrainUsageEntry(input: {
  threadId: string
  tally: BrainUsageTally
  savedTokens: number
  now: Date
}): BrainUsageRoundsEntry {
  return {
    ts: input.now.toISOString(),
    run_id: brainUsageRunId(input.now),
    type: 'brain_usage',
    thread_id: input.threadId,
    searches: input.tally.searches,
    fresh_hits: input.tally.freshHits,
    stale_hits: input.tally.staleHits,
    misses: input.tally.misses,
    saved_tokens: input.savedTokens,
  }
}

// ── Tracker (the onTurnComplete seam) ──────────────────────────────────────

/** The slice of ThreadStore the tracker needs (structural — ThreadStore fits).
 *  PERF: the per-turn window is fetched with the cursor as a SQL OFFSET
 *  (ThreadStore.listToolCallsSlim) instead of listing the whole thread to
 *  slice it in JS. */
export interface BrainUsageThreadSource {
  getThread(id: string): { projectRoot: string } | null
  listToolCallsSlim(id: string, fromIndex: number): BrainUsageToolCall[]
}

/** Injectable clock — production reads `new Date()`; tests pin it. */
export type Clock = () => Date

/**
 * Per-thread incremental brain-usage tracking, driven from the agent
 * manager's `onTurnComplete`. Counts every turn (success or not — the tool
 * calls happened either way). Turns with zero searches write nothing. For a
 * counting turn: estimate the turn's token savings (see brain-savings.ts),
 * append the delta to the primary root's rounds file, and fold it into the
 * cumulative store (counters + savedTokens + rolling burst samples),
 * serialized per root so concurrent thread completions never race the
 * read-modify-write. A turn with savings > 0 fires `onSavings` AFTER the
 * fold, so an IPC recompute triggered by it reads the fresh store.
 * Best-effort: nothing here ever propagates into the turn.
 */
export class BrainUsageTracker {
  /** Per-thread count of already-analyzed tool calls. */
  #cursors = new Map<string, number>()
  /** Per-root write chain — serializes rounds append + totals fold. */
  #rootChains = new Map<string, Promise<unknown>>()

  constructor(
    private readonly threads: BrainUsageThreadSource,
    private readonly clock: Clock = () => new Date(),
    /** Test seam: receives each in-flight persistence promise so a test can
     *  await it deterministically (production omits it). */
    private readonly onWork?: (work: Promise<unknown>) => void,
    /** Fired once per turn whose estimated savings are positive — main
     *  forwards it as a `brain-savings` stream event to the renderer. */
    private readonly onSavings?: (
      threadId: string,
      savedTokens: number,
      /** #1280: whether the per-hit price was measured, and the hits behind
       *  the figure — the renderer shows the hits while uncalibrated. */
      provenance: { calibrated: boolean; hits: number },
    ) => void,
  ) {}

  onTurnComplete(threadId: string): void {
    const thread = this.threads.getThread(threadId)
    if (!thread) return
    const cursor = this.#cursors.get(threadId) ?? 0
    const turnCalls = this.threads.listToolCallsSlim(threadId, cursor)
    this.#cursors.set(threadId, cursor + turnCalls.length)
    if (turnCalls.length === 0) return
    const tally = analyzeBrainUsage(turnCalls)
    if (tally.searches === 0) return
    const analysis = classifyBrainSearches(turnCalls)
    const rootPath = thread.projectRoot
    const prev = this.#rootChains.get(rootPath) ?? Promise.resolve()
    const work = prev
      .then(() => this.#persistTurn(rootPath, threadId, tally, analysis))
      .catch(() => undefined)
    this.#rootChains.set(rootPath, work)
    this.onWork?.(work)
  }

  async #persistTurn(
    rootPath: string,
    threadId: string,
    tally: BrainUsageTally,
    analysis: BrainSavingsAnalysis,
  ): Promise<void> {
    const now = this.clock()
    // Savings for this turn: fold the turn's measured bursts into the rolling
    // samples FIRST, then price each hit at the resulting median baseline —
    // the freshest data the estimate can honestly use.
    const store = await readBrainUsageStore(rootPath)
    const burstSamples = appendBurstSamples(store.burstSamples, analysis.burstCosts)
    const baseline = resolveBaseline(burstSamples)
    // #1419: pass the baseline WITH its provenance — an unmeasured one banks
    // nothing, instead of quietly accumulating hits × a constant.
    const savedTokens = estimateSavedTokens(analysis, baseline)
    // Rounds append and totals fold fail independently — one broken file must
    // not silence the other.
    try {
      const entry = buildBrainUsageEntry({ threadId, tally, savedTokens, now })
      const roundsPath = join(rootPath, ROUNDS_FILE_RELPATH)
      await mkdir(dirname(roundsPath), { recursive: true })
      await appendFile(roundsPath, `${JSON.stringify(entry)}\n`, 'utf8')
    } catch (error) {
      console.warn(`[BrainUsage] rounds append failed for ${rootPath}`, error)
    }
    try {
      const totals = store.totals
      await writeBrainUsageStore(rootPath, {
        totals: {
          searches: totals.searches + tally.searches,
          freshHits: totals.freshHits + tally.freshHits,
          staleHits: totals.staleHits + tally.staleHits,
          misses: totals.misses + tally.misses,
          savedTokens: totals.savedTokens + savedTokens,
          calibrated: baseline.measured,
          updatedAt: now.toISOString(),
        },
        burstSamples,
      })
    } catch (error) {
      console.warn(`[BrainUsage] totals write failed for ${rootPath}`, error)
    }
    // #1419: fire on HITS, not on a positive figure. An uncalibrated project
    // now banks 0 (the constant was ~12× the measured median), and gating on
    // savedTokens would have silenced the stats line entirely — losing #1280's
    // "N knowledge hits", which is the honest thing to show while there is no
    // baseline to price against.
    if (savedTokens > 0 || analysis.hits > 0) {
      try {
        this.onSavings?.(threadId, savedTokens, {
          calibrated: baseline.measured,
          hits: analysis.hits,
        })
      } catch (error) {
        console.warn(`[BrainUsage] onSavings callback failed for ${threadId}`, error)
      }
    }
  }
}

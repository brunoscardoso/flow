import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  analyzeBrainUsage,
  BrainUsageTracker,
  brainUsageRunId,
  buildBrainUsageEntry,
  isBrainSearchCommand,
  isExplorationCall,
  parseHitCounts,
  readBrainUsageStore,
  readBrainUsageTotals,
  type BrainUsageToolCall,
} from './brain-usage'

// ── helpers ────────────────────────────────────────────────────────────────

function bash(command: string, output?: string): BrainUsageToolCall {
  return {
    toolName: 'Bash',
    inputJson: JSON.stringify({ command }),
    outputJson: output === undefined ? null : JSON.stringify(output),
  }
}

function tool(toolName: string, input: Record<string, unknown> = {}): BrainUsageToolCall {
  return { toolName, inputJson: JSON.stringify(input), outputJson: null }
}

const SEARCH = 'planflow-ai brain search "thread scope"'

// ── search detection ───────────────────────────────────────────────────────

describe('isBrainSearchCommand', () => {
  it('matches the plain verb', () => {
    expect(isBrainSearchCommand('planflow-ai brain search "x"')).toBe(true)
  })

  it('matches the shim path and the bundled mjs', () => {
    expect(
      isBrainSearchCommand('/Users/u/Library/Application Support/flow/bin/planflow-ai brain search "x"'),
    ).toBe(true)
    expect(
      isBrainSearchCommand('ELECTRON_RUN_AS_NODE=1 /x/electron /y/planflow-ai.mjs brain search q'),
    ).toBe(true)
  })

  it('matches repo-dev and npx invocations', () => {
    expect(isBrainSearchCommand('node dist/cli/index.js brain search "who writes rounds"')).toBe(true)
    expect(isBrainSearchCommand('npx planflow-ai brain search topic --json')).toBe(true)
  })

  it('does not match unrelated commands or a bare phrase', () => {
    expect(isBrainSearchCommand('grep -r "brain search" src/')).toBe(false)
    expect(isBrainSearchCommand('planflow-ai blueprint derive')).toBe(false)
    expect(isBrainSearchCommand('echo brain search')).toBe(false)
  })
})

// ── exploration detection ──────────────────────────────────────────────────

describe('isExplorationCall', () => {
  it('counts Grep and Glob tool calls', () => {
    expect(isExplorationCall(tool('Grep', { pattern: 'x' }))).toBe(true)
    expect(isExplorationCall(tool('Glob', { pattern: '**/*.ts' }))).toBe(true)
  })

  it('counts Bash grep/rg/find invocations', () => {
    expect(isExplorationCall(bash('grep -rn "foo" src/'))).toBe(true)
    expect(isExplorationCall(bash('rg foo --type ts'))).toBe(true)
    expect(isExplorationCall(bash('find . -name "*.ts"'))).toBe(true)
    expect(isExplorationCall(bash('git grep foo'))).toBe(true)
  })

  it('does not count other tools or non-exploration Bash', () => {
    expect(isExplorationCall(tool('Read', { file_path: '/x' }))).toBe(false)
    expect(isExplorationCall(bash('npm run test'))).toBe(false)
    // A brain search is never its own exploration fallback.
    expect(isExplorationCall(bash(SEARCH))).toBe(false)
    // Word-boundary: "findings"/"regrep" style tokens don't count.
    expect(isExplorationCall(bash('cat findings.md'))).toBe(false)
  })
})

// ── hit parsing ────────────────────────────────────────────────────────────

describe('parseHitCounts', () => {
  it('parses human-output freshness markers', () => {
    const output = [
      '1. ● fresh symbol app/src/a.ts:12',
      '2. ○ stale — verify against code note flow/brain/x.md',
      '3. ● fresh code app/src/b.ts:1',
      '4. note docs/adr.md (no marker — unknown)',
    ].join('\n')
    expect(parseHitCounts(JSON.stringify(output))).toEqual({ fresh: 2, stale: 1 })
  })

  it('parses --json freshness fields, ignoring unknown', () => {
    const output = JSON.stringify({
      query: 'x',
      hits: [
        { id: 'a', freshness: 'fresh' },
        { id: 'b', freshness: 'stale' },
        { id: 'c', freshness: 'unknown' },
        { id: 'd', freshness: 'fresh' },
      ],
    })
    expect(parseHitCounts(JSON.stringify(output))).toEqual({ fresh: 2, stale: 1 })
  })

  it('reads content-block array outputs', () => {
    const blocks = [{ type: 'text', text: '1. ● fresh symbol x.ts:1\n2. ○ stale note y.md' }]
    expect(parseHitCounts(JSON.stringify(blocks))).toEqual({ fresh: 1, stale: 1 })
  })

  it('tolerates missing or non-JSON output', () => {
    expect(parseHitCounts(null)).toEqual({ fresh: 0, stale: 0 })
    expect(parseHitCounts('● fresh raw text ○ stale')).toEqual({ fresh: 1, stale: 1 })
  })
})

// ── analyzer ───────────────────────────────────────────────────────────────

describe('analyzeBrainUsage', () => {
  it('returns zeros for a turn with no searches (exploration alone is free)', () => {
    const tally = analyzeBrainUsage([tool('Grep'), bash('rg foo'), tool('Read')])
    expect(tally).toEqual({ searches: 0, freshHits: 0, staleHits: 0, misses: 0 })
  })

  it('counts a search with parsed hits and no miss when no exploration follows', () => {
    const tally = analyzeBrainUsage([
      bash(SEARCH, '1. ● fresh symbol a.ts:1\n2. ○ stale note b.md'),
      tool('Read', { file_path: '/x' }),
    ])
    expect(tally).toEqual({ searches: 1, freshHits: 1, staleHits: 1, misses: 0 })
  })

  it('counts one miss per search even for a long exploration burst', () => {
    const tally = analyzeBrainUsage([
      bash(SEARCH),
      tool('Grep'),
      tool('Glob'),
      bash('rg fallback'),
    ])
    expect(tally).toEqual({ searches: 1, freshHits: 0, staleHits: 0, misses: 1 })
  })

  it('scopes miss windows per search', () => {
    const tally = analyzeBrainUsage([
      bash(SEARCH), // miss (grep below)
      tool('Grep'),
      bash(SEARCH, '1. ● fresh symbol a.ts:1'), // no exploration after → hit
      tool('Read', { file_path: '/x' }),
    ])
    expect(tally).toEqual({ searches: 2, freshHits: 1, staleHits: 0, misses: 1 })
  })

  it('does not count exploration before the first search as a miss', () => {
    const tally = analyzeBrainUsage([tool('Grep'), bash(SEARCH)])
    expect(tally).toEqual({ searches: 1, freshHits: 0, staleHits: 0, misses: 0 })
  })

  it('tolerates malformed input JSON', () => {
    const tally = analyzeBrainUsage([
      { toolName: 'Bash', inputJson: '{not json', outputJson: null },
      { toolName: 'Bash', inputJson: null, outputJson: null },
    ])
    expect(tally).toEqual({ searches: 0, freshHits: 0, staleHits: 0, misses: 0 })
  })
})

// ── rounds entry ───────────────────────────────────────────────────────────

describe('buildBrainUsageEntry', () => {
  it('builds the typed entry with a UTC per-day run id', () => {
    const now = new Date('2026-07-28T10:00:00.000Z')
    expect(brainUsageRunId(now)).toBe('brain-usage-20260728')
    expect(
      buildBrainUsageEntry({
        threadId: 't1',
        tally: { searches: 2, freshHits: 3, staleHits: 1, misses: 1 },
        savedTokens: 8_000,
        now,
      }),
    ).toEqual({
      ts: '2026-07-28T10:00:00.000Z',
      run_id: 'brain-usage-20260728',
      type: 'brain_usage',
      thread_id: 't1',
      searches: 2,
      fresh_hits: 3,
      stale_hits: 1,
      misses: 1,
      saved_tokens: 8_000,
    })
  })
})

// ── tracker (per-thread accumulation + persistence) ────────────────────────

describe('BrainUsageTracker', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'brain-usage-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function makeTracker(callsByThread: Map<string, BrainUsageToolCall[]>) {
    const work: Promise<unknown>[] = []
    const savings: Array<{ threadId: string; savedTokens: number }> = []
    const tracker = new BrainUsageTracker(
      {
        getThread: (id) => (callsByThread.has(id) ? { projectRoot: root } : null),
        listToolCallsSlim: (id, fromIndex) => (callsByThread.get(id) ?? []).slice(fromIndex),
      },
      () => new Date('2026-07-28T10:00:00.000Z'),
      (w) => work.push(w),
      // #1419: the harness records the provenance too — an uncalibrated turn
      // reports its hits so the stats line can show them (#1280).
      (threadId, savedTokens, provenance) =>
        savings.push({ threadId, savedTokens, ...provenance }),
    )
    return { tracker, flush: () => Promise.all(work), savings }
  }

  it('folds only NEW tool calls per turn and accumulates totals across turns', async () => {
    const calls: BrainUsageToolCall[] = [bash(SEARCH, '1. ● fresh symbol a.ts:1')]
    const byThread = new Map([['t1', calls]])
    const { tracker, flush } = makeTracker(byThread)

    tracker.onTurnComplete('t1')
    await flush()
    let totals = await readBrainUsageTotals(root)
    expect(totals).toMatchObject({ searches: 1, freshHits: 1, staleHits: 0, misses: 0 })

    // Turn 2 appends a missed search; turn 1's calls must not be re-counted.
    calls.push(bash(SEARCH), tool('Grep'))
    tracker.onTurnComplete('t1')
    await flush()
    totals = await readBrainUsageTotals(root)
    expect(totals).toMatchObject({ searches: 2, freshHits: 1, staleHits: 0, misses: 1 })
    expect(totals.updatedAt).toBe('2026-07-28T10:00:00.000Z')
  })

  it('appends one brain_usage rounds entry per counting turn', async () => {
    const byThread = new Map([['t1', [bash(SEARCH, '1. ○ stale note x.md')]]])
    const { tracker, flush } = makeTracker(byThread)
    tracker.onTurnComplete('t1')
    await flush()

    const lines = readFileSync(join(root, 'flow', '.rounds.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      type: 'brain_usage',
      thread_id: 't1',
      searches: 1,
      stale_hits: 1,
      misses: 0,
    })
  })

  it('writes nothing for turns without a brain search', async () => {
    const byThread = new Map([['t1', [tool('Grep'), bash('rg foo')]]])
    const { tracker, flush } = makeTracker(byThread)
    tracker.onTurnComplete('t1')
    await flush()
    expect(existsSync(join(root, 'flow', '.rounds.jsonl'))).toBe(false)
    expect(existsSync(join(root, 'flow', 'brain', '.structure', 'brain-usage.json'))).toBe(false)
  })

  it('banks NOTHING while uncalibrated, but still reports the hit (#1419)', async () => {
    const byThread = new Map([['t1', [bash(SEARCH, '1. ● fresh symbol a.ts:1'), tool('Read')]]])
    const { tracker, flush, savings } = makeTracker(byThread)
    tracker.onTurnComplete('t1')
    await flush()

    // #1419: a fresh store has no burst samples, so there is no baseline to
    // price against — banking `hits × 8_000` there mixed two scales in one
    // cumulative total (the measured medians on real stores are ~678).
    const totals = await readBrainUsageTotals(root)
    expect(totals.savedTokens).toBe(0)
    expect(totals.calibrated).toBe(false)
    // …but the turn still reports its HIT, so the stats line can say so
    // (#1280) rather than going silent.
    expect(savings).toEqual([
      { threadId: 't1', savedTokens: 0, calibrated: false, hits: 1 },
    ])
    const entry = JSON.parse(
      readFileSync(join(root, 'flow', '.rounds.jsonl'), 'utf8').trim(),
    ) as Record<string, unknown>
    expect(entry.saved_tokens).toBe(0)
  })

  it('a hit turn feeds the stats-line: the onSavings payload IS the brain-savings stream event', async () => {
    // main/index.ts forwards this callback verbatim as the `brain-savings`
    // threads:stream event the conversation pane's "~Nk saved" segment reads —
    // this pins that a hit-turn actually produces a well-formed emission.
    const byThread = new Map([['t1', [bash(SEARCH, '1. ● fresh symbol a.ts:1'), tool('Read')]]])
    const { tracker, flush, savings } = makeTracker(byThread)
    tracker.onTurnComplete('t1')
    await flush()
    expect(savings).toHaveLength(1)
    const emitted = savings[0] as {
      threadId: string
      savedTokens: number
      calibrated?: boolean
      hits?: number
    }
    const event: import('../../shared/ipc-contract').AgentStreamEvent = {
      kind: 'brain-savings',
      threadId: emitted.threadId,
      savedTokens: emitted.savedTokens,
    }
    expect(event).toEqual({
      kind: 'brain-savings',
      threadId: 't1',
      savedTokens: 0, // #1419: uncalibrated banks nothing; the HIT is the signal
    })
  })

  it('saves nothing for a miss turn but persists its measured burst sample', async () => {
    const burstOutput = 'g'.repeat(4_000) // 1,000 tokens measured
    const byThread = new Map([
      ['t1', [bash(SEARCH), { toolName: 'Grep', inputJson: '{}', outputJson: JSON.stringify(burstOutput) }]],
    ])
    const { tracker, flush, savings } = makeTracker(byThread)
    tracker.onTurnComplete('t1')
    await flush()

    const store = await readBrainUsageStore(root)
    expect(store.totals.savedTokens).toBe(0)
    expect(store.burstSamples).toEqual([1_000])
    expect(savings).toEqual([]) // zero-savings turns never fire the event
  })

  it('prices hits at the project median once enough burst samples exist', async () => {
    // Seed a store whose rolling samples already establish a median of 5,000.
    const structureDir = join(root, 'flow', 'brain', '.structure')
    mkdirSync(structureDir, { recursive: true })
    writeFileSync(
      join(structureDir, 'brain-usage.json'),
      JSON.stringify({
        searches: 3,
        freshHits: 0,
        staleHits: 0,
        misses: 3,
        savedTokens: 0,
        updatedAt: '2026-07-27T00:00:00.000Z',
        burstSamples: [4_000, 6_000, 5_000],
      }),
    )
    const byThread = new Map([['t1', [bash(SEARCH, '1. ● fresh symbol a.ts:1')]]])
    const { tracker, flush, savings } = makeTracker(byThread)
    tracker.onTurnComplete('t1')
    await flush()

    const totals = await readBrainUsageTotals(root)
    expect(totals.savedTokens).toBe(5_000)
    expect(savings).toEqual([
      { threadId: 't1', savedTokens: 5_000, calibrated: true, hits: 1 },
    ])
  })

  it('ignores unknown threads and repeated completions with no new calls', async () => {
    const byThread = new Map([['t1', [bash(SEARCH)]]])
    const { tracker, flush } = makeTracker(byThread)
    tracker.onTurnComplete('missing') // unknown thread — no-op
    tracker.onTurnComplete('t1')
    tracker.onTurnComplete('t1') // no new calls — no-op
    await flush()
    const totals = await readBrainUsageTotals(root)
    expect(totals.searches).toBe(1)
  })
})

// ── totals read fail-soft ──────────────────────────────────────────────────

describe('readBrainUsageTotals', () => {
  it('answers zeros for a root with no store', async () => {
    const root = mkdtempSync(join(tmpdir(), 'brain-usage-empty-'))
    try {
      expect(await readBrainUsageTotals(root)).toEqual({
        searches: 0,
        freshHits: 0,
        staleHits: 0,
        misses: 0,
        savedTokens: 0,
        // No samples → the baseline is the flat default, so the store reports
        // itself uncalibrated (#1280).
        calibrated: false,
        updatedAt: null,
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

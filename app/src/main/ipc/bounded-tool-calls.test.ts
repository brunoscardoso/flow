import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ToolCallRecord } from '../../shared/ipc-contract'
import { boundedToolCalls } from './index'

function call(id: string, outputJson: string | null = 'x'.repeat(8_000)): ToolCallRecord {
  return {
    id,
    threadId: 'th-1',
    messageId: null,
    toolName: 'Read',
    inputJson: '{"file_path":"/a/b.ts"}',
    outputJson,
    status: 'success',
    startedAt: '2026-08-18T10:00:00.000Z',
    completedAt: '2026-08-18T10:00:01.000Z',
  }
}

describe('boundedToolCalls — the heaviest read in the app, bounded', () => {
  // MEASURED, which is why this exists: a synthetic 600-call thread with 8 KB
  // outputs serializes to 4.96 MB, and the pane re-reads it on every open AND
  // every turn's reconcile. That is what a five-second click is made of.
  const thread = [call('1'), call('2'), call('3'), call('4'), call('5')]

  it('keeps the NEWEST outputs — the ones the pane actually mounts', () => {
    // listToolCalls returns oldest first, so the newest are the tail.
    const bounded = boundedToolCalls(thread, 2)
    expect(bounded.map((entry) => entry.outputJson === null)).toEqual([true, true, true, false, false])
    expect(bounded.map((entry) => entry.outputWithheld === true)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ])
  })

  it('says WITHHELD rather than empty — the two are different facts', () => {
    // A card that renders "not sent" as "no output" is the app lying about
    // what it stored, so the flag rides the record and the card reads it.
    const [oldest] = boundedToolCalls(thread, 1)
    expect(oldest?.outputJson).toBeNull()
    expect(oldest?.outputWithheld).toBe(true)
  })

  it('never marks a call that HAS no output', () => {
    const mixed = [call('1', null), call('2')]
    const bounded = boundedToolCalls(mixed, 1)
    expect(bounded[0]?.outputWithheld).toBeUndefined()
    expect(bounded[0]?.outputJson).toBeNull()
  })

  it('hands back everything when no limit is asked for', () => {
    for (const limit of [undefined, 0, -1]) {
      const all = boundedToolCalls(thread, limit)
      expect(all.every((entry) => entry.outputJson !== null)).toBe(true)
      expect(all.every((entry) => entry.outputWithheld === undefined)).toBe(true)
    }
  })

  it('never mutates the store’s own rows', () => {
    // They are shared with the caller that asked for everything; emptying one
    // here is how an output would exist in SQLite and nowhere else.
    const rows = [call('1'), call('2')]
    boundedToolCalls(rows, 1)
    expect(rows[0]?.outputJson).not.toBeNull()
  })

  it('is a no-op for a thread shorter than the limit', () => {
    const short = boundedToolCalls(thread, 50)
    expect(short.every((entry) => entry.outputJson !== null)).toBe(true)
  })
})

describe('the input half — a write carries a whole file', () => {
  // MEASURED: with 20% Write calls carrying ~14 KB files, the inputs alone are
  // 2.18 MB of a 600-call session — the bulk left over once outputs are
  // bounded. But the COLLAPSED card prints `file_path` out of that input, so
  // withholding it outright would blank the summary line of every old write.
  const write = (content: string): ToolCallRecord => ({
    ...call('w', null),
    toolName: 'Write',
    inputJson: JSON.stringify({ file_path: '/repo/src/big.ts', content }),
  })

  it('keeps the summary scalars and drops the bulk', () => {
    const [trimmed] = boundedToolCalls([write('x'.repeat(20_000)), call('newest')], 1)
    expect(trimmed?.inputWithheld).toBe(true)
    const parsed = JSON.parse(trimmed?.inputJson ?? '{}') as Record<string, unknown>
    // The card's summary still reads exactly as it did…
    expect(parsed['file_path']).toBe('/repo/src/big.ts')
    // …and the file it was carrying is gone.
    expect(parsed['content']).toBeUndefined()
    expect((trimmed?.inputJson ?? '').length).toBeLessThan(500)
  })

  it('leaves a small input completely alone', () => {
    const small = { ...call('s', null), inputJson: '{"file_path":"/a/b.ts"}' }
    const [trimmed] = boundedToolCalls([small, call('newest')], 1)
    expect(trimmed?.inputJson).toBe('{"file_path":"/a/b.ts"}')
    expect(trimmed?.inputWithheld).toBeUndefined()
  })

  it('keeps a prefix of an input that does not parse — a summary needs text', () => {
    const broken = { ...call('b', null), inputJson: `not json ${'x'.repeat(9_000)}` }
    const [trimmed] = boundedToolCalls([broken, call('newest')], 1)
    expect(trimmed?.inputWithheld).toBe(true)
    expect(trimmed?.inputJson?.startsWith('not json')).toBe(true)
    expect((trimmed?.inputJson ?? '').length).toBeLessThanOrEqual(2_000)
  })

  it('summarizes EVERY key the card might print', () => {
    // The card's own list, asserted against — the two live on opposite sides of
    // the IPC boundary and a key that survives here but not there is a summary
    // line that silently empties.
    const source = readFileSync(
      join(__dirname, '..', '..', 'renderer', 'threads', 'tool-card.ts'),
      'utf-8',
    )
    const declared = /const SUMMARY_KEYS = \[([^\]]*)\]/.exec(source)?.[1] ?? ''
    const keys = [...declared.matchAll(/'([^']+)'/g)].map((match) => match[1])
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      const input = JSON.stringify({ [key]: '/some/value', body: 'y'.repeat(20_000) })
      const [trimmed] = boundedToolCalls([{ ...call('k', null), inputJson: input }, call('n')], 1)
      const parsed = JSON.parse(trimmed?.inputJson ?? '{}') as Record<string, unknown>
      expect({ key, kept: parsed[key] }).toEqual({ key, kept: '/some/value' })
    }
  })
})

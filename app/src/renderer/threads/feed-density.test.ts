import {
  DEFAULT_FEED_DENSITY,
  FEED_DENSITIES,
  feedEntries,
  feedUnits,
  isFeedDensity,
  projectFeed,
  type FeedClassifiers,
  type FeedUnit,
} from './feed-density'
import type { RequestRole } from './request-summary'
import type { TurnRole } from './turn-summary'
import type { ToolCallRecord } from '../../shared/ipc-contract'

// ── Fixtures ────────────────────────────────────────────────────────────────
//
// A tiny stand-in for the pane's HistoryEntry: the projection is generic and
// imports no view types, so the test does not need a ToolCallRecord either.

type Entry =
  | { kind: 'assistant'; id: string; endsTurn?: boolean }
  | { kind: 'user'; id: string }
  | { kind: 'tool'; id: string; messageId: string | null; key: string | null }

const assistant = (id: string, endsTurn = false): Entry => ({ kind: 'assistant', id, endsTurn })
const user = (id: string): Entry => ({ kind: 'user', id })
const tool = (id: string, messageId: string | null, key: string | null = 'command'): Entry => ({
  kind: 'tool',
  id,
  messageId,
  key,
})

const classifiers: FeedClassifiers<Entry> = {
  turnRole: (entry): TurnRole => {
    if (entry.kind === 'tool') return { kind: 'tool', messageId: entry.messageId }
    if (entry.kind === 'assistant') return { kind: 'assistant', messageId: entry.id }
    return { kind: 'break' }
  },
  requestRole: (entry): RequestRole => {
    if (entry.kind === 'user') return { kind: 'user' }
    if (entry.kind === 'assistant') {
      return {
        kind: 'assistant',
        messageId: entry.id,
        endsTurn: entry.endsTurn === true,
        content: entry.id,
        model: null,
        createdAt: '2026-10-08T10:00:00.000Z',
      }
    }
    return { kind: 'tool', messageId: entry.messageId, record: { id: entry.id } as ToolCallRecord }
  },
  groupKey: (entry) => (entry.kind === 'tool' ? entry.key : null),
}

/**
 * A representative feed: a user turn, an assistant turn with a groupable run of
 * commands plus an ungrouped edit, a second assistant turn with a null-messageId
 * call, and a trailing orphan tool whose turn is outside the slice.
 */
const representative: Entry[] = [
  user('u1'),
  assistant('m1'),
  tool('t1', 'm1'),
  tool('t2', 'm1'),
  tool('t3', 'm1'),
  tool('t4', 'm1', 'edit:/a.ts'),
  assistant('m2'),
  tool('t5', null),
  user('u2'),
  tool('t6', 'm9'),
]

const ids = (units: readonly FeedUnit<Entry>[]): string[] =>
  feedEntries(units).map((entry) => entry.id)

// ── The point of the phase ──────────────────────────────────────────────────

describe('projectFeed — Detailed is the identity', () => {
  // This is the assertion the phase exists for. The reference product shipped
  // exactly this feature and then shipped a release that collapsed detail in
  // defiance of the setting, which its users filed as "hides tool call details
  // in defiance of setting" (plan_chat-feed-signal_v1, C-2 / FR-7). Asserting
  // reference equality — not deep equality — makes that regression unavailable:
  // any implementation that rebuilds, re-folds, filters or even maps the list
  // fails here before it can reach a reader.
  it('returns the SAME array it was given', () => {
    const units = feedUnits(representative)
    expect(projectFeed('detailed', units, classifiers)).toBe(units)
  })

  it('returns the same array for every unit shape, not just the atomic one', () => {
    const shapes: Array<FeedUnit<Entry>[]> = [
      [],
      feedUnits(representative),
      [{ level: 'group', key: 'command', entries: [tool('t1', 'm1'), tool('t2', 'm1')] }],
      [{ level: 'turn', messageId: 'm1', head: assistant('m1'), tools: [tool('t1', 'm1')] }],
      projectFeed('compact', feedUnits(representative), classifiers) as FeedUnit<Entry>[],
      // A mixture no producer emits today, to pin the identity as total rather
      // than as a property of the input the pane happens to build.
      [
        { level: 'entry', entry: user('u1') },
        { level: 'turn', messageId: 'm1', head: assistant('m1'), tools: [tool('t1', 'm1')] },
        { level: 'group', key: 'context', entries: [tool('t2', null), tool('t3', null)] },
      ],
    ]
    for (const units of shapes) {
      expect(projectFeed('detailed', units, classifiers)).toBe(units)
    }
  })

  it('does not mutate what it hands back', () => {
    const units = feedUnits(representative)
    const before = JSON.stringify(units)
    projectFeed('detailed', units, classifiers)
    expect(JSON.stringify(units)).toBe(before)
  })

  it('keeps every tool call visible as its own unit', () => {
    const projected = projectFeed('detailed', feedUnits(representative), classifiers)
    expect(projected.every((unit) => unit.level === 'entry')).toBe(true)
    expect(projected).toHaveLength(representative.length)
  })
})

// ── The other two rungs ─────────────────────────────────────────────────────

describe('projectFeed — compact is the request fold', () => {
  it('folds each request into one request unit, from the message to the answer', () => {
    const projected = projectFeed('compact', feedUnits(representative), classifiers)
    expect(projected.map((unit) => unit.level)).toEqual(['request', 'request'])
    const [first, second] = projected as Array<Extract<FeedUnit<Entry>, { level: 'request' }>>
    expect(first.request.user?.id).toBe('u1')
    // Unmarked (stored before the turn-end mark): the last assistant message answers.
    expect(first.request.answer?.id).toBe('m2')
    expect(first.request.steps.map((step) => [step.head?.id ?? null, step.tools.map((t) => t.id)])).toEqual([
      ['m1', ['t1', 't2', 't3', 't4']],
      [null, ['t5']],
    ])
    expect(second.request.user?.id).toBe('u2')
    expect(second.request.live).toBe(true)
  })

  it('chooses the answer from the turn-end mark', () => {
    const marked: Entry[] = [user('u1'), assistant('m1', true), assistant('m2'), tool('t1', 'm2')]
    const [unit] = projectFeed('compact', feedUnits(marked), classifiers)
    expect(unit).toMatchObject({ level: 'request' })
    const { request } = unit as Extract<FeedUnit<Entry>, { level: 'request' }>
    expect(request.answer?.id).toBe('m1')
    expect(request.steps.map((step) => step.head?.id ?? null)).toEqual(['m2'])
  })

  it('has no turn units — the turn fold moved to Balanced', () => {
    const projected = projectFeed('compact', feedUnits(representative), classifiers)
    expect(projected.length).toBeGreaterThan(0)
    expect(projected.some((unit) => unit.level === 'turn')).toBe(false)
  })
})

describe('projectFeed — balanced is the per-message turn fold', () => {
  it('folds a settled turn into one unit and leaves breaks alone', () => {
    const projected = projectFeed('balanced', feedUnits(representative), classifiers)
    const turns = projected.filter((unit) => unit.level === 'turn')
    expect(turns).toHaveLength(2)
    expect(turns[0]).toMatchObject({ messageId: 'm1' })
    expect((turns[0] as { tools: Entry[] }).tools.map((entry) => entry.id)).toEqual([
      't1',
      't2',
      't3',
      't4',
    ])
    // A null-messageId call joins the turn in progress rather than opening one.
    expect((turns[1] as { tools: Entry[] }).tools.map((entry) => entry.id)).toEqual(['t5'])
    expect(projected.some((unit) => unit.level === 'request')).toBe(false)
  })

  it('groups the entries that belong to no turn, in contiguous runs', () => {
    const orphans: Entry[] = [
      user('u1'),
      tool('o1', 'gone'),
      tool('o2', 'gone'),
      tool('o3', 'gone'),
    ]
    const projected = projectFeed('balanced', feedUnits(orphans), classifiers)
    expect(projected.map((unit) => unit.level)).toEqual(['entry', 'group'])
  })
})

// ── Invariants shared by all three ──────────────────────────────────────────

describe('projectFeed — invariants', () => {
  it('never drops, duplicates or reorders an entry, at any density', () => {
    const expected = representative.map((entry) => entry.id)
    for (const density of FEED_DENSITIES) {
      expect(ids(projectFeed(density, feedUnits(representative), classifiers))).toEqual(expected)
    }
  })

  it('is independent of the density its input was produced at', () => {
    // A reader toggling Compact → Balanced (and back) must land on the same
    // picture as one who went straight there — the projection re-folds from
    // entries, never from whatever depth it was handed.
    const direct = projectFeed('balanced', feedUnits(representative), classifiers)
    const viaCompact = projectFeed(
      'balanced',
      projectFeed('compact', feedUnits(representative), classifiers),
      classifiers,
    )
    expect(viaCompact).toEqual(direct)
    const compact = projectFeed('compact', feedUnits(representative), classifiers)
    expect(projectFeed('compact', direct, classifiers)).toEqual(compact)
  })

  it('is idempotent per density', () => {
    for (const density of FEED_DENSITIES) {
      const once = projectFeed(density, feedUnits(representative), classifiers)
      expect(projectFeed(density, once, classifiers)).toEqual(once)
    }
  })

  it('handles an empty feed', () => {
    for (const density of FEED_DENSITIES) {
      expect(projectFeed(density, [], classifiers)).toEqual([])
    }
  })
})

describe('feed density values', () => {
  it('defaults to compact — the fold this feature exists to deliver', () => {
    expect(DEFAULT_FEED_DENSITY).toBe('compact')
  })

  it('accepts only the three known values', () => {
    expect(FEED_DENSITIES.every((density) => isFeedDensity(density))).toBe(true)
    for (const value of ['Compact', 'verbose', '', null, undefined, 3, {}]) {
      expect(isFeedDensity(value)).toBe(false)
    }
  })
})

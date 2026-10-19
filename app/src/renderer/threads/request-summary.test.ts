import type { ToolCallRecord, ToolCallStatus } from '../../shared/ipc-contract'
import {
  formatRequestElapsed,
  isNoChangeAnswer,
  planRequests,
  requestRowLabel,
  requestRowSegments,
  requestSummary,
  type Request,
  type RequestRole,
  type RequestUnit,
} from './request-summary'

// ── Fixtures ────────────────────────────────────────────────────────────────

type Entry =
  | { kind: 'user'; id: string; at: string }
  | { kind: 'assistant'; id: string; text: string; endsTurn: boolean; model: string | null; at: string }
  | { kind: 'tool'; id: string; record: ToolCallRecord }
  | { kind: 'card'; id: string }
  | { kind: 'system'; id: string }

const T0 = Date.parse('2026-10-08T10:00:00.000Z')
const at = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString()

const user = (id: string, minute = 0): Entry => ({ kind: 'user', id, at: at(minute) })
const say = (
  id: string,
  text: string,
  options: { ends?: boolean; model?: string | null; minute?: number } = {},
): Entry => ({
  kind: 'assistant',
  id,
  text,
  endsTurn: options.ends ?? false,
  model: options.model === undefined ? 'claude-opus-4-8' : options.model,
  at: at(options.minute ?? 0),
})
const tool = (
  id: string,
  messageId: string | null,
  options: { status?: ToolCallStatus; name?: string; file?: string; minute?: number } = {},
): Entry => ({
  kind: 'tool',
  id,
  record: {
    id,
    threadId: 'th',
    messageId,
    toolName: options.name ?? 'Bash',
    inputJson: options.file === undefined ? '{"command":"ls"}' : JSON.stringify({ file_path: options.file }),
    outputJson: null,
    status: options.status ?? 'success',
    startedAt: at(options.minute ?? 0),
    completedAt: at(options.minute ?? 0),
  },
})
const card = (id: string): Entry => ({ kind: 'card', id })
const system = (id: string): Entry => ({ kind: 'system', id })

const classify = (entry: Entry): RequestRole => {
  switch (entry.kind) {
    case 'user':
      return { kind: 'user', createdAt: entry.at }
    case 'assistant':
      return {
        kind: 'assistant',
        messageId: entry.id,
        endsTurn: entry.endsTurn,
        content: entry.text,
        model: entry.model,
        createdAt: entry.at,
      }
    case 'tool':
      return { kind: 'tool', messageId: entry.record.messageId, record: entry.record }
    case 'card':
      return { kind: 'card' }
    case 'system':
      return { kind: 'other' }
  }
}

const requests = (units: Array<RequestUnit<Entry>>): Array<Request<Entry>> =>
  units.filter((unit): unit is Request<Entry> => unit.request)

const id = (entry: Entry | null): string | null => (entry === null ? null : entry.id)

const stepShape = (request: Request<Entry>): Array<[string | null, string[]]> =>
  request.steps.map((step) => [id(step.head), step.tools.map((entry) => entry.id)])

/** Every entry, in order, exactly once — from the units alone. */
const flatten = (units: Array<RequestUnit<Entry>>): string[] =>
  units.flatMap((unit) => (unit.request ? unit.entries.map((entry) => entry.id) : [unit.entry.id]))

// ── isNoChangeAnswer ────────────────────────────────────────────────────────

describe('isNoChangeAnswer', () => {
  it('is true for the exact text, trimmed', () => {
    expect(isNoChangeAnswer('No change.')).toBe(true)
    expect(isNoChangeAnswer('  No change.\n')).toBe(true)
  })

  it('never guesses from other wording', () => {
    for (const text of ['No change', 'no change.', '`No change.`', 'No change. Waiting.', 'Nothing new.', '']) {
      expect(isNoChangeAnswer(text)).toBe(false)
    }
  })
})

// ── planRequests ────────────────────────────────────────────────────────────

describe('planRequests — one request, steps and one answer', () => {
  const feed: Entry[] = [
    user('u1'),
    say('m1', 'Reading the plan.'),
    tool('t1', 'm1'),
    tool('t2', 'm1'),
    say('m2', 'Writing phase 1.'),
    tool('t3', 'm2', { name: 'Edit', file: '/a.ts' }),
    say('m3', 'Running the tests.'),
    tool('t4', 'm3'),
    say('m4', 'Done. Phase 1 is in.', { ends: true }),
  ]

  it('folds three step messages and their tools under one request with the final answer', () => {
    const units = planRequests(feed, classify)
    expect(units).toHaveLength(1)
    const [request] = requests(units)
    expect(id(request.user)).toBe('u1')
    expect(stepShape(request)).toEqual([
      ['m1', ['t1', 't2']],
      ['m2', ['t3']],
      ['m3', ['t4']],
    ])
    expect(id(request.answer)).toBe('m4')
    expect(request.hiddenNoChange).toBe(0)
    expect(request.live).toBe(false)
    // …and the answer is not also a step.
    expect(request.steps.some((step) => step.head === request.answer)).toBe(false)
  })

  it('keeps order and every entry exactly once', () => {
    const units = planRequests(feed, classify)
    expect(flatten(units)).toEqual(feed.map((entry) => entry.id))
  })
})

describe('planRequests — wake-ups (FR-9, FR-10)', () => {
  it('hides a wake-up turn ending "No change." and keeps the earlier answer', () => {
    const feed: Entry[] = [
      user('u1'),
      say('m1', 'Started two helpers.'),
      tool('t1', 'm1'),
      say('m2', 'The helpers run. I will report.', { ends: true }),
      say('m3', 'Checking the helpers.'),
      tool('t2', 'm3'),
      say('m4', 'No change.', { ends: true }),
    ]
    const [request] = requests(planRequests(feed, classify))
    expect(id(request.answer)).toBe('m2')
    expect(request.hiddenNoChange).toBe(1)
    expect(stepShape(request)).toEqual([
      ['m1', ['t1']],
      ['m3', ['t2']],
    ])
    // The hidden reply is not shown anywhere, yet it is still in the record.
    const shown = [...request.steps.map((step) => step.head), request.answer]
    expect(shown.map(id)).not.toContain('m4')
    expect(request.entries.map((entry) => entry.id)).toContain('m4')
  })

  it('lets a wake-up with a real new answer replace the shown answer', () => {
    const feed: Entry[] = [
      user('u1'),
      say('m1', 'The helpers run. I will report.', { ends: true }),
      say('m2', 'One helper finished.'),
      tool('t1', 'm2'),
      say('m3', 'Both helpers are done. All tests pass.', { ends: true }),
    ]
    const [request] = requests(planRequests(feed, classify))
    expect(id(request.answer)).toBe('m3')
    // The earlier turn-ending message stays as a step.
    expect(stepShape(request)).toEqual([
      ['m1', []],
      ['m2', ['t1']],
    ])
    expect(request.hiddenNoChange).toBe(0)
  })
})

describe('planRequests — cards and other rows', () => {
  it('passes a question card through and splits the request at it', () => {
    const feed: Entry[] = [
      user('u1'),
      say('m1', 'Reading.'),
      tool('t1', 'm1'),
      card('q1'),
      say('m2', 'Using your answer.'),
      tool('t2', 'm2'),
      say('m3', 'Done.', { ends: true }),
    ]
    const units = planRequests(feed, classify)
    expect(units.map((unit) => (unit.request ? 'request' : unit.entry.id))).toEqual([
      'request',
      'q1',
      'request',
    ])
    const [before, after] = requests(units)
    expect(id(before.user)).toBe('u1')
    expect(stepShape(before)).toEqual([['m1', ['t1']]])
    expect(before.answer).toBeNull()
    expect(before.live).toBe(false)
    expect(after.user).toBeNull()
    expect(id(after.answer)).toBe('m3')
    expect(flatten(units)).toEqual(feed.map((entry) => entry.id))
  })

  it('puts system rows after the answer, in their order', () => {
    const feed: Entry[] = [user('u1'), say('m1', 'Writing.'), system('s1'), say('m2', 'Done.', { ends: true }), system('s2')]
    const [request] = requests(planRequests(feed, classify))
    expect(request.trailing.map((entry) => entry.id)).toEqual(['s1', 's2'])
    expect(id(request.answer)).toBe('m2')
  })

  it('passes a system row before any request through as itself', () => {
    const units = planRequests([system('s0'), user('u1')], classify)
    expect(units[0]).toEqual({ request: false, entry: system('s0') })
    expect(units[1].request).toBe(true)
  })
})

describe('planRequests — old threads and live requests', () => {
  it('falls back to the last assistant message when no message carries the mark', () => {
    const feed: Entry[] = [user('u1'), say('m1', 'Reading.'), tool('t1', 'm1'), say('m2', 'Here is the answer.')]
    const [request] = requests(planRequests(feed, classify))
    expect(id(request.answer)).toBe('m2')
    expect(stepShape(request)).toEqual([['m1', ['t1']]])
    expect(request.live).toBe(false)
  })

  it('marks the last request live while no turn has ended', () => {
    const feed: Entry[] = [
      user('u1'),
      say('m1', 'Done.', { ends: true }),
      user('u2'),
      say('m2', 'Wake-up check.', { ends: false }),
      tool('t1', 'm2'),
      say('m3', 'Reading the helper output.', { ends: false }),
    ]
    const units = planRequests(feed, classify, { running: true })
    const [first, last] = requests(units)
    expect(first.live).toBe(false)
    expect(id(first.answer)).toBe('m1')
    expect(last.live).toBe(true)
    // Running: no fallback answer — the unmarked messages are steps.
    expect(last.answer).toBeNull()
    expect(stepShape(last)).toEqual([
      ['m2', ['t1']],
      ['m3', []],
    ])
  })

  it('infers live when the last request has only tools and no answer', () => {
    const feed: Entry[] = [user('u1'), tool('t1', null), tool('t2', null)]
    const [request] = requests(planRequests(feed, classify))
    expect(stepShape(request)).toEqual([[null, ['t1', 't2']]])
    expect(request.live).toBe(true)
  })

  it('is not live once the thread says it is not running', () => {
    const feed: Entry[] = [user('u1'), tool('t1', null)]
    const [request] = requests(planRequests(feed, classify, { running: false }))
    expect(request.live).toBe(false)
  })
})

// ── requestSummary and the row's line ──────────────────────────────────────

describe('requestSummary', () => {
  const feed: Entry[] = [
    user('u1', 0),
    say('m1', 'Writing.', { minute: 1 }),
    tool('t1', 'm1', { name: 'Edit', file: '/a.ts', minute: 2 }),
    tool('t2', 'm1', { name: 'Edit', file: '/a.ts', minute: 3 }),
    tool('t3', 'm1', { name: 'Write', file: '/b.ts', minute: 3 }),
    tool('t4', 'm1', { status: 'error', minute: 4 }),
    tool('t5', 'm1', { status: 'interrupted', minute: 5 }),
    say('m2', 'Done.', { ends: true, model: 'claude-opus-4-8', minute: 6 }),
  ]

  it('counts tools, failures and distinct files with the turn-row rule', () => {
    const [request] = requests(planRequests(feed, classify))
    const summary = requestSummary(request, { classify })
    expect(summary.tools).toBe(5)
    // error counts; interrupted (stopped by the person) does not.
    expect(summary.failed).toBe(1)
    expect(summary.filesEdited).toBe(2)
    expect(summary.model).toBe('claude-opus-4-8')
    expect(summary.elapsedMs).toBe(6 * 60_000)
    expect(requestRowLabel(summary, false)).toBe('Worked 6 min · 5 tools · 1 failed · 2 files edited')
  })

  it('times a live request to now', () => {
    const live: Entry[] = [user('u1', 0), say('m1', 'Reading.', { minute: 1 }), tool('t1', 'm1', { minute: 2 })]
    const [request] = requests(planRequests(live, classify, { running: true }))
    expect(request.live).toBe(true)
    const summary = requestSummary(request, { classify, now: () => T0 + 3 * 60_000 })
    expect(summary.elapsedMs).toBe(3 * 60_000)
    expect(requestRowLabel(summary, true)).toBe('Working · 3 min · 1 tool')
  })
})

describe('requestRowSegments', () => {
  it('omits zero segments and flags only the failure segment, by value', () => {
    const segments = requestRowSegments(
      { elapsedMs: 60_000, tools: 2, failed: 2, filesEdited: 0, model: null },
      false,
    )
    expect(segments).toEqual([
      { text: 'Worked 1 min', failed: false },
      { text: '2 tools', failed: false },
      { text: '2 failed', failed: true },
    ])
  })

  it('says nothing about time when no time is known', () => {
    expect(requestRowLabel({ elapsedMs: null, tools: 0, failed: 0, filesEdited: 0, model: null }, false)).toBe(
      'Worked',
    )
  })
})

describe('formatRequestElapsed', () => {
  it('formats minutes and hours', () => {
    expect(formatRequestElapsed(0)).toBe('<1 min')
    expect(formatRequestElapsed(59_000)).toBe('<1 min')
    expect(formatRequestElapsed(6 * 60_000 + 50_000)).toBe('6 min')
    expect(formatRequestElapsed(60 * 60_000)).toBe('1 h')
    expect(formatRequestElapsed(65 * 60_000)).toBe('1 h 5 min')
  })
})

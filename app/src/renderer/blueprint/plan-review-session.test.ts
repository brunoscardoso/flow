import type { PlanNoteReport, PlanNotesAnswer, PlanSetNoteAnswer, PlanSetNoteRequest } from '../../shared/ipc-contract'
import { draftStorageKey, type DraftStorage } from './note-review-model'
import { OWN_WRITE_ECHO_MS, PlanReviewSession, type PlanReviewDeps } from './plan-review-session'

function note(n: number, extra: Partial<PlanNoteReport> = {}): PlanNoteReport {
  return {
    n,
    phase: 1,
    kind: 'change',
    target: `file:src/a.ts:fn${String(n)}`,
    file: 'src/a.ts',
    symbol: `fn${String(n)}`,
    status: 'proposed',
    comments: [],
    ...extra,
  }
}

function snapshot(notes: PlanNoteReport[]): PlanNotesAnswer {
  return {
    ok: true,
    plan: 'pay',
    path: 'flow/plans/plan_pay_v1.md',
    notes,
    counts: { total: notes.length, accepted: 0, rejected: 0, unreviewed: notes.length },
    unreadable: [],
  }
}

function memoryStorage(): DraftStorage & { data: Record<string, string> } {
  const data: Record<string, string> = {}
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
    removeItem: (key) => {
      delete data[key]
    },
  }
}

function harness(options: { notes?: PlanNoteReport[]; setNote?: (request: PlanSetNoteRequest) => Promise<PlanSetNoteAnswer>; threadId?: string | null } = {}) {
  const sent: Array<{ threadId: string; text: string }> = []
  const writes: PlanSetNoteRequest[] = []
  const storage = memoryStorage()
  const notes = options.notes ?? [note(1), note(2)]
  const deps: PlanReviewDeps = {
    notes: async () => snapshot(notes),
    setNote:
      options.setNote ??
      (async (request) => {
        writes.push(request)
        const base = notes.find((entry) => entry.n === request.note) as PlanNoteReport
        const written: PlanNoteReport = {
          ...base,
          ...(request.status === undefined ? {} : { status: request.status }),
          ...(request.reason === undefined ? {} : { reason: request.reason }),
          ...(request.verdict === undefined ? {} : { verdict: request.verdict, verdictWhy: request.why ?? '' }),
        }
        return { ok: true, plan: 'pay', path: 'flow/plans/plan_pay_v1.md', changed: true, note: written }
      }),
    storage,
    sendPrompt: (threadId, text) => sent.push({ threadId, text }),
  }
  let changes = 0
  const session = new PlanReviewSession(
    { rootPath: '/repo', plan: 'pay', threadId: options.threadId === undefined ? 't1' : options.threadId },
    deps,
    () => {
      changes += 1
    },
  )
  return { session, sent, writes, storage, changes: () => changes }
}

describe('PlanReviewSession', () => {
  it('reads the notes and knows its plan file', async () => {
    const { session } = harness()
    await session.load()
    expect(session.state.loaded).toBe(true)
    expect(session.state.notes.map((entry) => entry.n)).toEqual([1, 2])
    expect(session.isPlanFile('/repo', 'flow/plans/plan_pay_v1.md')).toBe(true)
    expect(session.isPlanFile('/repo', 'flow/plans/plan_other_v1.md')).toBe(false)
    expect(session.isPlanFile('/other', 'flow/plans/plan_pay_v1.md')).toBe(false)
  })

  it('keeps a failed read as one sentence', async () => {
    const { session } = harness()
    const failing = new PlanReviewSession(
      { rootPath: '/repo', plan: 'gone', threadId: null },
      { notes: async () => ({ ok: false, reason: 'unknown-plan', detail: 'Flow could not find that plan.' }), setNote: jest.fn(), storage: null, sendPrompt: jest.fn() },
      () => undefined,
    )
    await failing.load()
    expect(failing.state.error).toBe('Flow could not find that plan.')
    expect(session.state.error).toBeNull()
  })

  it('writes Accept and Reject at once, with an optional reason', async () => {
    const { session, writes } = harness()
    await session.load()
    await session.decide(1, 'accepted')
    await session.decide(2, 'rejected', '  one call site ')
    expect(writes).toEqual([
      { rootPath: '/repo', plan: 'pay', note: 1, status: 'accepted' },
      { rootPath: '/repo', plan: 'pay', note: 2, status: 'rejected', reason: 'one call site' },
    ])
    expect(session.state.notes.map((entry) => entry.status)).toEqual(['accepted', 'rejected'])
    expect(session.state.saves).toEqual({})
  })

  it('Accept all accepts the notes not reviewed yet, one write at a time, and leaves a rejected note rejected', async () => {
    let inFlight = 0
    let most = 0
    const written: PlanSetNoteRequest[] = []
    const notes = [note(1), note(2, { status: 'rejected', reason: 'no' }), note(3), note(4, { status: 'accepted' })]
    const { session } = harness({
      notes,
      setNote: async (request) => {
        inFlight += 1
        most = Math.max(most, inFlight)
        written.push(request)
        await Promise.resolve()
        inFlight -= 1
        const base = notes.find((entry) => entry.n === request.note) as PlanNoteReport
        return { ok: true, plan: 'pay', path: 'flow/plans/plan_pay_v1.md', changed: true, note: { ...base, status: request.status ?? base.status } }
      },
    })
    await session.load()
    await session.acceptAll()
    expect(written.map((request) => [request.note, request.status])).toEqual([
      [1, 'accepted'],
      [3, 'accepted'],
    ])
    expect(most).toBe(1)
    expect(session.state.notes.map((entry) => entry.status)).toEqual(['accepted', 'rejected', 'accepted', 'accepted'])
    expect(session.canSend).toBe(true)
  })

  it('Accept all marks only the note whose write failed as not saved', async () => {
    const { session } = harness({
      notes: [note(1), note(2)],
      setNote: async (request) =>
        request.note === 1
          ? { ok: false, reason: null, detail: 'Flow could not write this decision.' }
          : { ok: true, plan: 'pay', path: 'flow/plans/plan_pay_v1.md', changed: true, note: note(2, { status: 'accepted' }) },
    })
    await session.load()
    await session.acceptAll()
    expect(session.state.notes.map((entry) => entry.status)).toEqual(['proposed', 'accepted'])
    expect(session.state.saves).toEqual({ 1: { state: 'failed', detail: 'Flow could not write this decision.' } })
  })

  it('pressing the held decision again takes it back', async () => {
    const { session, writes } = harness({ notes: [note(1, { status: 'accepted' })] })
    await session.load()
    await session.decide(1, 'accepted')
    expect(writes[0]?.status).toBe('proposed')
  })

  it('a write that fails keeps the old decision and says not saved', async () => {
    const { session } = harness({ setNote: async () => ({ ok: false, reason: 'unknown-note', detail: 'That note is gone.' }) })
    await session.load()
    await session.decide(1, 'accepted')
    expect(session.state.notes[0]?.status).toBe('proposed')
    expect(session.state.saves[1]).toEqual({ state: 'failed', detail: 'That note is gone.' })
  })

  it('a write that throws is not saved either', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const { session } = harness({
      setNote: async () => {
        throw new Error('ipc down')
      },
    })
    await session.load()
    await session.decide(2, 'rejected')
    expect(session.state.notes[1]?.status).toBe('proposed')
    expect(session.state.saves[2]?.state).toBe('failed')
    error.mockRestore()
  })

  it('records a verdict with its sentence, and refuses one without', async () => {
    const { session, writes } = harness()
    await session.load()
    await session.setVerdict(1, 'differs', '   ')
    expect(writes).toEqual([])
    await session.setVerdict(1, 'differs', 'three of four cases')
    expect(writes).toEqual([{ rootPath: '/repo', plan: 'pay', note: 1, verdict: 'differs', why: 'three of four cases' }])
    expect(session.state.notes[0]?.verdict).toBe('differs')
  })

  it('keeps comments as a per-plan draft, and sends nothing for them', async () => {
    const { session, sent, storage } = harness()
    await session.load()
    session.comment(2, 'keep it inline')
    expect(sent).toEqual([])
    expect(JSON.parse(storage.data[draftStorageKey('/repo', 'pay')] ?? '{}')).toEqual({ 2: 'keep it inline' })
    // A new session for the same plan finds them (a restart before Send).
    const again = new PlanReviewSession({ rootPath: '/repo', plan: 'pay', threadId: 't1' }, { notes: jest.fn(), setNote: jest.fn(), storage, sendPrompt: jest.fn() }, () => undefined)
    expect(again.state.drafts).toEqual({ 2: 'keep it inline' })
  })

  it('sends ONE message only when every note is reviewed, then clears the comments', async () => {
    const { session, sent, storage } = harness()
    await session.load()
    session.comment(1, 'fine')
    expect(session.send()).toBe(false)
    expect(sent).toEqual([])
    await session.decide(1, 'accepted')
    await session.decide(2, 'rejected')
    expect(session.canSend).toBe(true)
    expect(session.send()).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.threadId).toBe('t1')
    expect(sent[0]?.text).toContain('- Note 1 (fn1): accepted.\n  Comment: fine')
    expect(session.state.drafts).toEqual({})
    expect(session.state.sent).toBe(true)
    expect(storage.data[draftStorageKey('/repo', 'pay')]).toBeUndefined()
  })

  it('cannot send without a conversation', async () => {
    const { session, sent } = harness({ threadId: null, notes: [note(1, { status: 'accepted' })] })
    await session.load()
    expect(session.canSend).toBe(false)
    expect(session.send()).toBe(false)
    expect(sent).toEqual([])
  })

  it('a newer read wins over an older one still in flight', async () => {
    let resolveFirst: (answer: PlanNotesAnswer) => void = () => undefined
    const reads = [
      new Promise<PlanNotesAnswer>((resolve) => {
        resolveFirst = resolve
      }),
      Promise.resolve(snapshot([note(1, { what: 'new words' })])),
    ]
    const session = new PlanReviewSession(
      { rootPath: '/repo', plan: 'pay', threadId: null },
      { notes: () => reads.shift() as Promise<PlanNotesAnswer>, setNote: jest.fn(), storage: null, sendPrompt: jest.fn() },
      () => undefined,
    )
    const first = session.load()
    await session.load()
    resolveFirst(snapshot([note(1, { what: 'old words' })]))
    await first
    expect(session.state.notes[0]?.what).toBe('new words')
  })
})

describe('PlanReviewSession — after Send review', () => {
  it('a revision of the notes ends the sent state; a decision landing does not', async () => {
    let notes = [note(1, { status: 'accepted' })]
    const session = new PlanReviewSession(
      { rootPath: '/repo', plan: 'pay', threadId: 't1' },
      { notes: async () => snapshot(notes), setNote: jest.fn(), storage: null, sendPrompt: jest.fn() },
      () => undefined,
    )
    await session.load()
    expect(session.send()).toBe(true)
    notes = [note(1, { status: 'accepted', reason: 'x' })]
    await session.load()
    expect(session.state.sent).toBe(true)
    notes = [note(1, { status: 'accepted', what: 'revised words' })]
    await session.load()
    expect(session.state.sent).toBe(false)
  })
})

/**
 * A plan file the fake writer rewrites the way the real one does — read the
 * whole file, yield, write it back. Two writes overlapping lose one decision,
 * so the fake records overlap as well as order.
 */
function fileBackedWriter(initial: PlanNoteReport[]) {
  let file = initial.map((entry) => ({ ...entry }))
  let inFlight = 0
  let most = 0
  const order: Array<[number, string | undefined]> = []
  const setNote = async (request: PlanSetNoteRequest): Promise<PlanSetNoteAnswer> => {
    inFlight += 1
    most = Math.max(most, inFlight)
    order.push([request.note, request.status ?? request.verdict])
    const read = file.map((entry) => ({ ...entry }))
    await new Promise((resolve) => setTimeout(resolve, 1))
    const written = read.map((entry) =>
      entry.n === request.note
        ? {
            ...entry,
            ...(request.status === undefined ? {} : { status: request.status }),
            ...(request.verdict === undefined ? {} : { verdict: request.verdict, verdictWhy: request.why ?? '' }),
          }
        : entry,
    )
    file = written
    inFlight -= 1
    return { ok: true, plan: 'pay', path: 'flow/plans/plan_pay_v1.md', changed: true, note: written.find((entry) => entry.n === request.note) as PlanNoteReport }
  }
  return { setNote, order, most: () => most, file: () => file }
}

function writerSession(writer: ReturnType<typeof fileBackedWriter>, extra: Partial<PlanReviewDeps> = {}) {
  return new PlanReviewSession(
    { rootPath: '/repo', plan: 'pay', threadId: 't1' },
    { notes: async () => snapshot(writer.file()), setNote: writer.setNote, storage: null, sendPrompt: jest.fn(), ...extra },
    () => undefined,
  )
}

describe('PlanReviewSession — every write on one chain', () => {
  it('two notes decided in quick succession are written one at a time, and both decisions land', async () => {
    const writer = fileBackedWriter([note(1), note(2)])
    const session = writerSession(writer)
    await session.load()
    const first = session.decide(1, 'accepted')
    const second = session.decide(2, 'rejected')
    // Both are on screen at once, each saving.
    expect(session.state.notes.map((entry) => entry.status)).toEqual(['accepted', 'rejected'])
    expect(session.canSend).toBe(false)
    await Promise.all([first, second])
    expect(writer.most()).toBe(1)
    expect(writer.order).toEqual([
      [1, 'accepted'],
      [2, 'rejected'],
    ])
    expect(writer.file().map((entry) => entry.status)).toEqual(['accepted', 'rejected'])
    expect(session.state.notes.map((entry) => entry.status)).toEqual(['accepted', 'rejected'])
    expect(session.canSend).toBe(true)
  })

  it('a decision made during Accept all is written in turn, and Accept all leaves that note alone', async () => {
    const writer = fileBackedWriter([note(1), note(2), note(3)])
    const session = writerSession(writer)
    await session.load()
    const all = session.acceptAll()
    const mine = session.decide(3, 'rejected')
    await Promise.all([all, mine])
    expect(writer.most()).toBe(1)
    expect(writer.order.filter(([n]) => n === 3)).toEqual([[3, 'rejected']])
    expect(writer.file().map((entry) => entry.status)).toEqual(['accepted', 'accepted', 'rejected'])
    expect(session.state.notes.map((entry) => entry.status)).toEqual(['accepted', 'accepted', 'rejected'])
  })

  it('Accept all pressed twice writes each note once', async () => {
    const writer = fileBackedWriter([note(1), note(2)])
    const session = writerSession(writer)
    await session.load()
    const first = session.acceptAll()
    expect(session.state.acceptingAll).toBe(true)
    const second = session.acceptAll()
    await Promise.all([first, second])
    expect(writer.order).toEqual([
      [1, 'accepted'],
      [2, 'accepted'],
    ])
    expect(writer.most()).toBe(1)
    expect(session.state.acceptingAll).toBe(false)
  })

  it('a verdict waits for a decision in flight, never overlapping it', async () => {
    const writer = fileBackedWriter([note(1), note(2, { status: 'accepted' })])
    const session = writerSession(writer)
    await session.load()
    await Promise.all([session.decide(1, 'accepted'), session.setVerdict(2, 'done', 'as described')])
    expect(writer.most()).toBe(1)
    expect(writer.file().map((entry) => [entry.status, entry.verdict])).toEqual([
      ['accepted', undefined],
      ['accepted', 'done'],
    ])
  })

  it('a rejected note takes no verdict', async () => {
    const writer = fileBackedWriter([note(1, { status: 'rejected' })])
    const session = writerSession(writer)
    await session.load()
    await session.setVerdict(1, 'done', 'it was built anyway')
    expect(writer.order).toEqual([])
  })
})

describe('PlanReviewSession — reads against its own writes', () => {
  it('a read that started before a decision landed never takes the decision back', async () => {
    let release: (answer: PlanNotesAnswer) => void = () => undefined
    const reads: Array<Promise<PlanNotesAnswer>> = [
      Promise.resolve(snapshot([note(1)])),
      new Promise<PlanNotesAnswer>((resolve) => {
        release = resolve
      }),
    ]
    const writer = fileBackedWriter([note(1)])
    const session = writerSession(writer, { notes: () => reads.shift() as Promise<PlanNotesAnswer> })
    await session.load()
    const stale = session.load()
    await session.decide(1, 'accepted')
    expect(session.state.notes[0]?.status).toBe('accepted')
    // The older read answers with the file as it was before the write.
    release(snapshot([note(1, { what: 'new words' })]))
    await stale
    expect(session.state.notes[0]?.status).toBe('accepted')
    // …while what it says about the note's words still arrives.
    expect(session.state.notes[0]?.what).toBe('new words')
  })

  it('a change to the plan file is its own write echoing while writes are in flight and briefly after', async () => {
    let clock = 1000
    const writer = fileBackedWriter([note(1)])
    const session = writerSession(writer, { now: () => clock })
    await session.load()
    expect(session.wantsReloadOnFileChange).toBe(true)
    const write = session.decide(1, 'accepted')
    expect(session.wantsReloadOnFileChange).toBe(false)
    await write
    expect(session.wantsReloadOnFileChange).toBe(false)
    clock += OWN_WRITE_ECHO_MS - 1
    expect(session.wantsReloadOnFileChange).toBe(false)
    clock += 1
    expect(session.wantsReloadOnFileChange).toBe(true)
  })
})

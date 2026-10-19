import { liveWorkTarget, statusHasLiveTurn, turnLiveAfter, type TurnEdge } from './turn-liveness'

/** Fold a sequence of edges from a resting thread. */
function after(edges: TurnEdge[], start = false): boolean {
  return edges.reduce(turnLiveAfter, start)
}

describe('turnLiveAfter — a turn runs from its start to its end, not while things move', () => {
  it('a send starts a turn and done ends it', () => {
    expect(after([{ kind: 'send' }])).toBe(true)
    expect(after([{ kind: 'send' }, { kind: 'status', status: 'working' }, { kind: 'done' }])).toBe(false)
  })

  it('a background agent reporting a tool after done is no turn — the reason the hold used to stick', () => {
    // POSITIVE FIRST (allowed-pattern #28): the turn WAS live before it ended.
    const turn: TurnEdge[] = [{ kind: 'status', status: 'working' }, { kind: 'motion' }]
    expect(after(turn)).toBe(true)
    expect(after([...turn, { kind: 'status', status: 'done' }, { kind: 'done' }, { kind: 'motion' }, { kind: 'motion' }])).toBe(false)
  })

  it('motion never starts a turn and never ends one', () => {
    expect(turnLiveAfter(false, { kind: 'motion' })).toBe(false)
    expect(turnLiveAfter(true, { kind: 'motion' })).toBe(true)
  })

  it('a turn waiting on a decision is still that turn', () => {
    expect(after([{ kind: 'status', status: 'working' }, { kind: 'status', status: 'needs-decision' }])).toBe(true)
  })

  it('an interrupt (idle), a failure, an error, a rolled-back send and a failed first-message discovery all end it', () => {
    for (const end of [
      { kind: 'status', status: 'idle' },
      { kind: 'status', status: 'failed' },
      { kind: 'status', status: 'blocked' },
      { kind: 'status', status: 'done' },
      { kind: 'error' },
      { kind: 'send-rolled-back' },
      { kind: 'learning-first-failed' },
    ] satisfies TurnEdge[]) {
      expect(after([{ kind: 'send' }, end])).toBe(false)
    }
  })

  it('opening a thread takes its stored status — a working thread is mid-turn, any other is not', () => {
    expect(turnLiveAfter(false, { kind: 'thread-opened', status: 'working' })).toBe(true)
    expect(turnLiveAfter(true, { kind: 'thread-opened', status: 'done' })).toBe(false)
    expect(turnLiveAfter(true, { kind: 'thread-opened', status: undefined })).toBe(false)
  })

  it('statusHasLiveTurn names the live statuses', () => {
    expect(statusHasLiveTurn('working')).toBe(true)
    expect(statusHasLiveTurn('needs-decision')).toBe(true)
    expect(statusHasLiveTurn('idle')).toBe(false)
    expect(statusHasLiveTurn(undefined)).toBe(false)
  })
})

describe('liveWorkTarget — a background agent after done never starts a live work row', () => {
  it('Compact: the running turn feeds the row; after `done` the work goes to the feed', () => {
    const live = after([{ kind: 'send' }, { kind: 'motion' }])
    expect(liveWorkTarget('compact', live)).toBe('request-row')
    // The turn ended; a background agent reports a tool — motion, not a new turn.
    const settled = after([{ kind: 'send' }, { kind: 'done' }, { kind: 'motion' }])
    expect(liveWorkTarget('compact', settled)).toBe('feed')
  })

  it('other densities never use the row', () => {
    expect(liveWorkTarget('balanced', true)).toBe('feed')
    expect(liveWorkTarget('detailed', true)).toBe('feed')
  })
})

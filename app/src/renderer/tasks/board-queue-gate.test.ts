// The queue-read gate (loops-on-the-board, review finding H3).
//
// THE ASSERTION THAT MATTERS IS A COUNT. Every test below counts how many times
// `perform` ran, because `perform` is the two `spawn`s — `loop list` and
// `loop status` — and the finding was never about a wrong answer. It was about
// the same right answer being fetched twice over the network.
//
// The first block reproduces the ordinary claim path exactly as the review
// traced it: a forced refresh starts, the `tasks:updated` debounce fires an
// unforced one 50 ms later while the first is still waiting on `gh`. Without
// the gate that is four CLI processes for one claim.

import { QueueReadGate } from './board-queue-gate'

/** A perform that never settles until told, counting how many times it ran. */
function deferred(): {
  perform: () => Promise<void>
  release: (index?: number) => void
  count: () => number
} {
  const resolvers: Array<() => void> = []
  let runs = 0
  const perform = (): Promise<void> => {
    runs += 1
    return new Promise<void>((resolve) => resolvers.push(resolve))
  }
  return {
    perform,
    count: () => runs,
    release: (index = 0) => resolvers[index]?.(),
  }
}

/** Let every already-queued microtask drain. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('one claim spawns ONE pair of CLI processes, not two (H3)', () => {
  it('an unforced refresh arriving mid-read joins it instead of starting its own', async () => {
    const gh = deferred()
    const gate = new QueueReadGate(30_000, () => 1_000)

    // #claimCard finished: refresh({reloadQueue: true}).
    const forced = gate.read('/repo', true, gh.perform)
    // 50 ms later the DB insert's tasks:updated debounce fires
    // api.tasks.onUpdated(() => void board.refresh()) — unforced, and the `gh`
    // round trip the forced read is waiting on has not come back.
    const incidental = gate.read('/repo', false, gh.perform)

    expect(gh.count()).toBe(1)
    // Not merely "did not run again" — the second caller is waiting on the FIRST
    // read, so it cannot resolve before that read does.
    let incidentalDone = false
    void incidental.then(() => {
      incidentalDone = true
    })
    await settle()
    expect(incidentalDone).toBe(false)

    gh.release(0)
    await Promise.all([forced, incidental])
    expect(gh.count()).toBe(1)
    expect(incidentalDone).toBe(true)
  })

  it('N unforced callers piling onto one read are still one read', async () => {
    const gh = deferred()
    const gate = new QueueReadGate(30_000, () => 1_000)

    const waiters = [
      gate.read('/repo', true, gh.perform),
      gate.read('/repo', false, gh.perform),
      gate.read('/repo', false, gh.perform),
      gate.read('/repo', false, gh.perform),
    ]
    expect(gh.count()).toBe(1)
    gh.release(0)
    await Promise.all(waiters)
    expect(gh.count()).toBe(1)
  })
})

describe('the TTL and the force/no-force design are unchanged', () => {
  it('an unforced read inside the TTL of a completed read does not spawn', async () => {
    const gh = deferred()
    let now = 1_000
    const gate = new QueueReadGate(30_000, () => now)

    const first = gate.read('/repo', false, gh.perform)
    gh.release(0)
    await first
    expect(gh.count()).toBe(1)

    now += 29_000
    await gate.read('/repo', false, gh.perform)
    expect(gh.count()).toBe(1)
  })

  it('an unforced read past the TTL spawns again', async () => {
    const gh = deferred()
    let now = 1_000
    const gate = new QueueReadGate(30_000, () => now)

    const first = gate.read('/repo', false, gh.perform)
    gh.release(0)
    await first

    now += 30_001
    const second = gate.read('/repo', false, gh.perform)
    expect(gh.count()).toBe(2)
    gh.release(1)
    await second
  })

  it('a force inside the TTL still spawns — Retry means read it again', async () => {
    const gh = deferred()
    const gate = new QueueReadGate(30_000, () => 1_000)

    const first = gate.read('/repo', false, gh.perform)
    gh.release(0)
    await first

    const forced = gate.read('/repo', true, gh.perform)
    expect(gh.count()).toBe(2)
    gh.release(1)
    await forced
  })

  it('another project is never fresh, whatever this one just read', async () => {
    const gh = deferred()
    const gate = new QueueReadGate(30_000, () => 1_000)

    const first = gate.read('/repo', false, gh.perform)
    gh.release(0)
    await first

    const other = gate.read('/other', false, gh.perform)
    expect(gh.count()).toBe(2)
    gh.release(1)
    await other
  })

  it('forget() drops the stamp — a board with no project has no last answer', async () => {
    const gh = deferred()
    const gate = new QueueReadGate(30_000, () => 1_000)

    const first = gate.read('/repo', false, gh.perform)
    gh.release(0)
    await first

    gate.forget()
    const second = gate.read('/repo', false, gh.perform)
    expect(gh.count()).toBe(2)
    gh.release(1)
    await second
  })
})

describe('a forced caller gets the world as of when it asked', () => {
  it('does not join a read that had already started — it gets the one after', async () => {
    const gh = deferred()
    const gate = new QueueReadGate(30_000, () => 1_000)

    // A read is out on the wire. THEN the user presses Retry — the answer being
    // fetched is the very one they are retrying, so joining it would be a Retry
    // that re-reports the thing it was pressed about.
    const running = gate.read('/repo', false, gh.perform)
    const retry = gate.read('/repo', true, gh.perform)

    // Queued, not started: the trailing read must not spawn beside the running
    // one, or the finding is back wearing the other hat.
    expect(gh.count()).toBe(1)
    gh.release(0)
    await running
    expect(gh.count()).toBe(2)
    gh.release(1)
    await retry
  })

  it('coalesces every forced caller behind one in-flight read into ONE trailing read', async () => {
    const gh = deferred()
    const gate = new QueueReadGate(30_000, () => 1_000)

    const running = gate.read('/repo', false, gh.perform)
    // Retry, Retry, Retry, and a project switch landing in the same window.
    const trailing = [
      gate.read('/repo', true, gh.perform),
      gate.read('/repo', true, gh.perform),
      gate.read('/repo', true, gh.perform),
    ]
    expect(gh.count()).toBe(1)

    gh.release(0)
    await running
    // Worst case is two spawn pairs — the one running plus one trailing — never
    // one per press.
    expect(gh.count()).toBe(2)
    gh.release(1)
    await Promise.all(trailing)
    expect(gh.count()).toBe(2)
  })

  it('never runs two reads at once, even across a project switch', async () => {
    const gh = deferred()
    const gate = new QueueReadGate(30_000, () => 1_000)

    const first = gate.read('/repo', true, gh.perform)
    // setActiveRoot: a forced read for a DIFFERENT project. Joining the read in
    // flight would settle the board on the queue of the project that closed.
    const switched = gate.read('/other', true, gh.perform)
    expect(gh.count()).toBe(1)

    gh.release(0)
    await first
    expect(gh.count()).toBe(2)
    gh.release(1)
    await switched
  })
})

describe('a read that failed leaves nothing fresh behind it', () => {
  it('does not stamp the TTL, so the next unforced caller reads again', async () => {
    let runs = 0
    const gate = new QueueReadGate(30_000, () => 1_000)
    const failing = (): Promise<void> => {
      runs += 1
      return Promise.reject(new Error('gh exploded'))
    }

    await expect(gate.read('/repo', false, failing)).rejects.toThrow('gh exploded')
    expect(runs).toBe(1)

    await expect(gate.read('/repo', false, failing)).rejects.toThrow('gh exploded')
    expect(runs).toBe(2)
  })

  it('releases the in-flight slot, so a later read is not queued behind a corpse', async () => {
    const gate = new QueueReadGate(30_000, () => 1_000)
    await expect(
      gate.read('/repo', false, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')

    let ran = false
    await gate.read('/repo', true, async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('a trailing read queued behind a failing one still runs, and the gate recovers (#1705)', async () => {
    // The documented worst case — an in-flight read plus ONE trailing read —
    // crossed with a failure: the in-flight read rejects AFTER a forced caller
    // (Retry, a project switch, a claim tail) has queued the trailing link.
    // The trailing link must not inherit the rejection it was queued behind:
    // it runs `perform` itself, and win or lose it clears the slot, so the
    // board is never bricked into re-reporting the original gh error forever.
    const gate = new QueueReadGate(30_000, () => 1_000)
    let rejectInFlight: (error: Error) => void = () => {}
    const inFlight = gate.read('/repo', true, () => {
      return new Promise<void>((_resolve, reject) => {
        rejectInFlight = reject
      })
    })

    let trailingRuns = 0
    const trailing = gate.read('/repo', true, async () => {
      trailingRuns += 1
    })

    rejectInFlight(new Error('gh timed out'))
    await expect(inFlight).rejects.toThrow('gh timed out')

    // The trailing read succeeds on its own — the predecessor's rejection
    // belonged to the callers who joined the predecessor.
    await trailing
    expect(trailingRuns).toBe(1)

    // And the gate is idle again: a later read spawns fresh instead of joining
    // a settled, rejected link.
    let laterRuns = 0
    await gate.read('/other', true, async () => {
      laterRuns += 1
    })
    expect(laterRuns).toBe(1)
  })
})

/**
 * THE WINDOW, and the four things about it that are easy to get subtly wrong:
 * starting twice, recording a terminal nobody asked for, claiming completeness
 * the browser's own buffer cannot give, and putting untimed output on a
 * timeline that claims to be ordered.
 */
import { DebugSessionRecorder, DEFAULT_DEBUG_LIMITS } from './debug-session'
import type { DebugSessionDeps } from './debug-session'
import type { BrowserCapture } from '../../shared/browser-capture-types'
import type { StampedTerminalChunk } from '../../shared/terminal-stamp'

function consoleCapture(ts: number, text: string): BrowserCapture {
  return {
    kind: 'console',
    id: `c-${ts}-${text}`,
    componentPath: null,
    redacted: false,
    payload: { level: 'log', text, ts },
  } as unknown as BrowserCapture
}

function harness(over: Partial<DebugSessionDeps> = {}) {
  let clock = 1_000_000
  const observers: ((c: StampedTerminalChunk) => void)[] = []
  const captures: BrowserCapture[] = []
  const deps: DebugSessionDeps = {
    observeTerminalOutput: (fn) => {
      observers.push(fn)
      return () => {
        const at = observers.indexOf(fn)
        if (at >= 0) observers.splice(at, 1)
      }
    },
    terminalsInScope: () => [
      { terminalId: 'api', label: 'orbit-core', projectRoot: '/repos/core' },
      { terminalId: 'web', label: 'orbit-app', projectRoot: '/repos/app' },
    ],
    scrollbackTail: (id) => `tail of ${id}`,
    browserCaptures: () => [...captures],
    now: () => clock,
    ...over,
  }
  return {
    deps,
    recorder: new DebugSessionRecorder(deps),
    emit: (terminalId: string, data: string, at = clock) => {
      for (const fn of [...observers]) fn({ terminalId, at, data })
    },
    capture: (ts: number, text: string) => captures.push(consoleCapture(ts, text)),
    tick: (ms: number) => {
      clock += ms
    },
    at: () => clock,
    observerCount: () => observers.length,
  }
}

describe('the debug session window', () => {
  it('records nothing until it is started, and nothing after it stops', () => {
    const h = harness()
    h.emit('api', 'before\n')
    expect(h.observerCount()).toBe(0)

    h.recorder.start('t1')
    h.emit('api', 'during\n')
    const result = h.recorder.stop()

    h.emit('api', 'after\n')
    // The positive first: it DID record (allowed-pattern #28).
    expect(result?.records.map((r) => (r.source === 'terminal' ? r.data : ''))).toEqual([
      'during\n',
    ])
    // …and it let go of the terminal when it finished.
    expect(h.observerCount()).toBe(0)
  })

  it('starting twice returns the SAME session, not a second one', () => {
    // Silently discarding a reproduction somebody is halfway through is the one
    // outcome worse than refusing.
    const h = harness()
    const first = h.recorder.start('t1')
    h.emit('api', 'work in progress\n')
    const second = h.recorder.start('t1')
    expect(second.id).toBe(first.id)
    expect(second.startedAt).toBe(first.startedAt)
    expect(h.recorder.stop()?.records).toHaveLength(1)
  })

  it('ignores a terminal outside the thread’s scope', () => {
    // A window holds terminals from projects this conversation has nothing to
    // do with; sweeping them in would report somebody else's build.
    const h = harness()
    h.recorder.start('t1')
    h.emit('api', 'mine\n')
    h.emit('stranger', 'not mine\n')
    const result = h.recorder.stop()
    expect(result?.records).toHaveLength(1)
    expect(result?.records[0]).toMatchObject({ terminalId: 'api', label: 'orbit-core' })
  })

  it('merges browser and terminal records onto one timeline, in time order', () => {
    // THE WHOLE POINT OF THE FEATURE.
    const h = harness()
    h.recorder.start('t1')
    const t0 = h.at()
    h.capture(t0 + 10, 'clicked save')
    h.emit('api', 'POST /save 500\n', t0 + 20)
    h.capture(t0 + 30, 'request failed')
    h.emit('web', 'render error\n', t0 + 5)
    h.tick(100)
    const result = h.recorder.stop()
    expect(result?.records.map((r) => r.at)).toEqual([t0 + 5, t0 + 10, t0 + 20, t0 + 30])
    expect(result?.records.map((r) => r.source)).toEqual([
      'terminal',
      'browser',
      'terminal',
      'browser',
    ])
  })

  it('takes only the browser entries inside the window', () => {
    const h = harness()
    h.capture(1, 'ancient history')
    h.recorder.start('t1')
    const t0 = h.at()
    h.capture(t0 + 5, 'inside')
    h.tick(50)
    const endedAt = h.at()
    h.capture(endedAt + 5000, 'from the future')
    const result = h.recorder.stop()
    const texts = result?.records.map((r) =>
      r.source === 'browser' ? (r.capture.payload as { text: string }).text : '',
    )
    expect(texts).toEqual(['inside'])
  })

  it('says when the browser’s own buffer dropped part of the window', () => {
    // Its buffer evicts oldest-first independently of any session. An artifact
    // that does not say so claims a completeness it does not have.
    const h = harness()
    h.recorder.start('t1')
    const t0 = h.at()
    h.tick(100)
    // Everything the buffer still holds began AFTER we did — so it dropped ours.
    h.capture(t0 + 50, 'survivor')
    expect(h.recorder.stop()?.browserEvicted).toBe(true)

    const clean = harness()
    clean.capture(1, 'older than the session')
    clean.recorder.start('t1')
    clean.tick(100)
    expect(clean.recorder.stop()?.browserEvicted).toBe(false)
  })

  it('keeps the untimed pre-roll OFF the timeline', () => {
    // The display scrollback carries no clock, so placing it would mean
    // inventing a position — a plausible order that is not the real one.
    const h = harness()
    h.recorder.start('t1')
    h.emit('api', 'timed\n')
    const result = h.recorder.stop()
    expect(result?.preRoll).toEqual([
      { terminalId: 'api', label: 'orbit-core', text: 'tail of api' },
      { terminalId: 'web', label: 'orbit-app', text: 'tail of web' },
    ])
    expect(result?.records.every((r) => r.at > 0)).toBe(true)
    expect(result?.records).toHaveLength(1)
  })

  it('stops itself rather than running for ever, and says that is what happened', () => {
    const h = harness()
    h.recorder.start('t1')
    expect(h.recorder.expired()).toBe(false)
    h.tick(DEFAULT_DEBUG_LIMITS.maxDurationMs)
    expect(h.recorder.expired()).toBe(true)
    expect(h.recorder.stop('capped')?.end).toBe('capped')
  })

  it('answers nothing to a Finish nobody started', () => {
    const h = harness()
    expect(h.recorder.stop()).toBeNull()
    expect(h.recorder.recording).toBe(false)
  })

  it('drops interactions outside the window', () => {
    const h = harness()
    h.recorder.interaction({ source: 'interaction', at: 1, target: 'button Save', kind: 'click' })
    h.recorder.start('t1')
    h.recorder.interaction({
      source: 'interaction',
      at: h.at(),
      target: 'button Save',
      kind: 'click',
    })
    const result = h.recorder.stop()
    expect(result?.records.filter((r) => r.source === 'interaction')).toHaveLength(1)
  })
})

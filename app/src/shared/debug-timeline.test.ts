/**
 * THE CORRELATION, AND THE REDACTION — the two things this feature is for and
 * the two things that would make it worse than useless if wrong.
 */
import { narrativeText, summaryText, terminalContextFor, timelineText } from './debug-timeline'
import type { DebugRecord, DebugSessionResult } from './debug-session-types'
import type { BrowserCapture } from './browser-capture-types'

const T0 = 1_700_000_000_000

const consoleCap = (ts: number, level: string, text: string): BrowserCapture =>
  ({ kind: 'console', id: `c${ts}`, componentPath: null, redacted: false,
     payload: { level, text, ts } } as unknown as BrowserCapture)

const netCap = (ts: number, status: number, url: string): BrowserCapture =>
  ({ kind: 'network', id: `n${ts}`, componentPath: null, redacted: false,
     payload: { method: 'POST', url, status, timingMs: 120, requestHeaders: {},
                responseHeaders: {}, ts } } as unknown as BrowserCapture)

function session(records: DebugRecord[], over: Partial<DebugSessionResult> = {}): DebugSessionResult {
  return {
    id: 'dbg-1',
    threadId: 't1',
    startedAt: T0,
    endedAt: T0 + 5000,
    end: 'finished',
    terminals: [
      { terminalId: 'api', label: 'orbit-core', projectRoot: '/repos/core' },
      { terminalId: 'web', label: 'orbit-app', projectRoot: '/repos/app' },
    ],
    records,
    preRoll: [],
    lost: {},
    browserEvicted: false,
    ...over,
  }
}

describe('the timeline', () => {
  it('interleaves what you did, what the page did, and what the server printed', () => {
    // THE WHOLE FEATURE, in one assertion: three sources, one order.
    const text = timelineText(
      session([
        { source: 'interaction', at: T0 + 100, target: 'button Save', kind: 'click' },
        { source: 'browser', at: T0 + 150, capture: netCap(T0 + 150, 500, 'https://api/save') },
        { source: 'terminal', at: T0 + 160, terminalId: 'api', label: 'orbit-core-api',
          data: 'IntegrityError: duplicate key\n' },
      ]),
    )
    // The offset column, not any line containing a '+' — the Sources header
    // ends with "+ the embedded browser" and was matching too.
    const rows = text.split('\n').filter((l) => /^\s*\+\d/.test(l))
    expect(rows[0]).toContain('you        click button Save')
    expect(rows[1]).toContain('network    POST https://api/save -> 500'.replace('->', '\u2192'))
    // The label is cut to the column's ten characters, so the '-api' is gone.
    expect(rows[2]).toContain('orbit-core IntegrityError: duplicate key')
  })

  it('redacts the TERMINAL half, which never had a boundary of its own', () => {
    // Server logs print connection strings and env dumps that headers never do.
    const text = timelineText(
      session([
        { source: 'terminal', at: T0 + 10, terminalId: 'api', label: 'core',
          data: 'starting with Authorization: Bearer abcdef1234567890abcdef1234567890\n' },
      ]),
    )
    expect(text).not.toContain('abcdef1234567890abcdef1234567890')
    expect(text).toContain('[redacted]')
  })

  it('strips escape sequences without touching the text', () => {
    const text = timelineText(
      session([
        { source: 'terminal', at: T0 + 10, terminalId: 'api', label: 'core',
          data: '\x1b[31mERROR\x1b[0m something broke\n' },
      ]),
    )
    expect(text).toContain('ERROR something broke')
    expect(text).not.toContain('[31m')
  })

  it('keeps the untimed pre-roll below the timeline and says why', () => {
    const text = timelineText(
      session([], { preRoll: [{ terminalId: 'api', label: 'core', text: 'earlier output' }] }),
    )
    expect(text).toContain('Before recording started')
    expect(text).toContain('carries no clock')
    expect(text.indexOf('Timeline')).toBeLessThan(text.indexOf('Before recording started'))
  })

  it('says what it dropped, rather than presenting a hole as a record', () => {
    const text = timelineText(
      session([], { lost: { terminal: { droppedRecords: 12, droppedBytes: 900 } }, browserEvicted: true }),
    )
    expect(text).toContain('12 records')
    expect(text).toContain('from the START of the window')
    expect(text).toContain('capture buffer')
  })

  it('says a capped session was not finished by hand', () => {
    expect(timelineText(session([], { end: 'capped' }))).toContain('stopped itself')
  })
})

describe('the summary that goes in the thread', () => {
  it('leads with the failure, then what the server said around it, then what you did', () => {
    // This is the sequence an engineer used to assemble by hand across panes.
    const text = summaryText(
      session([
        { source: 'interaction', at: T0 + 100, target: 'button Save', kind: 'click' },
        { source: 'browser', at: T0 + 150, capture: netCap(T0 + 150, 500, 'https://api/save') },
        { source: 'terminal', at: T0 + 160, terminalId: 'api', label: 'orbit-core',
          data: 'IntegrityError: duplicate key value\n' },
      ]),
      '/tmp/dbg/session.md',
    )
    expect(text).toContain('1 failure')
    expect(text).toContain('POST https://api/save')
    expect(text).toContain('IntegrityError: duplicate key value')
    expect(text).toContain('you click button Save just before this')
    expect(text).toContain('/tmp/dbg/session.md')
  })

  it('counts a console error as a failure too', () => {
    const text = summaryText(
      session([{ source: 'browser', at: T0 + 20, capture: consoleCap(T0 + 20, 'error', 'Cannot read x of undefined') }]),
      null,
    )
    expect(text).toContain('Cannot read x of undefined')
  })

  it('says plainly when nothing failed, instead of an empty section', () => {
    const text = summaryText(
      session([{ source: 'browser', at: T0 + 20, capture: netCap(T0 + 20, 200, 'https://api/ok') }]),
      '/tmp/x.md',
    )
    expect(text).toContain('Nothing failed inside the window')
  })

  it('redacts the summary too — it is the part that reaches a model', () => {
    const text = summaryText(
      session([
        { source: 'browser', at: T0 + 10, capture: netCap(T0 + 10, 500, 'https://api/x') },
        { source: 'terminal', at: T0 + 11, terminalId: 'api', label: 'core',
          data: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n' },
      ]),
      '/tmp/x.md',
    )
    expect(text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  })

  it('still reaches the thread when the artifact could not be written', () => {
    const text = summaryText(session([]), null)
    expect(text).toContain('could not be written')
    expect(text).toContain('Debug session')
  })

  it('admits incompleteness rather than implying it caught everything', () => {
    const text = summaryText(session([], { browserEvicted: true }), '/tmp/x.md')
    expect(text).toContain('Incomplete')
  })
})

describe('the narrative — the short version a person reads', () => {
  const links = { timeline: 'flow/debug-sessions/dbg-1/timeline.md' }

  const story = () =>
    session([
      { source: 'interaction', at: T0 + 100, target: 'page', kind: 'load', url: 'http://localhost:3000/new' },
      { source: 'interaction', at: T0 + 900, target: 'button Save', kind: 'click' },
      { source: 'browser', at: T0 + 1000, capture: netCap(T0 + 1000, 500, 'http://localhost:3000/api/save') },
      { source: 'terminal', at: T0 + 1100, terminalId: 'api', label: 'orbit-core',
        data: 'IntegrityError: duplicate key value\n' },
    ])

  it('tells it in the order a person reconstructs it: where, what they did, what broke', () => {
    const text = narrativeText(story(), links)
    expect(text.indexOf('## What you did')).toBeLessThan(text.indexOf('## What went wrong'))
    expect(text).toContain('Started on `http://localhost:3000/new`')
    expect(text).toContain('clicked **button Save**')
    expect(text).toContain('POST http://localhost:3000/api/save')
    expect(text).toContain('Right after you clicked **button Save**')
    expect(text).toContain('IntegrityError: duplicate key value')
  })

  it('names the timeline as the source of truth rather than replacing it', () => {
    // The whole point of the split: the short version is a READING, and says so.
    const text = narrativeText(story(), links)
    expect(text).toContain('## The full record')
    expect(text).toContain('source')
  })

  it('links the timeline by a PROJECT-relative path, which is what opens', () => {
    // A sibling link rendered fine and opened nothing: the markdown surface
    // resolves against the project root, not against the summary's folder.
    const text = narrativeText(story(), links)
    expect(text).toContain('(flow/debug-sessions/dbg-1/timeline.md)')
  })

  it('does not link the HAR', () => {
    // It is written beside the timeline for anyone who wants devtools, but a
    // second link to a megabyte of JSON is a thing to explain, not to use.
    expect(narrativeText(story(), links)).not.toContain('network.har')
  })

  it('says plainly when the page captured nothing, instead of an empty section', () => {
    const text = narrativeText(
      session([
        { source: 'terminal', at: T0 + 10, terminalId: 'api', label: 'core', data: 'quiet\n' },
      ]),
      links,
    )
    expect(text).toContain('Nothing was captured from the page itself')
    expect(text).toContain('no page interactions were captured')
  })

  it('lists what it does NOT cover, rather than implying completeness', () => {
    const text = narrativeText(
      session([], { lost: { terminal: { droppedRecords: 9, droppedBytes: 400 } }, browserEvicted: true, end: 'capped' }),
      links,
    )
    expect(text).toContain('## What this does not cover')
    expect(text).toContain('dropped 9 records')
    expect(text).toContain('stopped itself at its time limit')
  })

  it('redacts, because this is the file a person opens and an agent reads', () => {
    const text = narrativeText(
      session([
        { source: 'browser', at: T0 + 10, capture: netCap(T0 + 10, 500, 'https://api/x') },
        { source: 'terminal', at: T0 + 11, terminalId: 'api', label: 'core',
          data: 'db postgresql://svc:S3cr3tPass@db.internal:5432/x\n' },
      ]),
      links,
    )
    expect(text).not.toContain('S3cr3tPass')
    expect(text).toContain('[redacted]')
  })

  it('bounds a long reproduction instead of retelling all of it', () => {
    const many: DebugRecord[] = []
    for (let i = 0; i < 40; i += 1) {
      many.push({ source: 'interaction', at: T0 + i * 10, target: `button ${i}`, kind: 'click' })
    }
    const text = narrativeText(session(many), links)
    expect(text).toContain('more, in the full record')
    expect(text.split('clicked **').length - 1).toBeLessThanOrEqual(13)
  })
})

describe('one failure, not three', () => {
  const consoleErr = (ts: number, text: string): DebugRecord => ({
    source: 'browser',
    at: ts,
    capture: consoleCap(ts, 'error', text),
  })

  it('does not count a browser’s own noise about a request as a second failure', () => {
    // A single 404 arrives as the network entry AND a "Failed to load resource"
    // line the browser prints about it. Counted separately, one failure became
    // three and the summary said "8 failures" about three.
    const text = summaryText(
      session([
        { source: 'browser', at: T0 + 100, capture: netCap(T0 + 100, 404, 'https://api/x') },
        consoleErr(T0 + 110, 'Failed to load resource: the server responded with a status of 404'),
      ]),
      '/tmp/x.md',
    )
    expect(text).toContain('1 failure')
    expect(text).not.toContain('2 failure')
  })

  it('does not repeat the same request failing twice in the same moment', () => {
    const text = summaryText(
      session([
        { source: 'browser', at: T0 + 100, capture: netCap(T0 + 100, 404, 'https://api/x?a=1') },
        { source: 'browser', at: T0 + 300, capture: netCap(T0 + 300, 404, 'https://api/x?a=2') },
      ]),
      '/tmp/x.md',
    )
    // Same endpoint, same status, moments apart — one thing that broke.
    expect(text).toContain('1 failure')
  })

  it('DOES report the same request failing again much later', () => {
    // A reader wants to know it happened again — that is a different fact.
    const text = summaryText(
      session([
        { source: 'browser', at: T0 + 100, capture: netCap(T0 + 100, 500, 'https://api/x') },
        { source: 'browser', at: T0 + 60_000, capture: netCap(T0 + 60_000, 500, 'https://api/x') },
      ]),
      '/tmp/x.md',
    )
    expect(text).toContain('2 failures')
  })
})

describe('terminalContextFor — lines that are actually about the failure', () => {
  const failure = { at: T0 + 1000, what: 'POST https://api.example.com/v1/orders → 500' }

  const noise = (at: number, text: string): DebugRecord => ({
    source: 'terminal', at, terminalId: 'a', label: 'core', data: `${text}\n`,
  })

  it('prefers a line naming the path over one that merely happened nearby', () => {
    const picked = terminalContextFor(
      failure,
      [
        noise(T0 + 900, '2026-09-21 | DEBUG | receive_response_body.complete'),
        noise(T0 + 1100, 'IntegrityError on /v1/orders — rolling back'),
      ],
      4,
    )
    expect(picked[0]?.text).toContain('/v1/orders')
  })

  it('quotes NOTHING rather than four unrelated lines', () => {
    // Every failure in a real artifact quoted the same four DEBUG traces, none
    // of them related to any of them. Silence is the honest answer.
    const picked = terminalContextFor(
      failure,
      [
        noise(T0 + 900, '2026-09-21 | DEBUG | response_closed.started'),
        noise(T0 + 950, '2026-09-21 | DEBUG | response_closed.complete'),
      ],
      4,
    )
    expect(picked).toEqual([])
  })

  it('takes an error even when it names nothing', () => {
    const picked = terminalContextFor(failure, [noise(T0 + 1200, 'Traceback (most recent call last)')], 4)
    expect(picked).toHaveLength(1)
  })

  it('ignores output far from the failure', () => {
    const picked = terminalContextFor(failure, [noise(T0 + 90_000, 'ERROR on /v1/orders')], 4)
    expect(picked).toEqual([])
  })

  it('does not quote the same line twice', () => {
    const picked = terminalContextFor(
      failure,
      [noise(T0 + 1100, 'ERROR /v1/orders failed'), noise(T0 + 1200, 'ERROR /v1/orders failed')],
      4,
    )
    expect(picked).toHaveLength(1)
  })
})

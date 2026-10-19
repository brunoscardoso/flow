import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeDebugArtifact } from './debug-artifact'
import type { DebugSessionResult } from '../../shared/debug-session-types'
import type { BrowserCapture } from '../../shared/browser-capture-types'

const T0 = 1_700_000_000_000

const netCap = (ts: number, status: number, url: string): BrowserCapture =>
  ({ kind: 'network', id: `n${ts}`, componentPath: null, redacted: false,
     payload: { method: 'POST', url, status, timingMs: 30, requestHeaders: {},
                responseHeaders: {}, ts } } as unknown as BrowserCapture)

function session(over: Partial<DebugSessionResult> = {}): DebugSessionResult {
  return {
    id: 'dbg-test-1',
    threadId: 't1',
    startedAt: T0,
    endedAt: T0 + 2000,
    end: 'finished',
    terminals: [{ terminalId: 'api', label: 'orbit-core', projectRoot: '/repos/core' }],
    records: [
      { source: 'browser', at: T0 + 10, capture: netCap(T0 + 10, 500, 'https://api/save') },
      { source: 'terminal', at: T0 + 20, terminalId: 'api', label: 'orbit-core',
        data: 'IntegrityError: duplicate key\n' },
    ],
    preRoll: [],
    lost: {},
    browserEvicted: false,
    ...over,
  }
}

describe('writeDebugArtifact', () => {
  let root = ''
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'flow-dbg-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('writes into the PROJECT, under a directory that ignores itself', async () => {
    // It used to write to userData, which made the file unopenable — the
    // editor resolves paths against the project and its checkouts. Putting it
    // in the working tree raises the obvious objection, which the .gitignore
    // answers without touching the user's own file.
    const artifact = await writeDebugArtifact(session(), root)
    expect(artifact!.dir.startsWith(join(root, 'flow', 'debug-sessions'))).toBe(true)
    const ignore = await readFile(join(root, 'flow', 'debug-sessions', '.gitignore'), 'utf8')
    expect(ignore).toContain('*')
  })

  it('reports the timeline RELATIVE to the project, for a reader and an agent', async () => {
    // An absolute path is this machine's business; a relative one is what a
    // person recognises and what an agent can open.
    const artifact = await writeDebugArtifact(session(), root)
    expect(artifact!.timelineRelPath).toBe(
      join('flow', 'debug-sessions', 'dbg-test-1', 'timeline.md'),
    )
    // The chip's text cites the SHORT file — the timeline is cited from inside
    // that one, as the source of truth it is a reading of.
    expect(artifact!.summary).toContain(artifact!.summaryRelPath)
    expect(artifact!.summary).not.toContain(root)
  })

  it('writes BOTH — the short version and the full record', async () => {
    // The timeline holds everything and is thousands of lines of it. Handing
    // that to somebody who wants to know what broke is the wrong file; handing
    // them only a summary loses the evidence. Both, and the summary cites the
    // other.
    const artifact = await writeDebugArtifact(session(), root)
    const files = readdirSync(artifact!.dir)
    expect(files).toContain('summary.md')
    expect(files).toContain('timeline.md')
    const summary = await readFile(join(artifact!.dir, 'summary.md'), 'utf8')
    expect(summary).toContain('# Debug session')
    expect(summary).toContain('timeline.md')
  })

  it('points the chip and the open at the SHORT file', async () => {
    const artifact = await writeDebugArtifact(session(), root)
    expect(artifact!.summaryRelPath.endsWith('summary.md')).toBe(true)
    expect(artifact!.summary).toContain(artifact!.summaryRelPath)
  })

  it('writes a timeline and a HAR, and hands back the summary', async () => {
    const artifact = await writeDebugArtifact(session(), root)
    expect(artifact).not.toBeNull()
    const timeline = await readFile(artifact!.timelinePath, 'utf8')
    expect(timeline).toContain('IntegrityError: duplicate key')
    expect(timeline).toContain('POST https://api/save')
    const har = JSON.parse(await readFile(artifact!.harPath!, 'utf8'))
    expect(har.log.entries).toHaveLength(1)
    expect(artifact!.summary).toContain('1 failure')
  })

  it('names the HAR from inside the timeline, so one leads to the other', async () => {
    const artifact = await writeDebugArtifact(session(), root)
    const timeline = await readFile(artifact!.timelinePath, 'utf8')
    expect(timeline).toContain('network.har')
    expect(timeline).toContain('RETAINED')
  })

  it('writes no HAR when the window caught no network at all', async () => {
    // An empty HAR is a file that says a session saw nothing, which is not the
    // same as a session that saw nothing being unable to say so.
    const artifact = await writeDebugArtifact(
      session({ records: [{ source: 'terminal', at: T0 + 5, terminalId: 'api', label: 'core', data: 'quiet\n' }] }),
      root,
    )
    expect(artifact!.harPath).toBeNull()
    const timeline = await readFile(artifact!.timelinePath, 'utf8')
    expect(timeline).not.toContain('network.har')
  })

  it('returns null rather than throwing when the directory cannot be made', async () => {
    // Failing to write is not failing the session: the caller still posts a
    // summary, and summaryText(result, null) says the record is all there is.
    const artifact = await writeDebugArtifact(session(), '/proc/nonexistent-and-unwritable')
    expect(artifact).toBeNull()
  })

  it('redacts on the way to disk — nothing raw is ever written', async () => {
    const artifact = await writeDebugArtifact(
      session({
        records: [
          { source: 'terminal', at: T0 + 5, terminalId: 'api', label: 'core',
            data: 'db postgresql://svc:S3cr3tPass@db.internal:5432/x\n' },
        ],
      }),
      root,
    )
    const timeline = await readFile(artifact!.timelinePath, 'utf8')
    expect(timeline).not.toContain('S3cr3tPass')
    expect(timeline).toContain('[redacted]')
    // …and the host survives, because "which database" is the question.
    expect(timeline).toContain('db.internal')
  })
})

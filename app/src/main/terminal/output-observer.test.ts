/**
 * STAMPED OUTPUT, AND WHAT IT COSTS WHEN NOBODY IS LISTENING.
 *
 * The debug session correlates terminal output with browser activity by sorting
 * on one clock, which means every chunk needs the moment it arrived. Terminal
 * output is not debounced or batched anywhere in this app — during a noisy build
 * this path runs thousands of times a second, in main, where every window waits.
 *
 * So the design is an observer list rather than a widened `TERMINAL_DATA_EVENT`,
 * and the promise is that an empty list costs a `size === 0` check. THAT is what
 * these tests are for: the first two prove it works, and the third proves it
 * costs nothing — which is the claim a reviewer cannot check by reading.
 */
import { TerminalManager } from './index'
import type { StampedTerminalChunk } from '../../shared/terminal-stamp'

const PROJECT = '/repos/project'

describe('stamped terminal output', () => {
  it('hands mirrored output to an observer, with a clock on it', () => {
    const mgr = new TerminalManager()
    const info = mgr.ensureAgentTerminal({ threadId: 't1', cwd: PROJECT, projectRoot: PROJECT })
    const seen: StampedTerminalChunk[] = []
    mgr.observeOutput((chunk) => seen.push(chunk))

    const before = Date.now()
    mgr.writeOutput(info.terminalId, 'npm ERR! something broke\n')
    const after = Date.now()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.terminalId).toBe(info.terminalId)
    expect(seen[0]?.data).toBe('npm ERR! something broke\n')
    // EPOCH MS ON THE HOST CLOCK — the same clock the browser's `ts` was
    // measured against, which is the only reason a merge is a sort.
    expect(seen[0]?.at).toBeGreaterThanOrEqual(before)
    expect(seen[0]?.at).toBeLessThanOrEqual(after)
    mgr.disposeAll()
  })

  it('stops when the observer removes itself, and not before', () => {
    const mgr = new TerminalManager()
    const info = mgr.ensureAgentTerminal({ threadId: 't1', cwd: PROJECT, projectRoot: PROJECT })
    const seen: StampedTerminalChunk[] = []
    const stop = mgr.observeOutput((chunk) => seen.push(chunk))

    mgr.writeOutput(info.terminalId, 'during\n')
    stop()
    mgr.writeOutput(info.terminalId, 'after\n')

    // The positive first: it WAS recording, so the absence below means
    // something (allowed-pattern #28).
    expect(seen.map((c) => c.data)).toEqual(['during\n'])
    mgr.disposeAll()
  })

  it('reads no clock at all when nobody is watching', () => {
    // THE WHOLE POINT OF THE OBSERVER LIST. A timestamp taken unconditionally
    // would be taken thousands of times a second for every user, to serve a
    // recording almost nobody is making. `Date.now` is the observable proxy for
    // "did this path do any work".
    const mgr = new TerminalManager()
    const info = mgr.ensureAgentTerminal({ threadId: 't1', cwd: PROJECT, projectRoot: PROJECT })
    const now = jest.spyOn(Date, 'now')

    mgr.writeOutput(info.terminalId, 'quiet\n')
    expect(now).not.toHaveBeenCalled()

    // …and it starts reading it the moment somebody does watch, so the
    // assertion above cannot pass because the spy was simply never reachable.
    mgr.observeOutput(() => undefined)
    mgr.writeOutput(info.terminalId, 'watched\n')
    expect(now).toHaveBeenCalled()

    now.mockRestore()
    mgr.disposeAll()
  })

  it('keeps the terminal alive when an observer throws', () => {
    const mgr = new TerminalManager()
    const info = mgr.ensureAgentTerminal({ threadId: 't1', cwd: PROJECT, projectRoot: PROJECT })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const seen: string[] = []
    mgr.observeOutput(() => {
      throw new Error('a recorder fell over')
    })
    mgr.observeOutput((chunk) => seen.push(chunk.data))

    expect(() => mgr.writeOutput(info.terminalId, 'still flowing\n')).not.toThrow()
    // The one that did not throw still got its chunk.
    expect(seen).toEqual(['still flowing\n'])
    warn.mockRestore()
    mgr.disposeAll()
  })
})

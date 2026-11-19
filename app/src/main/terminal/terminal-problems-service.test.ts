import type { TerminalInfo } from '../../shared/ipc-contract'
import type { TerminalProblemCounts } from '../../shared/terminal-problems'
import { BATCH_MS, BROADCAST_MS, MAX_PENDING_CHARS, TerminalProblemsService, type TerminalProblemsTimers } from './terminal-problems-service'

/** Timers driven by hand: `run(ms)` fires what is due. */
function manualTimers(): TerminalProblemsTimers & { run(ms: number): void; pending(): number } {
  let now = 0
  let seq = 0
  const queue = new Map<number, { at: number; callback: () => void }>()
  return {
    set: (callback, ms) => {
      seq += 1
      queue.set(seq, { at: now + ms, callback })
      return seq
    },
    clear: (handle) => queue.delete(handle as number),
    run: (ms) => {
      now += ms
      for (const [id, entry] of [...queue.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at > now) continue
        queue.delete(id)
        entry.callback()
      }
    },
    pending: () => queue.size,
  }
}

function info(terminalId: string, extra: Partial<TerminalInfo> = {}): TerminalInfo {
  return { terminalId, kind: 'user', title: 'zsh', cwd: '/work/jupiter-core', projectRoot: '/work/jupiter-core', ...extra }
}

function setup() {
  const timers = manualTimers()
  const changes: TerminalProblemCounts[] = []
  let clock = 1_000
  const service = new TerminalProblemsService({ onChanged: (counts) => changes.push(counts), timers, now: () => clock })
  return { service, timers, changes, advance: (ms: number) => (clock += ms) }
}

describe('TerminalProblemsService', () => {
  test('output is read in a batch, and one coalesced broadcast carries the counts', () => {
    const { service, timers, changes } = setup()
    service.track(info('t1'))
    service.data('t1', 'Error: one\n')
    service.data('t1', 'Error: two\n')
    expect(service.counts()).toEqual({ errors: 0, warnings: 0 }) // not read yet
    timers.run(BATCH_MS)
    expect(service.counts()).toEqual({ errors: 2, warnings: 0 })
    expect(changes).toEqual([])
    service.data('t1', 'WARNING: three\n')
    timers.run(BATCH_MS)
    timers.run(BROADCAST_MS)
    expect(changes).toEqual([{ errors: 2, warnings: 1 }])
  })

  test('output without problems never broadcasts', () => {
    const { service, timers, changes } = setup()
    service.track(info('t1'))
    service.data('t1', 'compiled\nready\n')
    timers.run(BATCH_MS)
    timers.run(BROADCAST_MS)
    expect(changes).toEqual([])
    expect(timers.pending()).toBe(0)
  })

  test('agent terminals are not read', () => {
    const { service, timers } = setup()
    service.track(info('agent', { kind: 'agent' }))
    service.data('agent', 'Error: from the agent\n')
    timers.run(BATCH_MS)
    expect(service.counts()).toEqual({ errors: 0, warnings: 0 })
  })

  test('the snapshot groups by terminal, newest first, with label, project and Launchpad flag', () => {
    const { service, timers, advance } = setup()
    service.track(info('plain', { title: 'zsh' }))
    service.track(
      info('step', { title: 'core-dev', run: { scopeKey: 'k', stepId: 's', projectRoot: '/work/jupiter-core' } }),
    )
    service.data('plain', 'Error: older\n')
    timers.run(BATCH_MS)
    advance(1_000)
    service.data('step', 'WARNING: newer\nError: newest\n')
    timers.run(BATCH_MS)
    const snapshot = service.snapshot()
    expect(snapshot.counts).toEqual({ errors: 2, warnings: 1 })
    expect(snapshot.withheld).toBe(0)
    expect(snapshot.groups.map((group) => [group.terminalId, group.label, group.projectName, group.launchpad])).toEqual([
      ['step', 'core-dev', 'jupiter-core', true],
      ['plain', 'zsh', 'jupiter-core', false],
    ])
    expect(snapshot.groups[0]!.problems.map((problem) => problem.message)).toEqual(['Error: newest', 'newer'])
  })

  test('limit 0 is counts only; a bound sends errors before warnings and says what it withheld', () => {
    const { service, timers } = setup()
    service.track(info('a'))
    service.track(info('b'))
    service.data('a', 'WARNING: alpha\nWARNING: beta\nWARNING: gamma\n')
    service.data('b', 'Error: e1\n')
    timers.run(BATCH_MS)
    expect(service.snapshot(0)).toEqual({ counts: { errors: 1, warnings: 3 }, groups: [], withheld: 4 })
    const bounded = service.snapshot(2)
    expect(bounded.withheld).toBe(2)
    expect(bounded.groups.flatMap((group) => group.problems.map((problem) => problem.message))).toContain('Error: e1')
  })

  test('a closed terminal takes its rows; clear empties every terminal; both broadcast', () => {
    const { service, timers, changes } = setup()
    service.track(info('a'))
    service.track(info('b'))
    service.data('a', 'Error: a\n')
    service.data('b', 'Error: b\n')
    timers.run(BATCH_MS)
    timers.run(BROADCAST_MS)
    expect(changes.at(-1)).toEqual({ errors: 2, warnings: 0 })
    service.removed('a')
    timers.run(BROADCAST_MS)
    expect(changes.at(-1)).toEqual({ errors: 1, warnings: 0 })
    service.clear()
    timers.run(BROADCAST_MS)
    expect(changes.at(-1)).toEqual({ errors: 0, warnings: 0 })
    // The terminal is still read after a clear.
    service.data('b', 'Error: again\n')
    timers.run(BATCH_MS)
    expect(service.counts()).toEqual({ errors: 1, warnings: 0 })
  })

  test('a rename relabels the rows', () => {
    const { service, timers } = setup()
    service.track(info('a', { title: 'zsh' }))
    service.data('a', 'Error: a\n')
    timers.run(BATCH_MS)
    service.updateInfo(info('a', { title: 'api' }))
    expect(service.snapshot().groups[0]!.label).toBe('api')
  })

  test('the exit flushes an unfinished line', () => {
    const { service } = setup()
    service.track(info('a'))
    service.data('a', 'Error: no newline')
    service.exited('a')
    expect(service.counts()).toEqual({ errors: 1, warnings: 0 })
  })

  test('a flood keeps the pending batch bounded and starts at a whole line', () => {
    const { service, timers } = setup()
    service.track(info('a'))
    const chunk = `${'y'.repeat(1023)}\n`
    for (let index = 0; index < (MAX_PENDING_CHARS / 1024) * 2; index += 1) service.data('a', chunk)
    service.data('a', 'Error: at the end\n')
    timers.run(BATCH_MS)
    expect(service.snapshot().groups[0]!.problems.map((problem) => problem.message)).toEqual(['Error: at the end'])
  })
})

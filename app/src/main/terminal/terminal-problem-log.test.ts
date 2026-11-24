import { CONTEXT_LINES, MAX_PROBLEMS_PER_TERMINAL, TerminalProblemLog } from './terminal-problem-log'

const ESC = '\u001b'

function clock(start = 1_000): { now: () => number; tick: (ms: number) => void } {
  let at = start
  return { now: () => at, tick: (ms) => (at += ms) }
}

const warning = (second: number): string =>
  `2026-11-18 20:56:0${second}.890 | WARNING  | lumen_core.harness.runtime.stop_signal:_resubscribe:588 - Stop signal resubscribe failed: Error 61 connecting to localhost:6379. Connection refused.\r\n`

const TRACEBACK = [
  'Traceback (most recent call last):',
  '  File "/app/worker.py", line 12, in main',
  '    await run()',
  '  File ".../asyncpg/connect_utils.py", line 969, in _create_ssl_connection',
  '    tr, pr = await loop.create_connection(',
  '  File "uvloop/loop.pyx", line 2020, in uvloop.loop.Loop.create_connection',
  '    await waiter',
  `${ESC}[31mConnectionRefusedError: [Errno 61] Connection refused${ESC}[0m`,
].join('\r\n')

describe('TerminalProblemLog', () => {
  test('a repeated warning is one row counted, first seen kept, last seen moved', () => {
    const time = clock()
    const log = new TerminalProblemLog('t1', time.now)
    for (let second = 1; second <= 5; second += 1) {
      expect(log.feed(warning(second))).toBe(true)
      time.tick(1_000)
    }
    const [row, ...rest] = log.problems()
    expect(rest).toEqual([])
    expect(row).toMatchObject({
      terminalId: 't1',
      severity: 'warning',
      count: 5,
      firstSeen: 1_000,
      lastSeen: 5_000,
      meta: 'lumen_core.harness.runtime.stop_signal',
      message: 'Stop signal resubscribe failed: Error 61 connecting to localhost:6379. Connection refused.',
    })
    expect(log.counts()).toEqual({ errors: 0, warnings: 1 })
  })

  test('keeps the lines printed before the problem, ANSI removed, and the problem line itself', () => {
    const log = new TerminalProblemLog('t1')
    log.feed(`${TRACEBACK}\r\n`)
    const [row] = log.problems()
    expect(row!.severity).toBe('error')
    expect(row!.line).toBe('ConnectionRefusedError: [Errno 61] Connection refused')
    expect(row!.context).toHaveLength(CONTEXT_LINES)
    expect(row!.context[0]).toBe('  File "/app/worker.py", line 12, in main')
    expect(row!.context.at(-1)).toBe('    await waiter')
    expect(row!.firstContext).toEqual(row!.context)
  })

  test('the latest context replaces the old one on a repeat; the first stays', () => {
    const log = new TerminalProblemLog('t1')
    log.feed('first try\nError: boom\n')
    log.feed('second try\nError: boom\n')
    const [row] = log.problems()
    expect(row!.count).toBe(2)
    expect(row!.firstContext).toEqual(['first try'])
    expect(row!.context).toEqual(['first try', 'Error: boom', 'second try'])
  })

  test('a line split across chunks is judged once, whole', () => {
    const log = new TerminalProblemLog('t1')
    expect(log.feed('Connection')).toBe(false)
    expect(log.feed('RefusedError: [Errno 61] Conn')).toBe(false)
    expect(log.feed('ection refused\r\nnext')).toBe(true)
    expect(log.problems().map((row) => row.message)).toEqual(['ConnectionRefusedError: [Errno 61] Connection refused'])
  })

  test('an unfinished last line counts when the process exits', () => {
    const log = new TerminalProblemLog('t1')
    log.feed('Error: exited without a newline')
    expect(log.size).toBe(0)
    expect(log.flush()).toBe(true)
    expect(log.size).toBe(1)
  })

  test('colour that spans lines is followed', () => {
    const log = new TerminalProblemLog('t1')
    log.feed(`${ESC}[31mthe whole block is red now\nand this line too is red\n${ESC}[0mplain line here\n`)
    expect(log.problems().map((row) => row.message)).toEqual(['and this line too is red', 'the whole block is red now'])
  })

  test('newest first, and only the newest distinct problems are kept', () => {
    const time = clock()
    const log = new TerminalProblemLog('t1', time.now)
    for (let index = 0; index < MAX_PROBLEMS_PER_TERMINAL + 5; index += 1) {
      log.feed(`Error: problem number ${'x'.repeat(index + 1)}\n`)
      time.tick(1)
    }
    expect(log.size).toBe(MAX_PROBLEMS_PER_TERMINAL)
    const problems = log.problems()
    expect(problems[0]!.message).toBe(`Error: problem number ${'x'.repeat(MAX_PROBLEMS_PER_TERMINAL + 5)}`)
    expect(problems.some((row) => row.message === 'Error: problem number x')).toBe(false)
  })

  test('a repeat moves its row to the front', () => {
    const time = clock()
    const log = new TerminalProblemLog('t1', time.now)
    log.feed('Error: alpha\n')
    time.tick(1)
    log.feed('Error: beta\n')
    time.tick(1)
    log.feed('Error: alpha\n')
    expect(log.problems().map((row) => row.message)).toEqual(['Error: alpha', 'Error: beta'])
  })

  test('output without problems changes nothing; clear empties the rows', () => {
    const log = new TerminalProblemLog('t1')
    expect(log.feed('compiling…\nready in 120 ms\n')).toBe(false)
    log.feed('Error: x\n')
    log.clear()
    expect(log.size).toBe(0)
    expect(log.counts()).toEqual({ errors: 0, warnings: 0 })
  })

  test('a long progress line without newlines stays bounded', () => {
    const log = new TerminalProblemLog('t1')
    for (let index = 0; index < 2_000; index += 1) log.feed(`\rdownloading ${index}% ${'#'.repeat(40)}`)
    log.feed('\n')
    expect(log.size).toBe(0)
  })
})

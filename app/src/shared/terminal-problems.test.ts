import {
  applySgr,
  colourOfLine,
  detectProblem,
  lastScreenSegment,
  normalizeProblemText,
  problemFingerprint,
  stripAnsi,
  type DetectedProblem,
} from './terminal-problems'

const ESC = '\u001b'
const red = (text: string): string => `${ESC}[31m${text}${ESC}[0m`
const yellow = (text: string): string => `${ESC}[33m${text}${ESC}[0m`

/** Judge a raw line the way the log does: colour first, then words. */
function judge(raw: string): DetectedProblem | null {
  return detectProblem(raw, colourOfLine(raw, null).tone)
}

describe('stripAnsi', () => {
  test('removes colours, cursor moves, titles and control characters but keeps tabs', () => {
    expect(stripAnsi(`${ESC}[1;31mboom${ESC}[0m`)).toBe('boom')
    expect(stripAnsi(`${ESC}[2K${ESC}[1Gdone`)).toBe('done')
    expect(stripAnsi(`${ESC}]0;title\u0007shell`)).toBe('shell')
    expect(stripAnsi('a\tb\u0007')).toBe('a\tb')
  })
})

describe('colour', () => {
  test('SGR red, bright red, 256-colour and truecolor reds are red', () => {
    expect(applySgr(null, '31')).toBe('red')
    expect(applySgr(null, '1;91')).toBe('red')
    expect(applySgr(null, '38;5;196')).toBe('red')
    expect(applySgr(null, '38;5;9')).toBe('red')
    expect(applySgr(null, '38;2;230;40;40')).toBe('red')
    expect(applySgr(null, '33')).toBe('yellow')
    expect(applySgr(null, '38;5;220')).toBe('yellow')
    expect(applySgr('red', '0')).toBeNull()
    expect(applySgr('red', '')).toBeNull()
    expect(applySgr('red', '39')).toBeNull()
    expect(applySgr(null, '32')).toBe('other')
    // A background colour's parameters are not read as a foreground.
    expect(applySgr(null, '48;5;196')).toBeNull()
  })

  test('a line is red when most of what it shows is red', () => {
    expect(colourOfLine(red('ConnectionRefusedError: refused'), null).tone).toBe('red')
    expect(colourOfLine(`${red('FAIL')} src/a.test.ts and a long tail in plain text`, null).tone).toBeNull()
    expect(colourOfLine(yellow('deprecated: use the other one'), null).tone).toBe('yellow')
  })

  test('colour carries over to the next line until it is reset', () => {
    const first = colourOfLine(`${ESC}[31mTraceback starts here`, null)
    expect(first.end).toBe('red')
    expect(colourOfLine('  and continues red', first.end).tone).toBe('red')
  })

  test('only what a carriage return left on screen counts, and a CRLF ending is not a redraw', () => {
    expect(colourOfLine(`${red('downloading 10%')}\rall good now`, null).tone).toBeNull()
    expect(colourOfLine(`${red('a real red error line')}\r`, null).tone).toBe('red')
    expect(lastScreenSegment('10%\r50%\r100% done\r')).toBe('100% done')
  })
})

describe('detectProblem — structured log lines', () => {
  test('Python loguru: level, message after the location, module as meta', () => {
    expect(
      judge(
        '2026-11-18 20:56:06.890 | WARNING  | jupiter_core.harness.runtime.stop_signal:_resubscribe:588 - Stop signal resubscribe failed: Error 61 connecting to localhost:6379. Connection refused.',
      ),
    ).toEqual({
      severity: 'warning',
      message: 'Stop signal resubscribe failed: Error 61 connecting to localhost:6379. Connection refused.',
      meta: 'jupiter_core.harness.runtime.stop_signal',
    })
    expect(judge('2026-11-18 20:56:07.001 | ERROR    | app.db:connect:12 - could not connect')).toMatchObject({
      severity: 'error',
      message: 'could not connect',
      meta: 'app.db',
    })
  })

  test('loguru with its own colours is read the same way', () => {
    const raw = `${ESC}[32m2026-11-18 20:56:06.890${ESC}[0m | ${ESC}[33m${ESC}[1mWARNING ${ESC}[0m | ${ESC}[36mmod.sub${ESC}[0m:${ESC}[36mfn${ESC}[0m:${ESC}[36m588${ESC}[0m - ${ESC}[33m${ESC}[1mretry failed${ESC}[0m`
    expect(judge(raw)).toEqual({ severity: 'warning', message: 'retry failed', meta: 'mod.sub' })
  })

  test('Rust tracing: level after the timestamp, target as meta', () => {
    expect(
      judge('2026-11-18T23:55:52.313450Z  WARN temporalio_sdk_core::worker: Namespace celeste is not found.'),
    ).toEqual({ severity: 'warning', message: 'Namespace celeste is not found.', meta: 'temporalio_sdk_core::worker' })
    const coloured = `${ESC}[2m2026-11-18T23:55:52.313450Z${ESC}[0m ${ESC}[31mERROR${ESC}[0m ${ESC}[2mtemporalio_sdk_core::worker${ESC}[0m${ESC}[2m:${ESC}[0m Worker failed`
    expect(judge(coloured)).toEqual({ severity: 'error', message: 'Worker failed', meta: 'temporalio_sdk_core::worker' })
  })

  test('the level token wins: DEBUG and INFO lines are not problems, even red or saying "error"', () => {
    expect(judge('2026-11-18 20:56:06.890 | INFO     | app.retry:loop:1 - error budget is fine')).toBeNull()
    expect(judge('2026-11-18T23:55:52Z DEBUG hyper::client: error parsing header, retrying')).toBeNull()
    expect(judge(red('INFO: error handler registered'))).toBeNull()
    expect(judge('[debug] Error: not really, just a log line')).toBeNull()
    expect(judge('{"level":"info","msg":"error count 0"}')).toBeNull()
    expect(judge('level=info msg="error rate normal"')).toBeNull()
  })

  test('bracketed, upper-case, Python logging and uvicorn levels', () => {
    expect(judge('[ERROR] build failed')).toMatchObject({ severity: 'error', message: 'build failed' })
    expect(judge('[warn] cache is cold')).toMatchObject({ severity: 'warning', message: 'cache is cold' })
    expect(judge('ERROR:    Exception in ASGI application')).toMatchObject({ severity: 'error', message: 'Exception in ASGI application' })
    expect(judge('INFO:     127.0.0.1:52344 - "GET /health HTTP/1.1" 200 OK')).toBeNull()
    expect(judge('WARNING:root:disk almost full')).toEqual({ severity: 'warning', message: 'disk almost full', meta: 'root' })
    expect(judge('FATAL: database files are incompatible')).toMatchObject({ severity: 'error' })
    expect(judge('CRITICAL out of memory')).toMatchObject({ severity: 'error', message: 'out of memory' })
    expect(judge('12:00:01 [error] socket closed')).toMatchObject({ severity: 'error', message: 'socket closed' })
  })

  test('JSON and logfmt lines', () => {
    expect(judge('{"level":"error","msg":"payment failed","logger":"billing"}')).toEqual({
      severity: 'error',
      message: 'payment failed',
      meta: 'billing',
    })
    expect(judge('{"level":40,"time":1,"msg":"slow query"}')).toMatchObject({ severity: 'warning', message: 'slow query' })
    expect(judge('time=2026-11-18T10:00:00Z level=error msg="queue full" component=worker')).toEqual({
      severity: 'error',
      message: 'queue full',
      meta: 'worker',
    })
  })
})

describe('detectProblem — shapes that are errors by position', () => {
  test('a traceback ends with the exception line', () => {
    expect(judge('ConnectionRefusedError: [Errno 61] Connection refused')).toEqual({
      severity: 'error',
      message: 'ConnectionRefusedError: [Errno 61] Connection refused',
      meta: null,
    })
    expect(judge('RuntimeError: Workflow worker failed')).toMatchObject({ severity: 'error', message: 'RuntimeError: Workflow worker failed' })
    expect(judge('asyncpg.exceptions.InvalidPasswordError: password authentication failed')).toMatchObject({ severity: 'error' })
    expect(judge('Uncaught TypeError: x is not a function')).toMatchObject({ severity: 'error' })
    expect(judge('Exception in thread "main" java.lang.NullPointerException')).toMatchObject({ severity: 'error' })
  })

  test('the traceback frames around it are not problems', () => {
    expect(judge('Traceback (most recent call last):')).toBeNull()
    expect(judge('  File ".../asyncpg/connect_utils.py", line 969, in _create_ssl_connection')).toBeNull()
    expect(judge('    tr, pr = await loop.create_connection(')).toBeNull()
    expect(judge('    raise RuntimeError("Workflow worker failed")')).toBeNull()
    // An indented exception shape is a continuation, not a new problem.
    expect(judge('    ValueError: inside a chained message')).toBeNull()
  })

  test('error: / Error: / warning: at the start, rustc codes, npm, panics', () => {
    expect(judge('error: could not compile `app` due to 2 previous errors')).toMatchObject({ severity: 'error' })
    expect(judge('error[E0308]: mismatched types')).toMatchObject({ severity: 'error', message: 'error[E0308]: mismatched types' })
    expect(judge('warning: unused variable: `x`')).toMatchObject({ severity: 'warning' })
    expect(judge("Error: Cannot find module 'express'")).toMatchObject({ severity: 'error' })
    expect(judge('Warning: Each child in a list should have a unique "key" prop.')).toMatchObject({ severity: 'warning' })
    expect(judge('npm ERR! code ELIFECYCLE')).toEqual({ severity: 'error', message: 'code ELIFECYCLE', meta: 'npm' })
    expect(judge('npm WARN deprecated inflight@1.0.6')).toMatchObject({ severity: 'warning', meta: 'npm' })
    expect(judge('panic: runtime error: index out of range [3] with length 3')).toMatchObject({ severity: 'error' })
    expect(judge("thread 'main' panicked at src/main.rs:4:5:")).toMatchObject({ severity: 'error' })
  })

  test('compiler diagnostics keep their location as meta', () => {
    expect(judge('src/main.c:12:5: error: expected ‘;’ before ‘}’ token')).toEqual({
      severity: 'error',
      message: 'expected ‘;’ before ‘}’ token',
      meta: 'src/main.c:12:5',
    })
    expect(judge('src/app.ts(12,5): error TS2322: Type string is not assignable to type number.')).toMatchObject({
      severity: 'error',
      message: 'TS2322: Type string is not assignable to type number.',
      meta: 'src/app.ts(12,5)',
    })
    expect(judge('src/app.ts:12:5 - error TS2322: Type mismatch.')).toMatchObject({ severity: 'error', meta: 'src/app.ts:12:5' })
    expect(judge('/app/x.py:3: DeprecationWarning: datetime.utcnow() is deprecated')).toEqual({
      severity: 'warning',
      message: 'DeprecationWarning: datetime.utcnow() is deprecated',
      meta: '/app/x.py:3',
    })
  })

  test('a docker compose prefix is looked through and kept as meta', () => {
    expect(judge('web-1  | ERROR: relation "users" does not exist')).toEqual({
      severity: 'error',
      message: 'relation "users" does not exist',
      meta: 'web-1',
    })
  })
})

describe('detectProblem — colour, and what never counts', () => {
  test('a red line is an error, a yellow line a warning', () => {
    expect(judge(red('ConnectionRefusedError: [Errno 61] Connection refused'))).toMatchObject({ severity: 'error' })
    expect(judge(red('Something went badly wrong here'))).toMatchObject({ severity: 'error', message: 'Something went badly wrong here' })
    expect(judge(yellow('Port 3000 is in use, trying another one'))).toMatchObject({ severity: 'warning' })
    expect(judge(`${ESC}[38;5;196mrequest failed with status 500${ESC}[0m`)).toMatchObject({ severity: 'error' })
  })

  test('diffs, single red words and file listings are not problems', () => {
    expect(judge(red('-  const removed = true'))).toBeNull()
    expect(judge(red('+++ b/src/file.ts'))).toBeNull()
    expect(judge(red('build.sh'))).toBeNull()
    expect(judge(red('FAIL'))).toBeNull()
  })

  test('"error" in ordinary prose is not at a level position', () => {
    expect(judge('Compiled with 0 errors and 2 hints')).toBeNull()
    expect(judge('error handling is done in the middleware')).toBeNull()
    expect(judge('The ERROR column shows failures per day')).toBeNull()
    expect(judge('Checking for errors... none found')).toBeNull()
    expect(judge('bruno@mac app % printf "ConnectionRefusedError: x"')).toBeNull()
    expect(judge('')).toBeNull()
    expect(judge('   ')).toBeNull()
  })

  test('a line longer than the cap is cut', () => {
    const found = judge(`Error: ${'x'.repeat(5000)}`)
    expect(found?.message.length).toBeLessThanOrEqual(2000)
  })
})

describe('the same problem', () => {
  test('times, dates, ids, numbers and quoted values are taken out; the host stays', () => {
    expect(normalizeProblemText('Error 61 connecting to localhost:6379. Connection refused.')).toBe(
      'Error # connecting to localhost:#. Connection refused.',
    )
    expect(normalizeProblemText('job 3f2a9c1e-1d2b-4c3a-9e8f-0123456789ab failed at 2026-11-18T20:55:14Z')).toBe(
      'job <id> failed at <time>',
    )
    expect(normalizeProblemText("Cannot find module 'express' at 0x7ffe12")).toBe("Cannot find module '…' at <hex>")
    expect(normalizeProblemText("can't connect, don't retry")).toBe("can't connect, don't retry")
  })

  test('repeats share a fingerprint; a different message or severity does not', () => {
    const a = problemFingerprint({ severity: 'warning', message: 'retry 1 of 5 failed after 120ms', meta: 'mod' })
    const b = problemFingerprint({ severity: 'warning', message: 'retry 2 of 5 failed after 98ms', meta: 'mod' })
    expect(a).toBe(b)
    expect(problemFingerprint({ severity: 'error', message: 'retry 1 of 5 failed after 120ms', meta: 'mod' })).not.toBe(a)
    expect(problemFingerprint({ severity: 'warning', message: 'token refresh failed', meta: 'mod' })).not.toBe(a)
  })
})

import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  readSlowLog,
  recordSlow,
  setSlowLogDirectory,
  slowLogPath,
  timed,
  watchEventLoopLag,
} from './slow-handler'

describe('the slow log', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flow-slowlog-'))
    setSlowLogDirectory(dir)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes where the user’s machine keeps it', () => {
    // console.log in a packaged app goes nowhere its user can read, which is
    // why "it is slow again" kept being unanswerable.
    recordSlow('[ipc] threads:list handled in 900ms')
    const written = readFileSync(join(dir, 'logs', 'slow.log'), 'utf8')
    expect(written).toContain('threads:list handled in 900ms')
    // Timestamped, because "which of these was the click I made" is the
    // question a log has to answer.
    expect(written).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('hands back its tail, newest last — the report somebody pastes', () => {
    recordSlow('[ipc] first')
    recordSlow('[renderer] blocked for 900ms (nothing in flight)')
    const report = readSlowLog()
    expect(report).toContain('[ipc] first')
    expect(report.indexOf('[ipc] first')).toBeLessThan(report.indexOf('blocked for 900ms'))
  })

  it('reports emptiness as an answer, not as a failure', () => {
    // "Nothing has been slow enough to record" is a finding. A thrown error or
    // a missing file would read as the instrument being broken.
    expect(readSlowLog()).toBe('')
    expect(slowLogPath()).toContain('slow.log')
  })

  it('keeps the tail when the log outgrows what a person can read', () => {
    for (let i = 0; i < 200; i += 1) recordSlow(`[ipc] line ${String(i)}`)
    const tail = readSlowLog(400)
    expect(tail.length).toBeLessThanOrEqual(400)
    expect(tail).toContain('line 199')
    expect(tail).not.toContain('line 0 ')
  })

  it('never lets a broken log break the app', () => {
    setSlowLogDirectory('/definitely/not/a/writable/place')
    expect(() => recordSlow('anything')).not.toThrow()
  })

  it('times a handler and stays out of the way of a fast one', async () => {
    const fast = timed('threads:list', () => 'ok')
    await expect(fast(undefined)).resolves.toBe('ok')
    expect(existsSync(join(dir, 'logs', 'slow.log'))).toBe(false)

    const slow = timed('blueprint:read', async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return 'late'
    })
    await expect(slow(undefined)).resolves.toBe('late')
    expect(readFileSync(join(dir, 'logs', 'slow.log'), 'utf8')).toContain('blueprint:read handled in')
  })

  it('records a handler that threw, then rethrows it', async () => {
    const boom = timed('git:status', async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      throw new Error('nope')
    })
    await expect(boom(undefined)).rejects.toThrow('nope')
    expect(readFileSync(join(dir, 'logs', 'slow.log'), 'utf8')).toContain('git:status')
  })

  it('notices the main process being blocked by work that never crosses IPC', async () => {
    // The handlers were all fast and the app was still busy: a watcher's scan,
    // a synchronous read, a spawn nobody requested. A timer measuring its own
    // lateness catches those, and names nothing it cannot prove.
    const stop = watchEventLoopLag(20, 50)
    try {
      const until = Date.now() + 140
      while (Date.now() < until) {
        // Block the loop on purpose.
      }
      await new Promise((resolve) => setTimeout(resolve, 60))
      const written = readFileSync(join(dir, 'logs', 'slow.log'), 'utf8')
      expect(written).toMatch(/\[main\] blocked for \d+ms/)
    } finally {
      stop()
    }
  })
})

describe('a stall says whether it was working or waiting', () => {
  it('carries CPU, heap and what was in flight', async () => {
    // "blocked for 12796ms" told us the symptom and nothing about the cause.
    // A loop 12 s late having spent 0.2 s of CPU was blocked on something; one
    // that spent 12 s was computing — two different bugs, one symptom.
    const dir = mkdtempSync(join(tmpdir(), 'flow-stall-'))
    setSlowLogDirectory(dir)
    const stop = watchEventLoopLag(20, 50)
    try {
      const until = Date.now() + 140
      while (Date.now() < until) {
        // Burn the loop on purpose: this one IS the working kind.
      }
      await new Promise((resolve) => setTimeout(resolve, 60))
      const written = readFileSync(join(dir, 'logs', 'slow.log'), 'utf8')
      expect(written).toMatch(/\[main\] blocked for \d+ms \(cpu \d+ms, heap \d+MB, /)
      // Nothing was in flight, and it says so rather than leaving a blank.
      expect(written).toContain('nothing in flight')
    } finally {
      stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

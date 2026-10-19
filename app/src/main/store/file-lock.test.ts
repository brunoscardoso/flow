// The main process's async advisory file lock — the on-disk convention it
// shares with the CLI (`<target>.lock`, exclusive-create, stale takeover) and
// the one thing it does DIFFERENTLY: re-entrancy is per async context, not a
// module-level set, so two concurrent writers never mistake each other's hold
// for their own.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FileLockTimeoutError, withFileLock } from './file-lock'

/** Small enough to test the deadline, large enough to never flake. */
const LIMITS = { staleMs: 60_000, waitMs: 400, retryMs: 10 }

/** A wait long enough that an unserialized second writer overlaps the first. */
const OVERLAP_MS = 30

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('withFileLock', () => {
  let tempDir: string
  let lockPath: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'flow-file-lock-test-'))
    lockPath = join(tempDir, 'nested', 'thing.lock')
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('holds the lock file for the duration of fn and releases it after', async () => {
    const result = await withFileLock(lockPath, LIMITS, async () => {
      await delay(1)
      expect(existsSync(lockPath)).toBe(true)
      return 'done'
    })
    expect(result).toBe('done')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('releases the lock when fn rejects', async () => {
    await expect(
      withFileLock(lockPath, LIMITS, async () => {
        throw new Error('holder refused')
      }),
    ).rejects.toThrow('holder refused')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('is re-entrant inside the holder’s own async context', async () => {
    const result = await withFileLock(lockPath, LIMITS, async () =>
      withFileLock(lockPath, LIMITS, async () => {
        expect(existsSync(lockPath)).toBe(true)
        return 'nested'
      }),
    )
    expect(result).toBe('nested')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('two different paths are independent holds', async () => {
    const other = join(tempDir, 'other.lock')
    await withFileLock(lockPath, LIMITS, async () => {
      expect(await withFileLock(other, LIMITS, () => 'both')).toBe('both')
    })
    expect(existsSync(lockPath)).toBe(false)
    expect(existsSync(other)).toBe(false)
  })

  it('serializes overlapping callers in the SAME process — no shared-set false re-entry', async () => {
    // The bug this pins: a module-level held-set (correct for the CLI's
    // synchronous lock) would let the second caller walk straight in while the
    // first is awaiting, which is the lost update the lock exists to stop.
    const order: string[] = []
    const critical = async (name: string): Promise<void> => {
      await withFileLock(lockPath, LIMITS, async () => {
        order.push(`${name}:enter`)
        await delay(OVERLAP_MS)
        order.push(`${name}:leave`)
      })
    }
    await Promise.all([critical('a'), critical('b')])
    // Whoever went first, neither entered while the other was inside.
    expect(order).toHaveLength(4)
    expect(order[1]).toBe(`${order[0].split(':')[0]}:leave`)
    expect(order[3]).toBe(`${order[2].split(':')[0]}:leave`)
  })

  it('takes over a stale lock left by a dead process', async () => {
    mkdirSync(join(tempDir, 'nested'), { recursive: true })
    writeFileSync(lockPath, '99999', 'utf-8')
    const past = new Date(Date.now() - LIMITS.staleMs - 60_000)
    utimesSync(lockPath, past, past)
    await expect(withFileLock(lockPath, LIMITS, () => 'reclaimed')).resolves.toBe('reclaimed')
    expect(existsSync(lockPath)).toBe(false)
  })

  it('a LIVE lock held by another process refuses with FileLockTimeoutError after the wait', async () => {
    mkdirSync(join(tempDir, 'nested'), { recursive: true })
    writeFileSync(lockPath, '99999', 'utf-8')
    // Freshly written, so it is live — acquisition must wait out `waitMs` and
    // then refuse rather than proceed unguarded: proceeding is the lost-update
    // bug the lock exists to stop.
    await expect(withFileLock(lockPath, LIMITS, () => 'never')).rejects.toBeInstanceOf(
      FileLockTimeoutError,
    )
    // The foreign lock is NOT ours to delete on refusal.
    expect(existsSync(lockPath)).toBe(true)
  })

  // ── Release must be OWNERSHIP-SCOPED (#1825) ────────────────────────────
  //
  // The release was `rm(lockPath, { force: true })` — whatever file is there,
  // not the one this holder took. After a stale takeover the path holds the NEW
  // holder's lock, so the slow holder's `finally` freed a lock it did not own
  // and the next waiter walked straight into an occupied critical section.
  //
  // The trigger is not a crash. It is a LIVE holder outliving `staleMs` — a
  // learn pass over a big corpus, a brain compaction, or a laptop suspend,
  // which makes every live holder read as stale on wake because staleness is
  // wall-clock mtime age.
  describe('a holder that was taken over while still running (#1825)', () => {
    /** staleMs small enough that a deliberately slow holder goes stale. */
    const TAKEOVER = { staleMs: 300, waitMs: 5_000, retryMs: 10 }

    // Every case here deliberately provokes the "ran unguarded" warning, which
    // is the behaviour under test, not noise to read. Captured rather than
    // printed so a real warning from somewhere else still stands out — and
    // asserted once below, so silencing it cannot hide its removal.
    let warned: jest.SpyInstance

    beforeEach(() => {
      warned = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    })

    afterEach(() => {
      warned.mockRestore()
    })

    it('warns that the completed work ran unguarded', async () => {
      const slow = withFileLock(lockPath, TAKEOVER, async () => {
        await delay(400)
      })
      await delay(320)
      const taker = withFileLock(lockPath, TAKEOVER, async () => {
        await delay(160)
      })
      await Promise.all([slow, taker])

      expect(warned).toHaveBeenCalledTimes(1)
      expect(String(warned.mock.calls[0]?.[0])).toContain('ran unguarded')
    })

    it('does not free the lock of the holder that took over from it', async () => {
      // TIMING IS THE WHOLE TEST, so it is spelled out. The takeover holder B
      // must stay UNDER staleMs for the entire window, otherwise C reclaims it
      // legitimately and the test would go green on by-design behaviour rather
      // than on the fix:
      //
      //   t=0    A acquires, will hold 400ms
      //   t=300  A's lock is stale (nobody has looked yet)
      //   t=320  B finds it stale, takes over, holds 280ms (< staleMs) -> to 600
      //   t=400  A's `finally` fires. THE BUG: it deleted B's lock file here.
      //   t=480  C attempts. B's lock is 160ms old — NOT stale, so C must wait.
      //   t=600  B releases; C acquires after it.
      let bInside = false
      let overlapped = false

      const a = withFileLock(lockPath, TAKEOVER, async () => {
        await delay(400)
      })

      await delay(320)

      const b = withFileLock(lockPath, TAKEOVER, async () => {
        bInside = true
        await delay(280)
        bInside = false
      })

      await delay(160) // t=480: A's finally has fired, B is still inside and fresh

      const c = withFileLock(lockPath, TAKEOVER, async () => {
        if (bInside) overlapped = true
      })

      await Promise.all([a, b, c])
      expect(overlapped).toBe(false)
    })

    it('leaves the new holder’s lock file on disk when it exits', async () => {
      // The mechanism, asserted directly: A's release is a no-op because the
      // file it finds is not the one it wrote.
      const slow = withFileLock(lockPath, TAKEOVER, async () => {
        await delay(400)
      })
      await delay(320)

      let lockPresentAfterSlowExited = false
      const taker = withFileLock(lockPath, TAKEOVER, async () => {
        await delay(160) // outlives the slow holder's release at t=400
        lockPresentAfterSlowExited = existsSync(lockPath)
      })

      await Promise.all([slow, taker])
      expect(lockPresentAfterSlowExited).toBe(true)
    })

    it('still removes its OWN lock file on the ordinary path', async () => {
      // The fix must not turn release into a leak.
      await withFileLock(lockPath, TAKEOVER, async () => {
        expect(existsSync(lockPath)).toBe(true)
      })
      expect(existsSync(lockPath)).toBe(false)
    })

    it('two writers in the SAME process get distinct tokens — a pid cannot tell them apart', async () => {
      // Both real call sites (learning-state, brain compaction) live in the
      // main process, so the pid written at acquire time is identical for two
      // concurrent holders. Ownership has to be per-acquisition.
      const first = withFileLock(lockPath, TAKEOVER, async () => {
        await delay(400)
      })
      await delay(320)
      const tokenDuringTakeover = withFileLock(lockPath, TAKEOVER, async () => {
        await delay(160)
        return readFileSync(lockPath, 'utf-8')
      })
      const [, token] = await Promise.all([first, tokenDuringTakeover])
      expect(token).not.toBe(String(process.pid))
      expect(token.length).toBeGreaterThan(0)
    })
  })
})

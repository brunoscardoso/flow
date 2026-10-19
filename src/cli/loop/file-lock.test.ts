/**
 * Tests for the advisory inter-process file lock (#1662, #1663).
 *
 * Real fs via mkdtemp, like the sibling store tests. The limits are injected,
 * so the deadline branch is proven in milliseconds rather than by waiting out
 * a production-sized window; staleness is proven by aging the file with
 * `utimesSync`, never by sleeping.
 */

import { jest } from '@jest/globals';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { FileLockTimeoutError, withFileLock } = await import('./file-lock.js');

/** Small enough to test the deadline, large enough to never flake. */
const LIMITS = { staleMs: 60_000, waitMs: 200, retryMs: 10 };

describe('withFileLock', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'plan-flow-file-lock-test-'));
    lockPath = join(tempDir, 'nested', 'thing.lock');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('holds the lock file for the duration of fn and releases it after', () => {
    const result = withFileLock(lockPath, LIMITS, () => {
      expect(existsSync(lockPath)).toBe(true);
      return 'done';
    });
    expect(result).toBe('done');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when fn throws', () => {
    expect(() =>
      withFileLock(lockPath, LIMITS, () => {
        throw new Error('holder refused');
      }),
    ).toThrow('holder refused');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('is re-entrant per path within a process, and the OUTER hold releases', () => {
    const result = withFileLock(lockPath, LIMITS, () =>
      withFileLock(lockPath, LIMITS, () => {
        expect(existsSync(lockPath)).toBe(true);
        return 'nested';
      }),
    );
    expect(result).toBe('nested');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('two different paths are independent holds', () => {
    const other = join(tempDir, 'other.lock');
    withFileLock(lockPath, LIMITS, () => {
      const result = withFileLock(other, LIMITS, () => 'both');
      expect(result).toBe('both');
    });
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(other)).toBe(false);
  });

  it('takes over a stale lock left by a dead process', () => {
    mkdirSync(join(tempDir, 'nested'), { recursive: true });
    writeFileSync(lockPath, '99999', 'utf-8');
    const past = new Date(Date.now() - LIMITS.staleMs - 60_000);
    utimesSync(lockPath, past, past);
    expect(withFileLock(lockPath, LIMITS, () => 'reclaimed')).toBe('reclaimed');
    expect(existsSync(lockPath)).toBe(false);
  });

  it('a LIVE lock held by another process refuses with FileLockTimeoutError after the wait', () => {
    mkdirSync(join(tempDir, 'nested'), { recursive: true });
    writeFileSync(lockPath, '99999', 'utf-8');
    // Freshly written, so it is live — acquisition must wait out `waitMs` and
    // then refuse rather than proceed unguarded: proceeding is the lost-update
    // bug the lock exists to stop.
    expect(() => withFileLock(lockPath, LIMITS, () => 'never')).toThrow(FileLockTimeoutError);
    // The foreign lock is NOT ours to delete on refusal.
    expect(existsSync(lockPath)).toBe(true);
  });

  // ── Release is OWNERSHIP-SCOPED (#1825) ────────────────────────────────
  //
  // The release was an unconditional `unlinkSync`. A holder that outlives
  // `staleMs` gets taken over, and by the time its `finally` runs the path
  // holds the TAKEOVER holder's lock — which the unlink then deleted, freeing
  // a critical section somebody was still inside.
  //
  // Here the hazard is strictly cross-process (a synchronous `fn` cannot
  // interleave within one process), so the takeover holder is simulated by a
  // lock file this process did not write — which is exactly what another CLI
  // invocation's lock looks like from in here.
  describe('a holder that was taken over while still running (#1825)', () => {
    it('leaves a lock file it does not own alone, instead of deleting it', () => {
      mkdirSync(join(tempDir, 'nested'), { recursive: true });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      withFileLock(lockPath, LIMITS, () => {
        // Mid-flight, another process reclaims the lock and writes its own
        // token over ours. Our release must now be a no-op.
        writeFileSync(lockPath, 'another-process-token', 'utf-8');
      });

      expect(existsSync(lockPath)).toBe(true);
      expect(readFileSync(lockPath, 'utf-8')).toBe('another-process-token');
      warn.mockRestore();
    });

    it('says out loud that the completed work ran unguarded', () => {
      mkdirSync(join(tempDir, 'nested'), { recursive: true });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

      withFileLock(lockPath, LIMITS, () => {
        writeFileSync(lockPath, 'another-process-token', 'utf-8');
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('ran unguarded');
      warn.mockRestore();
    });

    it('writes a token that is not the pid — two holders in one process would share one', () => {
      mkdirSync(join(tempDir, 'nested'), { recursive: true });
      let onDisk = '';
      withFileLock(lockPath, LIMITS, () => {
        onDisk = readFileSync(lockPath, 'utf-8');
      });
      expect(onDisk).not.toBe(String(process.pid));
      expect(onDisk.length).toBeGreaterThan(0);
    });

    it('still removes its OWN lock file on the ordinary path', () => {
      withFileLock(lockPath, LIMITS, () => undefined);
      expect(existsSync(lockPath)).toBe(false);
    });
  });
});

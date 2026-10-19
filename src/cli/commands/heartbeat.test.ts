/**
 * Tests for heartbeat CLI command
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { jest } from '@jest/globals';
import { runHeartbeat, startHeartbeatIfNeeded } from './heartbeat.js';

function createTempDir(): string {
  const dir = join(tmpdir(), `plan-flow-heartbeat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

describe('heartbeat CLI', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mkdirSync(join(tempDir, 'flow'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  describe('status', () => {
    it('should report stopped when no PID file exists', async () => {
      // Should not throw
      await runHeartbeat('status', { target: tempDir });
    });

    it('should clean stale PID file', async () => {
      const pidPath = join(tempDir, 'flow', '.heartbeat.pid');
      // Write a PID that is very unlikely to be running
      writeFileSync(pidPath, '999999999', 'utf-8');

      await runHeartbeat('status', { target: tempDir });

      // PID file should be cleaned up
      expect(existsSync(pidPath)).toBe(false);
    });
  });

  describe('stop', () => {
    it('should report not running when no PID file exists', async () => {
      // Should not throw
      await runHeartbeat('stop', { target: tempDir });
    });

    it('should clean stale PID on stop', async () => {
      const pidPath = join(tempDir, 'flow', '.heartbeat.pid');
      writeFileSync(pidPath, '999999999', 'utf-8');

      await runHeartbeat('stop', { target: tempDir });

      expect(existsSync(pidPath)).toBe(false);
    });
  });

  describe('start', () => {
    it('should warn when no heartbeat.md exists', async () => {
      // Should not throw, just warn
      await runHeartbeat('start', { target: tempDir });
      // No PID file should be created without heartbeat.md
      expect(existsSync(join(tempDir, 'flow', '.heartbeat.pid'))).toBe(false);
    });
  });

  describe('unknown action', () => {
    // This suite used to assert only "should not throw" — on `restart`, the
    // exact action that silently exited 0 (#1831). So the family's one
    // disagreement was not merely unguarded, it was pinned by a test whose
    // name called it graceful.
    //
    // `process.exitCode` is saved and restored around each case: the code under
    // test sets it on the REAL process, and leaking a 1 would fail the whole
    // jest run with every test passing.
    let previousExitCode: typeof process.exitCode;

    beforeEach(() => {
      previousExitCode = process.exitCode;
    });

    afterEach(() => {
      process.exitCode = previousExitCode;
    });

    it.each(['restart', 'statsu', 'bogus'])(
      'refuses %s with exit 1, in the family’s own wording',
      async (action) => {
        const errors: string[] = [];
        const spy = jest
          .spyOn(console, 'log')
          .mockImplementation((...args: unknown[]) => errors.push(String(args[0])));

        await runHeartbeat(action, { target: tempDir });
        spy.mockRestore();

        expect(process.exitCode).toBe(1);
        // `refused:` is the shape the CLI's E2E tests grep the combined
        // transcript for; the old `log.warn` line was invisible to it.
        const transcript = errors.join('\n');
        expect(transcript).toContain(`heartbeat refused: unknown action '${action}'`);
        expect(transcript).toContain('expected start|stop|status');
      },
    );

    it('leaves the exit code alone for an action that exists', async () => {
      // The other half: refusing must not become the default answer.
      process.exitCode = undefined;
      const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await runHeartbeat('status', { target: tempDir });
      spy.mockRestore();

      expect(process.exitCode).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// startHeartbeatIfNeeded — version-drift restart (Phase 1, Tasks 1.2–1.5)
//
// Every process seam is injected: no real daemon is signalled or spawned, and
// the injected `wait` resolves immediately, so nothing here sleeps.
// ---------------------------------------------------------------------------

interface Harness {
  target: string;
  stops: number[];
  spawns: string[];
  waits: number[];
  notices: string[];
  deps: Parameters<typeof startHeartbeatIfNeeded>[1];
}

const INSTALLED = '9.9.9';
const RUNNING_PID = 4242;

function makeHarness(
  target: string,
  options: {
    /** How many liveness polls the daemon survives after being stopped. */
    survivesPolls?: number;
    /** Never dies — proves the bounded wait degrades instead of hanging. */
    immortal?: boolean;
    stopThrows?: Error;
    spawnThrows?: Error;
    /** Whether a spawned daemon writes a fresh pid file. */
    spawnWritesPid?: boolean;
    newPid?: number;
  } = {},
): Harness {
  const stops: number[] = [];
  const spawns: string[] = [];
  const waits: number[] = [];
  const notices: string[] = [];

  const spawnWritesPid = options.spawnWritesPid ?? true;
  const newPid = options.newPid ?? 7777;
  let alivePolls = options.survivesPolls ?? 0;
  let stopped = false;

  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    notices.push(args.map(String).join(' '));
  });

  return {
    target,
    stops,
    spawns,
    waits,
    notices,
    deps: {
      installedVersion: () => INSTALLED,
      isRunning: (pid: number) => {
        if (pid !== RUNNING_PID) return false;
        if (!stopped) return true;
        if (options.immortal) return true;
        if (alivePolls > 0) {
          alivePolls--;
          return true;
        }
        return false;
      },
      stopDaemon: (pid: number) => {
        if (options.stopThrows) throw options.stopThrows;
        stops.push(pid);
        stopped = true;
      },
      spawnDaemon: (spawnTarget: string) => {
        if (options.spawnThrows) throw options.spawnThrows;
        spawns.push(spawnTarget);
        if (spawnWritesPid) {
          writeFileSync(join(spawnTarget, 'flow', '.heartbeat.pid'), String(newPid), 'utf-8');
        }
      },
      wait: async (ms: number) => {
        waits.push(ms);
      },
    },
  };
}

describe('startHeartbeatIfNeeded — daemon version drift', () => {
  let tempDir: string;
  let pidPath: string;
  let sidecarPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    mkdirSync(join(tempDir, 'flow'), { recursive: true });
    writeFileSync(join(tempDir, 'flow', 'heartbeat.md'), '# Heartbeat\n', 'utf-8');
    pidPath = join(tempDir, 'flow', '.heartbeat.pid');
    sidecarPath = join(tempDir, 'flow', '.heartbeat.version');
    writeFileSync(pidPath, String(RUNNING_PID), 'utf-8');
  });

  afterEach(() => {
    jest.restoreAllMocks();
    cleanup(tempDir);
  });

  describe('reading the running version (Task 1.2)', () => {
    it('treats an absent sidecar as drifted — the pre-upgrade daemon migrates once', async () => {
      const h = makeHarness(tempDir);
      await startHeartbeatIfNeeded(tempDir, h.deps);

      expect(h.stops).toEqual([RUNNING_PID]);
      expect(h.spawns).toEqual([tempDir]);
      expect(h.notices.join('\n')).toContain(`version unknown → ${INSTALLED}`);
    });

    it('treats an empty/unreadable sidecar as drifted, not as current', async () => {
      writeFileSync(sidecarPath, '  \n', 'utf-8');
      const h = makeHarness(tempDir);
      await startHeartbeatIfNeeded(tempDir, h.deps);

      expect(h.stops).toEqual([RUNNING_PID]);
      expect(h.notices.join('\n')).toContain('version unknown →');
    });

    it('treats a different recorded version as drifted', async () => {
      writeFileSync(sidecarPath, '1.4.2', 'utf-8');
      const h = makeHarness(tempDir);
      await startHeartbeatIfNeeded(tempDir, h.deps);

      expect(h.stops).toEqual([RUNNING_PID]);
      expect(h.notices.join('\n')).toContain(`version 1.4.2 → ${INSTALLED}`);
    });
  });

  describe('restart on drift only (Task 1.3)', () => {
    it('stops, waits for the PID to clear, then starts — in that order', async () => {
      writeFileSync(sidecarPath, '1.4.2', 'utf-8');
      const h = makeHarness(tempDir, { survivesPolls: 3 });

      await startHeartbeatIfNeeded(tempDir, h.deps);

      expect(h.stops).toEqual([RUNNING_PID]);
      // 3 liveness polls (each followed by a wait) before the spawn, plus the
      // single post-spawn boot wait.
      expect(h.waits).toEqual([100, 100, 100, 500]);
      expect(h.spawns).toEqual([tempDir]);
    });

    it('logs ONE line naming both versions and the new PID', async () => {
      writeFileSync(sidecarPath, '1.4.2', 'utf-8');
      const h = makeHarness(tempDir, { newPid: 5150 });

      await startHeartbeatIfNeeded(tempDir, h.deps);

      const restartLines = h.notices.filter((line) => line.includes('restarted'));
      expect(restartLines).toHaveLength(1);
      expect(restartLines[0]).toContain(`version 1.4.2 → ${INSTALLED}`);
      expect(restartLines[0]).toContain('PID: 5150');
    });

    it('clears the dead daemon’s pid file and sidecar before spawning', async () => {
      writeFileSync(sidecarPath, '1.4.2', 'utf-8');
      const seen: Array<{ pid: boolean; sidecar: boolean }> = [];
      const h = makeHarness(tempDir);
      const inner = h.deps!.spawnDaemon!;
      h.deps!.spawnDaemon = (target: string) => {
        seen.push({ pid: existsSync(pidPath), sidecar: existsSync(sidecarPath) });
        inner(target);
      };

      await startHeartbeatIfNeeded(tempDir, h.deps);

      expect(seen).toEqual([{ pid: false, sidecar: false }]);
    });
  });

  describe('a current daemon is left completely alone (Task 1.4)', () => {
    it('does not stop and does not spawn when versions match exactly', async () => {
      writeFileSync(sidecarPath, INSTALLED, 'utf-8');
      const h = makeHarness(tempDir);

      await startHeartbeatIfNeeded(tempDir, h.deps);

      expect(h.stops).toEqual([]);
      expect(h.spawns).toEqual([]);
      expect(h.waits).toEqual([]);
      expect(h.notices.join('\n')).toContain(`already running (PID: ${RUNNING_PID}, version ${INSTALLED})`);
    });

    it('leaves the pid file and sidecar untouched', async () => {
      writeFileSync(sidecarPath, INSTALLED, 'utf-8');
      const h = makeHarness(tempDir);

      await startHeartbeatIfNeeded(tempDir, h.deps);

      expect(readFileSync(pidPath, 'utf-8')).toBe(String(RUNNING_PID));
      expect(readFileSync(sidecarPath, 'utf-8')).toBe(INSTALLED);
    });
  });

  describe('a failed restart degrades to a notice (Task 1.5)', () => {
    it('never throws and does not spawn when the daemon will not die', async () => {
      writeFileSync(sidecarPath, '1.4.2', 'utf-8');
      const h = makeHarness(tempDir, { immortal: true });

      await expect(startHeartbeatIfNeeded(tempDir, h.deps)).resolves.toBeUndefined();

      expect(h.spawns).toEqual([]);
      expect(h.notices.join('\n')).toContain('restart skipped');
      expect(h.notices.join('\n')).toContain('did not exit within 5000ms');
    });

    it('bounds the wait instead of polling forever', async () => {
      writeFileSync(sidecarPath, '1.4.2', 'utf-8');
      const h = makeHarness(tempDir, { immortal: true });

      await startHeartbeatIfNeeded(tempDir, h.deps);

      expect(h.waits).toHaveLength(50); // 5000ms / 100ms, hard bound
    });

    it('degrades to a notice when the stop signal cannot be sent', async () => {
      writeFileSync(sidecarPath, '1.4.2', 'utf-8');
      const h = makeHarness(tempDir, { stopThrows: new Error('EPERM') });

      await expect(startHeartbeatIfNeeded(tempDir, h.deps)).resolves.toBeUndefined();

      expect(h.spawns).toEqual([]);
      expect(h.notices.join('\n')).toContain('could not stop PID 4242 (EPERM)');
      // The old daemon is still alive — its pid file must survive.
      expect(existsSync(pidPath)).toBe(true);
    });

    it('degrades to a notice when the replacement daemon fails to spawn', async () => {
      writeFileSync(sidecarPath, '1.4.2', 'utf-8');
      const h = makeHarness(tempDir, { spawnThrows: new Error('ENOENT') });

      await expect(startHeartbeatIfNeeded(tempDir, h.deps)).resolves.toBeUndefined();

      expect(h.notices.join('\n')).toContain('restart failed');
      expect(h.notices.join('\n')).toContain('ENOENT');
    });

    it('degrades to a notice when the replacement daemon writes no PID', async () => {
      writeFileSync(sidecarPath, '1.4.2', 'utf-8');
      const h = makeHarness(tempDir, { spawnWritesPid: false });

      await startHeartbeatIfNeeded(tempDir, h.deps);

      expect(h.notices.join('\n')).toContain('did not write a PID');
    });

    it('never throws when the target has no flow directory at all', async () => {
      const missing = join(tempDir, 'nowhere');
      const h = makeHarness(tempDir);

      await expect(startHeartbeatIfNeeded(missing, h.deps)).resolves.toBeUndefined();
      expect(h.spawns).toEqual([]);
    });
  });

  describe('unchanged behavior when no daemon is running', () => {
    it('cleans a stale pid + sidecar and starts a fresh daemon', async () => {
      writeFileSync(pidPath, '999999999', 'utf-8');
      writeFileSync(sidecarPath, '1.0.0', 'utf-8');
      const h = makeHarness(tempDir);

      await startHeartbeatIfNeeded(tempDir, h.deps);

      expect(h.stops).toEqual([]);
      expect(h.spawns).toEqual([tempDir]);
      expect(h.notices.join('\n')).toContain('started in background');
    });

    it('does nothing at all without a heartbeat.md', async () => {
      rmSync(join(tempDir, 'flow', 'heartbeat.md'));
      const h = makeHarness(tempDir);

      await startHeartbeatIfNeeded(tempDir, h.deps);

      expect(h.spawns).toEqual([]);
      expect(h.stops).toEqual([]);
    });
  });
});

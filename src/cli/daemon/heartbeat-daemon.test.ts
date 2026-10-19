/**
 * Tests for heartbeat daemon scheduling logic
 *
 * Tests the scheduling calculations without spawning actual processes.
 */

// We test the exported scheduling helpers by importing the parser
// and verifying schedule-to-interval logic.
// The daemon itself is a standalone script — we test its parser and
// scheduling math here.

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSchedule, parseHeartbeatFile } from './heartbeat-parser.js';
import {
  UNKNOWN_VERSION,
  checkVersionDrift,
  getVersionSidecarPath,
  readInstalledVersion,
  readVersionSidecar,
  removeVersionSidecar,
  versionLabel,
  writeVersionSidecar,
} from './version-sidecar.js';
import { createEvent } from './event-writer.js';
import {
  FAILURE_STREAK_ALERT,
  createTaskRunner,
  buildClaudeArgs,
  buildTaskEnv,
  msUntilNextOccurrence as runnerMsUntilNextOccurrence,
  ACTIVE_SESSION_ERROR,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  HEADLESS_SYSTEM_PROMPT,
  type TaskRunner,
} from './task-runner.js';
import type { HeartbeatTask, ScheduleConfig, NotificationEvent } from '../types.js';

describe('heartbeat daemon scheduling', () => {
  describe('msUntilNextOccurrence logic', () => {
    // This replicates the daemon's internal logic for testability

    function msUntilNextOccurrence(config: ScheduleConfig, now: Date): number {
      if (config.type === 'daily') {
        const target = new Date(now);
        target.setHours(config.hour!, config.minute!, 0, 0);
        if (target.getTime() <= now.getTime()) {
          target.setDate(target.getDate() + 1);
        }
        return target.getTime() - now.getTime();
      }

      if (config.type === 'weekly') {
        const target = new Date(now);
        const currentDay = now.getDay();
        let daysUntil = config.dayOfWeek! - currentDay;
        if (daysUntil < 0) daysUntil += 7;
        if (daysUntil === 0) {
          target.setHours(config.hour!, config.minute!, 0, 0);
          if (target.getTime() <= now.getTime()) {
            daysUntil = 7;
          }
        }
        target.setDate(now.getDate() + daysUntil);
        target.setHours(config.hour!, config.minute!, 0, 0);
        return target.getTime() - now.getTime();
      }

      return 0; // interval starts immediately
    }

    it('should calculate daily schedule for future time today', () => {
      // 9 AM today, schedule for 10 PM today
      const now = new Date('2026-03-06T09:00:00');
      const config = parseSchedule('daily at 10:00 PM')!;
      const ms = msUntilNextOccurrence(config, now);

      // 13 hours from 9 AM to 10 PM
      expect(ms).toBe(13 * 60 * 60 * 1000);
    });

    it('should calculate daily schedule for past time (next day)', () => {
      // 11 PM today, schedule for 10 PM — should be tomorrow
      const now = new Date('2026-03-06T23:00:00');
      const config = parseSchedule('daily at 10:00 PM')!;
      const ms = msUntilNextOccurrence(config, now);

      // 23 hours until 10 PM tomorrow
      expect(ms).toBe(23 * 60 * 60 * 1000);
    });

    it('should return 0 for interval schedules', () => {
      const config = parseSchedule('every 6 hours')!;
      const now = new Date();
      const ms = msUntilNextOccurrence(config, now);
      expect(ms).toBe(0);
    });

    it('should calculate weekly schedule for future day this week', () => {
      // Wednesday, schedule for Friday
      const now = new Date('2026-03-04T09:00:00'); // Wednesday
      const config = parseSchedule('weekly on friday at 5:00 PM')!;
      const ms = msUntilNextOccurrence(config, now);

      // 2 days + 8 hours
      const expected = (2 * 24 + 8) * 60 * 60 * 1000;
      expect(ms).toBe(expected);
    });

    it('should calculate weekly schedule for past day (next week)', () => {
      // Friday, schedule for Wednesday
      const now = new Date('2026-03-06T09:00:00'); // Friday
      const config = parseSchedule('weekly on wednesday at 9:00 AM')!;
      const ms = msUntilNextOccurrence(config, now);

      // 5 days
      const expected = 5 * 24 * 60 * 60 * 1000;
      expect(ms).toBe(expected);
    });
  });

  describe('notification integration — exit code mapping', () => {
    /**
     * Maps daemon exit codes to notification events.
     * This mirrors the logic in heartbeat-daemon.ts:
     *   exit 0 → task_complete / info
     *   exit 1 → task_failed / error
     *   exit 2 → task_blocked / warn
     */
    function exitCodeToEvent(taskName: string, exitCode: number): NotificationEvent {
      if (exitCode === 0) {
        return createEvent(taskName, 'task_complete', 'info', `Task "${taskName}" completed successfully`);
      }
      if (exitCode === 2) {
        return createEvent(taskName, 'task_blocked', 'warn', `Task "${taskName}" needs human input (exit 2)`);
      }
      return createEvent(taskName, 'task_failed', 'error', `Task "${taskName}" failed with exit code ${exitCode}`);
    }

    it('should map exit code 0 to task_complete / info', () => {
      const event = exitCodeToEvent('research', 0);
      expect(event.type).toBe('task_complete');
      expect(event.level).toBe('info');
      expect(event.task).toBe('research');
      expect(event.message).toContain('completed successfully');
    });

    it('should map exit code 1 to task_failed / error', () => {
      const event = exitCodeToEvent('research', 1);
      expect(event.type).toBe('task_failed');
      expect(event.level).toBe('error');
      expect(event.message).toContain('failed');
      expect(event.message).toContain('exit code 1');
    });

    it('should map exit code 2 to task_blocked / warn', () => {
      const event = exitCodeToEvent('research', 2);
      expect(event.type).toBe('task_blocked');
      expect(event.level).toBe('warn');
      expect(event.message).toContain('needs human input');
    });

    it('should map unknown exit codes to task_failed / error', () => {
      const event = exitCodeToEvent('research', 137);
      expect(event.type).toBe('task_failed');
      expect(event.level).toBe('error');
      expect(event.message).toContain('exit code 137');
    });

    it('should produce events with valid id and timestamp', () => {
      const event = exitCodeToEvent('my-task', 0);
      expect(event.id).toBeDefined();
      expect(typeof event.id).toBe('string');
      expect(event.id.length).toBeGreaterThan(0);
      expect(event.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('task parsing integration', () => {
    it('should parse and schedule a complete heartbeat config', () => {
      const content = `# Heartbeat

## Tasks

### research
- **Schedule**: daily at 10:00 PM
- **Command**: research about AI and add to brain
- **Enabled**: true
- **Description**: Daily AI research

### check-issues
- **Schedule**: every 2 hours
- **Command**: check github issues
- **Enabled**: true
- **Description**: Monitor issues

### disabled-task
- **Schedule**: every 30 minutes
- **Command**: should not run
- **Enabled**: false
- **Description**: This is disabled
`;

      const tasks = parseHeartbeatFile(content);
      expect(tasks).toHaveLength(3);

      const enabledTasks = tasks.filter((t) => t.enabled);
      expect(enabledTasks).toHaveLength(2);

      const disabledTasks = tasks.filter((t) => !t.enabled);
      expect(disabledTasks).toHaveLength(1);
      expect(disabledTasks[0].name).toBe('disabled-task');
    });
  });
});

// ---------------------------------------------------------------------------
// Task runner — the daemon's scheduling/execution core, exercised through
// injected dependencies (no real spawn, no real timers, no sleeping).
// ---------------------------------------------------------------------------

/** Minimal stand-in for a spawned ChildProcess. */
class FakeChildProcess {
  private stdoutHandlers: Array<(data: Buffer) => void> = [];
  private stderrHandlers: Array<(data: Buffer) => void> = [];
  private closeHandlers: Array<(code: number | null) => void> = [];
  private errorHandlers: Array<(err: Error) => void> = [];

  stdout = {
    on: (_event: string, cb: (data: Buffer) => void): void => {
      this.stdoutHandlers.push(cb);
    },
  };

  stderr = {
    on: (_event: string, cb: (data: Buffer) => void): void => {
      this.stderrHandlers.push(cb);
    },
  };

  on = (event: string, cb: (arg: never) => void): FakeChildProcess => {
    if (event === 'close') this.closeHandlers.push(cb as unknown as (code: number | null) => void);
    if (event === 'error') this.errorHandlers.push(cb as unknown as (err: Error) => void);
    return this;
  };

  emitStdout(text: string): void {
    for (const h of this.stdoutHandlers) h(Buffer.from(text));
  }

  emitStderr(text: string): void {
    for (const h of this.stderrHandlers) h(Buffer.from(text));
  }

  close(code: number | null): void {
    for (const h of this.closeHandlers) h(code);
  }

  fail(err: Error): void {
    for (const h of this.errorHandlers) h(err);
  }
}

interface FakeTimer {
  id: number;
  kind: 'timeout' | 'interval';
  ms: number;
  fire: () => void;
}

interface Harness {
  runner: TaskRunner;
  logs: string[];
  events: NotificationEvent[];
  spawns: Array<{ command: string; args: string[]; options: SpawnOptions }>;
  children: FakeChildProcess[];
  timers: FakeTimer[];
  prompts: Array<{ task: string; output: string; error: string; flowDir: string }>;
  disabled: string[];
  cleared: number[];
  setPromptExists: (value: boolean) => void;
  lastChild: () => FakeChildProcess;
  lastTimer: () => FakeTimer;
  types: () => string[];
}

const TARGET = '/repo';
const FLOW_DIR = '/repo/flow';

function makeHarness(
  options: {
    autopilot?: boolean;
    promptExists?: boolean;
    env?: NodeJS.ProcessEnv;
    now?: Date;
    /** Make every notify reject — the wrapper must log it, never rethrow (#1580). */
    notifyRejects?: boolean;
  } = {},
): Harness {
  const logs: string[] = [];
  const events: NotificationEvent[] = [];
  const spawns: Array<{ command: string; args: string[]; options: SpawnOptions }> = [];
  const children: FakeChildProcess[] = [];
  const timers: FakeTimer[] = [];
  const prompts: Array<{ task: string; output: string; error: string; flowDir: string }> = [];
  const disabled: string[] = [];
  const cleared: number[] = [];

  let promptExists = options.promptExists ?? false;
  let seq = 0;

  const makeTimerFn =
    (kind: 'timeout' | 'interval') =>
    (fn: () => void, ms: number): NodeJS.Timeout => {
      const id = ++seq;
      timers.push({ id, kind, ms, fire: fn });
      return id as unknown as NodeJS.Timeout;
    };

  const runner = createTaskRunner({
    target: TARGET,
    flowDir: FLOW_DIR,
    spawn: (command: string, args: string[], spawnOptions: SpawnOptions): ChildProcess => {
      spawns.push({ command, args: [...args], options: spawnOptions });
      const child = new FakeChildProcess();
      children.push(child);
      return child as unknown as ChildProcess;
    },
    log: (message: string) => {
      logs.push(message);
    },
    notify: (event: NotificationEvent) => {
      events.push(event);
      if (options.notifyRejects) return Promise.reject(new Error('disk full'));
      return undefined;
    },
    writePrompt: (task: string, output: string, error: string, flowDir: string) => {
      prompts.push({ task, output, error, flowDir });
    },
    readAutopilot: () => options.autopilot ?? false,
    promptFileExists: () => promptExists,
    disableOneShotTask: (name: string) => {
      disabled.push(name);
    },
    env: options.env ?? { PATH: '/usr/bin', CLAUDECODE: '1' },
    now: () => options.now ?? new Date('2026-03-06T09:00:00'),
    setTimeoutFn: makeTimerFn('timeout'),
    setIntervalFn: makeTimerFn('interval'),
    clearTimerFn: (timer: NodeJS.Timeout) => {
      cleared.push(timer as unknown as number);
    },
  });

  return {
    runner,
    logs,
    events,
    spawns,
    children,
    timers,
    prompts,
    disabled,
    cleared,
    setPromptExists: (value: boolean) => {
      promptExists = value;
    },
    lastChild: () => children[children.length - 1],
    lastTimer: () => timers[timers.length - 1],
    types: () => events.map((e) => e.type),
  };
}

function makeTask(overrides: Partial<HeartbeatTask> = {}): HeartbeatTask {
  return {
    name: 'research',
    schedule: 'every 30 minutes',
    scheduleConfig: { type: 'interval', intervalMs: 30 * 60 * 1000 },
    command: 'research about AI and add to brain',
    enabled: true,
    description: 'Daily AI research',
    ...overrides,
  };
}

/**
 * A DEAD AUTOMATION MUST NOT READ AS AN IDLE ONE.
 *
 * This daemon once failed 97 consecutive times over two days. Every one of them
 * emitted a perfectly correct `task_failed` event, and the loops still looked
 * merely quiet — because nobody scrolls a log to discover that nothing has
 * worked since Tuesday. A streak is a different fact from a failure, and it has
 * to be said in its own words.
 */
describe('a failure streak says so out loud', () => {
  function failTimes(h: ReturnType<typeof makeHarness>, task: HeartbeatTask, times: number): void {
    for (let i = 0; i < times; i += 1) {
      h.runner.executeTask(task);
      h.lastChild().emitStderr('Failed to authenticate: OAuth session expired');
      h.lastChild().close(1);
    }
  }

  function streakEvents(h: ReturnType<typeof makeHarness>): string[] {
    return h.events.filter((e) => /times in a row/.test(e.message)).map((e) => e.message);
  }

  it('stays quiet below the threshold — two failures can be a blip', () => {
    const h = makeHarness();
    failTimes(h, makeTask({ name: 'loop-fix' }), FAILURE_STREAK_ALERT - 1);
    expect(streakEvents(h)).toEqual([]);
  });

  it('speaks at the threshold, naming the streak and the last error', () => {
    const h = makeHarness();
    failTimes(h, makeTask({ name: 'loop-fix' }), FAILURE_STREAK_ALERT);

    const alerts = streakEvents(h);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('"loop-fix" has failed 3 times in a row');
    // The message has to carry WHY, or the reader still has to go and find the
    // log this event exists to save them from reading.
    expect(alerts[0]).toContain('OAuth session expired');
    expect(alerts[0]).toContain('it is not running, it is failing');
  });

  it('says it ONCE — repeating it would become the noise it exists to cut through', () => {
    const h = makeHarness();
    failTimes(h, makeTask({ name: 'loop-fix' }), FAILURE_STREAK_ALERT + 4);
    expect(streakEvents(h)).toHaveLength(1);
  });

  it('a success ends the streak, so the next one counts from zero', () => {
    const h = makeHarness();
    const task = makeTask({ name: 'loop-fix' });
    failTimes(h, task, FAILURE_STREAK_ALERT - 1);

    h.runner.executeTask(task);
    h.lastChild().close(0);

    failTimes(h, task, FAILURE_STREAK_ALERT - 1);
    expect(streakEvents(h)).toEqual([]);
  });

  it('counts each task separately — two loops failing once is not a streak', () => {
    const h = makeHarness();
    failTimes(h, makeTask({ name: 'loop-fix' }), 2);
    failTimes(h, makeTask({ name: 'loop-find' }), 2);
    expect(streakEvents(h)).toEqual([]);
  });
});

describe('a rejecting notify stays out of the crash channel (#1580)', () => {
  it('is caught and logged — never an unhandled rejection', async () => {
    const h = makeHarness({ notifyRejects: true });

    h.runner.executeTask(makeTask({ name: 'loop-fix' }));
    h.lastChild().close(0);

    // The dispatches are fire-and-forget — drain the microtask queue so the
    // wrapper's catch has run. An uncaught rejection here would fail the run.
    await new Promise((resolve) => setImmediate(resolve));

    const failures = h.logs.filter((l) => l.includes('Notification failed (non-fatal): disk full'));
    // task_started + task_complete both rejected, both were caught.
    expect(failures).toHaveLength(2);
  });
});

describe('per-task lock map (Task 4.1)', () => {
  it('beats independent tasks concurrently instead of serializing them', () => {
    const h = makeHarness();

    h.runner.executeTask(makeTask({ name: 'fix' }));
    h.runner.executeTask(makeTask({ name: 'find' }));
    h.runner.executeTask(makeTask({ name: 'improve' }));

    expect(h.spawns).toHaveLength(3);
    expect(h.runner.locks.running()).toEqual(['fix', 'find', 'improve']);
  });

  it('refuses only a second beat of the SAME task', () => {
    const h = makeHarness();
    const fix = makeTask({ name: 'fix' });

    h.runner.executeTask(fix);
    h.runner.executeTask(fix);

    expect(h.spawns).toHaveLength(1);
    expect(h.runner.locks.isRunning('fix')).toBe(true);
  });

  it('a long-running task no longer swallows another task’s beat (the pre-fix bug)', () => {
    const h = makeHarness();
    const fix = makeTask({ name: 'fix' });

    h.runner.executeTask(fix); // still in flight — never closed
    h.runner.executeTask(makeTask({ name: 'find' }));
    h.runner.executeTask(makeTask({ name: 'improve' }));

    expect(h.spawns.map((s) => s.args[s.args.length - 1])).toHaveLength(3);
    expect(h.runner.locks.size()).toBe(3);
  });

  it('releases the lock on close so the next beat of that task runs', () => {
    const h = makeHarness();
    const fix = makeTask({ name: 'fix' });

    h.runner.executeTask(fix);
    h.lastChild().close(0);
    expect(h.runner.locks.isRunning('fix')).toBe(false);

    h.runner.executeTask(fix);
    expect(h.spawns).toHaveLength(2);
  });

  it('releases the lock when the spawn itself errors', () => {
    const h = makeHarness();
    const fix = makeTask({ name: 'fix' });

    h.runner.executeTask(fix);
    h.lastChild().fail(new Error('ENOENT'));
    expect(h.runner.locks.isRunning('fix')).toBe(false);

    h.runner.executeTask(fix);
    expect(h.spawns).toHaveLength(2);
  });
});

describe('skipped beats are visible (Task 4.2)', () => {
  it('logs "skipped, still running" instead of dropping silently', () => {
    const h = makeHarness();
    const fix = makeTask({ name: 'fix' });

    h.runner.executeTask(fix);
    h.runner.executeTask(fix);

    expect(h.logs).toContain('Task "fix" skipped, still running');
  });

  it('emits a task_skipped event for the refused beat', () => {
    const h = makeHarness();
    const fix = makeTask({ name: 'fix' });

    h.runner.executeTask(fix);
    h.runner.executeTask(fix);

    const skipped = h.events.filter((e) => e.type === 'task_skipped');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].task).toBe('fix');
    expect(skipped[0].level).toBe('warn');
    expect(skipped[0].message).toBe('Task skipped, still running: fix');
  });

  it('does not spawn or emit task_started for the refused beat', () => {
    const h = makeHarness();
    const fix = makeTask({ name: 'fix' });

    h.runner.executeTask(fix);
    h.runner.executeTask(fix);

    expect(h.spawns).toHaveLength(1);
    expect(h.events.filter((e) => e.type === 'task_started')).toHaveLength(1);
  });
});

/**
 * THE DAEMON HAS NO LOOP PATH LEFT.
 *
 * It used to carry a loop-task predicate and give the tasks it matched an
 * exemption from the active-session deferral, because a loop beat ran in its own
 * worktree and must not go quiet when a human opened a session here. Loop runs
 * are dispatched as Claude Code background agents now, so there is no such task
 * for the daemon to recognise — and these tests assert the ABSENCE, because a
 * half-removed special case reads exactly like a removed one until a task hits
 * it.
 */
describe('every task takes the same active-session deferral', () => {
  function failWithActiveSession(h: Harness): void {
    const child = h.lastChild();
    child.emitStderr(`Error: claude ${ACTIVE_SESSION_ERROR}`);
    child.close(1);
  }

  it('defers an ordinary task onto the retry ladder', () => {
    const h = makeHarness();
    h.runner.executeTask(makeTask());
    failWithActiveSession(h);

    expect(
      h.logs.some((l) => l.includes('deferred — Claude Code session active. Will retry in 60s (attempt 1/5)')),
    ).toBe(true);
    expect(h.timers.filter((t) => t.ms === RETRY_DELAY_MS)).toHaveLength(1);
    expect(h.types()).toEqual(['task_started']);
  });

  it('defers a task whose command LOOKS like a loop beat, exactly the same way', () => {
    const h = makeHarness();
    h.runner.executeTask(makeTask({ name: 'loop-fix', command: '/agent-loop fix' }));
    failWithActiveSession(h);

    expect(h.timers.filter((t) => t.ms === RETRY_DELAY_MS)).toHaveLength(1);
    expect(h.logs.some((l) => l.includes('not deferring'))).toBe(false);
    expect(h.types()).toEqual(['task_started']);
  });

  it('defers a task carrying an explicit Loop field, exactly the same way', () => {
    const h = makeHarness();
    h.runner.executeTask(makeTask({ name: 'improve-beat', loop: 'improve' }));
    failWithActiveSession(h);

    expect(h.timers.filter((t) => t.ms === RETRY_DELAY_MS)).toHaveLength(1);
    expect(h.types()).toEqual(['task_started']);
  });

  it('leaves the retry ladder intact — 5 retries, then gives up', () => {
    const h = makeHarness();
    const task = makeTask();

    h.runner.executeTask(task);
    failWithActiveSession(h);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      h.lastTimer().fire();
      failWithActiveSession(h);
    }

    expect(h.logs.some((l) => l.includes(`exhausted ${MAX_RETRIES} retries`))).toBe(true);
    expect(h.spawns).toHaveLength(1 + MAX_RETRIES);
  });

  it('routes a failure that is NOT an active-session error to the failure path', () => {
    const h = makeHarness();
    h.runner.executeTask(makeTask({ name: 'loop-fix', command: '/agent-loop fix' }));
    h.lastChild().emitStderr('boom');
    h.lastChild().close(1);

    expect(h.timers.filter((t) => t.ms === RETRY_DELAY_MS)).toHaveLength(0);
    expect(h.logs).toContain('Task "loop-fix" failed with code 1');
    expect(h.types()).toEqual(['task_started', 'task_failed']);
  });
});

describe('NFR-4 — existing non-loop tasks behave identically', () => {
  /**
   * ONE TASK, ALL THE WAY THROUGH, AFTER THE LOOP PATH CAME OUT.
   *
   * The assertions around this one each pin a single seam — the argv, the timer,
   * an event list. None of them answers the question a heartbeat user actually
   * has, which is whether their scheduled task still goes from a line in
   * `heartbeat.md` to a finished run. So this walks the whole path in order and
   * pins every log line and every event the daemon produced along it: parse,
   * schedule, fire, spawn, exit, complete.
   *
   * Nothing in it mentions loops. That is the point — this is the behaviour that
   * had to survive the removal untouched, so it is asserted from the outside,
   * where a user stands.
   */
  it('parses, schedules, runs and logs an ordinary task end to end', () => {
    const [task] = parseHeartbeatFile(`# Heartbeat

### research
- **Schedule**: every 30 minutes
- **Command**: research about AI and add to brain
- **Enabled**: true
- **Description**: Daily AI research
`);
    expect(task.loop).toBeUndefined();

    const h = makeHarness();
    h.runner.scheduleTask(task);

    // Scheduled as one repeating interval, announced in the daemon's own words.
    expect(h.timers).toEqual([expect.objectContaining({ kind: 'interval', ms: 30 * 60 * 1000 })]);
    expect(h.logs).toEqual(['Scheduling "research" every 1800s']);
    expect(h.spawns).toHaveLength(0);

    // The beat arrives: one `claude` child, in the project, with the pinned argv.
    h.timers[0].fire();
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0].command).toBe('claude');
    expect(h.spawns[0].options.cwd).toBe(TARGET);
    expect(h.spawns[0].args).toEqual([
      '-p',
      '--dangerously-skip-permissions',
      '--append-system-prompt',
      HEADLESS_SYSTEM_PROMPT,
      '--',
      'research about AI and add to brain',
    ]);

    // While it runs, its lock is held and a second beat is refused out loud.
    expect(h.runner.locks.isRunning('research')).toBe(true);

    h.lastChild().emitStdout('done\n');
    h.lastChild().close(0);

    expect(h.runner.locks.isRunning('research')).toBe(false);
    expect(h.logs).toEqual([
      'Scheduling "research" every 1800s',
      'Executing "research": research about AI and add to brain',
      'Task "research" completed successfully',
      // ONE CALL, ONE LINE (#1803/#1819). This used to expect the raw slice —
      // two leading spaces and the agent's own trailing newline — which is
      // exactly the shape that turned one event into many physical lines and
      // ate 75% of the log's retention window. `outputLogLine` collapses it;
      // an ordinary task's log is still three events plus its output, which is
      // what "behave identically" meant and still holds.
      'output: done',
    ]);
    expect(h.types()).toEqual(['task_started', 'task_complete']);
    expect(h.prompts).toEqual([]);
    expect(h.disabled).toEqual([]);
    // No retry ladder, no leftover timer: the interval it was scheduled on is
    // still the only timer the daemon holds for this task.
    expect(h.timers).toHaveLength(1);
  });

  // Pinned verbatim from the pre-change daemon. If this string ever drifts,
  // every heartbeat task's spawn changed.
  const PINNED_SYSTEM_PROMPT =
    'You are running autonomously via the heartbeat daemon. There is NO human to ask for permission — you MUST act directly. Use Edit/Write/Bash tools without hesitation. Never say "Could you grant permission" or "I need write access" — you already have full permissions via --dangerously-skip-permissions. If a tool call fails, retry or find an alternative. Complete the task fully.';

  describe('spawn arguments', () => {
    it('pins the appended system prompt', () => {
      expect(HEADLESS_SYSTEM_PROMPT).toBe(PINNED_SYSTEM_PROMPT);
    });

    it('builds the exact argv the daemon built before', () => {
      expect(buildClaudeArgs(makeTask())).toEqual([
        '-p',
        '--dangerously-skip-permissions',
        '--append-system-prompt',
        PINNED_SYSTEM_PROMPT,
        '--',
        'research about AI and add to brain',
      ]);
    });

    it('appends --add-dir per extra directory, before the command', () => {
      expect(buildClaudeArgs(makeTask({ addDirs: ['/a', '/b'] }))).toEqual([
        '-p',
        '--dangerously-skip-permissions',
        '--append-system-prompt',
        PINNED_SYSTEM_PROMPT,
        '--add-dir',
        '/a',
        '--add-dir',
        '/b',
        '--',
        'research about AI and add to brain',
      ]);
    });

    /**
     * THE COMMAND IS THE PROMPT, AND NOTHING MAY EAT IT.
     *
     * `--add-dir` is variadic in the Claude CLI: it keeps consuming values
     * until the next flag. With the command last and no separator, the prompt
     * became one more directory and the run died with "Input must be provided
     * either through stdin or as a prompt argument when using --print" — so a
     * task carrying `Add Dirs` NEVER ran. Measured live: ten consecutive
     * beats, zero successes, over ten hours, visible only in the heartbeat log
     * because nothing escalates a repeated identical failure.
     */
    it('always ends with `--` then the command, whatever flags precede it', () => {
      for (const task of [makeTask(), makeTask({ addDirs: ['/a'] }), makeTask({ addDirs: ['/a', '/b'] })]) {
        const args = buildClaudeArgs(task);
        // POSITIVE FIRST (#28): the flags really were built, so the separator
        // below is evidence of the guard and not of an empty argv.
        expect(args[0]).toBe('-p');
        expect(args.at(-1)).toBe(task.command);
        expect(args.at(-2)).toBe('--');
        // …and the command appears exactly once, never also as a flag value.
        expect(args.filter((arg) => arg === task.command)).toHaveLength(1);
      }
    });

    it('never leaves the command adjacent to a variadic flag value', () => {
      // The specific shape that broke: `--add-dir /a <command>`.
      const args = buildClaudeArgs(makeTask({ addDirs: ['/a'] }));
      const lastDir = args.lastIndexOf('/a');
      expect(args[lastDir + 1]).toBe('--');
    });

    it('spawns `claude` in the target dir with CLAUDECODE stripped', () => {
      const h = makeHarness({ env: { PATH: '/usr/bin', HOME: '/home/me', CLAUDECODE: '1' } });
      h.runner.executeTask(makeTask());

      expect(h.spawns[0].command).toBe('claude');
      expect(h.spawns[0].options.cwd).toBe(TARGET);
      expect(h.spawns[0].options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      // Nothing added to the environment either. The daemon used to inject a
      // per-spawn `PLANFLOW_BEAT_ID` for the loop finalizer to key on (#1671);
      // the finalizer is gone and so is the variable, so a heartbeat child's
      // environment is once again the daemon's own minus CLAUDECODE.
      const env = h.spawns[0].options.env as Record<string, string>;
      expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/me' });
      expect(env['PLANFLOW_BEAT_ID']).toBeUndefined();
    });

    it('buildTaskEnv keeps every other variable untouched', () => {
      expect(buildTaskEnv({ A: '1', CLAUDECODE: '1', B: '2' })).toEqual({ A: '1', B: '2' });
    });
  });

  describe('schedule', () => {
    it('schedules an interval task with the same interval and log line', () => {
      const h = makeHarness();
      h.runner.scheduleTask(makeTask());

      expect(h.timers).toEqual([
        expect.objectContaining({ kind: 'interval', ms: 30 * 60 * 1000 }),
      ]);
      expect(h.logs).toContain('Scheduling "research" every 1800s');
    });

    it('schedules a one-shot task as a timeout', () => {
      const h = makeHarness();
      h.runner.scheduleTask(
        makeTask({
          name: 'one-shot',
          schedule: 'in 2 hours',
          scheduleConfig: { type: 'once', intervalMs: 2 * 60 * 60 * 1000 },
        }),
      );

      expect(h.timers).toEqual([
        expect.objectContaining({ kind: 'timeout', ms: 2 * 60 * 60 * 1000 }),
      ]);
      expect(h.logs).toContain('Scheduling one-shot "one-shot" — runs in 7200s');
    });

    it('schedules a daily task at the same offset, then repeats every 24h', () => {
      const h = makeHarness({ now: new Date('2026-03-06T09:00:00') });
      h.runner.scheduleTask(
        makeTask({
          name: 'nightly',
          schedule: 'daily at 10:00 PM',
          scheduleConfig: { type: 'daily', hour: 22, minute: 0 },
        }),
      );

      expect(h.timers[0]).toMatchObject({ kind: 'timeout', ms: 13 * 60 * 60 * 1000 });
      expect(h.logs).toContain('Scheduling "nightly" — next run in 46800s');

      h.timers[0].fire();
      expect(h.spawns).toHaveLength(1);
      expect(h.timers[1]).toMatchObject({ kind: 'interval', ms: 24 * 60 * 60 * 1000 });
    });

    it('schedules a weekly task at the same offset, then repeats every 7 days', () => {
      const h = makeHarness({ now: new Date('2026-03-04T09:00:00') }); // Wednesday
      h.runner.scheduleTask(
        makeTask({
          name: 'weekly-report',
          schedule: 'weekly on friday at 5:00 PM',
          scheduleConfig: { type: 'weekly', hour: 17, minute: 0, dayOfWeek: 5 },
        }),
      );

      expect(h.timers[0]).toMatchObject({ kind: 'timeout', ms: (2 * 24 + 8) * 60 * 60 * 1000 });

      h.timers[0].fire();
      expect(h.timers[1]).toMatchObject({ kind: 'interval', ms: 7 * 24 * 60 * 60 * 1000 });
    });

    it('skips a disabled task without scheduling anything', () => {
      const h = makeHarness();
      h.runner.scheduleTask(makeTask({ name: 'off', enabled: false }));

      expect(h.timers).toHaveLength(0);
      expect(h.logs).toContain('Task "off" is disabled, skipping');
    });

    it('msUntilNextOccurrence math is unchanged', () => {
      expect(
        runnerMsUntilNextOccurrence({ type: 'daily', hour: 22, minute: 0 }, new Date('2026-03-06T09:00:00')),
      ).toBe(13 * 60 * 60 * 1000);
      expect(
        runnerMsUntilNextOccurrence({ type: 'daily', hour: 22, minute: 0 }, new Date('2026-03-06T23:00:00')),
      ).toBe(23 * 60 * 60 * 1000);
      expect(
        runnerMsUntilNextOccurrence(
          { type: 'weekly', hour: 9, minute: 0, dayOfWeek: 3 },
          new Date('2026-03-06T09:00:00'),
        ),
      ).toBe(5 * 24 * 60 * 60 * 1000);
      expect(runnerMsUntilNextOccurrence({ type: 'interval', intervalMs: 1000 }, new Date())).toBe(0);
      expect(runnerMsUntilNextOccurrence({ type: 'once', intervalMs: 5000 }, new Date())).toBe(5000);
    });

    it('clearTimers clears every timer it handed out', () => {
      const h = makeHarness();
      h.runner.scheduleTask(makeTask({ name: 'a' }));
      h.runner.scheduleTask(makeTask({ name: 'b' }));
      h.runner.clearTimers();

      expect(h.cleared).toEqual(h.timers.map((t) => t.id));
    });
  });

  describe('emitted events', () => {
    it('emits exactly task_started then task_complete on a clean run', () => {
      const h = makeHarness();
      h.runner.executeTask(makeTask());
      h.lastChild().close(0);

      expect(h.types()).toEqual(['task_started', 'task_complete']);
      expect(h.events[0]).toMatchObject({
        task: 'research',
        level: 'info',
        message: 'Starting task: research',
      });
      expect(h.events[1]).toMatchObject({
        task: 'research',
        level: 'info',
        message: 'Task completed: research',
      });
      expect(h.events.every((e) => typeof e.id === 'string' && e.timestamp instanceof Date)).toBe(true);
      expect(h.logs).toContain('Task "research" completed successfully');
    });

    it('never emits task_skipped for a task running alone', () => {
      const h = makeHarness();
      h.runner.executeTask(makeTask());
      h.lastChild().close(0);
      h.runner.executeTask(makeTask());
      h.lastChild().close(0);

      expect(h.types()).toEqual(['task_started', 'task_complete', 'task_started', 'task_complete']);
    });

    it('emits task_failed with the same message shape on a non-zero exit', () => {
      const h = makeHarness();
      h.runner.executeTask(makeTask());
      h.lastChild().emitStderr('kaboom');
      h.lastChild().close(1);

      expect(h.types()).toEqual(['task_started', 'task_failed']);
      expect(h.events[1]).toMatchObject({
        level: 'error',
        message: 'Task failed (exit 1): research\nkaboom',
      });
    });

    it('emits task_blocked and writes a prompt on exit code 2', () => {
      const h = makeHarness();
      h.runner.executeTask(makeTask());
      h.lastChild().emitStdout('needs a decision');
      h.lastChild().close(2);

      expect(h.types()).toEqual(['task_started', 'task_blocked']);
      expect(h.events[1]).toMatchObject({
        level: 'error',
        message: 'Task blocked (needs input): research',
      });
      expect(h.prompts).toEqual([
        { task: 'research', output: 'needs a decision', error: '', flowDir: FLOW_DIR },
      ]);
    });

    it('skips the prompt file under autopilot, keeping the [autopilot ON] marker', () => {
      const h = makeHarness({ autopilot: true });
      h.runner.executeTask(makeTask());
      h.lastChild().close(2);

      expect(h.prompts).toHaveLength(0);
      expect(h.events[1].message).toBe('Task blocked (needs input): research [autopilot ON]');
      expect(h.logs).toContain('  Autopilot ON — skipping prompt, continuing');
    });

    it('treats a NEW prompt file after a clean exit as blocked', () => {
      const h = makeHarness({ promptExists: false });
      h.runner.executeTask(makeTask());
      h.setPromptExists(true);
      h.lastChild().close(0);

      expect(h.types()).toEqual(['task_started', 'task_blocked']);
      expect(h.events[1].message).toBe('Task needs input: research');
    });

    it('does not treat a PRE-EXISTING prompt file as blocked', () => {
      const h = makeHarness({ promptExists: true });
      h.runner.executeTask(makeTask());
      h.lastChild().close(0);

      expect(h.types()).toEqual(['task_started', 'task_complete']);
    });

    it('emits task_failed on a spawn error', () => {
      const h = makeHarness();
      h.runner.executeTask(makeTask());
      h.lastChild().fail(new Error('ENOENT'));

      expect(h.types()).toEqual(['task_started', 'task_failed']);
      expect(h.events[1].message).toBe('Task spawn error: research — ENOENT');
    });

    it('disables a one-shot task after a successful run', () => {
      const h = makeHarness();
      h.runner.executeTask(makeTask({ name: 'once-only', oneShot: true }));
      h.lastChild().close(0);

      expect(h.disabled).toEqual(['once-only']);
    });

    it('does not disable a one-shot task that failed', () => {
      const h = makeHarness();
      h.runner.executeTask(makeTask({ name: 'once-only', oneShot: true }));
      h.lastChild().close(1);

      expect(h.disabled).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Version sidecar (Phase 1, Task 1.1) — the daemon says which version it is.
// The daemon script itself is a side-effecting bootstrap that cannot be
// imported under jest, so its behavior is tested through the sidecar module it
// delegates to, plus a structural check that both call sites still exist.
// ---------------------------------------------------------------------------

describe('heartbeat version sidecar', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `plan-flow-sidecar-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempDir, 'flow'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes the version beside the pid file, not inside it', () => {
    writeVersionSidecar(tempDir, '1.4.3');

    expect(getVersionSidecarPath(tempDir)).toBe(join(tempDir, 'flow', '.heartbeat.version'));
    expect(readFileSync(getVersionSidecarPath(tempDir), 'utf-8')).toBe('1.4.3');
    // The pid file format is untouched — older readers still parse it.
    expect(existsSync(join(tempDir, 'flow', '.heartbeat.pid'))).toBe(false);
  });

  it('reads back exactly what the daemon wrote', () => {
    writeVersionSidecar(tempDir, '2.0.0');
    expect(readVersionSidecar(tempDir)).toBe('2.0.0');
  });

  it('removes the sidecar, and removing an absent one is a no-op', () => {
    writeVersionSidecar(tempDir, '1.4.3');
    removeVersionSidecar(tempDir);
    expect(existsSync(getVersionSidecarPath(tempDir))).toBe(false);

    expect(() => removeVersionSidecar(tempDir)).not.toThrow();
  });

  it('never throws when the flow directory does not exist', () => {
    const missing = join(tempDir, 'nope');
    expect(() => writeVersionSidecar(missing, '1.4.3')).not.toThrow();
    expect(readVersionSidecar(missing)).toBeNull();
    expect(() => removeVersionSidecar(missing)).not.toThrow();
  });

  it('treats an absent sidecar as unknown (the pre-feature daemon)', () => {
    expect(readVersionSidecar(tempDir)).toBeNull();
  });

  it('treats an empty sidecar as unknown rather than as a version', () => {
    writeFileSync(getVersionSidecarPath(tempDir), '   \n', 'utf-8');
    expect(readVersionSidecar(tempDir)).toBeNull();
  });

  it('reads the installed version from the package, not a literal', () => {
    const pkg = JSON.parse(
      readFileSync(join(process.cwd(), 'package.json'), 'utf-8'),
    ) as { version: string };
    expect(readInstalledVersion()).toBe(pkg.version);
    expect(readInstalledVersion()).not.toBe(UNKNOWN_VERSION);
  });

  describe('drift verdict', () => {
    it('reports no drift only on an exact match', () => {
      writeVersionSidecar(tempDir, '1.4.3');
      expect(checkVersionDrift(tempDir, '1.4.3')).toEqual({
        drifted: false,
        running: '1.4.3',
        installed: '1.4.3',
      });
    });

    it('reports drift for a different version', () => {
      writeVersionSidecar(tempDir, '1.4.2');
      expect(checkVersionDrift(tempDir, '1.4.3')).toMatchObject({ drifted: true, running: '1.4.2' });
    });

    it('reports drift when there is no sidecar at all (migration case)', () => {
      expect(checkVersionDrift(tempDir, '1.4.3')).toEqual({
        drifted: true,
        running: null,
        installed: '1.4.3',
      });
    });

    it('labels an unknown running version', () => {
      expect(versionLabel(null)).toBe(UNKNOWN_VERSION);
      expect(versionLabel('1.4.3')).toBe('1.4.3');
    });
  });

  describe('daemon call sites', () => {
    const daemonSource = readFileSync(
      join(process.cwd(), 'src', 'cli', 'daemon', 'heartbeat-daemon.ts'),
      'utf-8',
    );

    it('writes the sidecar on the same path that writes the pid file', () => {
      const boot = daemonSource.slice(daemonSource.indexOf('writeFileSync(pidPath'));
      expect(boot).toContain('writeVersionSidecar(target, daemonVersion)');
    });

    it('removes the sidecar on the same path that unlinks the pid file', () => {
      const cleanup = daemonSource.slice(
        daemonSource.indexOf('function cleanup'),
        daemonSource.indexOf('// --- Main ---'),
      );
      expect(cleanup).toContain('unlinkSync(pidPath)');
      expect(cleanup).toContain('removeVersionSidecar(target)');
    });
  });
});

/**
 * #1803 — the daemon's log stays readable when an agent is verbose.
 *
 * `.heartbeat.log` is line-oriented and every reader counts physical lines:
 * `truncateLog` keeps the last 500 believing that to be ~500 events, and
 * `heartbeat status` shows the last five believing those to be the five most
 * recent things the daemon did. Passing an agent's markdown final message into
 * that one-line writer made one event a dozen lines — measured at 374 of the
 * last 500 lines on this repo's own log, so 75% of the retention window was
 * spilled prose and the event history was a quarter as deep as intended.
 *
 * The tests below drive the REAL task runner, because the bug lived in what the
 * call sites handed the writer, not in the writer alone.
 */
describe('agent output never spills across log lines (#1803)', () => {
  /** An agent final message of the shape that broke it. */
  const AGENT_OUTPUT = [
    'Run complete — find (producer)',
    '',
    '**Verdict**: proceed',
    '',
    '| # | Finding |',
    '|---|---|',
    ...Array.from(
      { length: 8 },
      (_, i) =>
        `| [#${1790 + i}](https://github.com/dev/plan-flow/issues/${1790 + i}) | a finding |`,
    ),
  ].join('\n');

  function runWith(stdout: string, stderr: string, code: number): string[] {
    const h = makeHarness();
    h.runner.executeTask(makeTask());
    const child = h.lastChild();
    if (stdout) child.emitStdout(stdout);
    if (stderr) child.emitStderr(stderr);
    child.close(code);
    return h.logs;
  }

  it('a successful task logs its output as ONE line', () => {
    const logged = runWith(AGENT_OUTPUT, '', 0);
    const output = logged.filter((line) => line.includes('output:'));

    expect(output).toHaveLength(1);
    expect(output[0].split('\n')).toHaveLength(1);
  });

  it('every line the runner logs is a single line, whatever the exit code', () => {
    // The four call sites were `output`, `context`, and `stderr` twice — one
    // per failure path. The guard is on all of them at once, because the
    // enforcement is in the writer and a fifth site should inherit it.
    for (const code of [0, 1, 2]) {
      const logged = runWith(AGENT_OUTPUT, AGENT_OUTPUT, code);
      const spilled = logged.filter((line) => line.includes('\n'));
      expect({ code, spilled }).toEqual({ code, spilled: [] });
    }
  });

  it('does not sever a URL at the character limit', () => {
    // The live artifact ended at `| [#1795](https:/`, which reads as corruption
    // rather than as truncation.
    const logged = runWith(AGENT_OUTPUT, '', 0);
    const output = logged.find((line) => line.includes('output:')) ?? '';

    expect(output.endsWith('…')).toBe(true);
    expect(/https:\/\/\S*…$/.test(output)).toBe(false);
  });

  it('a short output is logged verbatim — no ellipsis, nothing added', () => {
    const logged = runWith('all good', '', 0);

    expect(logged).toContain('output: all good');
  });
  it('the WRITER enforces it, not the call sites', () => {
    // The tests above drive the runner, so they prove the four call sites
    // behave. The rule they depend on is that a FIFTH site would inherit it
    // (allowed-pattern #14) — which lives in the daemon script's own `log`, and
    // the script is a standalone entry point this suite reads rather than
    // imports (the same idiom the version-sidecar tests use below).
    const daemonSource = readFileSync(
      join(process.cwd(), 'src', 'cli', 'daemon', 'heartbeat-daemon.ts'),
      'utf-8',
    );
    const writer = daemonSource.slice(
      daemonSource.indexOf('function log(message: string)'),
      daemonSource.indexOf('function truncateLog'),
    );

    expect(writer).toContain('oneLogLine(message)');
    // …and nothing appends `message` raw alongside it.
    expect(writer).not.toMatch(/\$\{message\}/);
  });
});

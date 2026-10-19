/**
 * Heartbeat task runner — the daemon's scheduling and execution core.
 *
 * Extracted from `heartbeat-daemon.ts` (which stays the bootstrap that wires
 * the real fs / spawn / timer dependencies in) so the scheduling math, the
 * spawn arguments, the per-task lock and the emitted events can be asserted
 * without spawning a real Claude Code process or sleeping in a test.
 *
 * Behaviour for heartbeat tasks is unchanged from the pre-extraction daemon —
 * same schedule math, same spawn arguments, same events, same retry ladder. One
 * thing did change and it stays: the global `taskRunning` boolean is now a
 * per-task lock map, so independent tasks beat concurrently and a refused beat
 * is LOGGED and emitted rather than silently dropped.
 *
 * THE DAEMON NO LONGER KNOWS WHAT A LOOP IS. It used to carry three loop-only
 * behaviours — a loop-task predicate, an exemption from the active-session
 * deferral, and a finalizer that reclaimed a loop slot when a run's process
 * ended without recording. All three existed because the daemon was a second
 * supervisor for a process Claude Code was already supervising. Loop runs are
 * now dispatched as Claude Code background agents, which own their own
 * lifecycle, so this file treats every scheduled task the same way: a command,
 * a child, an exit code.
 */

import { randomUUID } from 'node:crypto';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type {
  HeartbeatTask,
  NotificationEvent,
  NotificationLevel,
  NotificationType,
  ScheduleConfig,
} from '../types.js';
import { createTaskLocks, type TaskLocks } from './task-locks.js';
import { outputLogLine } from './log-line.js';

export const ACTIVE_SESSION_ERROR = 'cannot be launched inside another Claude Code session';
export const MAX_RETRIES = 5;

/**
 * Consecutive failures before the daemon says so in its own voice.
 *
 * Three, because one or two can be transient — a network blip, a locked profile
 * — and three in a row is a task that is not working. Low enough to catch a dead
 * automation the same morning it dies rather than two days later.
 */
export const FAILURE_STREAK_ALERT = 3;
export const RETRY_DELAY_MS = 60_000;
export const TAIL_LINES = 20;

/**
 * How much captured process output one log line may carry.
 *
 * The number the four call sites each spelled out; it lives here now so the
 * next one inherits it instead of choosing again (#1803).
 */
const OUTPUT_LOG_LIMIT = 500;
export const DAILY_REPEAT_MS = 24 * 60 * 60 * 1000;
export const WEEKLY_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;
export const PROMPT_FILENAME = '.heartbeat-prompt.md';

/**
 * The system prompt appended to every heartbeat-spawned Claude run.
 * Byte-identical to the pre-extraction daemon — the regression test pins it.
 */
export const HEADLESS_SYSTEM_PROMPT =
  'You are running autonomously via the heartbeat daemon. There is NO human to ask for permission — you MUST act directly. Use Edit/Write/Bash tools without hesitation. Never say "Could you grant permission" or "I need write access" — you already have full permissions via --dangerously-skip-permissions. If a tool call fails, retry or find an alternative. Complete the task fully.';

export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
export type TimerFn = (callback: () => void, ms: number) => NodeJS.Timeout;

export interface TaskRunnerDeps {
  /** Working directory tasks are spawned in. */
  target: string;
  /** The project's `flow/` directory — where events and prompts are written. */
  flowDir: string;
  spawn: SpawnFn;
  log: (message: string) => void;
  notify: (event: NotificationEvent, flowDir: string) => Promise<void> | void;
  writePrompt: (
    taskName: string,
    output: string,
    error: string,
    flowDir: string,
  ) => Promise<void> | void;
  readAutopilot: () => boolean;
  /** Whether `flow/.heartbeat-prompt.md` exists right now. */
  promptFileExists: () => boolean;
  disableOneShotTask: (taskName: string) => void;
  /** Base environment; `CLAUDECODE` is stripped from the child's copy. */
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  setTimeoutFn?: TimerFn;
  setIntervalFn?: TimerFn;
  clearTimerFn?: (timer: NodeJS.Timeout) => void;
  /** Injectable so the daemon and the IDE can share one lock map if needed. */
  locks?: TaskLocks;
}

export interface TaskRunner {
  readonly locks: TaskLocks;
  scheduleTask(task: HeartbeatTask): void;
  executeTask(task: HeartbeatTask): void;
  clearTimers(): void;
}

/**
 * Create a NotificationEvent with consistent structure.
 */
export function createEvent(
  task: HeartbeatTask,
  type: NotificationType,
  level: NotificationLevel,
  message: string,
  phase?: string,
): NotificationEvent {
  return {
    id: randomUUID(),
    timestamp: new Date(),
    task: task.name,
    type,
    level,
    message,
    ...(phase ? { phase } : {}),
  };
}

/**
 * Return the last N lines from a string.
 */
export function tailLines(text: string, n: number): string {
  const lines = text.split('\n');
  return lines.slice(-n).join('\n');
}

/**
 * Milliseconds until the next occurrence of a schedule, relative to `now`.
 */
export function msUntilNextOccurrence(config: ScheduleConfig, now: Date = new Date()): number {
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

  // once — run after delay
  if (config.type === 'once') {
    return config.intervalMs!;
  }

  // interval — start immediately
  return 0;
}

/**
 * The exact argv passed to `claude` for a heartbeat task.
 */
export function buildClaudeArgs(task: HeartbeatTask): string[] {
  const args = [
    '-p',
    '--dangerously-skip-permissions',
    '--append-system-prompt',
    HEADLESS_SYSTEM_PROMPT,
  ];

  if (task.addDirs?.length) {
    for (const dir of task.addDirs) {
      args.push('--add-dir', dir);
    }
  }

  // `--` ENDS THE FLAGS, so the command after it is the PROMPT and nothing else.
  //
  // `--add-dir` is variadic in the Claude CLI: it keeps taking values until the
  // next flag, so a prompt placed after it was swallowed as one more directory
  // and the run died with "Input must be provided either through stdin or as a
  // prompt argument when using --print". Measured on 2.1.296 — a task carrying
  // `Add Dirs` NEVER ran, and the failure is invisible unless somebody reads
  // `flow/.heartbeat.log`, because nothing escalates a repeated identical
  // failure. Live here: ten consecutive beats, zero successes, for ten hours.
  //
  // The separator is the fix rather than re-ordering the flags, because it also
  // holds for the next variadic option somebody adds, and for a prompt that
  // begins with a dash.
  args.push('--', task.command);
  return args;
}

/**
 * Strip `CLAUDECODE` so the spawned run is not mistaken for a nested session.
 * The daemon runs detached — it is not actually nested.
 */
export function buildTaskEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleanEnv = { ...env };
  delete cleanEnv['CLAUDECODE'];
  return cleanEnv;
}

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const {
    target,
    flowDir,
    spawn,
    log,
    notify: notifyDep,
    writePrompt,
    readAutopilot,
    promptFileExists,
    disableOneShotTask,
    env = process.env,
    now = () => new Date(),
    setTimeoutFn = setTimeout,
    setIntervalFn = setInterval,
    clearTimerFn,
    locks = createTaskLocks(),
  } = deps;

  /**
   * A notification is advisory: it must never surface as an unhandled
   * rejection (#1580 — every dispatch below is fire-and-forget `void`, so a
   * rejection had nowhere to go but the daemon's crash channel). One wrapper
   * here catches for all dispatch sites rather than a `.catch` per call.
   */
  const notify = async (event: NotificationEvent, dir: string): Promise<void> => {
    try {
      await notifyDep(event, dir);
    } catch (err) {
      log(`Notification failed (non-fatal): ${(err as Error).message}`);
    }
  };

  const activeTimers: NodeJS.Timeout[] = [];
  const retryCountMap = new Map<string, number>();
  /**
   * Consecutive failures per task, for the streak escalation below.
   *
   * Separate from `retryCountMap`, which counts DEFERRALS for an active session
   * and is cleared when one succeeds. This counts a task that keeps dying.
   */
  const failureStreak = new Map<string, number>();

  function track(timer: NodeJS.Timeout): NodeJS.Timeout {
    activeTimers.push(timer);
    return timer;
  }

  function clearTimers(): void {
    for (const timer of activeTimers) {
      if (clearTimerFn) {
        clearTimerFn(timer);
      } else {
        clearTimeout(timer);
        clearInterval(timer);
      }
    }
    activeTimers.length = 0;
  }

  function scheduleRetry(task: HeartbeatTask): void {
    const count = (retryCountMap.get(task.name) ?? 0) + 1;
    retryCountMap.set(task.name, count);

    if (count > MAX_RETRIES) {
      log(
        `Task "${task.name}" failed — exhausted ${MAX_RETRIES} retries (Claude Code session kept active)`,
      );
      retryCountMap.delete(task.name);
      return;
    }

    log(
      `Task "${task.name}" deferred — Claude Code session active. Will retry in 60s (attempt ${count}/${MAX_RETRIES})`,
    );
    track(setTimeoutFn(() => executeTask(task), RETRY_DELAY_MS));
  }

  function executeTask(task: HeartbeatTask): void {
    // Per-task lock: only a second beat of the SAME task is refused, and the
    // refusal is visible rather than a silent drop.
    if (!locks.acquire(task.name)) {
      log(`Task "${task.name}" skipped, still running`);
      void notify(
        createEvent(task, 'task_skipped', 'warn', `Task skipped, still running: ${task.name}`),
        flowDir,
      );
      return;
    }

    log(`Executing "${task.name}": ${task.command}`);

    // Snapshot prompt file state before task runs
    const promptExistedBefore = promptFileExists();

    // Emit task_started notification (fire-and-forget)
    void notify(
      createEvent(task, 'task_started', 'info', `Starting task: ${task.name}`),
      flowDir,
    );

    // No `PLANFLOW_BEAT_ID` in the child's environment any more. It was a
    // per-spawn id that existed for exactly one reader: the loop finalizer,
    // which used it to tell THIS child's slot lock from a live in-session run's
    // (#1671). With the finalizer gone the id has no reader, and stamping it
    // would only invite something to start depending on the daemon again.
    const child = spawn('claude', buildClaudeArgs(task), {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: target,
      env: buildTaskEnv(env),
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    child.on('close', (code: number | null) => {
      locks.release(task.name);
      const outputTail = tailLines(stdout, TAIL_LINES);
      const errorTail = tailLines(stderr, TAIL_LINES);

      // The loop finalizer used to run here, reclaiming a loop slot whose run
      // exited without recording an ending. Nothing replaces it in the daemon:
      // a loop run is a Claude Code background agent now, and the harness that
      // owns the process is the thing that reports it dead.

      if (code === 0) {
        retryCountMap.delete(task.name);
        // A success ends the streak — the next one starts counting from zero.
        failureStreak.delete(task.name);

        // Check if the task created a NEW prompt file (blocked via file, not exit code)
        if (!promptExistedBefore && promptFileExists()) {
          log(`Task "${task.name}" completed but created prompt file — treating as blocked`);

          void notify(
            createEvent(task, 'task_blocked', 'error', `Task needs input: ${task.name}`),
            flowDir,
          );
        } else {
          log(`Task "${task.name}" completed successfully`);

          // Emit task_complete notification (fire-and-forget)
          void notify(
            createEvent(task, 'task_complete', 'info', `Task completed: ${task.name}`),
            flowDir,
          );
        }

        if (task.oneShot) {
          disableOneShotTask(task.name);
        }
      } else if (code === 2) {
        // Exit code 2 — task needs human input
        log(`Task "${task.name}" blocked — needs input (exit code 2)`);
        if (stderr) log(outputLogLine('stderr', stderr, OUTPUT_LOG_LIMIT));

        const isAutopilot = readAutopilot();

        // Emit task_blocked notification (fire-and-forget)
        void notify(
          createEvent(
            task,
            'task_blocked',
            'error',
            `Task blocked (needs input): ${task.name}${isAutopilot ? ' [autopilot ON]' : ''}`,
          ),
          flowDir,
        );

        if (!isAutopilot) {
          void writePrompt(task.name, outputTail, errorTail, flowDir);
          log(`  prompt written to flow/${PROMPT_FILENAME} — waiting for human input`);
        } else {
          log(`  Autopilot ON — skipping prompt, continuing`);
        }
        // #1819's one-call-one-line rule, kept: this used to log a raw 500-char
        // slice of agent stdout as a single call, which broke the log's
        // one-line-per-event contract and spilled prose across 75% of the
        // retention window.
        log(outputLogLine(`context (last ${TAIL_LINES} lines)`, outputTail, OUTPUT_LOG_LIMIT));
      } else if (stderr.includes(ACTIVE_SESSION_ERROR)) {
        // EVERY task defers now. The exemption that used to sit here was for
        // loop tasks only — a loop beat ran in its own worktree, so going quiet
        // because a human opened a session in the project was wrong for it. The
        // daemon does not dispatch loop beats any more (the module that named
        // them is gone), so the exemption has no subject, and an ordinary
        // heartbeat task's retry ladder is exactly what it was before loops
        // ever existed.
        scheduleRetry(task);
      } else {
        log(`Task "${task.name}" failed with code ${code}`);
        if (stderr) log(outputLogLine('stderr', stderr, OUTPUT_LOG_LIMIT));

        // Emit task_failed notification (fire-and-forget)
        void notify(
          createEvent(
            task,
            'task_failed',
            'error',
            `Task failed (exit ${code}): ${task.name}${errorTail ? '\n' + errorTail.slice(0, 300) : ''}`,
          ),
          flowDir,
        );

        // A STREAK IS A DIFFERENT FACT FROM A FAILURE, and it needs saying out
        // loud exactly once.
        //
        // This daemon once failed 97 consecutive times over two days — every
        // run emitting a perfectly good `task_failed` event — and it read as
        // idle rather than broken, because nobody scrolls a log to discover
        // that nothing has worked since Tuesday. One more identical event would
        // not have helped; a line that says "this has now failed N times in a
        // row" is a different thing to see.
        //
        // Emitted ONCE, at the threshold, not on every failure after it: the
        // point is to break through the noise, and repeating it would become
        // the noise.
        const streak = (failureStreak.get(task.name) ?? 0) + 1;
        failureStreak.set(task.name, streak);
        if (streak === FAILURE_STREAK_ALERT) {
          log(`Task "${task.name}" has now failed ${String(streak)} times in a row`);
          void notify(
            createEvent(
              task,
              'task_failed',
              'error',
              `"${task.name}" has failed ${String(streak)} times in a row — it is not running, it is failing. Last error: ${errorTail.slice(0, 200) || `exit ${String(code)}`}`,
            ),
            flowDir,
          );
        }
      }
      if (stdout) log(outputLogLine('output', stdout, OUTPUT_LOG_LIMIT));
    });

    child.on('error', (err: Error) => {
      locks.release(task.name);
      log(`Task "${task.name}" error: ${err.message}`);

      // Emit task_failed notification for spawn errors (fire-and-forget)
      void notify(
        createEvent(task, 'task_failed', 'error', `Task spawn error: ${task.name} — ${err.message}`),
        flowDir,
      );
    });
  }

  function scheduleTask(task: HeartbeatTask): void {
    if (!task.enabled) {
      log(`Task "${task.name}" is disabled, skipping`);
      return;
    }

    const config = task.scheduleConfig;

    if (config.type === 'once') {
      const ms = config.intervalMs!;
      log(`Scheduling one-shot "${task.name}" — runs in ${Math.round(ms / 1000)}s`);
      track(setTimeoutFn(() => executeTask(task), ms));
      return;
    }

    if (config.type === 'interval') {
      log(`Scheduling "${task.name}" every ${config.intervalMs! / 1000}s`);
      track(setIntervalFn(() => executeTask(task), config.intervalMs!));
      return;
    }

    // For daily/weekly, schedule the first occurrence, then repeat
    const ms = msUntilNextOccurrence(config, now());
    const repeatMs = config.type === 'daily' ? DAILY_REPEAT_MS : WEEKLY_REPEAT_MS;

    log(`Scheduling "${task.name}" — next run in ${Math.round(ms / 1000)}s`);

    track(
      setTimeoutFn(() => {
        executeTask(task);
        track(setIntervalFn(() => executeTask(task), repeatMs));
      }, ms),
    );
  }

  return { locks, scheduleTask, executeTask, clearTimers };
}

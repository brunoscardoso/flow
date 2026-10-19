/**
 * Tests for the `loop` verb family — `planflow-ai loop <verb>`.
 *
 * TWO LAYERS, EACH FOR WHAT ONLY IT CAN PROVE:
 *
 *   (1) SUBPROCESS E2E, spawning the REAL CLI entry through tsx exactly like
 *       `guard.test.ts` and `plan.test.ts`. This is the only layer that can
 *       prove the things a caller actually depends on: that the verb is
 *       registered on the program, that a refusal is ONE `loop refused:` line
 *       on the COMBINED transcript (allowed-pattern #15 — this repo's logger
 *       routes error() through console.log), and that the exit code is 1.
 *
 *   (2) IN-PROCESS, calling `runLoop` with an injected clock and an injected
 *       exec. This is the only layer that can prove determinism (identical
 *       inputs, byte-identical output) and the git-pull soft-failure path,
 *       because a subprocess has neither a fixed clock nor a controllable git.
 *
 * GIT IS REACHED THROUGH AN INJECTED EXEC, never a PATH stub — the `GhExec`
 * precedent from `github-queue.ts`. No test in this file runs a real `git` or a
 * real `gh`, and nothing here touches the network or this repository.
 *
 * Every fixture is a throwaway temp project with a `flow/loops/` directory, so
 * no test reads or writes the developer's own loop state.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');
const { tsxRunnerPath } = await import('../utils/node-runner.js');
const { runLoop, parseUntil, renderHuman } = await import('./loop.js');
const { evaluateNext, skippedPull } = await import('../loop/next.js');
const { digestRunLog, readRunLog } = await import('../loop/run-log.js');
const { acquireLoopLock, liveLocks, readLoopState, writeLoopState } = await import(
  '../loop/loop-state.js'
);
const { LOOPS_DIRNAME, parseLoopDirective } = await import('../loop/directive-parser.js');
const { emptyInstructions, instructionsPath, readInstructions, startInstruction, writeInstructions } =
  await import('../loop/instructions.js');

type LoopOptions = Parameters<typeof runLoop>[1];
type LoopRuntime = Parameters<typeof runLoop>[2];

const PACKAGE_ROOT = getPackageRoot();
const TSX_BIN = tsxRunnerPath(PACKAGE_ROOT);
const CLI_ENTRY = join(PACKAGE_ROOT, 'src', 'cli', 'index.ts');
const E2E_TIMEOUT_MS = 120_000;

/** A fixed clock, so every timestamp in an assertion is a constant. */
const NOW = Date.parse('2026-08-12T09:00:00.000Z');
/** The same instant the store writes — instructions stamp an ISO `since`. */
const NOW_ISO = new Date(NOW).toISOString();

// ── fixtures ─────────────────────────────────────────────

const PRODUCER_DIRECTIVE = `---
loop: find
engine: producer
mission: Hunt for real bugs in the source tree
scope: [src, app/src]
slice: changed
queue: ledger
max_open_issues: 2
max_run_minutes: 20
---

## Direction

Look for what is actually broken, not what is merely ugly.

## Rules

Reproduce before filing.
`;

const CONSUMER_DIRECTIVE = `---
loop: fix
engine: consumer
mission: Drain the queue one item at a time
queue: ledger
---
`;

/** A consumer whose queue is a repo — where an item id IS an issue number. */
const GITHUB_CONSUMER_DIRECTIVE = `---
loop: fix
engine: consumer
mission: Drain the open issue queue
queue: github
repo: owner/name
---
`;

/** A second consumer, on a ledger — an id here is not an issue number. */
const LEDGER_CONSUMER_DIRECTIVE = `---
loop: gap
engine: consumer
mission: Drain the ledger queue
queue: ledger
---
`;

const GATED_DIRECTIVE = `---
loop: gated
engine: producer
mission: File everything behind an approval gate
queue: ledger
needs_approval: true
---
`;

/** A loop pointed at an area — the `topic:` field the status row reports. */
const TOPICAL_DIRECTIVE = `---
loop: sweep
engine: producer
mission: Sweep the codemap for entries nothing points at
queue: ledger
topic: codemap
---
`;

const PAUSED_DIRECTIVE = `---
loop: parked
engine: producer
paused: true
mission: A loop steered off by commit
queue: ledger
---
`;

const projects: string[] = [];

/** A throwaway project with the named directives already in place. */
function makeProject(directives: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'loop-cli-'));
  projects.push(dir);
  mkdirSync(join(dir, 'flow', 'loops'), { recursive: true });
  for (const [name, content] of Object.entries(directives)) {
    writeFileSync(join(dir, 'flow', 'loops', `${name}.md`), content, 'utf-8');
  }
  return dir;
}

afterAll(() => {
  for (const dir of projects) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── in-process invocation ────────────────────────────────

interface Invocation {
  /** Everything written to stdout. */
  stdout: string;
  /** Everything the logger wrote (refusals included). */
  logged: string[];
  /** Just the `loop refused:` lines. */
  refusals: string[];
  exitCode: number;
  /** stdout parsed as JSON, or null when nothing was printed. */
  json: Record<string, unknown> | null;
}

/** An exec that always fails — the default, so no test can shell out by accident. */
const REFUSING_EXEC = (file: string): string => {
  throw new Error(`test exec: refusing to run '${file}'`);
};

type StdoutLike = { write: (chunk: unknown) => boolean };

/** Call a verb in-process, capturing stdout, the logger and the exit code. */
async function invoke(
  verb: string,
  options: Partial<LoopOptions> & { target: string },
  runtime: LoopRuntime = {},
): Promise<Invocation> {
  const chunks: string[] = [];
  const logged: string[] = [];
  const stdout = process.stdout as unknown as StdoutLike;
  const realWrite = stdout.write;
  const realLog = console.log;
  stdout.write = (chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  };
  console.log = (...args: unknown[]): void => {
    logged.push(args.map((arg) => String(arg)).join(' '));
  };

  const previousExit = process.exitCode;
  process.exitCode = 0;
  try {
    await runLoop(
      verb,
      { pull: false, ...options } as LoopOptions,
      { exec: REFUSING_EXEC, clock: () => NOW, ...runtime },
    );
  } finally {
    stdout.write = realWrite;
    console.log = realLog;
  }
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = previousExit;

  const text = chunks.join('');
  let json: Record<string, unknown> | null = null;
  if (text.trim().length > 0) {
    try {
      json = JSON.parse(text.trim()) as Record<string, unknown>;
    } catch {
      json = null;
    }
  }
  return {
    stdout: text,
    logged,
    refusals: logged.filter((line) => line.includes('loop refused:')),
    exitCode,
    json,
  };
}

/** File one finding, returning the result JSON. */
async function file(
  target: string,
  loop: string,
  title: string,
  extra: Partial<LoopOptions> = {},
): Promise<Invocation> {
  return invoke('file', { target, loop, title, body: 'because it is broken', ...extra });
}

/** Evidence that satisfies the close gate. */
const PASSING_EVIDENCE = JSON.stringify({
  commands: [{ command: 'npm run test -- src/cli/loop', exitCode: 0 }],
});

// ── subprocess E2E ───────────────────────────────────────

interface CliRun {
  stdout: string;
  stderr: string;
  combined: string;
  status: number | null;
}

function cli(args: string[], input?: string): CliRun {
  const result = spawnSync(process.execPath, [TSX_BIN, CLI_ENTRY, 'loop', ...args], {
    encoding: 'utf-8',
    timeout: E2E_TIMEOUT_MS,
    input: input ?? '',
  });
  if (result.error) {
    throw result.error;
  }
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, combined: `${stdout}\n${stderr}`, status: result.status };
}

describe('Task 3.1 — registration and the refusal contract', () => {
  it(
    'registers `loop <verb>` on the real CLI and answers with JSON on stdout, exit 0',
    () => {
      const target = makeProject({ find: PRODUCER_DIRECTIVE });
      const result = cli(['next', '--loop', 'find', '--no-pull', '--target', target]);
      expect(result.status).toBe(0);
      const verdict = JSON.parse(result.stdout.trim());
      expect(verdict.verdict).toBe('proceed');
      expect(verdict.mission).toBe('Hunt for real bugs in the source tree');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'an unknown verb refuses with exactly ONE `loop refused:` line on the combined transcript, exit 1',
    () => {
      const result = cli(['frobnicate', '--target', makeProject()]);
      expect(result.status).toBe(1);
      const refusals = result.combined
        .split('\n')
        .filter((line) => line.includes('loop refused:'));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain("unknown verb 'frobnicate'");
      // never doubled
      expect(refusals[0].match(/loop refused:/g)).toHaveLength(1);
      // the refusal is the ONLY output — no result JSON was written
      expect(result.combined).not.toContain('{"');
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'a missing directive refuses by path, exit 1',
    () => {
      const result = cli(['next', '--loop', 'ghost', '--no-pull', '--target', makeProject()]);
      expect(result.status).toBe(1);
      expect(result.combined).toContain('loop refused:');
      expect(result.combined).toContain("no directive for loop 'ghost'");
    },
    E2E_TIMEOUT_MS,
  );

  it(
    '--human renders the same verdict in readable form, exit 0',
    () => {
      const target = makeProject({ find: PRODUCER_DIRECTIVE });
      const result = cli(['next', '--loop', 'find', '--no-pull', '--human', '--target', target]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('find (producer): proceed');
      expect(result.stdout).toContain('mission: Hunt for real bugs');
      expect(result.stdout).toContain('pull: skipped');
      expect(result.stdout.trim().startsWith('{')).toBe(false);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'a gate whose pull fails says so in its own words, never git\'s, on stderr (#1798)',
    () => {
      // THE SECOND LEAK #1798 NAMED. `defaultLoopExec` had no `stdio` either, so
      // every git child inherited this process's stderr — `loop worktree`
      // printed git's checkout chatter immediately before its own success line,
      // and the per-checkout owner-stamp read (whose `catch` returns null by
      // design) printed a `fatal:` about `--worktree`.
      //
      // The gate's pull is the same shape and reachable without touching a real
      // checkout: this project is not a git repository at all, so `git pull`
      // fails, the gate catches it and reports it in the `pull:` note it already
      // owns. Git's own complaint belongs nowhere.
      const target = makeProject({ find: PRODUCER_DIRECTIVE });
      const result = cli(['next', '--loop', 'find', '--human', '--target', target]);

      expect(result.status).toBe(0);
      // The verb still SAYS the pull failed — quiet is not the same as hiding.
      expect(result.stdout).toContain('pull: git pull failed');
      // …and it is the only place that is said.
      expect(result.stderr).not.toContain('fatal:');
      expect(result.stderr).not.toContain('not a git repository');
    },
    E2E_TIMEOUT_MS,
  );

  it('a verb that needs a loop refuses by flag name, writes nothing to stdout', async () => {
    const result = await invoke('next', { target: makeProject() });
    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('next requires --loop <name>');
    expect(result.stdout).toBe('');
  });
});

describe('Task 3.2 — `loop next`', () => {
  it('proceeds on a free loop, taking the lock and persisting it', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const result = await invoke('next', { target, loop: 'find', owner: 'beat-1' });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      verdict: 'proceed',
      loop: 'find',
      engine: 'producer',
      slice: 'changed',
      scope: ['src', 'app/src'],
      owner: 'beat-1',
      maxRunMinutes: 20,
    });
    expect((result.json as Record<string, unknown>).direction).toContain('actually broken');
    expect((result.json as Record<string, unknown>).rules).toContain('Reproduce before filing');

    // the slot is on disk, its TTL sized from the directive's nominal run
    // length + margin. Phase 6 deleted the run budget, so `max_run_minutes`
    // now enforces nothing and sizes only this reservation.
    const state = readLoopState(join(target, 'flow'), NOW);
    expect(state.loops.find.locks?.[0].owner).toBe('beat-1');
    expect(state.loops.find.locks?.[0].slot).toBe(1);
    expect(Date.parse(state.loops.find.locks![0].expiresAt) - NOW).toBe(25 * 60 * 1000);
  });

  it('#1625 — stamps the pull it just did on its own lock, and stamps nothing when it did not', async () => {
    // WHAT THE RUN ALREADY BROUGHT CURRENT. The worktree shares this checkout's
    // ref store, so a resolve inside this window can reuse the ref the gate's
    // pull updated instead of re-negotiating with the remote for it (~1s here,
    // 2.7s reported). The stamp is the only evidence that permits the skip.
    // A git that answers instead of refusing: the pull succeeds, and
    // `rev-parse --abbrev-ref HEAD` names the branch it brought current.
    const workingGit = (_file: string, args: readonly string[]): string =>
      args[0] === 'rev-parse' ? 'main' : '';

    const pulled = makeProject({ find: PRODUCER_DIRECTIVE });
    await invoke(
      'next',
      { target: pulled, loop: 'find', owner: 'beat-1', pull: true },
      { exec: workingGit },
    );
    const withPull = readLoopState(join(pulled, 'flow'), NOW);
    expect(withPull.loops.find.locks?.[0].pulled?.at.length).toBeGreaterThan(0);
    expect(typeof withPull.loops.find.locks?.[0].pulled?.base).toBe('string');

    // A SKIPPED PULL BROUGHT NOTHING CURRENT, so it claims nothing — the skip
    // must never rest on a freshness that was not established (#1584).
    const skipped = makeProject({ find: PRODUCER_DIRECTIVE });
    await invoke('next', { target: skipped, loop: 'find', owner: 'beat-1', pull: false });
    const withoutPull = readLoopState(join(skipped, 'flow'), NOW);
    expect(withoutPull.loops.find.locks?.[0].pulled).toBeUndefined();
  });

  it('is deterministic — identical inputs produce byte-identical output, twice', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const options = { target, loop: 'find', owner: 'beat-fixed' };

    const first = await invoke('next', options);
    // The first beat WROTE its lock, so "identical inputs" means restoring the
    // state the first one saw — otherwise the second run is a different
    // question with a different (correct) answer.
    rmSync(join(target, 'flow', 'loops', 'state.json'));
    const second = await invoke('next', options);

    expect(first.stdout).toBe(second.stdout);
    expect(first.json).toMatchObject({ verdict: 'proceed', owner: 'beat-fixed' });
  });

  it('a beat re-entering the gate is not locked out by its own lock', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await invoke('next', { target, loop: 'find', owner: 'beat-1' });

    // THE SECOND GATE PASS NEEDS A LATER CLOCK. Phase 6 folded the re-entry
    // report into the slot itself: the gate now says "re-entered" when the slot
    // it got back carries an OLDER `acquiredAt` than this instant. Re-entering
    // inside the same frozen millisecond is indistinguishable from starting,
    // which is true of the code and only reachable in a test.
    const again = await invoke(
      'next',
      { target, loop: 'find', owner: 'beat-1' },
      { clock: () => NOW + 60_000 },
    );
    expect(again.json).toMatchObject({ verdict: 'proceed' });
    expect(String((again.json as Record<string, unknown>).reason)).toContain(
      "re-entered by 'beat-1'",
    );
  });

  it('the pure gate is a function of its inputs alone', () => {
    const directive = parseLoopDirective(PRODUCER_DIRECTIVE);
    const input = {
      directive,
      state: { version: 1, loops: {} },
      queue: {
        kind: 'ledger' as const,
        location: 'flow/loops/queue.jsonl',
        counts: {
          open: 0,
          closed: 3,
          claimed: 0,
          awaitingApproval: 0,
          parked: 0,
          claimable: 0,
        },
        fingerprints: ['b'.repeat(40), 'a'.repeat(40)],
      },
      pull: skippedPull('pull skipped (--no-pull)'),
      owner: 'beat-pure',
      now: NOW,
    };
    const first = evaluateNext(input);
    const second = evaluateNext(input);
    expect(JSON.stringify(first.result)).toBe(JSON.stringify(second.result));
    // fingerprints come back sorted, so two queue reads in any order agree
    expect(first.result.fingerprints).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
  });

  it('records a soft-failed git pull without aborting the beat', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const calls: string[][] = [];
    const result = await invoke(
      'next',
      { target, loop: 'find', owner: 'beat-1', pull: true },
      {
        clock: () => NOW,
        exec: (file: string, args: readonly string[]) => {
          calls.push([file, ...args]);
          throw new Error('fatal: could not read from remote repository\nplease check');
        },
      },
    );

    expect(calls).toEqual([['git', 'pull', '--ff-only']]);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ verdict: 'proceed' });
    const pull = (result.json as { pull: { attempted: boolean; ok: boolean; note: string } }).pull;
    expect(pull.attempted).toBe(true);
    expect(pull.ok).toBe(false);
    expect(pull.note).toContain('git pull failed');
    // collapsed to one line
    expect(pull.note).not.toContain('\n');
  });

  it('records a successful pull and skips it entirely under --no-pull', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const pulled = await invoke(
      'next',
      { target, loop: 'find', owner: 'beat-1', pull: true },
      { clock: () => NOW, exec: () => 'Already up to date.\n' },
    );
    expect(pulled.json).toMatchObject({ pull: { attempted: true, ok: true, note: '' } });

    const skipped = await invoke('next', { target, loop: 'find', owner: 'beat-1' });
    expect(skipped.json).toMatchObject({
      pull: { attempted: false, ok: false, note: 'pull skipped (--no-pull)' },
    });
  });

  it('a directive pause outranks everything and takes no lock', async () => {
    const target = makeProject({ parked: PAUSED_DIRECTIVE });
    const result = await invoke('next', { target, loop: 'parked', owner: 'beat-1' });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ verdict: 'paused', lock: null });
    expect(String((result.json as Record<string, unknown>).reason)).toContain('by its directive');
    expect(readLoopState(join(target, 'flow'), NOW).loops.parked).toBeUndefined();
  });

  it('a global pause stops a loop that is otherwise free', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await invoke('pause', { target, reason: 'release window' });

    const result = await invoke('next', { target, loop: 'find', owner: 'beat-1' });
    expect(result.json).toMatchObject({ verdict: 'paused', lock: null });
    expect(String((result.json as Record<string, unknown>).reason)).toContain('all loops are paused');
  });

  it("another beat's live lock yields `locked`", async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await invoke('next', { target, loop: 'find', owner: 'beat-1' });

    const result = await invoke('next', { target, loop: 'find', owner: 'beat-2' });
    expect(result.json).toMatchObject({ verdict: 'locked', lock: null });
    // The refusal names the SLOT TABLE now — `find` allows one concurrent run,
    // so one live slot is a full table and the incumbent is who to wait for.
    expect(String((result.json as Record<string, unknown>).reason)).toContain(
      "has no free run slot — 'beat-1' holds one",
    );
  });

  it('a producer at its cap skips rather than hunting with nowhere to file', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await file(target, 'find', 'first finding');
    await file(target, 'find', 'second finding');

    const result = await invoke('next', { target, loop: 'find', owner: 'beat-1' });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ verdict: 'skip', lock: null });
    expect(String((result.json as Record<string, unknown>).reason)).toContain('open-item cap reached');
    expect((result.json as { queue: { capReached: boolean } }).queue.capReached).toBe(true);
    // a skipped beat leaves no slot behind
    expect(readLoopState(join(target, 'flow'), NOW).loops.find?.locks).toBeUndefined();
  });

  it('a consumer with an empty in-tray skips, and hands back what it does know', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE, find: PRODUCER_DIRECTIVE });
    const empty = await invoke('next', { target, loop: 'fix', owner: 'beat-1' });
    expect(empty.json).toMatchObject({ verdict: 'skip' });
    expect(String((empty.json as Record<string, unknown>).reason)).toContain('nothing claimable');

    // the producer's known fingerprints travel in ITS verdict, so it never
    // has to be told what it already filed
    await file(target, 'find', 'a finding worth remembering', { file: 'src/x.ts' });
    const next = await invoke('next', { target, loop: 'find', owner: 'beat-2' });
    const fingerprints = (next.json as { fingerprints: string[] }).fingerprints;
    expect(fingerprints).toHaveLength(1);
    expect(fingerprints[0]).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('#1662 — a lock written by another process during the gate window survives', () => {
  const HALF_HOUR = 30 * 60 * 1000;

  /**
   * An exec whose `git pull` IS the concurrent process: while this gate's
   * multi-second window is open, it lands a lock into the store — exactly what
   * the daemon's overlapping beats and a terminal `/agent-loop` do live. The
   * gate's later write must be built from state that includes it.
   */
  function intruderPull(flowDir: string, loop: string): (file: string, args: readonly string[]) => string {
    return (_file, args) => {
      if (args[0] === 'pull') {
        const attempt = acquireLoopLock(readLoopState(flowDir, NOW), loop, 'run-intruder', HALF_HOUR, NOW);
        if (!attempt.acquired) throw new Error('test: the intruder could not take its lock');
        writeLoopState(flowDir, attempt.state);
        return '';
      }
      return args[0] === 'rev-parse' ? 'main' : '';
    };
  }

  it("another loop's lock landed mid-pull is not erased by this gate's write", async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE, find: PRODUCER_DIRECTIVE });
    const flowDir = join(target, 'flow');
    // a claimable item, so the consumer gate proceeds (and therefore writes)
    await file(target, 'fix', 'seed item');

    const result = await invoke(
      'next',
      { target, loop: 'fix', owner: 'beat-a', pull: true },
      { exec: intruderPull(flowDir, 'find') },
    );
    expect(result.json).toMatchObject({ verdict: 'proceed', owner: 'beat-a' });

    const state = readLoopState(flowDir, NOW);
    expect(liveLocks(state, 'find', NOW).map((lock) => lock.owner)).toEqual([
      'run-intruder',
    ]);
    expect(liveLocks(state, 'fix', NOW).map((lock) => lock.owner)).toEqual(['beat-a']);
  });

  it("this loop's only slot taken mid-pull turns the verdict into locked, never proceed", async () => {
    // The live sequence from the issue: a run told it holds slot 1 keeps
    // holding it — the gate that raced it is the one refused.
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const flowDir = join(target, 'flow');
    await file(target, 'fix', 'seed item');

    const result = await invoke(
      'next',
      { target, loop: 'fix', owner: 'beat-a', pull: true },
      { exec: intruderPull(flowDir, 'fix') },
    );
    expect(result.json).toMatchObject({ verdict: 'locked' });
    expect(String((result.json as Record<string, unknown>).reason)).toContain('run-intruder');

    const state = readLoopState(flowDir, NOW);
    expect(liveLocks(state, 'fix', NOW).map((lock) => lock.owner)).toEqual([
      'run-intruder',
    ]);
  });
});

describe('#1663 — the pull is serialized per checkout', () => {
  it('runs `git pull` holding the checkout pull lock, and releases it after', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const pullLock = join(target, 'flow', 'loops', 'pull.lock');
    // The exec IS the pull — so the one place the lock can be observed held is
    // inside it. Concurrent gates block on this file instead of sharing
    // FETCH_HEAD, which is what turns the git fatal into a clean wait.
    const seenDuringPull: boolean[] = [];
    const observingGit = (_file: string, args: readonly string[]): string => {
      if (args[0] === 'pull') seenDuringPull.push(existsSync(pullLock));
      return args[0] === 'rev-parse' ? 'main' : '';
    };

    const result = await invoke(
      'next',
      { target, loop: 'find', owner: 'beat-1', pull: true },
      { exec: observingGit },
    );
    expect(result.json).toMatchObject({ verdict: 'proceed' });
    expect(seenDuringPull).toEqual([true]);
    expect(existsSync(pullLock)).toBe(false);
  });

  it('a stale pull lock left by a dead gate is reclaimed, not waited on', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const pullLock = join(target, 'flow', 'loops', 'pull.lock');
    writeFileSync(pullLock, '99999', 'utf-8');
    const past = new Date(Date.now() - 10 * 60_000);
    utimesSync(pullLock, past, past);

    const workingGit = (_file: string, args: readonly string[]): string =>
      args[0] === 'rev-parse' ? 'main' : '';
    const result = await invoke(
      'next',
      { target, loop: 'find', owner: 'beat-1', pull: true },
      { exec: workingGit },
    );
    expect(result.json).toMatchObject({ verdict: 'proceed' });
    expect((result.json as { pull: { ok: boolean } }).pull.ok).toBe(true);
    expect(existsSync(pullLock)).toBe(false);
  });
});

describe('Task 3.3 — `loop file` and `loop claim`', () => {
  it('files a finding, embeds the fingerprint marker, and reports a re-file as a duplicate', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const filed = await file(target, 'find', 'Crash on empty input', { file: 'src/a.ts' });

    expect(filed.exitCode).toBe(0);
    expect(filed.json).toMatchObject({ status: 'filed', loop: 'find' });
    const item = (filed.json as { item: { id: string; body: string; fingerprint: string } }).item;
    expect(item.body).toContain('<!-- loop: find -->');
    expect(item.body).toContain(`<!-- loop-fp: ${item.fingerprint} -->`);
    expect(item.body).toContain('<!-- loop-file: src/a.ts -->');

    // cosmetically different, same finding — and a duplicate is exit 0
    const again = await file(target, 'find', 'CRASH on empty input!', {
      file: './src/a.ts',
    });
    expect(again.exitCode).toBe(0);
    expect(again.json).toMatchObject({ status: 'duplicate' });
    expect((again.json as { item: { id: string } }).item.id).toBe(item.id);
  });

  it('refuses to file past the cap, with one line and exit 1', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await file(target, 'find', 'one');
    await file(target, 'find', 'two');

    const third = await file(target, 'find', 'three');
    expect(third.exitCode).toBe(1);
    expect(third.refusals).toHaveLength(1);
    expect(third.refusals[0]).toContain('open-item cap reached — 2 open, max 2');
    expect(third.stdout).toBe('');
  });

  it('claims the oldest eligible item, and reports an exhausted queue as `empty`', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await file(target, 'find', 'older');
    await file(target, 'find', 'newer');

    const claimed = await invoke('claim', { target, loop: 'find', owner: 'beat-1' });
    expect(claimed.exitCode).toBe(0);
    expect(claimed.json).toMatchObject({ status: 'claimed', owner: 'beat-1' });
    expect((claimed.json as { item: { title: string } }).item.title).toBe('older');

    const next = await invoke('claim', { target, loop: 'find', owner: 'beat-2' });
    expect((next.json as { item: { title: string } }).item.title).toBe('newer');

    const empty = await invoke('claim', { target, loop: 'find', owner: 'beat-3' });
    expect(empty.exitCode).toBe(0);
    expect(empty.json).toMatchObject({ status: 'empty' });
    expect(String((empty.json as Record<string, unknown>).reason)).toContain('nothing claimable');
  });

  it('skips an item behind the approval gate until `loop approve` clears it', async () => {
    const target = makeProject({ gated: GATED_DIRECTIVE });
    const filed = await file(target, 'gated', 'needs a human first');
    const item = (filed.json as { item: { id: string; approved: boolean; labels: string[] } }).item;
    expect(item.approved).toBe(false);
    expect(item.labels).toContain('needs-approval');

    const blocked = await invoke('claim', { target, loop: 'gated', owner: 'beat-1' });
    expect(blocked.json).toMatchObject({ status: 'empty' });

    const approved = await invoke('approve', { target, loop: 'gated', id: item.id });
    expect(approved.exitCode).toBe(0);
    expect(approved.json).toMatchObject({ status: 'approved', alreadyApproved: false });

    const claimed = await invoke('claim', { target, loop: 'gated', owner: 'beat-1' });
    expect(claimed.json).toMatchObject({ status: 'claimed' });

    // claiming a specific item somebody else holds refuses by name
    const stolen = await invoke('claim', {
      target,
      loop: 'gated',
      owner: 'beat-2',
      id: item.id,
    });
    expect(stolen.exitCode).toBe(1);
    expect(stolen.refusals[0]).toContain("already claimed by 'beat-1'");
  });
});

describe('Task 3.4 — `loop close` and the evidence gate', () => {
  async function fileOne(target: string, title = 'a real bug'): Promise<string> {
    const filed = await file(target, 'find', title);
    return (filed.json as { item: { id: string } }).item.id;
  }

  it('refuses a `done` close carrying prose alone', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const id = await fileOne(target);

    const result = await invoke('close', {
      target,
      loop: 'find',
      id,
      reason: 'done',
      detail: 'I am confident this is fixed now',
    });
    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('machine-checkable evidence');
    expect(result.stdout).toBe('');

    // and the item is still open
    const status = await invoke('status', { target, loop: 'find' });
    expect((status.json as { loops: Array<{ queue: { open: number } }> }).loops[0].queue.open).toBe(1);
  });

  it('refuses a `done` close whose recorded command did not exit 0', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const id = await fileOne(target);

    const result = await invoke('close', {
      target,
      loop: 'find',
      id,
      reason: 'done',
      evidence: JSON.stringify({ commands: [{ command: 'npm run test', exitCode: 1 }] }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain("exited 1");
  });

  it('refuses malformed evidence rather than closing on an unreadable claim', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const id = await fileOne(target);

    const result = await invoke('close', {
      target,
      loop: 'find',
      id,
      reason: 'done',
      evidence: '{not json',
    });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('malformed evidence JSON');
  });

  it('closes with captured exit codes, and records them verbatim in the ledger', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const id = await fileOne(target);

    const result = await invoke('close', {
      target,
      loop: 'find',
      id,
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'closed', reason: 'done' });
    expect((result.json as { item: { state: string } }).item.state).toBe('closed');

    const ledger = readFileSync(join(target, 'flow', 'loops', 'queue.jsonl'), 'utf-8');
    expect(ledger).toContain('"exitCode":0');
    expect(ledger).toContain('npm run test -- src/cli/loop');
  });

  it('requires a written reason for a wontfix — permanent memory is never unexplained', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const id = await fileOne(target);

    const bare = await invoke('close', { target, loop: 'find', id, reason: 'wontfix' });
    expect(bare.exitCode).toBe(1);
    expect(bare.refusals[0]).toContain('requires a written reason');

    const explained = await invoke('close', {
      target,
      loop: 'find',
      id,
      reason: 'wontfix',
      detail: 'intentional behaviour — see the discovery doc',
    });
    expect(explained.exitCode).toBe(0);
    expect(explained.json).toMatchObject({ status: 'closed', reason: 'wontfix' });
  });

  it('refuses an unknown close reason', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const id = await fileOne(target);
    const result = await invoke('close', { target, loop: 'find', id, reason: 'fixed-ish' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain("unknown close reason 'fixed-ish'");
  });
});

describe('Task 3.5 — `loop pause`, `loop resume`, `loop approve`', () => {
  it('refuses a pause with no reason', async () => {
    const result = await invoke('pause', { target: makeProject(), loop: 'find' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('pause requires --reason <text>');
  });

  it('writes a per-loop pause through the state store, with the reason recorded', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const result = await invoke('pause', {
      target,
      loop: 'find',
      reason: 'noisy findings',
      until: '+30m',
    });

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'paused', scope: 'loop', loop: 'find' });

    const state = readLoopState(join(target, 'flow'), NOW);
    expect(state.loops.find.pause?.reason).toBe('noisy findings');
    expect(Date.parse(state.loops.find.pause!.until!) - NOW).toBe(30 * 60 * 1000);

    // and it is in the log next to the beats it stopped
    const log = readRunLog(join(target, 'flow'));
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ kind: 'pause', loop: 'find', reason: 'noisy findings' });
  });

  it('pauses every loop when no --loop is given, and resumes them again', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await invoke('pause', { target, reason: 'deploying' });
    expect(readLoopState(join(target, 'flow'), NOW).globalPause?.reason).toBe('deploying');

    const resumed = await invoke('resume', { target, reason: 'deploy done' });
    expect(resumed.json).toMatchObject({ status: 'resumed', scope: 'global' });
    expect(readLoopState(join(target, 'flow'), NOW).globalPause).toBeUndefined();
  });

  it('a per-loop resume lifts the pause, and the loop really runs again', async () => {
    // IT ONLY LIFTS THE PAUSE NOW. This used to assert that resume ALSO zeroed
    // the consecutive-failure counter, because a tripped breaker would
    // otherwise re-trip on the next single failure and read as "resume did
    // nothing". Phase 6 deleted the breaker — nothing schedules unattended
    // re-runs any more — so lifting the pause is the whole verb.
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await invoke('pause', { target, loop: 'find', reason: 'something looked wrong' });
    expect(readLoopState(join(target, 'flow'), NOW).loops.find.pause?.reason).toBe(
      'something looked wrong',
    );

    await invoke('resume', { target, loop: 'find', reason: 'root cause fixed' });
    expect(readLoopState(join(target, 'flow'), NOW).loops.find.pause).toBeUndefined();

    // and the loop really beats again
    const next = await invoke('next', { target, loop: 'find', owner: 'beat-1' });
    expect(next.json).toMatchObject({ verdict: 'proceed' });
  });

  it('refuses a malformed --until', async () => {
    const result = await invoke('pause', {
      target: makeProject(),
      loop: 'find',
      reason: 'x',
      until: 'next tuesday-ish',
    });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('malformed --until');
  });

  it('parses both --until forms', () => {
    expect(parseUntil('+2h', NOW)).toBe(NOW + 2 * 3_600_000);
    expect(parseUntil('+1d', NOW)).toBe(NOW + 86_400_000);
    expect(parseUntil('2026-08-12T10:00:00.000Z', NOW)).toBe(Date.parse('2026-08-12T10:00:00.000Z'));
  });

  it('approving twice is success, not an error, and logs only the first', async () => {
    const target = makeProject({ gated: GATED_DIRECTIVE });
    const filed = await file(target, 'gated', 'gated finding');
    const id = (filed.json as { item: { id: string } }).item.id;

    const first = await invoke('approve', { target, loop: 'gated', id, owner: 'devuser' });
    expect(first.json).toMatchObject({ alreadyApproved: false });
    const second = await invoke('approve', { target, loop: 'gated', id, owner: 'devuser' });
    expect(second.exitCode).toBe(0);
    expect(second.json).toMatchObject({ status: 'approved', alreadyApproved: true });

    const approvals = readRunLog(join(target, 'flow')).filter((entry) => entry.kind === 'approve');
    expect(approvals).toHaveLength(1);
    expect(approvals[0].owner).toBe('devuser');
  });

  it('refuses to approve an item that does not exist', async () => {
    const target = makeProject({ gated: GATED_DIRECTIVE });
    const result = await invoke('approve', { target, loop: 'gated', id: '404' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain("no item '404' in the queue");
  });
});

/**
 * `loop disable` / `loop enable` — the DIRECTIVE pause, which had no writer.
 *
 * The point of these tests is the seam between the two pauses. A directive
 * pause is committed intent in markdown; a runtime pause is local state in
 * `state.json`. They stop the same loop and they are not the same fact, so the
 * assertions here are mostly about what did NOT happen: no state written, no
 * runtime pause lifted, no run-log line, and no byte of the directive changed
 * beyond one value token.
 */
describe('`loop disable` / `loop enable` — the directive pause', () => {
  /** A directive whose comment and prose are the thing that must survive. */
  const COMMENTED_DIRECTIVE = `---
loop: find
engine: producer
paused: true    # 2026-08-13: queue at its cap — resume once the list is short
mission: Hunt for real bugs in the source tree
queue: ledger
---

## Direction

Look for what is actually broken, not what is merely ugly.

## Rules

Reproduce before filing.
`;

  const directiveAt = (target: string, loop: string): string =>
    join(target, 'flow', LOOPS_DIRNAME, `${loop}.md`);

  it(
    'is registered on the real CLI, answers with JSON, exit 0',
    () => {
      const target = makeProject({ find: PRODUCER_DIRECTIVE });
      const result = cli(['disable', '--loop', 'find', '--target', target]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        status: 'disabled',
        loop: 'find',
        paused: true,
        wasPaused: false,
        changed: true,
      });
      expect(parseLoopDirective(readFileSync(directiveAt(target, 'find'), 'utf-8')).paused).toBe(true);
    },
    E2E_TIMEOUT_MS,
  );

  it('refuses without --loop — there is no global form', async () => {
    const result = await invoke('disable', { target: makeProject() });
    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('disable requires --loop <name>');
    expect(result.stdout).toBe('');
  });

  it('refuses a loop with no directive, and an unreadable one, writing nothing', async () => {
    const missing = await invoke('enable', { target: makeProject(), loop: 'ghost' });
    expect(missing.exitCode).toBe(1);
    expect(missing.refusals[0]).toContain("no directive for loop 'ghost'");

    const target = makeProject({ find: 'loop: find\nengine: producer\n' });
    const malformed = await invoke('disable', { target, loop: 'find' });
    expect(malformed.exitCode).toBe(1);
    expect(malformed.refusals).toHaveLength(1);
    expect(malformed.refusals[0]).toContain('missing frontmatter');
    // NOTHING WRITTEN: the file a verb could not read is the file it left alone.
    expect(readFileSync(directiveAt(target, 'find'), 'utf-8')).toBe('loop: find\nengine: producer\n');
  });

  it('changes exactly one line, keeping the comment and the prose below it', async () => {
    const target = makeProject({ find: COMMENTED_DIRECTIVE });
    const result = await invoke('enable', { target, loop: 'find' });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'enabled', paused: false, wasPaused: true, changed: true });

    const after = readFileSync(directiveAt(target, 'find'), 'utf-8');
    const changed = COMMENTED_DIRECTIVE.split('\n')
      .map((line, index) => [line, after.split('\n')[index]])
      .filter(([before, now]) => before !== now);
    expect(changed).toEqual([
      [
        'paused: true    # 2026-08-13: queue at its cap — resume once the list is short',
        'paused: false    # 2026-08-13: queue at its cap — resume once the list is short',
      ],
    ]);
  });

  it('setting what the file already says is a success that wrote nothing', async () => {
    const target = makeProject({ find: COMMENTED_DIRECTIVE });
    const result = await invoke('disable', { target, loop: 'find' });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'disabled', paused: true, wasPaused: true, changed: false });
    expect(readFileSync(directiveAt(target, 'find'), 'utf-8')).toBe(COMMENTED_DIRECTIVE);
    expect(renderHuman('disable', result.json)).toContain('already disabled: find');
  });

  it('the gate honours it on the very next run, and enabling gives the loop back', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await invoke('disable', { target, loop: 'find' });
    const stopped = await invoke('next', { target, loop: 'find', owner: 'beat-1' });
    expect(stopped.json).toMatchObject({ verdict: 'paused' });
    expect(String(stopped.json?.reason)).toContain('paused by its directive');

    await invoke('enable', { target, loop: 'find' });
    const running = await invoke('next', { target, loop: 'find', owner: 'beat-1' });
    expect(running.json).toMatchObject({ verdict: 'proceed' });
  });

  it('writes no runtime state and no run-log line — the file is the record', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const flowDir = join(target, 'flow');
    await invoke('disable', { target, loop: 'find' });

    expect(existsSync(join(flowDir, LOOPS_DIRNAME, 'state.json'))).toBe(false);
    expect(readLoopState(flowDir, NOW).loops.find).toBeUndefined();
    // `loop pause` records itself because nothing else would; a tracked file's
    // history is `git log`, so this verb adds no line to the run log.
    expect(readRunLog(flowDir)).toHaveLength(0);
  });

  it('neither pause lifts the other', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const flowDir = join(target, 'flow');

    // A runtime pause stands, and `enable` must not clear it…
    await invoke('pause', { target, loop: 'find', reason: 'noisy findings' });
    await invoke('enable', { target, loop: 'find' });
    expect(readLoopState(flowDir, NOW).loops.find.pause?.reason).toBe('noisy findings');

    // …and a runtime `resume` must not clear a directive pause either.
    await invoke('disable', { target, loop: 'find' });
    await invoke('resume', { target, loop: 'find', reason: 'looked at it' });
    expect(readLoopState(flowDir, NOW).loops.find.pause).toBeUndefined();
    expect(parseLoopDirective(readFileSync(directiveAt(target, 'find'), 'utf-8')).paused).toBe(true);

    // …and `loop status` still reports the one that is standing.
    const status = await invoke('status', { target, loop: 'find' });
    expect(status.json).toMatchObject({ loops: [{ loop: 'find', directivePaused: true }] });
    expect(renderHuman('status', status.json)).toContain('paused by directive');
  });
});

/**
 * `loop point` — where a loop's work comes from, which until now was reachable
 * only by hand-editing two coupled fields in markdown.
 *
 * THE COUPLING IS THE WHOLE RISK. `queue: github` requires a `repo:` and
 * refuses a `path:`; `queue: ledger` refuses the `repo:`. A switch that left the
 * old companion behind would produce a directive the parser turns away — and a
 * loop whose directive does not parse does not run at all, so every case here
 * ends by proving the file still reads, usually through the gate that actually
 * opens a run.
 */
describe('`loop point` — where a loop reads its work', () => {
  /** A consumer on a repo, with a comment and prose that must survive a switch. */
  const POINTED_DIRECTIVE = `---
loop: fix
engine: consumer
paused: true    # 2026-08-14: waiting on the release
mission: Drain the queue one item at a time
queue: github
repo: acme/widgets    # the fork, not upstream
---

## Direction

Take the oldest item that is ready and finish it.

## Rules

Reproduce before you close.
`;

  const directiveAt = (target: string, loop: string): string =>
    join(target, 'flow', LOOPS_DIRNAME, `${loop}.md`);

  it(
    'is registered on the real CLI, answers with JSON, exit 0',
    () => {
      const target = makeProject({ fix: GITHUB_CONSUMER_DIRECTIVE });
      const result = cli(['point', '--loop', 'fix', '--queue', 'ledger', '--target', target]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        status: 'pointed',
        loop: 'fix',
        queue: 'ledger',
        wasQueue: 'github',
        wasLocation: 'owner/name',
        changed: true,
      });
    },
    E2E_TIMEOUT_MS,
  );

  it('refuses without --loop and without --queue — neither has a default', async () => {
    const target = makeProject({ fix: GITHUB_CONSUMER_DIRECTIVE });
    const nameless = await invoke('point', { target, queue: 'ledger' });
    expect(nameless.exitCode).toBe(1);
    expect(nameless.refusals[0]).toContain('point requires --loop <name>');

    const storeless = await invoke('point', { target, loop: 'fix' });
    expect(storeless.exitCode).toBe(1);
    expect(storeless.refusals[0]).toContain('point requires --queue <github|ledger>');
    expect(storeless.stdout).toBe('');
    // Neither refusal touched the file it was asked about.
    expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).toBe(GITHUB_CONSUMER_DIRECTIVE);
  });

  it('refuses a github queue with no repo, and one that is not owner/name', async () => {
    const target = makeProject({ fix: LEDGER_CONSUMER_DIRECTIVE.replace('loop: gap', 'loop: fix') });
    const bare = await invoke('point', { target, loop: 'fix', queue: 'github' });
    expect(bare.exitCode).toBe(1);
    expect(bare.refusals[0]).toContain("queue 'github' requires 'repo: owner/name'");

    const malformed = await invoke('point', { target, loop: 'fix', queue: 'github', repo: 'widgets' });
    expect(malformed.exitCode).toBe(1);
    expect(malformed.refusals[0]).toContain("malformed repo 'widgets' — expected owner/name");
    // A repo cannot be guessed, so a bad one leaves the loop where it was.
    expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).toContain('queue: ledger');
  });

  it('refuses an unknown store, and each field under the queue that forbids it', async () => {
    const target = makeProject({ fix: GITHUB_CONSUMER_DIRECTIVE });
    const unknown = await invoke('point', { target, loop: 'fix', queue: 'jira' });
    expect(unknown.refusals[0]).toContain("unknown queue 'jira' — expected github|ledger");

    const crossed = await invoke('point', {
      target,
      loop: 'fix',
      queue: 'github',
      repo: 'acme/widgets',
      path: 'flow/loops/queue.jsonl',
    });
    expect(crossed.refusals[0]).toContain("'path' applies to queue 'ledger' only");

    const other = await invoke('point', { target, loop: 'fix', queue: 'ledger', repo: 'acme/widgets' });
    expect(other.refusals[0]).toContain("'repo' applies to queue 'github' only");
    expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).toBe(GITHUB_CONSUMER_DIRECTIVE);
  });

  it('a github → ledger switch leaves no stale repo, and the loop still runs', async () => {
    const target = makeProject({ fix: POINTED_DIRECTIVE });
    const result = await invoke('point', { target, loop: 'fix', queue: 'ledger' });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      status: 'pointed',
      queue: 'ledger',
      location: 'flow/loops/queue.jsonl',
      wasQueue: 'github',
      wasLocation: 'acme/widgets',
      changed: true,
    });

    const after = readFileSync(directiveAt(target, 'fix'), 'utf-8');
    expect(after).not.toContain('repo:');
    // The one line that had to go took its own trailing note with it; every
    // other comment, and all the prose, came through untouched.
    expect(after).toContain('paused: true    # 2026-08-14: waiting on the release');
    expect(after).toContain('Take the oldest item that is ready and finish it.');
    expect(after).toContain('Reproduce before you close.');
    // The parser accepts what the writer produced — proved through the verb
    // that actually reads it rather than by re-parsing in the test.
    const status = await invoke('status', { target, loop: 'fix' });
    expect(status.json).toMatchObject({
      loops: [{ loop: 'fix', queueKind: 'ledger', queueLocation: 'flow/loops/queue.jsonl' }],
    });
    expect(status.json?.loops).not.toMatchObject([{ directiveError: expect.anything() }]);
  });

  it('a ledger → github switch writes the repo and drops the path', async () => {
    const target = makeProject({ gap: LEDGER_CONSUMER_DIRECTIVE });
    await invoke('point', { target, loop: 'gap', queue: 'ledger', path: 'flow/loops/backlog.jsonl' });
    expect(readFileSync(directiveAt(target, 'gap'), 'utf-8')).toContain('path: flow/loops/backlog.jsonl');

    const result = await invoke('point', { target, loop: 'gap', queue: 'github', repo: 'acme/widgets' });
    expect(result.json).toMatchObject({
      queue: 'github',
      location: 'acme/widgets',
      wasQueue: 'ledger',
      wasLocation: 'flow/loops/backlog.jsonl',
      changed: true,
    });
    const after = readFileSync(directiveAt(target, 'gap'), 'utf-8');
    expect(after).not.toContain('path:');
    expect(parseLoopDirective(after, 'written').repo).toBe('acme/widgets');
  });

  it('pointing where it already points is a success that wrote nothing', async () => {
    const target = makeProject({ fix: POINTED_DIRECTIVE });
    const result = await invoke('point', { target, loop: 'fix', queue: 'github', repo: 'acme/widgets' });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ queue: 'github', location: 'acme/widgets', changed: false });
    expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).toBe(POINTED_DIRECTIVE);
    expect(renderHuman('point', result.json)).toBe(
      `already pointed: fix — reads github acme/widgets (${directiveAt(target, 'fix')})`,
    );
  });

  it('says where the loop reads now, in the words `loop status` uses', async () => {
    const target = makeProject({ fix: POINTED_DIRECTIVE });
    const result = await invoke('point', { target, loop: 'fix', queue: 'ledger' });
    expect(renderHuman('point', result.json)).toBe(
      `pointed: fix — reads ledger flow/loops/queue.jsonl (${directiveAt(target, 'fix')})`,
    );
  });

  it('refuses a malformed directive and an absent loop, writing nothing', async () => {
    const broken = ['---', 'loop: fix', 'engine: consumer', 'mission: m', 'quee: ledger', '---', ''].join('\n');
    const target = makeProject({ fix: broken });
    const result = await invoke('point', { target, loop: 'fix', queue: 'ledger' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain("unknown frontmatter key 'quee'");
    expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).toBe(broken);

    const ghost = await invoke('point', { target, loop: 'ghost', queue: 'ledger' });
    expect(ghost.exitCode).toBe(1);
    expect(ghost.refusals[0]).toContain("no directive for loop 'ghost'");
  });

  it('changes neither pause, and writes no runtime state or run-log line', async () => {
    const target = makeProject({ fix: POINTED_DIRECTIVE });
    const flowDir = join(target, 'flow');
    await invoke('pause', { target, loop: 'fix', reason: 'noisy findings' });
    await invoke('point', { target, loop: 'fix', queue: 'ledger' });

    // The directive's own pause survived the rewrite…
    expect(parseLoopDirective(readFileSync(directiveAt(target, 'fix'), 'utf-8')).paused).toBe(true);
    // …and so did the runtime one, which this verb has no business reading.
    expect(readLoopState(flowDir, NOW).loops.fix.pause?.reason).toBe('noisy findings');
    // One line in the run log: the pause's. Re-pointing a tracked file records
    // itself in `git log -p`, exactly as disable/enable do.
    expect(readRunLog(flowDir).filter((entry) => entry.event === 'point')).toHaveLength(0);
  });

  it('moves no items — a queue is a place, not a payload', async () => {
    const target = makeProject({ gap: LEDGER_CONSUMER_DIRECTIVE });
    await file(target, 'gap', 'something is broken');
    const before = await invoke('list', { target, loop: 'gap' });
    expect((before.json?.loops as { items: unknown[] }[])[0].items).toHaveLength(1);

    await invoke('point', { target, loop: 'gap', queue: 'github', repo: 'acme/widgets' });
    // The ledger still holds what it held: nothing was copied, closed or moved.
    const ledger = readFileSync(join(target, 'flow', LOOPS_DIRNAME, 'queue.jsonl'), 'utf-8');
    expect(ledger.trim().split('\n')).toHaveLength(1);
    expect(ledger).toContain('something is broken');
  });
});

/**
/**
 * `loop describe` — what a loop is TOLD, as opposed to where it reads.
 *
 * THE THREE THINGS THAT STEER A RUN AND HAD NO WRITER. `## Direction` is what to
 * look at, `## Rules` is what this loop has decided for itself, and
 * `max_open_issues` is the one stop it keeps by default. All three lived in
 * markdown only a person with an editor could change — which is why the IDE
 * could not offer them at all, the app being forbidden to author a directive.
 *
 * THE DEFAULT STOP IS A COUNT, AND ONLY A COUNT. Time is not enforced, and
 * `empty` is an outcome rather than a limit, so `max_open_issues` is the whole
 * of the leash a loop carries unless a person writes it one. That is what makes
 * `--rules` the other half of this verb rather than a nicety: everything a run
 * should respect beyond the count is opted into, never imposed.
 *
 * Like `point`, every case ends by proving the directive still parses: a loop
 * whose file the reader turns away does not run at all.
 */
describe('`loop describe` — what a loop is told', () => {
  const DESCRIBED = `---
loop: fix
engine: consumer
paused: true    # 2026-08-14: waiting on the release
mission: Drain the queue one item at a time
queue: github
repo: acme/widgets
---

## Direction

Take the oldest item that is ready and finish it.

## Rules

Reproduce before you close.
`;

  const directiveAt = (target: string, loop: string): string =>
    join(target, 'flow', LOOPS_DIRNAME, `${loop}.md`);

  const reread = (target: string, loop: string) =>
    parseLoopDirective(readFileSync(directiveAt(target, loop), 'utf-8'), `${loop}.md`);

  it(
    'is registered on the real CLI, answers with JSON, exit 0',
    () => {
      const target = makeProject({ fix: DESCRIBED });
      const result = cli(['describe', '--loop', 'fix', '--max-open', '12', '--target', target]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toMatchObject({
        status: 'described',
        loop: 'fix',
        changed: ['cap'],
        cap: 12,
      });
      expect(reread(target, 'fix').maxOpenIssues).toBe(12);
    },
    E2E_TIMEOUT_MS,
  );

  it('refuses without --loop, and when it was given nothing to say', async () => {
    const target = makeProject({ fix: DESCRIBED });
    const nameless = await invoke('describe', { target, direction: 'x' });
    expect(nameless.exitCode).toBe(1);
    expect(nameless.refusals[0]).toContain('describe requires --loop <name>');

    // A describe naming no field is a caller that forgot its arguments.
    // Answering it "changed nothing" would read as the loop already saying
    // something nobody asked about.
    const silent = await invoke('describe', { target, loop: 'fix' });
    expect(silent.exitCode).toBe(1);
    expect(silent.refusals[0]).toContain('--direction <text>, --rules <text> or --max-open <n>');
    expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).toBe(DESCRIBED);
  });

  it('writes both prose sections at once and leaves the frontmatter alone', async () => {
    const target = makeProject({ fix: DESCRIBED });
    const result = await invoke('describe', {
      target,
      loop: 'fix',
      direction: 'Start with the loops panel.',
      rules: 'One finding per item.',
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ changed: ['direction', 'rules'], cap: null });

    const directive = reread(target, 'fix');
    expect(directive.direction).toBe('Start with the loops panel.');
    expect(directive.rules).toBe('One finding per item.');
    // The fields the verb was not asked about, including the comment on `paused`.
    expect(directive.queue).toBe('github');
    expect(directive.paused).toBe(true);
    expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).toContain('waiting on the release');
  });

  // EMPTY IS A STATE. "This loop has no rules of its own" is a thing a person
  // means, and a heading with nothing under it reads as one they abandoned.
  it('clearing a section removes it, and the directive still parses', async () => {
    const target = makeProject({ fix: DESCRIBED });
    const result = await invoke('describe', { target, loop: 'fix', rules: '' });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).not.toContain('## Rules');
    expect(reread(target, 'fix').rules).toBe('');
    expect(reread(target, 'fix').direction).toBe('Take the oldest item that is ready and finish it.');
  });

  it('refuses a cap that is not a positive whole number, writing nothing', async () => {
    const target = makeProject({ fix: DESCRIBED });
    for (const bad of ['0', '-3', '2.5', 'lots']) {
      const result = await invoke('describe', { target, loop: 'fix', maxOpen: bad });
      expect(result.exitCode).toBe(1);
      expect(result.refusals[0]).toContain('--max-open must be a positive whole number');
      expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).toBe(DESCRIBED);
    }
  });

  it('saying what the file already says is a success that wrote nothing', async () => {
    const target = makeProject({ fix: DESCRIBED });
    const result = await invoke('describe', {
      target,
      loop: 'fix',
      direction: 'Take the oldest item that is ready and finish it.',
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ changed: [] });
    expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).toBe(DESCRIBED);
    // A no-op must not read as a failure — this is the ordinary outcome of a
    // panel re-saving a field nobody edited.
    expect(renderHuman('describe', result.json)).toContain('no change');
  });

  it("renders the human line in point's shape — what, to which loop, in which file", async () => {
    const target = makeProject({ fix: DESCRIBED });
    const result = await invoke('describe', { target, loop: 'fix', maxOpen: '15', rules: 'Ship small.' });
    expect(renderHuman('describe', result.json)).toBe(
      `described: fix — cap, rules (max_open_issues: 15) (${directiveAt(target, 'fix')})`,
    );
  });

  /**
   * PROSE OVER STDIN, for the reason `--body -` exists (#1865).
   *
   * cmd.exe's `/c` parser cuts a literal multi-line argument at its first
   * newline before the `.cmd` shim's own script runs, so a Windows agent
   * setting a Direction would have written line one and reported success.
   * `## Direction` is multi-line by nature — a seeded directive's is fifteen
   * lines — which makes this flag the worst place in the family to lose the
   * rest of a value silently.
   */
  it('reads a multi-line direction from stdin when it is given as -', async () => {
    const target = makeProject({ fix: DESCRIBED });
    const direction = [
      'Three kinds of finding:',
      '',
      '1. A bug you made happen.',
      '2. A gap between the docs and the code.',
      '3. A cleanup target.',
    ].join('\n');

    const fakeStdin = {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<string> {
        yield direction;
      },
    };
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    try {
      const result = await invoke('describe', { target, loop: 'fix', direction: '-' });
      expect(result.exitCode).toBe(0);
      // EVERY line, and the re-parse's own reading of them — not the string
      // this test handed in.
      expect(reread(target, 'fix').direction).toBe(direction);
      // The box it was not asked about is untouched, sentinel or not.
      expect(reread(target, 'fix').rules).toBe('Reproduce before you close.');
    } finally {
      if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
    }
  });

  // ONE PAYLOAD, ONE STDIN. Serving the same bytes to both fields would write
  // a person's direction into their rules and call it a success.
  it('refuses to read both prose fields from stdin, writing nothing', async () => {
    const target = makeProject({ fix: DESCRIBED });
    const result = await invoke('describe', { target, loop: 'fix', direction: '-', rules: '-' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain("only one of --direction or --rules may be '-'");
    expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).toBe(DESCRIBED);
  });

  it('refuses a malformed directive and an absent loop, writing nothing', async () => {
    const broken = ['---', 'loop: fix', 'engine: consumer', 'mission: m', 'quee: ledger', '---', ''].join('\n');
    const target = makeProject({ fix: broken });
    const result = await invoke('describe', { target, loop: 'fix', rules: 'x' });
    expect(result.exitCode).toBe(1);
    expect(readFileSync(directiveAt(target, 'fix'), 'utf-8')).toBe(broken);

    const ghost = await invoke('describe', { target, loop: 'ghost', rules: 'x' });
    expect(ghost.exitCode).toBe(1);
    expect(ghost.refusals[0]).toContain("no directive for loop 'ghost'");
  });
});


describe('the stop condition is the run\'s own word', () => {
  /**
   * PHASE 6 TOOK THE ARBITER AWAY, NOT THE WORD. This describe used to prove
   * the opposite of its first test below: `budget` was the one condition the
   * CLI could check, because it owned the run budget and could measure the
   * elapsed time against it. The budget is deleted — a run is a Claude Code
   * session and that session's end is the end — so nothing here can measure
   * anything, and every word of the closed vocabulary is now accepted as the
   * run's own report about its own session. What survives is the vocabulary
   * being CLOSED, which is what keeps "why did runs stop" countable.
   */
  it('accepts `budget`, which nothing here can prove any more', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const gate = await invoke('next', { target, loop: 'find' });
    const owner = String((gate.json as Record<string, unknown>).owner);

    const recorded = await invoke('log', {
      target,
      loop: 'find',
      owner,
      record: JSON.stringify({
        kind: 'run',
        loop: 'find',
        outcome: 'success',
        stopCondition: 'budget',
      }),
    });

    expect(recorded.exitCode).toBe(0);
    expect((recorded.json as { entry: { stopCondition?: string } }).entry.stopCondition).toBe(
      'budget',
    );
  });

  it('still accepts the conditions it cannot check', async () => {
    // `empty` and `cap` are facts about a queue this seam does not read, and
    // `none` claims nothing — refusing them would be inventing a verdict.
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const gate = await invoke('next', { target, loop: 'find' });
    const owner = String((gate.json as Record<string, unknown>).owner);

    const recorded = await invoke('log', {
      target,
      loop: 'find',
      owner,
      record: JSON.stringify({
        kind: 'run',
        loop: 'find',
        outcome: 'success',
        stopCondition: 'empty',
      }),
    });
    expect(recorded.exitCode).toBe(0);
  });
});

describe('a real limit names the continuation — the drain is not the run (#14)', () => {
  it('a consumer `cap` ending with claimables carries "open a fresh gate and continue"', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE, fix: CONSUMER_DIRECTIVE });
    await file(target, 'find', 'a real bug');
    const gate = await invoke('next', { target, loop: 'fix', owner: 'run-A' });
    expect(gate.json).toMatchObject({ verdict: 'proceed' });

    const recorded = await invoke('log', {
      target,
      loop: 'fix',
      owner: 'run-A',
      record: JSON.stringify({ kind: 'run', loop: 'fix', outcome: 'success', stopCondition: 'cap' }),
    });
    expect(recorded.exitCode).toBe(0);
    const continuation = String((recorded.json as Record<string, unknown>).continuation ?? '');
    expect(continuation).toContain('still claimable');
    expect(continuation).toContain('open a fresh gate');
  });

  it('says nothing when the queue is drained, and nothing for a producer', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE, fix: CONSUMER_DIRECTIVE });
    const gate = await invoke('next', { target, loop: 'fix', owner: 'run-A' });
    expect(gate.json).toMatchObject({ verdict: 'skip' });

    const drained = await invoke('log', {
      target,
      loop: 'fix',
      owner: 'run-A',
      record: JSON.stringify({ kind: 'run', loop: 'fix', outcome: 'success', stopCondition: 'cap' }),
    });
    expect((drained.json as Record<string, unknown>).continuation).toBeUndefined();

    await file(target, 'find', 'a real bug');
    const producerGate = await invoke('next', { target, loop: 'find', owner: 'run-B' });
    expect(producerGate.json).toMatchObject({ verdict: 'proceed' });
    const producer = await invoke('log', {
      target,
      loop: 'find',
      owner: 'run-B',
      record: JSON.stringify({ kind: 'run', loop: 'find', outcome: 'success', stopCondition: 'cap' }),
    });
    expect((producer.json as Record<string, unknown>).continuation).toBeUndefined();
  });
});

describe('Task 3.6 — `loop status` and `loop log`', () => {
  it('records one structured line per beat, folding the outcome into the state store', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await invoke('next', { target, loop: 'find', owner: 'beat-1' });

    const recorded = await invoke('log', {
      target,
      record: JSON.stringify({
        loop: 'find',
        owner: 'beat-1',
        outcome: 'success',
        verdict: 'proceed',
        filed: 2,
        closed: 0,
        durationMs: 1234,
      }),
    });

    expect(recorded.exitCode).toBe(0);
    expect(recorded.json).toMatchObject({ status: 'recorded' });
    expect((recorded.json as { entry: Record<string, unknown> }).entry).toMatchObject({
      // `run` is the kind a finished turn records now. `beat` is the same fact
      // under its old name and is still accepted — every line already in a
      // project's log says `beat`, and a reader that stopped recognising them
      // would report that the loops had never run.
      kind: 'run',
      loop: 'find',
      outcome: 'success',
      filed: 2,
      ts: new Date(NOW).toISOString(),
    });

    // HOW THE LAST RUN ENDED, kept as history. The consecutive-failure counter
    // this used to feed went with the breaker in Phase 6: nothing schedules
    // unattended re-runs, so counting failures protects nobody, and a counter
    // that trips nothing still has to be reset, explained and kept true.
    const state = readLoopState(join(target, 'flow'), NOW);
    expect(state.loops.find.lastOutcome).toBe('success');
    // the beat is over, so its slot went back
    expect(state.loops.find.locks).toBeUndefined();
  });

  it('refuses a beat record with no outcome, and an unknown kind', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const noOutcome = await invoke('log', {
      target,
      record: JSON.stringify({ loop: 'find' }),
    });
    expect(noOutcome.exitCode).toBe(1);
    expect(noOutcome.refusals[0]).toContain("outcome of 'success' or 'failure'");

    const badKind = await invoke('log', {
      target,
      record: JSON.stringify({ loop: 'find', kind: 'shrug', outcome: 'success' }),
    });
    expect(badKind.exitCode).toBe(1);
    expect(badKind.refusals[0]).toContain("unknown record kind 'shrug'");

    const badJson = await invoke('log', { target, record: '{oops' });
    expect(badJson.exitCode).toBe(1);
    expect(badJson.refusals[0]).toContain('malformed record JSON');
  });

  /**
   * THE RENAME MUST NOT SEVER THE AUDIT TRAIL (#1576).
   *
   * `readRunLog` picked ONE file — legacy only while `runs.jsonl` was absent —
   * so the first post-rename write made every pre-rename line unreachable. This
   * repo lost its 2026-08-12 global pause that way and then printed a resume
   * with no pause before it. The two files are disjoint (nothing ever copied
   * one into the other), so the whole history is both of them.
   */
  it('keeps pre-rename lines after a post-rename run is recorded', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE, fix: CONSUMER_DIRECTIVE });
    seedRuns(target, [
      { ts: '2026-08-12T13:45:36.316Z', kind: 'pause', loop: '', reason: 'armed, awaiting go-ahead' },
      { ts: '2026-08-12T14:00:00.000Z', kind: 'beat', loop: 'find', outcome: 'success', filed: 2 },
    ]);

    // The write that used to orphan the legacy file.
    await invoke('log', {
      target,
      record: JSON.stringify({ loop: 'fix', outcome: 'success', closed: 1 }),
    });

    const all = await invoke('log', { target });
    expect(all.exitCode).toBe(0);
    const entries = (all.json as { entries: { kind: string; reason: string }[] }).entries;
    expect(entries.map((entry) => entry.kind)).toEqual(['pause', 'beat', 'run']);
    expect(entries[0].reason).toBe('armed, awaiting go-ahead');
    // Legacy lines are COUNTED too — the digest is the same claim, rolled up.
    // The pre-rename run counts beside the post-rename one; the pause is not a
    // run and never counted as one, before the rename or after it.
    expect((all.json as { digest: Record<string, number> }).digest).toMatchObject({
      beats: 2,
      filed: 2,
    });
  });

  it('reads back the window and the rolled-up digest', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE, fix: CONSUMER_DIRECTIVE });
    await invoke('log', {
      target,
      record: JSON.stringify({ loop: 'find', outcome: 'success', filed: 3 }),
    });
    await invoke('log', {
      target,
      record: JSON.stringify({ loop: 'fix', outcome: 'success', closed: 1 }),
    });
    await invoke('log', {
      target,
      record: JSON.stringify({ loop: 'fix', outcome: 'failure' }),
    });

    const all = await invoke('log', { target });
    expect(all.exitCode).toBe(0);
    expect((all.json as { entries: unknown[] }).entries).toHaveLength(3);
    expect((all.json as { digest: Record<string, number> }).digest).toMatchObject({
      beats: 3,
      success: 2,
      failure: 1,
      filed: 3,
      closed: 1,
    });

    const scoped = await invoke('log', { target, loop: 'fix' });
    expect((scoped.json as { entries: unknown[] }).entries).toHaveLength(2);
    expect((scoped.json as { digest: Record<string, number> }).digest.beats).toBe(2);

    const windowed = await invoke('log', { target, limit: '1' });
    expect((windowed.json as { entries: unknown[] }).entries).toHaveLength(1);
    // the digest still covers everything, not just the returned window
    expect((windowed.json as { digest: Record<string, number> }).digest.beats).toBe(3);

    const badLimit = await invoke('log', { target, limit: 'lots' });
    expect(badLimit.exitCode).toBe(1);
    expect(badLimit.refusals[0]).toContain('malformed --limit');
  });

  it('digests are a pure fold — the same entries always roll up the same way', () => {
    const entries = readRunLog(join(makeProject(), 'flow'));
    expect(digestRunLog(entries)).toEqual(digestRunLog(entries));
    expect(digestRunLog([]).beats).toBe(0);
  });

  it('reports every loop, its mission, its queue and the digest', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE, fix: CONSUMER_DIRECTIVE });
    await file(target, 'find', 'something to fix');
    await invoke('log', {
      target,
      record: JSON.stringify({ loop: 'find', outcome: 'success', filed: 1 }),
    });

    const result = await invoke('status', { target });
    expect(result.exitCode).toBe(0);
    const rows = (result.json as { loops: Array<Record<string, unknown>> }).loops;
    expect(rows.map((row) => row.loop)).toEqual(['find', 'fix']);

    const find = rows[0] as {
      mission: string;
      engine: string;
      queue: { open: number; maxOpenIssues: number; capReached: boolean };
      lastOutcome: string;
    };
    expect(find.mission).toBe('Hunt for real bugs in the source tree');
    expect(find.engine).toBe('producer');
    expect(find.queue).toMatchObject({ open: 1, maxOpenIssues: 2, capReached: false });
    // No `breaker` field: Phase 6 deleted it from the row along with the
    // counter behind it. `lastOutcome` is what a person reads instead.
    expect(find).not.toHaveProperty('breaker');
    expect(find.lastOutcome).toBe('success');
    expect((result.json as { digest: { beats: number } }).digest.beats).toBe(1);
  });

  it('names the gated items, not just how many — a count cannot be approved', async () => {
    const target = makeProject({ gated: GATED_DIRECTIVE });
    await file(target, 'gated', 'first gated finding');
    await file(target, 'gated', 'second gated finding');

    const result = await invoke('status', { target });
    expect(result.exitCode).toBe(0);
    const row = (result.json as { loops: Array<Record<string, unknown>> }).loops[0];
    expect((row.queue as { awaitingApproval: number }).awaitingApproval).toBe(2);
    const ids = row.awaitingApprovalIds as string[];
    expect(ids).toHaveLength(2);

    // The ids are real: approving one clears exactly one from the next report.
    await invoke('approve', { target, loop: 'gated', id: ids[0] });
    const after = await invoke('status', { target });
    const afterRow = (after.json as { loops: Array<Record<string, unknown>> }).loops[0];
    expect((afterRow.queue as { awaitingApproval: number }).awaitingApproval).toBe(1);
    expect(afterRow.awaitingApprovalIds).toEqual([ids[1]]);
  });

  it('distinguishes "nothing is gated" from "nobody could read the queue"', async () => {
    // A readable queue with no gated item yields an EMPTY list — actionable.
    const open = makeProject({ find: PRODUCER_DIRECTIVE });
    await file(open, 'find', 'an ungated finding');
    const openRow = ((await invoke('status', { target: open })).json as {
      loops: Array<Record<string, unknown>>;
    }).loops[0];
    expect(openRow.awaitingApprovalIds).toEqual([]);

    // A row whose directive never parsed has no queue and therefore no list.
    // Absent must never read as "nothing is gated".
    const broken = makeProject({ find: PRODUCER_DIRECTIVE });
    writeFileSync(join(broken, 'flow', 'loops', 'bad.md'), '---\nloop: bad\n---\n', 'utf-8');
    const brokenRow = ((await invoke('status', { target: broken })).json as {
      loops: Array<Record<string, unknown>>;
    }).loops[0];
    expect(brokenRow.directiveError).toBeTruthy();
    expect(brokenRow.queue).toBeNull();
    expect(brokenRow.awaitingApprovalIds).toBeUndefined();
  });

  it('an unreadable directive is a row that says so, never a refusal that blanks the report', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    writeFileSync(join(target, 'flow', 'loops', 'broken.md'), '---\nloop: broken\n---\n', 'utf-8');

    const result = await invoke('status', { target });
    expect(result.exitCode).toBe(0);
    const rows = (result.json as { loops: Array<Record<string, unknown>> }).loops;
    expect(rows.map((row) => row.loop)).toEqual(['broken', 'find']);
    expect(String(rows[0].directiveError)).toContain("missing 'engine'");
    expect(rows[1].mission).toBe('Hunt for real bugs in the source tree');
  });

  it('surfaces a global pause and scopes to one loop on request', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE, fix: CONSUMER_DIRECTIVE });
    await invoke('pause', { target, reason: 'all hands' });

    const all = await invoke('status', { target });
    expect((all.json as { globalPause: { reason: string } }).globalPause.reason).toBe('all hands');

    const scoped = await invoke('status', { target, loop: 'fix' });
    expect((scoped.json as { loops: unknown[] }).loops).toHaveLength(1);
  });

  it('--human renders the SAME result object, never a second computation', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await file(target, 'find', 'a finding');

    const json = await invoke('status', { target });
    const human = await invoke('status', { target, human: true });

    expect(human.stdout).toBe(`${renderHuman('status', json.json)}\n`);
    expect(human.stdout).toContain('find [producer]');
    expect(human.stdout).toContain('digest:');
  });

  it('reports the topic the directive points the loop at, and absent when it points at none', async () => {
    // One field, read by every surface: the bracket below and the IDE panel
    // both take the topic from HERE rather than opening the directive again.
    const target = makeProject({ sweep: TOPICAL_DIRECTIVE, fix: CONSUMER_DIRECTIVE });

    const rows = ((await invoke('status', { target })).json as {
      loops: Array<Record<string, unknown>>;
    }).loops;
    const byLoop = new Map(rows.map((row) => [row.loop as string, row]));
    expect(byLoop.get('sweep')?.topic).toBe('codemap');
    // ABSENT, not empty: a loop with no topic is not working "on nothing in
    // particular", it simply never said.
    expect(byLoop.get('fix')).not.toHaveProperty('topic');
  });

  it('puts the topic in the bracket, and falls back to the engine without one', async () => {
    // The engine never changes for the life of a directive; the topic changes
    // with every steering commit, and is the reason anyone reads this line.
    const target = makeProject({ sweep: TOPICAL_DIRECTIVE, find: PRODUCER_DIRECTIVE });
    const json = await invoke('status', { target });
    const human = await invoke('status', { target, human: true });

    expect(human.stdout).toBe(`${renderHuman('status', json.json)}\n`);
    expect(human.stdout).toContain('sweep [codemap]');
    expect(human.stdout).not.toContain('sweep [producer]');
    // Unchanged for a directive that does not use the feature.
    expect(human.stdout).toContain('find [producer]');
  });
});

describe('Task 2.2 — `loop status` reports the hunt', () => {
  /** The rows of a `loop status` result, by loop name. */
  function statusRows(result: Invocation): Map<string, Record<string, unknown>> {
    const rows = (result.json as { loops: Array<Record<string, unknown>> }).loops;
    return new Map(rows.map((row) => [row.loop as string, row]));
  }

  /** The store as its own reader answers it — the row's only source of truth. */
  function storedInstructions(target: string): unknown {
    // Round-tripped through JSON because that is what a caller receives: an
    // absent optional field is absent, not `undefined`.
    return JSON.parse(JSON.stringify(readInstructions(join(target, 'flow')).instructions));
  }

  it('finishes a hunt — stopped, still counted, still reported', async () => {
    // THE THIRD THING YOU CAN DO WITH A HUNT: carry on, erase, or say it is
    // done. Only the last leaves a record, which is what lets a board draw a
    // finished hunt in Done instead of dropping it off the screen.
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const flowDir = join(target, 'flow');
    let store = startInstruction(emptyInstructions(), 'tenant id drift', '2026-08-17T10:00:00.000Z').store;
    store = startInstruction(store, 'flaky tests', '2026-08-17T10:00:00.000Z').store;
    writeInstructions(flowDir, store);

    const result = await invoke('finish', { target, loop: 'find', focus: ' Tenant ID Drift ' });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      status: 'finished',
      loop: 'find',
      text: 'tenant id drift',
      // What is LEFT running — the question the next press asks.
      remaining: 1,
    });
    expect(storedInstructions(target)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: 'tenant id drift', status: 'stopped' }),
        expect.objectContaining({ text: 'flaky tests', status: 'active' }),
      ]),
    );
  });

  it('says when a loop has nothing left running', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    writeInstructions(
      join(target, 'flow'),
      startInstruction(emptyInstructions(), 'only hunt', '2026-08-17T10:00:00.000Z').store,
    );
    const result = await invoke('finish', { target, loop: 'find', focus: 'only hunt' });
    expect(result.json).toMatchObject({ remaining: 0 });
    expect(renderHuman('finish', result.json)).toContain('nothing left running');
  });

  it('refuses a hunt that is not there, and one it was not given', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const missing = await invoke('finish', { target, loop: 'find', focus: 'never typed' });
    expect(missing.exitCode).toBe(1);
    expect(missing.refusals[0]).toContain('nothing to finish');

    const unnamed = await invoke('finish', { target, loop: 'find' });
    expect(unnamed.exitCode).toBe(1);
    expect(unnamed.refusals[0]).toContain('--focus');
  });

  it('forgets one hunt, leaving the others and the runtime state alone', async () => {
    // THE GAP THIS VERB FILLS. `resume --focus` restarts a hunt at zero and
    // nothing ended one, so a person clearing a loop out found its hunts still
    // on the board reading `filed 0/20` — restarted, not finished.
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const flowDir = join(target, 'flow');
    let store = startInstruction(emptyInstructions(), 'tenant id drift', '2026-08-17T10:00:00.000Z').store;
    store = startInstruction(store, 'flaky tests', '2026-08-17T10:00:00.000Z').store;
    writeInstructions(flowDir, store);

    const result = await invoke('forget', { target, loop: 'find', focus: '  Tenant ID Drift ' });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'forgotten', loop: 'find', remaining: 1 });
    expect((result.json as { forgot: string[] }).forgot).toEqual(['tenant id drift']);
    // The sentence is matched the way every other verb matches one — spacing
    // and case — and the hunt is GONE rather than marked.
    expect(storedInstructions(target)).toEqual([
      expect.objectContaining({ text: 'flaky tests', status: 'active' }),
    ]);
  });

  it('forgets every hunt with --all, and refuses to guess without one', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const flowDir = join(target, 'flow');
    let store = startInstruction(emptyInstructions(), 'tenant id drift', '2026-08-17T10:00:00.000Z').store;
    store = startInstruction(store, 'flaky tests', '2026-08-17T10:00:00.000Z').store;
    writeInstructions(flowDir, store);

    // A bare forget is two readings — "nothing" and "everything" — and one of
    // them cannot be taken back. It refuses instead of picking.
    const guessed = await invoke('forget', { target, loop: 'find' });
    expect(guessed.exitCode).toBe(1);
    expect(guessed.refusals[0]).toContain('--focus');
    expect(storedInstructions(target)).toHaveLength(2);

    const all = await invoke('forget', { target, loop: 'find', all: true });
    expect(all.exitCode).toBe(0);
    expect((all.json as { forgot: string[] }).forgot.sort()).toEqual(['flaky tests', 'tenant id drift']);
    expect(storedInstructions(target)).toEqual([]);
  });

  it('forgetting nothing is a success that says so', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const result = await invoke('forget', { target, loop: 'find', focus: 'never typed' });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ forgot: [], remaining: 0 });
    expect(renderHuman('forget', result.json)).toContain('forgot nothing');
  });

  it('refuses for a loop with no directive, writing nothing', async () => {
    const target = makeProject();
    const result = await invoke('forget', { target, loop: 'ghost', all: true });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain("no directive for loop 'ghost'");
  });

  it('refuses an unreadable store instead of clobbering it (#1704)', async () => {
    // Fail-soft read + unconditional write REPLACED a corrupt store with an
    // empty one while reporting "forgot nothing" — the recoverable hunt was
    // gone. The verb must answer "which hunts to end" from the store, and an
    // unreadable file has not answered, so it refuses the way `loop status`
    // reports `instructionsError` instead of "0 hunts".
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const corrupt = '{"version":1,"instructions":[{"text":"find dead code","filed":7,"cap":20,"status":"acti';
    const storePath = instructionsPath(join(target, 'flow'));
    writeFileSync(storePath, corrupt);

    const result = await invoke('forget', { target, loop: 'find', focus: 'some other hunt' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('unreadable');
    expect(result.refusals[0]).toContain('nothing was written');
    // The file survives byte-for-byte — the hunt is still recoverable by hand.
    expect(readFileSync(storePath, 'utf-8')).toBe(corrupt);
  });

  it('resume --focus refuses an unreadable store instead of clobbering it (#1722)', async () => {
    // The same loss #1704 fixed for `forget`, one verb over: fail-soft read →
    // stop (no-op on empty) → start → write replaced an unreadable store with
    // one holding only the resumed hunt. The refusal also keeps the verb
    // atomic — the pause must still stand when the focus half cannot happen.
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const flowDir = join(target, 'flow');
    const corrupt = '{"version":1,"instructions":[{"text":"find dead code","filed":7,"cap":20,"status":"acti';
    const storePath = instructionsPath(flowDir);
    writeFileSync(storePath, corrupt);
    await invoke('pause', { target, loop: 'find', reason: 'noisy findings' });

    const result = await invoke('resume', { target, loop: 'find', focus: 'some other hunt' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('unreadable');
    expect(result.refusals[0]).toContain('nothing was written');
    expect(readFileSync(storePath, 'utf-8')).toBe(corrupt);
    expect(readLoopState(flowDir, NOW).loops.find.pause?.reason).toBe('noisy findings');

    // A resume WITHOUT a focus never touches the store, so it still works.
    const plain = await invoke('resume', { target, loop: 'find', reason: 'looked at it' });
    expect(plain.exitCode).toBe(0);
    expect(readLoopState(flowDir, NOW).loops.find.pause).toBeUndefined();
    expect(readFileSync(storePath, 'utf-8')).toBe(corrupt);
  });

  it('reports a typed instruction verbatim — the text, the count and the cap', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });

    // The hunt is started through the VERB that starts one, not by writing the
    // store: what is under test is that status reports what `loop next` wrote.
    const gate = await invoke('next', {
      target,
      loop: 'find',
      focus: 'find gaps in the widget parser',
      cap: '3',
    });
    expect((gate.json as { verdict: string }).verdict).toBe('proceed');
    const owner = String((gate.json as { owner: string }).owner);
    await file(target, 'find', 'the widget parser drops the last field', { owner });

    const row = statusRows(await invoke('status', { target })).get('find');
    // NOT a hand-built expectation: the assertion is that status added, dropped
    // and derived nothing between the store and stdout.
    expect(row?.instructions).toEqual(storedInstructions(target));
    expect(row?.instructions).toEqual([
      expect.objectContaining({
        text: 'find gaps in the widget parser',
        filed: 1,
        cap: 3,
        status: 'active',
      }),
    ]);
    // No percentage, no "remaining", no status the store did not hold.
    expect(Object.keys((row?.instructions as Record<string, unknown>[])[0]).sort()).toEqual(
      ['cap', 'filed', 'quietRuns', 'since', 'status', 'text'],
    );
    expect(row?.instructionsError).toBeUndefined();
  });

  it('reports two hunts as two, in the order the store holds them', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const flowDir = join(target, 'flow');
    let store = startInstruction(emptyInstructions(), 'find dead codemap entries', NOW_ISO).store;
    store = startInstruction(store, 'find untested error paths', NOW_ISO, 5).store;
    writeInstructions(flowDir, store);

    const row = statusRows(await invoke('status', { target })).get('find');
    expect(row?.instructions).toEqual(storedInstructions(target));
    expect((row?.instructions as { text: string }[]).map((entry) => entry.text)).toEqual([
      'find dead codemap entries',
      'find untested error paths',
    ]);
  });

  it('distinguishes "hunting nothing" from "nobody could read the store"', async () => {
    // EMPTY is an answer: a producer that was simply started hunts nothing, and
    // a consumer cannot hunt at all — `loop next` writes the store only for a
    // producer, so `[]` on a consumer row is a fact and not a filter.
    const quiet = makeProject({ find: PRODUCER_DIRECTIVE, fix: CONSUMER_DIRECTIVE });
    const quietRows = statusRows(await invoke('status', { target: quiet }));
    expect(quietRows.get('find')?.instructions).toEqual([]);
    expect(quietRows.get('fix')?.instructions).toEqual([]);

    // ABSENT is the other answer: a store nobody could parse has not said the
    // producer stopped hunting, it has said nothing.
    const broken = makeProject({ find: PRODUCER_DIRECTIVE, fix: CONSUMER_DIRECTIVE });
    await file(broken, 'find', 'a finding that must survive the corrupt store');
    writeFileSync(instructionsPath(join(broken, 'flow')), '{ not json at all', 'utf-8');

    const brokenStatus = await invoke('status', { target: broken });
    expect(brokenStatus.exitCode).toBe(0);
    const brokenRows = statusRows(brokenStatus);
    expect(brokenRows.get('find')).not.toHaveProperty('instructions');
    expect(String(brokenRows.get('find')?.instructionsError)).toContain('JSON');
    // FAIL-SOFT: the unreadable store costs the hunt and nothing else — the
    // queue counts and the other loop's row all still report.
    expect(brokenRows.get('find')?.queue).toMatchObject({ open: 1 });
    expect(brokenRows.get('fix')).not.toHaveProperty('instructions');
    expect(brokenRows.get('fix')?.queueKind).toBe('ledger');
  });

  it('an unreadable directive reports no hunt and no store — never an empty one', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    writeFileSync(join(target, 'flow', 'loops', 'bad.md'), '---\nloop: bad\n---\n', 'utf-8');
    writeInstructions(
      join(target, 'flow'),
      startInstruction(emptyInstructions(), 'find gaps', NOW_ISO).store,
    );

    const row = statusRows(await invoke('status', { target })).get('bad');
    expect(row?.directiveError).toBeTruthy();
    // Whether a loop hunts at all is the ENGINE's answer, and no directive
    // parsed — so the row says nothing rather than guessing either way.
    expect(row).not.toHaveProperty('instructions');
    expect(row).not.toHaveProperty('instructionsError');
  });
});

describe('Task 2.3 — every loop names the store its work lives in', () => {
  /** The rows of a `loop status` result, by loop name. */
  function statusRows(result: Invocation): Map<string, Record<string, unknown>> {
    const rows = (result.json as { loops: Array<Record<string, unknown>> }).loops;
    return new Map(rows.map((row) => [row.loop as string, row]));
  }

  // The GitHub half of this lives in `loop-list.test.ts`, where `gh` is a
  // module mock (allowed-pattern #12) — a status row for a GitHub queue would
  // otherwise shell out to whatever `gh` happens to be on the machine.
  it('reports the kind and the location for every readable ledger loop', async () => {
    // The board reads the truth source from these two fields rather than
    // parsing the directive a second time, so "every loop" is the requirement:
    // a row without them would leave a column with no store to read.
    const target = makeProject({ find: PRODUCER_DIRECTIVE, gap: LEDGER_CONSUMER_DIRECTIVE });
    const rows = statusRows(await invoke('status', { target }));
    expect([...rows.keys()]).toEqual(['find', 'gap']);
    expect(rows.get('find')).toMatchObject({
      queueKind: 'ledger',
      queueLocation: 'flow/loops/queue.jsonl',
    });
    expect(rows.get('gap')).toMatchObject({
      queueKind: 'ledger',
      queueLocation: 'flow/loops/queue.jsonl',
    });
  });

  it('names neither when the directive itself could not be read', async () => {
    // The honest answer: nothing on disk said which store this loop uses. A
    // guessed kind would be worse than an absent one.
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    writeFileSync(join(target, 'flow', 'loops', 'bad.md'), '---\nloop: bad\n---\n', 'utf-8');
    const row = statusRows(await invoke('status', { target })).get('bad');
    expect(row?.directiveError).toBeTruthy();
    expect(row).not.toHaveProperty('queueKind');
    expect(row).not.toHaveProperty('queueLocation');
  });
});

describe('the state store is only ever written through the verbs', () => {
  it('a gated beat writes no state file at all', async () => {
    const target = makeProject({ parked: PAUSED_DIRECTIVE });
    await invoke('next', { target, loop: 'parked', owner: 'beat-1' });
    expect(existsSync(join(target, 'flow', 'loops', 'state.json'))).toBe(false);
  });
});

// ── Phase 5: one beat, one stage ─────────────────────────
//
// The fixtures below seed a REAL in-flight pipeline the way the project itself
// leaves one behind: a `flow/STATE.md`, a compiled `<plan>.run.json`, and
// `phase_result` lines in `flow/.rounds.jsonl`. Nothing writes a "current
// stage" field anywhere — the whole point is that the stage is derived from
// those three, so a test that seeded a stored stage would be testing nothing.

const DRAIN_DIRECTIVE = `---
loop: drain
engine: consumer
mission: A second consumer, so the pipeline lock has something to exclude
queue: ledger
---
`;

const PLAN_HASH = 'a'.repeat(64);

/** A compiled run artifact: 4 phases in 3 waves. */
function runArtifact(plan: string): string {
  return JSON.stringify({
    version: 1,
    plan,
    planHash: PLAN_HASH,
    phases: [1, 2, 3, 4].map((number) => ({
      number,
      name: `Phase ${number}`,
      complexity: 5,
      dependencies: [],
      model: 'sonnet',
      skip: false,
      tasks: [],
    })),
    waves: [
      { wave_number: 1, phase_numbers: [1, 2] },
      { wave_number: 2, phase_numbers: [3] },
      { wave_number: 3, phase_numbers: [4] },
    ],
    routing: [],
    commitStrategy: 'per-task',
    overrides: {},
    diagnostics: [],
  });
}

/** Seed an in-flight pipeline for `plan`, with `done` phases already recorded. */
function seedPipeline(target: string, plan: string, done: number[] = []): void {
  const flowDir = join(target, 'flow');
  mkdirSync(join(flowDir, 'plans'), { recursive: true });
  // THE HANDOFF RIDES THE CLAIM (#1599, applied fully): a pipeline exists
  // because an OPEN ITEM records the plan — `STATE.md` alone no longer names
  // one (it is the interactive session's mirror, and reading it fabricated
  // pipelines out of a human's unrelated work). The STATE.md below stays in
  // the seed only to prove it neither adds nor overrides anything.
  mkdirSync(join(flowDir, 'loops'), { recursive: true });
  appendFileSync(
    join(flowDir, 'loops', 'queue.jsonl'),
    [
      JSON.stringify({
        ts: '2026-08-12T07:00:00.000Z',
        id: '9001',
        event: 'filed',
        loop: 'fix',
        provenance: 'test',
        title: `pipeline carrier for ${plan}`,
        fingerprint: `fp-pipeline-${plan}`,
      }),
      JSON.stringify({
        ts: '2026-08-12T07:00:01.000Z',
        id: '9001',
        event: 'planned',
        loop: 'fix',
        provenance: 'test',
        plan,
      }),
      // Claimed and FRESH (five minutes before NOW, inside every TTL here):
      // mid-pipeline the item stays claimed by the run driving it, so the
      // carrier must not read as claimable work for whichever run a test
      // sends into the queue next.
      JSON.stringify({
        ts: '2026-08-12T08:55:00.000Z',
        id: '9001',
        event: 'claimed',
        loop: 'fix',
        provenance: 'test',
        owner: 'run-pipeline-carrier',
      }),
    ].join('\n') + '\n',
    'utf-8',
  );
  writeFileSync(
    join(flowDir, 'STATE.md'),
    ['## Execution State', '', '- **Active Skill**: execute-plan', `- **Active Plan**: plan_${plan}_v1`, ''].join('\n'),
    'utf-8',
  );
  writeFileSync(join(flowDir, 'plans', `plan_${plan}_v1.md`), '# plan\n', 'utf-8');
  writeFileSync(join(flowDir, 'plans', `${plan}.run.json`), runArtifact(plan), 'utf-8');
  writeFileSync(
    join(flowDir, '.rounds.jsonl'),
    done
      .map((phase) =>
        JSON.stringify({
          ts: '2026-08-12T08:00:00.000Z',
          run_id: 'run-1',
          type: 'phase_result',
          phase,
          status: 'success',
          planHash: PLAN_HASH,
        }),
      )
      .join('\n') + (done.length > 0 ? '\n' : ''),
    'utf-8',
  );
}

/** Write run-log lines directly — the stall counter's input. */
function seedRuns(target: string, lines: Record<string, unknown>[]): void {
  const dir = join(target, 'flow', 'loops');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'beats.jsonl'), lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf-8');
}

/** A recording exec, so no test in this file can reach a real git or gh. */
function recordingExec(answers: Record<string, string> = {}): {
  exec: (file: string, args: readonly string[], cwd: string) => string;
  calls: { file: string; args: string[]; cwd: string }[];
} {
  const calls: { file: string; args: string[]; cwd: string }[] = [];
  return {
    calls,
    exec: (file, args, cwd) => {
      calls.push({ file, args: [...args], cwd });
      const key = `${file} ${args[0] ?? ''} ${args[1] ?? ''}`.trim();
      return answers[key] ?? '';
    },
  };
}

/**
 * PHASE 6 DELETED THIS WHOLE SURFACE — the two describes that stood here.
 *
 * `Task 5.2 — loop next reports the stage and holds the machinery` proved that
 * the gate derived a pipeline stage, reported it on the verdict, and took the
 * single `pipelineLock` so exactly one consumer at a time could be inside
 * `/discovery-plan → /create-plan → /execute-plan`. `Task 5.4 — a stalled
 * pipeline gives the machinery back` proved the policy on top of it: two
 * resumes of the same stage, then unclaim the item and trip the breaker.
 *
 * Neither has anything left to hold. A run is a Claude Code background agent
 * scoped to one project root, so what may run at once is what a person
 * dispatched, and a TTL in `state.json` guessing at it was a second, worse
 * answer. The supervisor that acted on a stalled stage was the daemon's
 * finalizer, deleted in Phase 5 — with nothing counting resumes, an
 * abandonment threshold abandons nothing.
 *
 * What SURVIVED is tested elsewhere and deliberately so: the run-slot allocator
 * (`Task 5.5 — loop worktree`, and the gate tests in Task 3.2), because it
 * allocates git worktrees, which Claude Code does not do; and `deriveStage`
 * itself, which is still one of the three legal endings a claim may have
 * ('Task 3.2 — the other two honest endings record clean').
 */

describe('Task 5.3 — the verdict must exist before work starts', () => {
  async function claimed(target: string, title = 'something to judge'): Promise<string> {
    const filed = await file(target, 'fix', title);
    const id = String((filed.json as { item: { id: string } }).item.id);
    await invoke('claim', { target, loop: 'fix', owner: 'beat-1', id });
    return id;
  }

  it('refuses to report a verdict nobody recorded, in one line, exit 1', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimed(target);

    const result = await invoke('classify', { target, loop: 'fix', id });
    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('has no recorded classification');
    expect(result.stdout).toBe('');
  });

  it('records a `small` verdict, and reads it back with the reason attached', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimed(target);

    const result = await invoke('classify', {
      target,
      loop: 'fix',
      id,
      owner: 'beat-1',
      record: true,
      verdict: 'small',
      detail: 'one line in a comment',
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'recorded', verdict: 'small' });

    const readBack = await invoke('classify', { target, loop: 'fix', id });
    expect(readBack.json).toMatchObject({ status: 'ok', verdict: 'small' });
    expect(((readBack.json as { record: { detail: string } }).record).detail).toBe(
      'one line in a comment',
    );
  });

  it('recording `big` takes no lock — two consumers may both be in the flow', async () => {
    // THE INVERSE OF WHAT THIS ONCE PROVED. Recording `big` used to seize the
    // single `pipelineLock`, and the second consumer's `big` was refused with
    // "only one consumer may hold the machinery". Phase 6 deleted that lock: a
    // run is a Claude Code background agent scoped to one project root, so what
    // may run at once is what a person dispatched — a TTL in `state.json`
    // guessing at it was a second, worse answer. The verdict is still recorded;
    // it simply no longer gates anybody.
    const target = makeProject({ fix: CONSUMER_DIRECTIVE, drain: DRAIN_DIRECTIVE });
    const id = await claimed(target, 'a whole subsystem');

    const result = await invoke('classify', {
      target,
      loop: 'fix',
      id,
      owner: 'beat-1',
      record: true,
      verdict: 'big',
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'recorded', verdict: 'big' });

    const rival = await file(target, 'drain', 'another whole subsystem');
    const other = await invoke('classify', {
      target,
      loop: 'drain',
      id: String((rival.json as { item: { id: string } }).item.id),
      owner: 'beat-2',
      record: true,
      verdict: 'big',
    });
    expect(other.exitCode).toBe(0);
    expect(other.json).toMatchObject({ status: 'recorded', verdict: 'big' });
  });

  it('the CLI enforces that a verdict EXISTS, never what it says', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimed(target, 'a one-character typo');

    // A "big" verdict on a trivial item is accepted without argument — the
    // judgment is the agent's, and no heuristic here second-guesses it.
    const big = await invoke('classify', { target, loop: 'fix', id, record: true, verdict: 'big', owner: 'beat-1' });
    expect(big.exitCode).toBe(0);

    // …and a later correction supersedes it, without rewriting the record
    const small = await invoke('classify', { target, loop: 'fix', id, record: true, verdict: 'small', owner: 'beat-1' });
    expect(small.exitCode).toBe(0);
    const readBack = await invoke('classify', { target, loop: 'fix', id });
    expect((readBack.json as { verdict: string }).verdict).toBe('small');

    const lines = readFileSync(join(target, 'flow', 'loops', 'classifications.jsonl'), 'utf-8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
  });

  it(
    'the bare `--record` flag parses on the REAL CLI, with --verdict after it',
    () => {
      const target = makeProject({ fix: CONSUMER_DIRECTIVE });
      const filed = cli(['file', '--loop', 'fix', '--title', 'a thing', '--target', target]);
      expect(filed.status).toBe(0);
      const id = String(JSON.parse(filed.stdout.trim()).item.id);

      const recorded = cli([
        'classify',
        '--loop',
        'fix',
        '--id',
        id,
        '--record',
        '--verdict',
        'small',
        '--detail',
        'a comment typo',
        '--target',
        target,
      ]);
      expect(recorded.status).toBe(0);
      expect(JSON.parse(recorded.stdout.trim())).toMatchObject({
        status: 'recorded',
        verdict: 'small',
      });

      // …and `log --record` still requires its payload rather than reading the log
      const bare = cli(['log', '--record', '--loop', 'fix', '--target', target]);
      expect(bare.status).toBe(1);
      expect(bare.combined).toContain('log --record requires the run record as JSON');
    },
    E2E_TIMEOUT_MS,
  );

  describe('`--body -` reads the finding prose from stdin (#loop-fix-6)', () => {
    // The Windows `.cmd` shim every IDE-launched agent runs `planflow-ai`
    // through goes via cmd.exe's line-oriented `/c` parser, which drops
    // everything past the first line of a literal multi-line argument before
    // the shim script itself ever runs. `--body -` sidesteps that parser
    // entirely by carrying the text over stdin instead of argv.
    //
    // In-process (not `cli()`) because stdin is what is under test and the
    // subprocess helper does not pipe any. (The harness defect this note used
    // to describe — `cli()` spawning the extensionless `.bin/tsx` shim, which
    // `node` cannot parse on Windows — is fixed: `tsxRunnerPath` names the
    // module instead.)
    it('keeps every line of a piped multi-line body', async () => {
      const target = makeProject({ fix: CONSUMER_DIRECTIVE });
      const body = ['## Steps', '1. reproduce it', '2. watch it fail', '', '## Evidence', 'exit 0'].join('\n');

      const fakeStdin = {
        [Symbol.asyncIterator]: async function* (): AsyncGenerator<string> {
          yield body;
        },
      };
      const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
      Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

      try {
        const filed = await invoke('file', {
          target,
          loop: 'fix',
          title: 'multi-line body over stdin',
          body: '-',
        });
        expect(filed.exitCode).toBe(0);

        const lines = readFileSync(join(target, 'flow', 'loops', 'queue.jsonl'), 'utf-8').trim().split('\n');
        const record = JSON.parse(lines[lines.length - 1]) as { body: string };
        // the backend appends its own trailer comments after the body text —
        // what matters here is that none of the PIPED lines were dropped.
        expect(record.body.startsWith(body)).toBe(true);
      } finally {
        if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
      }
    });
  });
  it('refuses an unknown verdict, an unknown item, and someone else\'s claim', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimed(target);

    const bogus = await invoke('classify', { target, loop: 'fix', id, record: true, verdict: 'medium' });
    expect(bogus.exitCode).toBe(1);
    expect(bogus.refusals[0]).toContain("unknown verdict 'medium'");

    const ghost = await invoke('classify', { target, loop: 'fix', id: '999', record: true, verdict: 'big' });
    expect(ghost.exitCode).toBe(1);
    expect(ghost.refusals[0]).toContain("no item '999'");

    const stolen = await invoke('classify', {
      target,
      loop: 'fix',
      id,
      owner: 'beat-9',
      record: true,
      verdict: 'big',
    });
    expect(stolen.exitCode).toBe(1);
    expect(stolen.refusals[0]).toContain("claimed by 'beat-1'");

    const missingVerdict = await invoke('classify', { target, loop: 'fix', id, record: true });
    expect(missingVerdict.exitCode).toBe(1);
    expect(missingVerdict.refusals[0]).toContain('classify requires --verdict');
  });
});

describe('Task 5.5 — `loop worktree`', () => {
  const listing = (extra = ''): string =>
    `worktree /repo\nHEAD abc\nbranch refs/heads/main\n${extra}`;

  it('creates the loop\'s checkout on first use, on its own loop/ branch', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const git = recordingExec({
      'git worktree list': listing(),
      'git rev-parse --abbrev-ref': 'loop/fix',
    });

    const result = await invoke('worktree', { target, loop: 'fix' }, { exec: git.exec });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'created', loop: 'fix', branch: 'loop/fix', created: true });
    expect(git.calls.map((call) => call.args)).toContainEqual([
      'worktree',
      'add',
      '-B',
      'loop/fix',
      String((result.json as { path: string }).path),
    ]);
  });

  describe('run slots — the checkout follows the run, not a flag', () => {
    const TWO_SLOTS = `---
loop: fix
engine: consumer
mission: Drain the queue one item at a time
queue: ledger
max_concurrent_runs: 2
---
`;

    it('gives each concurrent run the checkout its own lock names', async () => {
      const target = makeProject({ fix: TWO_SLOTS, find: PRODUCER_DIRECTIVE });
      // A gate over an EMPTY queue skips, and a skip takes no lock — so the
      // queue needs work in it before two runs can be holding two slots.
      await invoke('file', { target, loop: 'find', owner: 'seed', title: 'one', body: 'a' });
      await invoke('file', { target, loop: 'find', owner: 'seed', title: 'two', body: 'b' });

      const gate = { target, loop: 'fix' } as const;
      expect((await invoke('next', { ...gate, owner: 'run-a' })).json).toMatchObject({
        verdict: 'proceed',
      });
      expect((await invoke('next', { ...gate, owner: 'run-b' })).json).toMatchObject({
        verdict: 'proceed',
      });

      const first = await invoke(
        'worktree',
        { target, loop: 'fix', owner: 'run-a' },
        { exec: recordingExec({ 'git worktree list': listing() }).exec },
      );
      const second = await invoke(
        'worktree',
        { target, loop: 'fix', owner: 'run-b' },
        { exec: recordingExec({ 'git worktree list': listing() }).exec },
      );

      expect(first.json).toMatchObject({ slot: 1, branch: 'loop/fix' });
      // detached, because slot 1 has `loop/fix` checked out and git allows a
      // branch in exactly one worktree
      expect(second.json).toMatchObject({ slot: 2, branch: null });
      expect((first.json as { path: string }).path).not.toBe(
        (second.json as { path: string }).path,
      );
    });

    it('refuses an owner whose lock is gone instead of falling back to slot 1 (#1742)', async () => {
      const target = makeProject({ fix: TWO_SLOTS });
      // No gate was opened for this owner, so it holds no live slot — exactly
      // the state an expired-but-alive run is in. Slot 1 as a fallback is the
      // checkout a fresh gate may already have handed a sibling.
      const result = await invoke(
        'worktree',
        { target, loop: 'fix', owner: 'run-expired' },
        { exec: recordingExec({ 'git worktree list': listing() }).exec },
      );
      expect(result.exitCode).toBe(1);
      expect(result.refusals.join('\n')).toContain("run 'run-expired' holds no live slot");
    });

    it('refuses to guess a checkout when the loop can run twice', async () => {
      const target = makeProject({ fix: TWO_SLOTS });
      const result = await invoke(
        'worktree',
        { target, loop: 'fix' },
        { exec: recordingExec({ 'git worktree list': listing() }).exec },
      );

      // Slot 1 as a default is what would hand a run working in slot 2 the
      // checkout slot 1 is committing in — the refusal is the point.
      expect(result.exitCode).toBe(1);
      expect(result.refusals.join('\n')).toContain('which one is asking');
    });

    it('still answers a single-slot loop with no owner at all', async () => {
      const target = makeProject({ fix: CONSUMER_DIRECTIVE });
      const result = await invoke(
        'worktree',
        { target, loop: 'fix' },
        { exec: recordingExec({ 'git worktree list': listing() }).exec },
      );
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ slot: 1, branch: 'loop/fix' });
    });

    it('lets a person name a slot directly, for a run that has already ended', async () => {
      const target = makeProject({ fix: TWO_SLOTS });
      const result = await invoke(
        'worktree',
        { target, loop: 'fix', slot: '2', prune: true },
        { exec: recordingExec({ 'git worktree list': listing() }).exec },
      );
      expect(result.exitCode).toBe(0);
      expect(result.json).toMatchObject({ slot: 2 });
    });

    it('refuses a slot that is not a slot', async () => {
      const target = makeProject({ fix: TWO_SLOTS });
      const result = await invoke(
        'worktree',
        { target, loop: 'fix', slot: '0' },
        { exec: recordingExec({ 'git worktree list': listing() }).exec },
      );
      expect(result.exitCode).toBe(1);
      expect(result.refusals.join('\n')).toContain("malformed --slot '0'");
    });
  });

  it('resolves the same path on every later beat, creating nothing', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const first = await invoke(
      'worktree',
      { target, loop: 'fix' },
      { exec: recordingExec({ 'git worktree list': listing() }).exec },
    );
    const path = String((first.json as { path: string }).path);

    const git = recordingExec({
      'git worktree list': listing(`\nworktree ${path}\nHEAD def\nbranch refs/heads/loop/fix\n`),
      'git rev-parse --abbrev-ref': 'loop/fix',
    });
    const second = await invoke('worktree', { target, loop: 'fix' }, { exec: git.exec });
    // `refresh` rides along (#1584): the resolve now also reports how the
    // checkout stands against origin/<base> — here already current, because
    // the recording exec answers every rev-parse with the same commit.
    expect(second.json).toMatchObject({
      status: 'ready',
      path,
      created: false,
      refresh: { state: 'current' },
    });
    expect(git.calls.some((call) => call.args[0] === 'worktree' && call.args[1] === 'add')).toBe(
      false,
    );
  });

  it("#1754 — refreshes to the repository's default branch, not the main checkout's HEAD", async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const probe = await invoke(
      'worktree',
      { target, loop: 'fix' },
      { exec: recordingExec({ 'git worktree list': listing() }).exec },
    );
    const path = String((probe.json as { path: string }).path);

    // The human sits on a WIP branch with no remote counterpart; origin/HEAD
    // names `trunk`. The worktree's fetch must target trunk — a WIP branch
    // becoming every worktree's fetch target is the #1754 failure.
    const git = recordingExec({
      'git worktree list': listing(`\nworktree ${path}\nHEAD def\nbranch refs/heads/loop/fix\n`),
      'git symbolic-ref --short': 'origin/trunk',
      'git rev-parse --abbrev-ref': 'loop/fix',
    });
    const result = await invoke('worktree', { target, loop: 'fix' }, { exec: git.exec });
    expect(result.exitCode).toBe(0);
    const fetches = git.calls.filter((call) => call.args[0] === 'fetch');
    expect(fetches.map((call) => call.args)).toEqual([['fetch', 'origin', 'trunk']]);
  });

  it('prunes on demand, without deleting the branch', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const probe = await invoke(
      'worktree',
      { target, loop: 'fix', create: false },
      { exec: recordingExec({ 'git worktree list': listing() }).exec },
    );
    const path = String((probe.json as { path: string }).path);
    expect(probe.json).toMatchObject({ status: 'absent' });

    const git = recordingExec({
      'git worktree list': listing(`\nworktree ${path}\nHEAD def\nbranch refs/heads/loop/fix\n`),
    });
    const pruned = await invoke('worktree', { target, loop: 'fix', prune: true }, { exec: git.exec });
    expect(pruned.json).toMatchObject({ status: 'pruned', branch: 'loop/fix' });
    expect(git.calls.map((call) => call.args.join(' '))).toEqual([
      'worktree list --porcelain',
      `worktree remove --force ${path}`,
      'worktree prune',
    ]);
  });

  it('refuses a worktree for a loop with no directive', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const git = recordingExec({ 'git worktree list': listing() });
    const result = await invoke('worktree', { target, loop: 'ghost' }, { exec: git.exec });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain("no directive for loop 'ghost'");
    expect(git.calls).toHaveLength(0);
  });
});

describe('Task 5.6 — the push carve-out, enforced at the seam', () => {
  it('pushes a loop/* branch and opens a PR from it', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const git = recordingExec({ 'gh pr create': 'https://github.com/o/r/pull/7\n' });

    const result = await invoke(
      'push',
      { target, loop: 'fix', branch: 'loop/fix', pr: true, title: 'fix: the thing', body: 'why' },
      { exec: git.exec },
    );
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      status: 'pushed',
      branch: 'loop/fix',
      remote: 'origin',
      pr: { url: 'https://github.com/o/r/pull/7', base: 'main' },
    });
    expect(git.calls[0].args).toEqual(['push', '--set-upstream', 'origin', 'loop/fix']);
    expect(git.calls[1].file).toBe('gh');
  });

  /**
   * `Closes #<n>` IS HOW THE BACKLOG DRAINS.
   *
   * A loop may not close an issue a person opened, so the issue is closed by
   * GitHub instead — on the merge of a pull request that says it closes it. The
   * one place the loop writes that reference is the body of its OWN pull request,
   * where writing anything at all is unremarkable.
   */
  it('writes `Closes #<id>` into its own PR body, once, and only for a GitHub queue', async () => {
    const target = makeProject({ fix: GITHUB_CONSUMER_DIRECTIVE, gap: LEDGER_CONSUMER_DIRECTIVE });

    const git = recordingExec({ 'gh pr create': 'https://github.com/o/r/pull/7\n' });
    await invoke(
      'push',
      { target, loop: 'fix', id: '1509', branch: 'loop/fix/1509', pr: true, body: 'why it broke' },
      { exec: git.exec },
    );
    const body = git.calls[1].args[git.calls[1].args.indexOf('--body') + 1];
    expect(body).toBe('why it broke\n\nCloses #1509');

    // already referenced by hand: left exactly as the beat wrote it
    const again = recordingExec({ 'gh pr create': 'https://github.com/o/r/pull/8\n' });
    await invoke(
      'push',
      { target, loop: 'fix', id: '1509', branch: 'loop/fix/1509', pr: true, body: 'Fixes #1509 — the map' },
      { exec: again.exec },
    );
    expect(again.calls[1].args[again.calls[1].args.indexOf('--body') + 1]).toBe('Fixes #1509 — the map');

    // a ledger id means nothing to GitHub, so nothing is written
    const ledger = recordingExec({ 'gh pr create': 'https://github.com/o/r/pull/9\n' });
    await invoke(
      'push',
      { target, loop: 'gap', id: '3', branch: 'loop/gap/3', pr: true, body: 'why' },
      { exec: ledger.exec },
    );
    expect(ledger.calls[1].args[ledger.calls[1].args.indexOf('--body') + 1]).toBe('why');
  });

  it('reads the PR body from stdin when `--body -` (#loop-fix-6)', async () => {
    const target = makeProject({ fix: GITHUB_CONSUMER_DIRECTIVE });
    const pipedBody = 'line one\nline two\nline three';

    const fakeStdin = {
      [Symbol.asyncIterator]: async function* (): AsyncGenerator<string> {
        yield pipedBody;
      },
    };
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

    try {
      const git = recordingExec({ 'gh pr create': 'https://github.com/o/r/pull/11\n' });
      await invoke(
        'push',
        { target, loop: 'fix', id: '1510', branch: 'loop/fix/1510', pr: true, body: '-' },
        { exec: git.exec },
      );
      const body = git.calls[1].args[git.calls[1].args.indexOf('--body') + 1];
      expect(body).toBe(`${pipedBody}\n\nCloses #1510`);
    } finally {
      if (originalStdin) Object.defineProperty(process, 'stdin', originalStdin);
    }
  });

  it('refuses any other ref with ONE line and exit 1, having run nothing', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    for (const branch of ['main', 'feat/agent-loops', 'HEAD:main', ':loop/fix']) {
      const git = recordingExec();
      const result = await invoke('push', { target, loop: 'fix', branch }, { exec: git.exec });
      expect(result.exitCode).toBe(1);
      expect(result.refusals).toHaveLength(1);
      expect(result.stdout).toBe('');
      // the guard runs BEFORE git does — a refused push has pushed nothing
      expect(git.calls).toHaveLength(0);
    }
  });

  it('refuses a PR opened from outside the carve-out before touching gh', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const git = recordingExec();
    const result = await invoke(
      'push',
      { target, loop: 'fix', branch: 'main', pr: true },
      { exec: git.exec },
    );
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('outside the carve-out');
    expect(git.calls).toHaveLength(0);
  });

  it('refuses a push with no branch by naming the flag', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const result = await invoke('push', { target, loop: 'fix' }, { exec: recordingExec().exec });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('push requires --branch');
  });

  it(
    'the refusal reaches a real caller as one line on the combined transcript',
    () => {
      const target = makeProject({ fix: CONSUMER_DIRECTIVE });
      const result = cli(['push', '--loop', 'fix', '--branch', 'main', '--target', target]);
      expect(result.status).toBe(1);
      const refusals = result.combined.split('\n').filter((line) => line.includes('loop refused:'));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain('outside the carve-out');
    },
    E2E_TIMEOUT_MS,
  );
});

describe('Task 5.7 — awaiting approval keeps the item', () => {
  it('pauses the loop, writes the prompt file, and keeps the item claimed', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    seedPipeline(target, 'agent-loops', [1, 2]);
    const filed = await file(target, 'fix', 'a risky change');
    const id = String((filed.json as { item: { id: string } }).item.id);
    await invoke('claim', { target, loop: 'fix', owner: 'beat-1', id });

    const result = await invoke('escalate', {
      target,
      loop: 'fix',
      owner: 'beat-1',
      id,
      detail: 'post-execution risk is high',
    });
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      status: 'awaiting-approval',
      loop: 'fix',
      reason: 'awaiting-approval — post-execution risk is high',
      id,
    });
    // NO `stage` ON THE RESULT ANY MORE (Phase 6). Escalation is a PAUSE, and
    // the stage annotation came from a supervisor that no longer exists — a
    // label derived from it would be a sentence nothing could stand behind.
    expect(result.json).not.toHaveProperty('stage');

    // the prompt a human answers is where the daemon and session start look
    const promptPath = join(target, 'flow', '.heartbeat-prompt.md');
    expect(existsSync(promptPath)).toBe(true);
    const prompt = readFileSync(promptPath, 'utf-8');
    expect(prompt).toContain('loop: fix');
    expect(prompt).toContain('post-execution risk is high');
    expect(prompt).toContain('planflow-ai loop resume --loop fix');

    const state = readLoopState(join(target, 'flow'), NOW);
    expect(state.loops.fix.pause?.reason).toBe('awaiting-approval — post-execution risk is high');
    // A HUMAN GATE IS NOT A FAILURE — it sets a pause and touches nothing else.
    // That used to be asserted against the breaker's counter, which Phase 6
    // deleted; the outcome history is the field that remains, and an escalation
    // must not write one.
    expect(state.loops.fix.lastOutcome).toBeUndefined();

    // the item stays claimed — nobody else picks it up while a human is looking
    const other = await invoke('claim', { target, loop: 'fix', owner: 'beat-2' });
    expect((other.json as { status: string }).status).toBe('empty');
  });

  it('the paused loop really stops beating until someone resumes it', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await file(target, 'fix', 'a risky change');
    await invoke('escalate', { target, loop: 'fix', detail: 'needs a human' });

    const gated = await invoke('next', { target, loop: 'fix', owner: 'beat-2' });
    expect(gated.json).toMatchObject({ verdict: 'paused' });
    expect(String((gated.json as { reason: string }).reason)).toContain('awaiting-approval');

    await invoke('resume', { target, loop: 'fix', detail: 'approved' });
    const after = await invoke('next', { target, loop: 'fix', owner: 'beat-3' });
    expect(after.json).toMatchObject({ verdict: 'proceed' });
  });

  it('refuses an escalation with no reason — a pause nobody explained is a bug later', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const result = await invoke('escalate', { target, loop: 'fix' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('escalate requires --detail <why>');
  });
});

// ── Phase 3: a beat cannot quietly leave an item open ────
//
// `loop close --reason done` already did the right thing; nothing forced a beat
// to reach it. A consumer that fixed an issue and forgot to close left the item
// open and held by an owner that was never coming back — and because the beat
// reported SUCCESS, the stall policy never fired either, so the item sat claimed
// forever and the cap filled with ghosts. That is forbidden-pattern #7 with a
// queue attached, so the rule lives in the CLI (allowed-pattern #14) and no beat
// prompt is told about it.

/** File one item under `loop` and claim it for `owner`, returning its id. */
async function claimOne(target: string, loop: string, owner: string, title = 'a real bug'): Promise<string> {
  const filed = await file(target, loop, title);
  const id = String((filed.json as { item: { id: string } }).item.id);
  const claimed = await invoke('claim', { target, loop, owner, id });
  expect(claimed.exitCode).toBe(0);
  return id;
}

/** Record a beat outcome the way a beat prompt does. */
async function record(
  target: string,
  loop: string,
  owner: string,
  outcome: 'success' | 'failure',
  runtime: LoopRuntime = {},
): Promise<Invocation> {
  return invoke(
    'log',
    {
      target,
      loop,
      owner,
      record: JSON.stringify({ kind: 'beat', loop, outcome, reason: 'one beat' }),
    },
    runtime,
  );
}

describe('closing an item hands the run the next one', () => {
  /** File `count` items and close the first, returning the close invocation. */
  async function closeOneOf(target: string, count: number): Promise<Invocation> {
    const ids: string[] = [];
    for (let n = 0; n < count; n += 1) {
      // A DISTINCT primary file per item: the fingerprint is what dedup keys on,
      // and three findings that differ only by a number in the title are one
      // finding as far as the queue is concerned.
      const filed = await file(target, 'fix', `finding ${String(n)}`, {
        file: `src/module-${String(n)}.ts`,
      });
      ids.push(String((filed.json as { item: { id: string } }).item.id));
    }
    await invoke('claim', { target, loop: 'fix', owner: 'run-a', id: ids[0] });
    return invoke('close', {
      target,
      loop: 'fix',
      owner: 'run-a',
      id: ids[0],
      reason: 'done',
      evidence: PASSING_EVIDENCE,
      human: true,
    });
  }

  it('says how many are left, so the run has a reason to keep going', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const closed = await closeOneOf(target, 3);

    expect(closed.exitCode).toBe(0);
    expect(closed.stdout).toContain('2 still claimable — claim the next');
  });

  it('says nothing when the queue really is empty — the one time stopping is right', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const closed = await closeOneOf(target, 1);

    expect(closed.exitCode).toBe(0);
    expect(closed.stdout).not.toContain('claim the next');
  });

  it('counts AFTER the close, never including the item just settled', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const closed = await closeOneOf(target, 2);
    // Two filed, one closed — one left, not two.
    expect(closed.stdout).toContain('1 still claimable');
  });
});

describe('a run that opened a pull request and did not land it', () => {
  /** Record a run's ending. */
  async function end(
    target: string,
    owner: string,
    outcome: 'success' | 'failure' = 'success',
    stopCondition = 'empty',
  ): Promise<Invocation> {
    return invoke('log', {
      target,
      loop: 'fix',
      owner,
      record: JSON.stringify({ kind: 'run', loop: 'fix', outcome, stopCondition, reason: 'done' }),
    });
  }

  /** A run that pushed a PR for `id` — the `gh pr create` reply is the URL. */
  async function pushedPr(target: string, owner: string, id: string): Promise<void> {
    const result = await invoke(
      'push',
      { target, loop: 'fix', owner, id, branch: `loop/fix.${id}`, pr: true },
      { exec: () => `https://github.com/owner/name/pull/${id}` },
    )
    expect(result.exitCode).toBe(0)
  }

  it('refuses the ending, naming the item and both ways forward', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await pushedPr(target, 'run-a', '1602');

    const result = await end(target, 'run-a');
    expect(result.exitCode).toBe(1);
    const refusal = result.refusals[0];
    expect(refusal).toContain('#1602');
    expect(refusal).toContain('loop merge');
    expect(refusal).toContain('`failure`');
  });

  it('lets the ending through once the item is landed', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await pushedPr(target, 'run-a', '1602');

    // What `loop merge` writes, without driving gh through a real merge.
    await invoke('log', {
      target,
      loop: 'fix',
      owner: 'run-a',
      record: JSON.stringify({ kind: 'merge', loop: 'fix', item: '1602', reason: 'merged' }),
    });

    expect((await end(target, 'run-a')).exitCode).toBe(0);
  });

  it('leaves a pull request for a person when the run records failure', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await pushedPr(target, 'run-a', '1602');
    // The honest ending when the merge gate refused — the reason travels with it.
    expect((await end(target, 'run-a', 'failure')).exitCode).toBe(0);
  });

  it("never fires on another run's pull request", async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await pushedPr(target, 'run-a', '1602');
    // run-b did its own work and owes nothing for run-a's branch.
    expect((await end(target, 'run-b')).exitCode).toBe(0);
  });

  it('pairs by item, so landing one leaves the other outstanding', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await pushedPr(target, 'run-a', '1602');
    await pushedPr(target, 'run-a', '1603');
    await invoke('log', {
      target,
      loop: 'fix',
      owner: 'run-a',
      record: JSON.stringify({ kind: 'merge', loop: 'fix', item: '1602', reason: 'merged' }),
    });

    const result = await end(target, 'run-a');
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('#1603');
    expect(result.refusals[0]).not.toContain('#1602');
  });
});

describe('a run ends exactly once', () => {
  async function end(target: string, owner: string, stopCondition = 'empty'): Promise<Invocation> {
    return invoke('log', {
      target,
      loop: 'fix',
      owner,
      record: JSON.stringify({
        kind: 'run',
        loop: 'fix',
        outcome: 'success',
        stopCondition,
        reason: 'done',
      }),
    });
  }

  it('refuses a second ending from the same run', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    expect((await end(target, 'run-a')).exitCode).toBe(0);

    const again = await end(target, 'run-a');
    expect(again.exitCode).toBe(1);
    expect(again.refusals[0]).toContain('already recorded an ending');
    // The digest counts endings, so a second one is a miscount, not a duplicate line.
    expect(again.refusals[0]).toContain('count it twice');
  });

  it('refuses it under the other run kind too', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await end(target, 'run-a');
    const asBeat = await invoke('log', {
      target,
      loop: 'fix',
      owner: 'run-a',
      record: JSON.stringify({ kind: 'beat', loop: 'fix', outcome: 'success', reason: 'again' }),
    });
    expect(asBeat.exitCode).toBe(1);
  });

  it('lets a different run end normally', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await end(target, 'run-a');
    expect((await end(target, 'run-b')).exitCode).toBe(0);
  });
});

describe('a run that says it ran out of work, with work still in the queue', () => {
  /** Record a run's ending with an explicit stop condition. */
  async function end(
    target: string,
    owner: string,
    stopCondition: string,
    outcome: 'success' | 'failure' = 'success',
  ): Promise<Invocation> {
    return invoke('log', {
      target,
      loop: 'fix',
      owner,
      record: JSON.stringify({ kind: 'run', loop: 'fix', outcome, stopCondition, reason: 'done' }),
    });
  }

  it("refuses 'empty' while the queue still has claimable items", async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await file(target, 'fix', 'still here');

    const result = await end(target, 'run-a', 'empty');
    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    const refusal = result.refusals[0];
    expect(refusal).toContain('1 item is still claimable');
    // it must teach the way past the head, which is what a run meeting this
    // has usually failed to find
    expect(refusal).toContain('loop claim --skip');
    expect(result.stdout).toBe('');
  });

  it("refuses 'none' the same way — both words claim nothing stopped the run", async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await file(target, 'fix', 'one');
    await file(target, 'fix', 'two');

    const result = await end(target, 'run-a', 'none');
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('2 items are still claimable');
  });

  it('persists nothing — the run can fix its ending and record again', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await file(target, 'fix', 'still here');
    const before = readRunLog(join(target, 'flow')).length;

    expect((await end(target, 'run-a', 'empty')).exitCode).toBe(1);
    expect(readRunLog(join(target, 'flow')).length).toBe(before);
  });

  it('accepts it once the queue really is drained', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const filed = await file(target, 'fix', 'the only one');
    const id = String((filed.json as { item: { id: string } }).item.id);
    await invoke('claim', { target, loop: 'fix', owner: 'run-a', id });
    await invoke('close', {
      target,
      loop: 'fix',
      owner: 'run-a',
      id,
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });

    expect((await end(target, 'run-a', 'empty')).exitCode).toBe(0);
  });

  it('never fires on a real limit — `cap` and `budget` are not this claim', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await file(target, 'fix', 'still here');
    expect((await end(target, 'run-a', 'cap')).exitCode).toBe(0);
  });

  it('never fires on a failure record — an honest failure must stay recordable', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await file(target, 'fix', 'still here');
    expect((await end(target, 'run-a', 'empty', 'failure')).exitCode).toBe(0);
  });

  it('never fires for a producer — its `empty` is about the repo, not the queue', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await file(target, 'find', 'a finding');

    const result = await invoke('log', {
      target,
      loop: 'find',
      owner: 'run-a',
      record: JSON.stringify({
        kind: 'run',
        loop: 'find',
        outcome: 'success',
        stopCondition: 'empty',
        reason: 'found nothing new',
      }),
    });
    expect(result.exitCode).toBe(0);
  });
});

describe('Task 3.1 — a success beat that still holds a claim is refused', () => {
  it('names the item and all three legitimate endings, in one line, exit 1', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimOne(target, 'fix', 'beat-1');

    const result = await record(target, 'fix', 'beat-1', 'success');
    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    const refusal = result.refusals[0];
    expect(refusal.match(/loop refused:/g)).toHaveLength(1);
    // the item, by name — a refusal nobody can act on is just an objection
    expect(refusal).toContain(`item ${id}`);
    // and the three endings, so the message teaches the fix
    expect(refusal).toContain('loop close --reason done');
    expect(refusal).toContain('a pipeline stage in flight');
    expect(refusal).toContain('loop unclaim');
    expect(refusal).toContain('records outcome `failure`');
    expect(result.stdout).toBe('');
  });

  it('persists nothing — no beat line, no outcome, no lock release', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await claimOne(target, 'fix', 'beat-1');
    await invoke('next', { target, loop: 'fix', owner: 'beat-1' });

    const before = readRunLog(join(target, 'flow')).length;
    expect((await record(target, 'fix', 'beat-1', 'success')).exitCode).toBe(1);

    expect(readRunLog(join(target, 'flow')).length).toBe(before);
    const state = readLoopState(join(target, 'flow'), NOW);
    expect(state.loops.fix.lastOutcome).toBeUndefined();
    // the beat's own lock is still held: the beat did not end
    expect(state.loops.fix.locks?.[0].owner).toBe('beat-1');
  });

  it('never fires on a `failure` record — a run that says so is being honest', async () => {
    // Making a failing run unable to report would be the worse bug. The line is
    // recorded and the outcome folded into the loop's history; the stall policy
    // that used to own the path afterwards went with Phase 6, so `lastOutcome`
    // is the whole of what the store keeps about it.
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await claimOne(target, 'fix', 'beat-1');

    const result = await record(target, 'fix', 'beat-1', 'failure');
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'recorded' });
    expect(readLoopState(join(target, 'flow'), NOW).loops.fix.lastOutcome).toBe('failure');
  });

  it('never fires for a producer — a producer files, it does not hold work', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await claimOne(target, 'find', 'beat-1');

    const result = await record(target, 'find', 'beat-1', 'success');
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'recorded' });
  });

  it("another beat's claim is not this beat's to end", async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await claimOne(target, 'fix', 'beat-1');

    // beat-2 held nothing, so its own ending is honest — the ghost beat-1 left
    // is beat-1's, and `loop status` is what surfaces it (Task 3.3)
    const result = await record(target, 'fix', 'beat-2', 'success');
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'recorded' });
  });
});

describe('Task 3.2 — the other two honest endings record clean', () => {
  it('closing the item ends the beat', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimOne(target, 'fix', 'beat-1');

    const closed = await invoke('close', {
      target,
      loop: 'fix',
      id,
      owner: 'beat-1',
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });
    expect(closed.exitCode).toBe(0);

    const result = await record(target, 'fix', 'beat-1', 'success');
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'recorded' });
  });

  it('an in-flight pipeline stage IS the hand-off — one stage per beat', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimOne(target, 'fix', 'beat-1');
    seedPipeline(target, 'agent-loops', [1, 2]);

    const result = await record(target, 'fix', 'beat-1', 'success');
    // The run ended holding the item ON PURPOSE — an in-flight stage IS the
    // hand-off, and the honest-ending rule still derives it in code (a
    // caller-supplied stage would be exactly the escape hatch it must not have).
    // What the LINE carries changed in Phase 6: the record no longer derives a
    // stage of its own, because the stalled-pipeline counter that read it is
    // gone and a queue round trip for a field nothing counts has no reader.
    expect(result.exitCode).toBe(0);
    expect((result.json as { entry: { stage?: string } }).entry.stage).toBeUndefined();
    const status = await invoke('status', { target, loop: 'fix' });
    // Two claims: this test's own item, plus the seeded pipeline carrier —
    // which is claimed by design, because mid-pipeline the item stays held.
    expect((status.json as { loops: { queue: { claimed: number } }[] }).loops[0].queue.claimed).toBe(2);
    expect(String(id).length).toBeGreaterThan(0);
  });

  it('releasing the claim ends the beat, and puts the item back for someone else', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimOne(target, 'fix', 'beat-1');

    const released = await invoke('unclaim', { target, loop: 'fix', id, owner: 'beat-1' });
    expect(released.exitCode).toBe(0);
    expect(released.json).toMatchObject({ status: 'unclaimed', loop: 'fix', id, wasClaimed: true });
    expect((released.json as { item: { claimedBy?: string } }).item.claimedBy).toBeUndefined();

    const result = await record(target, 'fix', 'beat-1', 'success');
    expect(result.exitCode).toBe(0);

    // released, not closed — the finding is still real and still workable
    const next = await invoke('claim', { target, loop: 'fix', owner: 'beat-2' });
    expect(next.json).toMatchObject({ status: 'claimed' });
  });

  it('unclaim refuses to release a claim held by another beat', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimOne(target, 'fix', 'beat-1');

    const stolen = await invoke('unclaim', { target, loop: 'fix', id, owner: 'beat-2' });
    expect(stolen.exitCode).toBe(1);
    expect(stolen.refusals).toHaveLength(1);
    expect(stolen.refusals[0]).toContain("claimed by 'beat-1'");
    expect(stolen.refusals[0]).toContain("'beat-2' cannot unclaim it");
  });

  describe('an abandoned claim can be taken over — the deadlock', () => {
    /** The lock TTL of a directive with the default 25-minute beat budget. */
    const TTL_MS = (25 + 5) * 60 * 1000;

    it('releases a claim whose holder is past the lock TTL, and says it took over', async () => {
      const target = makeProject({ fix: CONSUMER_DIRECTIVE });
      const id = await claimOne(target, 'fix', 'dead-beat');
      const later = NOW + TTL_MS + 60_000;

      const taken = await invoke(
        'unclaim',
        { target, loop: 'fix', id, owner: 'beat-2', human: true },
        { clock: () => later },
      );
      expect(taken.exitCode).toBe(0);
      expect(taken.stdout).toContain('abandoned claim taken over');

      // THE POINT OF THE FIX: the queue drains again
      const next = await invoke(
        'claim',
        { target, loop: 'fix', owner: 'beat-2' },
        { clock: () => later },
      );
      expect(next.json).toMatchObject({ status: 'claimed', item: { id } });
    });

    it('still refuses one second before the TTL — a live run keeps its item', async () => {
      const target = makeProject({ fix: CONSUMER_DIRECTIVE });
      const id = await claimOne(target, 'fix', 'beat-1');

      const stolen = await invoke(
        'unclaim',
        { target, loop: 'fix', id, owner: 'beat-2' },
        { clock: () => NOW + TTL_MS - 1000 },
      );
      expect(stolen.exitCode).toBe(1);
      expect(stolen.refusals[0]).toContain("'beat-2' cannot unclaim it");
    });

    it('an ordinary self-release is not reported as a takeover', async () => {
      const target = makeProject({ fix: CONSUMER_DIRECTIVE });
      const id = await claimOne(target, 'fix', 'beat-1');

      const released = await invoke('unclaim', { target, loop: 'fix', id, owner: 'beat-1', human: true });
      expect(released.exitCode).toBe(0);
      expect(released.stdout).toContain('released:');
      expect(released.stdout).not.toContain('taken over');
    });
  });

  it('releasing an item nobody holds is success, and renders as such', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const filed = await file(target, 'fix', 'never claimed');
    const id = String((filed.json as { item: { id: string } }).item.id);

    const released = await invoke('unclaim', { target, loop: 'fix', id, human: true });
    expect(released.exitCode).toBe(0);
    expect(released.stdout).toContain('was not claimed');
  });

  it('unclaim names the flag it is missing', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const result = await invoke('unclaim', { target, loop: 'fix' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('unclaim requires --id <id>');
  });
});

/**
 * `loop plan` — the surface a run says which pipeline it is advancing on (#1599).
 *
 * The handoff used to live only in `flow/STATE.md`, and a run that finished a
 * stage left the next one unable to see the pipeline at all. This is the write
 * that makes it structural: the plan name goes on the claim, which both runs
 * already read.
 */
describe('a run records the pipeline on its claim', () => {
  it('records the plan on the item, and reads it back off the queue', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimOne(target, 'fix', 'beat-1');

    const recorded = await invoke('plan', {
      target,
      loop: 'fix',
      id,
      owner: 'beat-1',
      plan: 'state-md-handoff',
    });
    expect(recorded.exitCode).toBe(0);
    expect(recorded.json).toMatchObject({ status: 'recorded', loop: 'fix', id, plan: 'state-md-handoff' });
    expect((recorded.json as { item: { plan?: string } }).item.plan).toBe('state-md-handoff');

    // …and it survives the run that wrote it: a fresh read sees the pipeline
    const status = await invoke('claim', { target, loop: 'fix', id, owner: 'beat-1' });
    expect((status.json as { item: { plan?: string } }).item.plan).toBe('state-md-handoff');
  });

  it('clears the record when no plan is named — one flag, both directions', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimOne(target, 'fix', 'beat-1');
    await invoke('plan', { target, loop: 'fix', id, owner: 'beat-1', plan: 'state-md-handoff' });

    const cleared = await invoke('plan', { target, loop: 'fix', id, owner: 'beat-1', human: true });
    expect(cleared.exitCode).toBe(0);
    expect(cleared.stdout).toContain('pipeline cleared');
  });

  it('refuses a plan name the marker could not carry', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimOne(target, 'fix', 'beat-1');

    const result = await invoke('plan', { target, loop: 'fix', id, owner: 'beat-1', plan: '../etc/passwd' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('no path separators');
  });

  it('names the flag it is missing', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const result = await invoke('plan', { target, loop: 'fix' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('plan requires --id <id>');
  });
});

describe('Task 3.3 — `loop status` reports abandoned claims', () => {
  /** The lock TTL of a directive with the default 25-minute beat budget. */
  const TTL_MS = (25 + 5) * 60 * 1000;

  it('names an open claim older than the lock TTL, without releasing it', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimOne(target, 'fix', 'beat-1');
    const later = NOW + TTL_MS + 60_000;

    const status = await invoke('status', { target, loop: 'fix' }, { clock: () => later });
    expect(status.exitCode).toBe(0);
    const row = (status.json as { loops: Record<string, unknown>[] }).loops[0];
    expect(row.abandonedClaims).toEqual([
      { id, owner: 'beat-1', claimedAt: new Date(NOW).toISOString(), ageMs: TTL_MS + 60_000 },
    ]);

    // A REPORT, NEVER AN ACTION: status is read-only, so the item is still held
    expect((row as { queue: { claimed: number } }).queue.claimed).toBe(1);
    const other = await invoke('claim', { target, loop: 'fix', owner: 'beat-2' });
    expect(other.json).toMatchObject({ status: 'empty' });
  });

  it('a claim still inside the TTL is live, not abandoned', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await claimOne(target, 'fix', 'beat-1');

    const status = await invoke('status', { target, loop: 'fix' }, { clock: () => NOW + 60_000 });
    const row = (status.json as { loops: { abandonedClaims: unknown[] }[] }).loops[0];
    expect(row.abandonedClaims).toEqual([]);
  });

  it('a closed item is never abandoned — closing IS the release', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimOne(target, 'fix', 'beat-1');
    await invoke('close', {
      target,
      loop: 'fix',
      id,
      owner: 'beat-1',
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });

    const status = await invoke('status', { target, loop: 'fix' }, { clock: () => NOW + 10 * TTL_MS });
    const row = (status.json as { loops: { abandonedClaims: unknown[] }[] }).loops[0];
    expect(row.abandonedClaims).toEqual([]);
  });

  it('--human names the stuck items, because a count cannot be chased', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const first = await claimOne(target, 'fix', 'beat-1', 'older');
    const second = await claimOne(target, 'fix', 'beat-2', 'newer');
    const later = NOW + TTL_MS + 60_000;

    const status = await invoke('status', { target, loop: 'fix', human: true }, { clock: () => later });
    expect(status.stdout).toContain(`2 abandoned claims (${first}, ${second})`);
  });

  it('a row nobody could read reports NO list, which must never read as "nothing is stuck"', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    writeFileSync(join(target, 'flow', 'loops', 'bad.md'), '---\nloop: bad\n---\n', 'utf-8');

    const status = await invoke('status', { target });
    expect(status.exitCode).toBe(0);
    const rows = (status.json as { loops: Record<string, unknown>[] }).loops;
    const broken = rows.find((row) => row.loop === 'bad') as Record<string, unknown>;
    expect(broken.directiveError).toBeTruthy();
    expect(broken.abandonedClaims).toBeUndefined();
    // and a readable row with nothing stuck says so, actionably
    const fix = rows.find((row) => row.loop === 'fix') as Record<string, unknown>;
    expect(fix.abandonedClaims).toEqual([]);
  });
});

// ── Phase 2: say when a run has died ─────────────────────
//
// The user's named worst case: a background agent is killed and the item it
// claimed stays claimed by a run that no longer exists. The claim carries the
// session its run lives in; `loop status` is TOLD what is running and names the
// claims whose session is not among them. It never goes looking — a read path
// that spawns a process is a read path that blocks.

describe('Phase 2 — `loop status` names the claims whose run has died', () => {
  /** The session a live run is in. */
  const ALIVE = '8b1e6bfd-2e30-432d-993a-125dca91778f';
  /** The session of a run that was killed. */
  const DEAD = '2c9f0a41-77aa-4d31-9f2e-31b8c1ad5e02';
  /** The user's own chat — in the same list, and not a loop run. */
  const CHAT = '7f87aba8-09a2-4c50-9bf6-2ae2e2a63ab0';

  /** The snapshot shape `claude agents --cwd <root> --json` really returns. */
  function snapshot(...sessions: string[]): string {
    return JSON.stringify([
      ...sessions.map((sessionId) => ({
        id: sessionId.slice(0, 8),
        cwd: '/repo',
        kind: 'background',
        startedAt: 1783733695215,
        sessionId,
        name: 'loop fix',
        state: 'running',
      })),
      {
        pid: 95820,
        cwd: '/repo',
        kind: 'interactive',
        startedAt: 1787580043902,
        sessionId: CHAT,
        name: 'plan-flow-56',
        status: 'busy',
      },
    ]);
  }

  /** File one item and claim it AS a run living in `session`. */
  async function claimAsRun(
    target: string,
    session: string,
    title = 'a real bug',
  ): Promise<{ id: string; owner: string }> {
    const filed = await file(target, 'fix', title);
    const id = String((filed.json as { item: { id: string } }).item.id);
    const claimed = await invoke('claim', { target, loop: 'fix', id, session });
    expect(claimed.exitCode).toBe(0);
    return { id, owner: String((claimed.json as { owner: string }).owner) };
  }

  it('records the run\'s session on the claim it takes', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const { id, owner } = await claimAsRun(target, ALIVE);
    expect(owner).toContain(ALIVE);

    // …and it is the claim, not a note beside it: a fresh read of the queue
    // hands the same owner back, which is what makes it checkable at all.
    const listed = await invoke('list', { target, loop: 'fix' });
    const items = (listed.json as { loops: { items: { id: string; claimedBy?: string }[] }[] })
      .loops[0].items;
    expect(items.find((item) => item.id === id)?.claimedBy).toBe(owner);
  });

  it('names the item, the loop and the dead run', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const { id, owner } = await claimAsRun(target, DEAD);

    const status = await invoke('status', { target, loop: 'fix', liveRuns: snapshot(ALIVE) });
    expect(status.exitCode).toBe(0);
    const row = (status.json as { loops: Record<string, unknown>[] }).loops[0];
    expect(row.stuckClaims).toEqual([
      { id, loop: 'fix', owner, sessionId: DEAD, claimedAt: new Date(NOW).toISOString() },
    ]);

    // A REPORT, NEVER AN ACTION — the item is still held afterwards
    const other = await invoke('claim', { target, loop: 'fix', owner: 'beat-2' });
    expect(other.json).toMatchObject({ status: 'empty' });
  });

  it('leaves a claim alone while its run is alive', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await claimAsRun(target, ALIVE);

    const status = await invoke('status', { target, loop: 'fix', liveRuns: snapshot(ALIVE) });
    expect((status.json as { loops: { stuckClaims: unknown[] }[] }).loops[0].stuckClaims).toEqual([]);
    expect((status.json as { runs: unknown }).runs).toEqual({ known: true });
  });

  it('does not mistake the user\'s own chat for a live run', async () => {
    // The interactive entry carries a sessionId exactly like a background one.
    // A reader that did not filter on `kind` would call this claim healthy for
    // as long as the user keeps a chat open.
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const { id } = await claimAsRun(target, CHAT);

    const status = await invoke('status', { target, loop: 'fix', liveRuns: snapshot() });
    const stuck = (status.json as { loops: { stuckClaims: { id: string }[] }[] }).loops[0]
      .stuckClaims;
    expect(stuck.map((claim) => claim.id)).toEqual([id]);
  });

  it('reports NOTHING when nothing said what is running — never everything', async () => {
    // The safety property. "We could not tell" collapsed into "no runs are
    // alive" would name every live claim in the project as dead.
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await claimAsRun(target, ALIVE);

    for (const liveRuns of [undefined, '{not json', '[{"kind":"background"}]']) {
      const status = await invoke('status', { target, loop: 'fix', ...(liveRuns === undefined ? {} : { liveRuns }) });
      expect(status.exitCode).toBe(0);
      // ABSENT, not empty: a reader must be able to tell "we did not ask" from
      // "every run is alive", which is the whole difference between the two.
      expect((status.json as { loops: Record<string, unknown>[] }).loops[0].stuckClaims).toBeUndefined();
      const runs = (status.json as { runs: { known: boolean; reason?: string } }).runs;
      expect(runs.known).toBe(false);
      expect(runs.reason).toBeTruthy();
    }
  });

  it('never calls another engineer\'s claim dead', async () => {
    // A claim taken by hand carries no session, and one read off a GitHub
    // assignee belongs to a machine whose runs were never in this list.
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await claimOne(target, 'fix', 'beat-1');

    const status = await invoke('status', { target, loop: 'fix', liveRuns: snapshot() });
    expect((status.json as { loops: { stuckClaims: unknown[] }[] }).loops[0].stuckClaims).toEqual([]);
  });

  it('--human names the item and the run, because a count cannot be chased', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const { id } = await claimAsRun(target, DEAD);

    const status = await invoke('status', {
      target,
      loop: 'fix',
      human: true,
      liveRuns: snapshot(ALIVE),
    });
    expect(status.stdout).toContain(`1 stuck claim (${id} — run ${DEAD} is gone)`);
  });

  it('--human says nothing extra when nothing said what is running', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await claimAsRun(target, ALIVE);

    const status = await invoke('status', { target, loop: 'fix', human: true });
    expect(status.stdout).not.toContain('stuck claim');
  });

  it('a row nobody could read reports NO list here either', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    writeFileSync(join(target, 'flow', 'loops', 'bad.md'), '---\nloop: bad\n---\n', 'utf-8');

    const status = await invoke('status', { target, liveRuns: snapshot(ALIVE) });
    const rows = (status.json as { loops: Record<string, unknown>[] }).loops;
    expect((rows.find((row) => row.loop === 'bad') as Record<string, unknown>).stuckClaims)
      .toBeUndefined();
    expect((rows.find((row) => row.loop === 'fix') as Record<string, unknown>).stuckClaims)
      .toEqual([]);
  });

  it('is registered on the real CLI, and reports the stuck claim there too', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const { id } = await claimAsRun(target, DEAD);

    const run = cli([
      'status',
      '--target',
      target,
      '--loop',
      'fix',
      '--human',
      '--live-runs',
      snapshot(ALIVE),
    ]);
    expect(run.status).toBe(0);
    expect(run.combined).toContain(`1 stuck claim (${id} — run ${DEAD} is gone)`);
  }, E2E_TIMEOUT_MS);
});

// ── the stop condition, after the budget went away ──────
//
// `Task 1.3 — a spent budget refuses NEW work, and only new work` stood here
// and is deleted whole. It proved that `loop claim` and `loop file` refused
// once a run had outrun `max_run_minutes`, measured at the verb seams against
// the lock the run was holding — the CLI is not resident during a run, so the
// seams were the only place a budget could bite.
//
// There is no budget left to bite with. `run-budget.ts` is gone: a run is a
// Claude Code background agent, and that session's end is the end. Its siblings
// in that describe ("still lets the run close what it holds", "refuses nothing
// while the budget still holds") would now pass because nothing refuses
// anything, which is a test asserting the absence of code rather than the
// presence of behaviour.
//
// `max_run_minutes` survives as the ONE honest input it still has: how long a
// run's checkout stays reserved before a run that died stops holding it. That
// is the slot TTL, and Task 3.2 asserts it directly.

/** One minute, in the milliseconds the injected clock counts. */
const MINUTE_MS = 60_000;

/** `find` reserves its slot for 25m (a 20m nominal run + the 5m margin). */
const PRODUCER_LATE = NOW + 21 * MINUTE_MS;

/** Open the gate the way a run does, taking the loop's slot at `NOW`. */
async function startRun(target: string, loop: string, owner: string): Promise<Invocation> {
  const gate = await invoke('next', { target, loop, owner });
  expect(gate.json).toMatchObject({ verdict: 'proceed' });
  return gate;
}

describe('Task 1.4 — the stop condition, on the gate and on the record', () => {
  it('names `cap` when a producer has nowhere left to file', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await file(target, 'find', 'one');
    await file(target, 'find', 'two');

    const gate = await invoke('next', { target, loop: 'find', owner: 'beat-1' });
    expect(gate.json).toMatchObject({ verdict: 'skip', stopCondition: 'cap' });
  });

  it('names `empty` when a consumer has nothing left to claim', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const gate = await invoke('next', { target, loop: 'fix', owner: 'beat-1' });
    expect(gate.json).toMatchObject({ verdict: 'skip', stopCondition: 'empty' });
  });

  it('names `none`, and stamps the run, while there is work to do', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const gate = await startRun(target, 'find', 'beat-1');

    // No `budget` block beside the stamp any more: Phase 6 deleted the run
    // budget, so `runStartedAt` is what the gate reports about the run's clock
    // and nothing enforces a length against it.
    expect(gate.json).toMatchObject({
      stopCondition: 'none',
      runStartedAt: '2026-08-12T09:00:00.000Z',
    });
    expect(gate.json).not.toHaveProperty('budget');
  });

  it('keeps the ORIGINAL stamp when the run re-enters the gate late', async () => {
    // THE STAMP IS THE SLOT'S, and a re-entrant acquire keeps the `acquiredAt`
    // it started with — re-entering the gate extends the reservation, it does
    // not restart the run. That invariant outlived the budget that used to
    // measure against it, and it is still what every surface reads for "when
    // did this run start".
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await file(target, 'find', 'something to do');
    await startRun(target, 'find', 'beat-1');

    const again = await invoke(
      'next',
      { target, loop: 'find', owner: 'beat-1' },
      { clock: () => PRODUCER_LATE },
    );
    expect(again.json).toMatchObject({
      verdict: 'proceed',
      stopCondition: 'none',
      runStartedAt: '2026-08-12T09:00:00.000Z',
    });
    expect(String((again.json as { reason: string }).reason)).toContain("re-entered by 'beat-1'");
    // …and the reservation moved out to the new instant plus the margin
    expect((again.json as { lock: { expiresAt: string } }).lock.expiresAt).toBe(
      new Date(PRODUCER_LATE + 25 * MINUTE_MS).toISOString(),
    );
  });

  it('records the condition the beat reports, and reads it back off the log', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    await startRun(target, 'find', 'beat-1');

    const recorded = await invoke('log', {
      target,
      loop: 'find',
      owner: 'beat-1',
      record: JSON.stringify({
        kind: 'beat',
        loop: 'find',
        outcome: 'success',
        reason: 'swept until the queue was full',
        stopCondition: 'cap',
        filed: 2,
      }),
    });
    expect(recorded.exitCode).toBe(0);
    expect((recorded.json as { entry: { stopCondition?: string } }).entry.stopCondition).toBe('cap');

    const entries = readRunLog(join(target, 'flow'));
    expect(entries[entries.length - 1].stopCondition).toBe('cap');
  });

  it('refuses a condition outside the vocabulary, writing no line at all', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const before = readRunLog(join(target, 'flow')).length;

    const result = await invoke('log', {
      target,
      loop: 'find',
      owner: 'beat-1',
      record: JSON.stringify({
        kind: 'beat',
        loop: 'find',
        outcome: 'success',
        stopCondition: 'i just felt like stopping',
      }),
    });
    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('unknown stopCondition');
    expect(result.refusals[0]).toContain('cap|empty|budget|none');
    expect(readRunLog(join(target, 'flow')).length).toBe(before);
  });

  // DELETED WITH THE BUDGET: 'fills in `budget` when the beat names no
  // condition and its time is spent'. That was the ONE condition the CLI could
  // prove by itself — arithmetic over the lock the run was about to release —
  // and Phase 6 took the arithmetic away. An unreported condition is now left
  // unreported rather than guessed at: inventing `budget` here would put a
  // claim in the log that nothing observed. The test below is what that leaves.

  it('leaves the condition absent when nothing stopped the beat', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await file(target, 'fix', 'something to do');
    await startRun(target, 'fix', 'beat-1');

    const recorded = await record(target, 'fix', 'beat-1', 'success');
    expect((recorded.json as { entry: { stopCondition?: string } }).entry.stopCondition)
      .toBeUndefined();
  });

  it('renders the slot and the stop condition for a person, from the same object', async () => {
    // THE SLOT, AND WHEN IT LAPSES — not a budget. `max_run_minutes` no longer
    // stops anything; it sizes how long this run's checkout stays reserved if
    // the run dies without giving it back.
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const proceeding = await invoke('next', { target, loop: 'find', owner: 'beat-1', human: true });
    expect(proceeding.stdout).toContain(
      'slot 1: beat-1, started 2026-08-12T09:00:00.000Z (reserved until 2026-08-12T09:25:00.000Z)',
    );
    expect(proceeding.stdout).not.toContain('stop condition');

    await file(target, 'find', 'one');
    await file(target, 'find', 'two');
    const capped = await invoke('next', { target, loop: 'find', owner: 'beat-1', human: true });
    expect(capped.stdout).toContain('stop condition: cap');
  });
});

// ── loop autonomy, Phase 3: only your own work ───────────

/**
 * Put an item into a loop's queue the way a PERSON does: prose, no markers.
 *
 * This is issue #1509 in miniature. The beat that met it created a label and
 * appended the markers `file()` would have written so the item would fit its
 * schema, then worked it — so the fixture has to be an item that reaches the
 * loop's scope carrying none of them.
 */
function handFile(target: string, loop: string, title: string, id = '1509'): string {
  const path = join(target, 'flow', 'loops', 'queue.jsonl');
  const line = `${JSON.stringify({
    ts: '2026-08-12T08:00:00.000Z',
    id,
    event: 'filed',
    loop,
    title,
    body: 'Tapping a saved location does nothing on the second try.',
    provenance: 'human',
  })}\n`;
  const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
  writeFileSync(path, `${existing}${line}`, 'utf-8');
  return id;
}

/** Every event line currently in a project's ledger. */
function ledgerEvents(target: string): Array<Record<string, unknown>> {
  const path = join(target, 'flow', 'loops', 'queue.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Every line currently in the local record for items no loop filed. */
function foreignEvents(target: string): Array<Record<string, unknown>> {
  const path = join(target, 'flow', 'loops', 'foreign.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/**
 * THE DEFECT THIS SUITE EXISTS FOR.
 *
 * A previous phase made provenance gate consumer work, so `fix` — a loop whose
 * whole mission is draining the user's issue backlog — could not see a single
 * hand-filed issue. `loop status` reported `0 claimable`, `claim` came back
 * `empty`, and the loop was inert on a queue full of work.
 *
 * The rule that was right is still here and still checked below: the ONLY thing
 * a loop writes on an item a person filed is the claim label. What changed is
 * that it may now WORK one.
 */
describe('loop autonomy — a consumer works a hand-filed item, and writes only the claim label', () => {
  it('claims one by id — the exact call that used to refuse', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');
    await startRun(target, 'fix', 'beat-1');

    const result = await invoke('claim', { target, loop: 'fix', owner: 'beat-1', id });

    expect(result.exitCode).toBe(0);
    expect(result.refusals).toEqual([]);
    expect(result.json).toMatchObject({
      status: 'claimed',
      owner: 'beat-1',
      item: { id, title: 'Quick locations on the map is not working', claimedBy: 'beat-1' },
    });
  });

  it('reports it claimable, so `status` stops lying about an empty queue', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    handFile(target, 'fix', 'Quick locations on the map is not working');

    const status = await invoke('status', { target, loop: 'fix' });
    expect((status.json as { loops: Array<{ queue: { open: number; claimable: number } }> }).loops[0].queue)
      .toMatchObject({ open: 1, claimable: 1 });
  });

  it('leaves the item exactly as its author left it — the claim lives beside the queue', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');
    const before = ledgerEvents(target);
    await startRun(target, 'fix', 'beat-1');

    await invoke('claim', { target, loop: 'fix', owner: 'beat-1', id });

    // the person's record is byte-for-byte as they left it
    expect(ledgerEvents(target)).toEqual(before);
    // and what the loop knows about it went into its own store
    expect(foreignEvents(target)).toMatchObject([
      { backend: 'ledger', id, loop: 'fix', event: 'claimed', owner: 'beat-1' },
    ]);
  });

  it('takes the oldest first when sweeping, person or loop — a queue is a queue', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    handFile(target, 'fix', 'Quick locations on the map is not working');
    await file(target, 'fix', 'a finding the loop filed itself');
    await startRun(target, 'fix', 'beat-1');

    const claimed = await invoke('claim', { target, loop: 'fix', owner: 'beat-1' });
    expect(claimed.exitCode).toBe(0);
    expect(claimed.json).toMatchObject({
      status: 'claimed',
      item: { title: 'Quick locations on the map is not working' },
    });
  });

  it('closes it WITHOUT closing it — a handled record, and no write on the item', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');
    await startRun(target, 'fix', 'beat-1');
    await invoke('claim', { target, loop: 'fix', owner: 'beat-1', id });
    const before = ledgerEvents(target);

    const closed = await invoke('close', {
      target,
      loop: 'fix',
      id,
      owner: 'beat-1',
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });

    expect(closed.exitCode).toBe(0);
    expect(closed.json).toMatchObject({ status: 'handled', reason: 'done' });
    expect((closed.json as { note: string }).note).toContain(`Closes #${id}`);
    // the item is still OPEN and still untouched — GitHub closes it on the merge
    expect((closed.json as { item: { state: string } }).item.state).toBe('open');
    expect(ledgerEvents(target)).toEqual(before);
    expect(foreignEvents(target).map((event) => event.event)).toEqual(['claimed', 'handled']);
  });

  it('never claims it twice — the handled record is what stops the next beat', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');
    await startRun(target, 'fix', 'beat-1');
    await invoke('claim', { target, loop: 'fix', owner: 'beat-1', id });
    await invoke('close', {
      target,
      loop: 'fix',
      id,
      owner: 'beat-1',
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });

    const again = await invoke('claim', { target, loop: 'fix', owner: 'beat-1' });
    expect(again.exitCode).toBe(0);
    expect(again.json).toMatchObject({ status: 'empty' });

    const targeted = await invoke('claim', { target, loop: 'fix', owner: 'beat-1', id });
    expect(targeted.exitCode).toBe(1);
    expect(targeted.refusals[0]).toContain('already handled by this loop');
    expect(targeted.refusals[0]).toContain('planflow-ai loop rework --loop fix --id 1509');
  });

  it('is workable again once a person says the fix did not hold', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');
    await startRun(target, 'fix', 'beat-1');
    await invoke('claim', { target, loop: 'fix', owner: 'beat-1', id });
    await invoke('close', {
      target,
      loop: 'fix',
      id,
      owner: 'beat-1',
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });
    // a beat cannot let itself off — the loop is still held
    const midRun = await invoke('rework', { target, loop: 'fix', id, detail: 'it came back' });
    expect(midRun.exitCode).toBe(1);
    expect(midRun.refusals[0]).toContain("a person's decision, never a run's");

    await record(target, 'fix', 'beat-1', 'success');
    const reworked = await invoke('rework', { target, loop: 'fix', id, detail: 'it came back' });
    expect(reworked.exitCode).toBe(0);
    expect(reworked.json).toMatchObject({ status: 'reworked', loop: 'fix', id });

    await startRun(target, 'fix', 'beat-2');
    const claimed = await invoke('claim', { target, loop: 'fix', owner: 'beat-2', id });
    expect(claimed.exitCode).toBe(0);
    expect(claimed.json).toMatchObject({ status: 'claimed' });
  });

  it('still refuses to APPROVE one — that write was never about who works it', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');
    const before = ledgerEvents(target);

    const result = await invoke('approve', { target, loop: 'fix', id, owner: 'beat-1' });
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain('item 1509 carries no loop marker');
    expect(result.refusals[0]).toContain("`approve` would change someone else's item");
    expect(ledgerEvents(target)).toEqual(before);
  });

  it('a PRODUCER is unchanged — it files, it does not claim', async () => {
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    handFile(target, 'find', 'Quick locations on the map is not working');
    await startRun(target, 'find', 'beat-1');

    const targeted = await invoke('claim', { target, loop: 'find', owner: 'beat-1', id: '1509' });
    expect(targeted.exitCode).toBe(1);
    expect(targeted.refusals[0]).toContain('item 1509 carries no loop marker');
    expect(targeted.refusals[0]).toContain('planflow-ai loop adopt --loop find --id 1509');

    const sweeping = await invoke('claim', { target, loop: 'find', owner: 'beat-1' });
    expect(sweeping.json).toMatchObject({ status: 'empty' });
  });
});

describe('loop autonomy, Task 3.3 — adoption is a human act a beat cannot reach', () => {
  it('REFUSES while a beat holds the loop — the rule is structural, not advice', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');
    const before = ledgerEvents(target);

    // this is the beat's own situation: it opened the gate, so it holds the lock
    await startRun(target, 'fix', 'beat-1');
    const result = await invoke('adopt', {
      target,
      loop: 'fix',
      id,
      owner: 'beat-1',
      detail: 'it looked like ours',
    });

    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain("loop 'fix' is running");
    expect(result.refusals[0]).toContain("run 'beat-1' holds it");
    expect(result.refusals[0]).toContain("a person's decision, never a run's");
    expect(result.stdout).toBe('');
    // and it wrote nothing at all
    expect(ledgerEvents(target)).toEqual(before);
    expect(readRunLog(join(target, 'flow')).some((entry) => entry.kind === 'adopt')).toBe(false);
  });

  it('is refused for the whole life of the beat, and allowed once the beat has ended', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');
    await startRun(target, 'fix', 'beat-1');

    const adopt = { target, loop: 'fix', id, detail: 'triaged by hand — this is ours' };
    expect((await invoke('adopt', adopt)).exitCode).toBe(1);
    // even mid-beat, with the item claimed-adjacent work going on
    expect((await invoke('adopt', { ...adopt, owner: 'beat-1' })).exitCode).toBe(1);

    // the beat ends, releasing the loop
    await record(target, 'fix', 'beat-1', 'success');

    const adopted = await invoke('adopt', adopt);
    expect(adopted.exitCode).toBe(0);
    expect(adopted.json).toMatchObject({
      status: 'adopted',
      loop: 'fix',
      id,
      detail: 'triaged by hand — this is ours',
    });
  });

  it('writes the marker once, leaving the person\'s prose untouched', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');

    const adopted = await invoke('adopt', { target, loop: 'fix', id, detail: 'ours after all' });
    const item = (adopted.json as { item: { body: string; title: string; labels: string[] } }).item;

    expect(item.body).toContain('Tapping a saved location does nothing on the second try.');
    expect(item.body).toContain('<!-- loop: fix -->');
    expect(item.body.match(/<!-- loop: /g)).toHaveLength(1);
    // no fingerprint invented for someone else's title, no label applied
    expect(item.body).not.toContain('loop-fp:');
    expect(item.labels).toEqual([]);
    expect(item.title).toBe('Quick locations on the map is not working');

    // a second adoption is refused — the marker is written once
    const again = await invoke('adopt', { target, loop: 'fix', id, detail: 'again' });
    expect(again.exitCode).toBe(1);
    expect(again.refusals[0]).toContain('already belongs to');
  });

  it('records the decision where a person audits the loop', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');

    await invoke('adopt', {
      target,
      loop: 'fix',
      id,
      owner: 'devuser',
      detail: 'reported by a user, and it is this loop\'s area',
    });

    const adoptions = readRunLog(join(target, 'flow')).filter((entry) => entry.kind === 'adopt');
    expect(adoptions).toHaveLength(1);
    expect(adoptions[0]).toMatchObject({ loop: 'fix', owner: 'devuser' });
    expect(adoptions[0].reason).toContain('item 1509 adopted');
    expect(adoptions[0].reason).toContain("this loop's area");
  });

  it('only then may a beat claim it', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');
    await invoke('adopt', { target, loop: 'fix', id, detail: 'ours' });
    await startRun(target, 'fix', 'beat-1');

    const claimed = await invoke('claim', { target, loop: 'fix', owner: 'beat-1', id });
    expect(claimed.exitCode).toBe(0);
    expect(claimed.json).toMatchObject({ status: 'claimed', item: { id } });
  });

  it('requires the item and a written reason — an unexplained override records nothing', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');

    const noId = await invoke('adopt', { target, loop: 'fix', detail: 'why' });
    expect(noId.exitCode).toBe(1);
    expect(noId.refusals[0]).toContain('adopt requires --id <id>');

    const noReason = await invoke('adopt', { target, loop: 'fix', id });
    expect(noReason.exitCode).toBe(1);
    expect(noReason.refusals[0]).toContain('adopt requires --detail <why>');
    expect(readRunLog(join(target, 'flow')).some((entry) => entry.kind === 'adopt')).toBe(false);
  });

  it('renders the same object for a person', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = handFile(target, 'fix', 'Quick locations on the map is not working');
    const adopted = await invoke('adopt', {
      target,
      loop: 'fix',
      id,
      detail: 'ours',
      human: true,
    });
    expect(adopted.stdout.trim()).toBe(
      'adopted into fix: #1509 Quick locations on the map is not working — ours',
    );
  });

  it(
    'is registered on the real CLI, and refuses there the same way',
    () => {
      const target = makeProject({ fix: CONSUMER_DIRECTIVE });
      handFile(target, 'fix', 'Quick locations on the map is not working');

      const missing = cli(['adopt', '--loop', 'fix', '--id', '1509', '--target', target]);
      expect(missing.status).toBe(1);
      const refusals = missing.combined.split('\n').filter((line) => line.includes('loop refused:'));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain('adopt requires --detail <why>');

      const adopted = cli([
        'adopt',
        '--loop',
        'fix',
        '--id',
        '1509',
        '--detail',
        'ours',
        '--target',
        target,
      ]);
      expect(adopted.status).toBe(0);
      expect(JSON.parse(adopted.stdout.trim())).toMatchObject({ status: 'adopted', id: '1509' });
    },
    E2E_TIMEOUT_MS,
  );
});

/**
 * Phase 4 — `loop merge`, the one verb that lands code without a person.
 *
 * Every test here is written against the same worry: this is the largest
 * autonomy increase in the feature, so what is proven is not "does a merge
 * work" but "what does it take to make it refuse, and does the refusal happen
 * BEFORE anything irreversible". The exec log is asserted EMPTY on every
 * refusal path that can be decided without asking GitHub anything — the same
 * discipline the push carve-out has ("a refused push has run no git").
 *
 * No test in this file runs a real `gh`: the exec is injected, and the default
 * one throws (allowed-pattern #12).
 */

/** What `gh pr view --json` answers for the loop's own branch. */
function prJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 7,
    headRefName: 'loop/fix/1',
    state: 'OPEN',
    url: 'https://github.com/o/r/pull/7',
    ...overrides,
  });
}

/** An exec that answers `gh pr view` and records everything it was asked to run. */
function ghExec(view: string = prJson()) {
  return recordingExec({ 'gh pr view': view });
}

/** Evidence that clears the merge bar. */
const MERGE_EVIDENCE = JSON.stringify({
  commands: [
    { command: 'npm run typecheck', exitCode: 0 },
    { command: 'npm run build', exitCode: 0 },
    { command: 'npm run test -- src/cli/loop', exitCode: 0 },
  ],
  summary: 'reproduced, fixed, verified',
});

/** File one item under `fix`, claim it for `beat-1`, and return its id. */
async function claimedItem(target: string): Promise<string> {
  const filed = await file(target, 'fix', 'a bug the loop found itself');
  const id = String((filed.json as { item: { id: string } }).item.id);
  await startRun(target, 'fix', 'beat-1');
  const claimed = await invoke('claim', { target, loop: 'fix', owner: 'beat-1', id });
  expect(claimed.exitCode).toBe(0);
  return id;
}

describe('Task 4.3 — `loop merge` lands only this loop\'s branch, on captured evidence', () => {
  it('merges its own branch: views the PR, then squashes it — and deletes nothing', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimedItem(target);
    const gh = ghExec();

    const result = await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id, branch: 'loop/fix/1', evidence: MERGE_EVIDENCE },
      { exec: gh.exec },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({
      status: 'merged',
      loop: 'fix',
      id,
      branch: 'loop/fix/1',
      pr: { number: '7', url: 'https://github.com/o/r/pull/7' },
    });
    expect(gh.calls.map((call) => call.args.slice(0, 3))).toEqual([
      ['pr', 'view', 'loop/fix/1'],
      ['pr', 'merge', '7'],
    ]);
    expect(gh.calls[1].args).toContain('--squash');
    // the push carve-out refuses a branch deletion; merging does not acquire it
    expect(gh.calls[1].args).not.toContain('--delete-branch');
  });

  it('refuses a branch that is not this loop\'s, having run NOTHING', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE, find: PRODUCER_DIRECTIVE });
    const id = await claimedItem(target);

    for (const branch of ['main', 'feat/agent-loops', 'loop/find/3', 'loop/fixer/1', 'loop/fix/3:main']) {
      const gh = ghExec();
      const result = await invoke(
        'merge',
        { target, loop: 'fix', owner: 'beat-1', id, branch, evidence: MERGE_EVIDENCE },
        { exec: gh.exec },
      );
      expect(result.exitCode).toBe(1);
      expect(result.refusals).toHaveLength(1);
      expect(result.refusals[0].match(/loop refused:/g)).toHaveLength(1);
      expect(result.stdout).toBe('');
      // the gate ran before the network did — no `gh` call was issued at all
      expect(gh.calls).toHaveLength(0);
    }
  });

  it('refuses prose, missing evidence and a failing command, having run NOTHING', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimedItem(target);

    const cases: Array<{ evidence?: string; expect: string }> = [
      { expect: 'never prose alone' },
      { evidence: JSON.stringify({ summary: 'it all passes' }), expect: 'never prose alone' },
      {
        evidence: JSON.stringify({ commands: [{ command: 'npm run test', exitCode: 0 }] }),
        expect: 'missing a typecheck and a build',
      },
      {
        evidence: JSON.stringify({
          commands: [
            { command: 'npm run typecheck', exitCode: 0 },
            { command: 'npm run build', exitCode: 1 },
            { command: 'npm run test -- src/cli/loop', exitCode: 0 },
          ],
        }),
        expect: 'exited 1',
      },
    ];

    for (const testCase of cases) {
      const gh = ghExec();
      const result = await invoke(
        'merge',
        {
          target,
          loop: 'fix',
          owner: 'beat-1',
          id,
          branch: 'loop/fix/1',
          ...(testCase.evidence === undefined ? {} : { evidence: testCase.evidence }),
        },
        { exec: gh.exec },
      );
      expect(result.exitCode).toBe(1);
      expect(result.refusals[0]).toContain(testCase.expect);
      expect(gh.calls).toHaveLength(0);
    }
  });

  it('lands a fix for a person\'s item, and records it locally rather than on the item', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    handFile(target, 'fix', 'Quick locations on the map is not working');
    const before = ledgerEvents(target);
    const gh = ghExec();

    const result = await invoke(
      'merge',
      {
        target,
        loop: 'fix',
        owner: 'beat-1',
        id: '1509',
        branch: 'loop/fix/1',
        evidence: MERGE_EVIDENCE,
      },
      { exec: gh.exec },
    );

    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'merged', id: '1509' });
    expect((result.json as { note: string }).note).toContain('Closes #1509');
    // the person's item is byte-for-byte as they left it — no merge note on it
    expect(ledgerEvents(target)).toEqual(before);
    expect(foreignEvents(target).map((event) => event.event)).toEqual(['handled']);
  });

  it('lands another loop\'s item — a consumer drains the queue it is pointed at', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE, find: PRODUCER_DIRECTIVE });
    const filed = await file(target, 'find', 'something the producer found');
    const id = String((filed.json as { item: { id: string } }).item.id);
    const gh = ghExec();

    const result = await invoke(
      'merge',
      {
        target,
        loop: 'fix',
        owner: 'beat-1',
        id,
        branch: 'loop/fix/1',
        evidence: MERGE_EVIDENCE,
      },
      { exec: gh.exec },
    );

    expect(result.exitCode).toBe(0);
    // it IS a loop's item, so the merge is recorded on the item itself
    expect(ledgerEvents(target).some((event) => event.event === 'merged')).toBe(true);
    expect(foreignEvents(target)).toEqual([]);
  });

  it('a PRODUCER still lands only its own — the narrow rule survives where it belongs', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE, find: PRODUCER_DIRECTIVE });
    const filed = await file(target, 'fix', 'a finding filed under fix');
    const id = String((filed.json as { item: { id: string } }).item.id);
    const gh = ghExec();

    const result = await invoke(
      'merge',
      {
        target,
        loop: 'find',
        owner: 'beat-1',
        id,
        branch: 'loop/find/1',
        evidence: MERGE_EVIDENCE,
      },
      { exec: gh.exec },
    );

    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain("was filed by loop 'fix', not 'find'");
    expect(gh.calls).toHaveLength(0);
  });

  it('refuses when another beat holds the claim, and when the item does not exist', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const filed = await file(target, 'fix', 'a bug the loop found itself');
    const id = String((filed.json as { item: { id: string } }).item.id);
    await startRun(target, 'fix', 'beat-2');
    await invoke('claim', { target, loop: 'fix', owner: 'beat-2', id });

    const held = ghExec();
    const takenOver = await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id, branch: 'loop/fix/1', evidence: MERGE_EVIDENCE },
      { exec: held.exec },
    );
    expect(takenOver.exitCode).toBe(1);
    expect(takenOver.refusals[0]).toContain("is claimed by 'beat-2' — 'beat-1' cannot merge it");
    expect(held.calls).toHaveLength(0);

    const missing = ghExec();
    const ghost = await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id: '404', branch: 'loop/fix/404', evidence: MERGE_EVIDENCE },
      { exec: missing.exec },
    );
    expect(ghost.exitCode).toBe(1);
    expect(ghost.refusals[0]).toContain("no item '404' in the queue");
    expect(missing.calls).toHaveLength(0);
  });

  it('refuses to land a branch for work that was decided against', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimedItem(target);
    await invoke('close', {
      target,
      loop: 'fix',
      owner: 'beat-1',
      id,
      reason: 'wontfix',
      detail: 'the behaviour is intended',
    });
    const gh = ghExec();

    const result = await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id, branch: 'loop/fix/1', evidence: MERGE_EVIDENCE },
      { exec: gh.exec },
    );
    expect(result.exitCode).toBe(1);
    expect(result.refusals[0]).toContain("closed as 'wontfix'");
    expect(gh.calls).toHaveLength(0);
  });

  it('lands an item already closed as done — closing and merging are separate acts', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimedItem(target);
    await invoke('close', {
      target,
      loop: 'fix',
      owner: 'beat-1',
      id,
      reason: 'done',
      evidence: PASSING_EVIDENCE,
    });
    const gh = ghExec();

    const result = await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id, branch: 'loop/fix/1', evidence: MERGE_EVIDENCE },
      { exec: gh.exec },
    );
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'merged', id });
  });

  it('checks the RESOLVED head, not the one it was handed — and merges nothing on a mismatch', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimedItem(target);

    // `gh` resolves the branch to a pull request whose head is something else
    // entirely. Everything before this validated a string the caller wrote.
    const impostor = ghExec(prJson({ headRefName: 'main' }));
    const mismatched = await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id, branch: 'loop/fix/1', evidence: MERGE_EVIDENCE },
      { exec: impostor.exec },
    );
    expect(mismatched.exitCode).toBe(1);
    expect(mismatched.refusals[0]).toContain("proposes 'main', not 'loop/fix/1'");
    // the view happened; the merge did not
    expect(impostor.calls).toHaveLength(1);
    expect(impostor.calls[0].args.slice(0, 2)).toEqual(['pr', 'view']);

    const settled = ghExec(prJson({ state: 'MERGED' }));
    const closed = await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id, branch: 'loop/fix/1', evidence: MERGE_EVIDENCE },
      { exec: settled.exec },
    );
    expect(closed.exitCode).toBe(1);
    expect(closed.refusals[0]).toContain('only an open pull request can be merged');
    expect(settled.calls).toHaveLength(1);

    const unreadable = ghExec('not json at all');
    const garbled = await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id, branch: 'loop/fix/1', evidence: MERGE_EVIDENCE },
      { exec: unreadable.exec },
    );
    expect(garbled.exitCode).toBe(1);
    expect(garbled.refusals[0]).toContain('unparseable JSON');
    expect(unreadable.calls).toHaveLength(1);
  });

  it('collapses a gh failure into ONE refusal line, and records nothing', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimedItem(target);
    const before = ledgerEvents(target);

    const result = await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id, branch: 'loop/fix/1', evidence: MERGE_EVIDENCE },
      {
        exec: (fileName: string, args: readonly string[]) => {
          if (args[1] === 'view') return prJson();
          throw new Error(
            `Command failed: ${fileName} pr merge\nGraphQL: Protected branch update failed\nRequired status checks are expected.`,
          );
        },
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]).toContain('gh pr merge 7 failed');
    expect(result.refusals[0]).toContain('Protected branch update failed');
    expect(result.refusals[0]).not.toContain('\n');
    // the merge did not happen, so nothing claims it did
    expect(ledgerEvents(target)).toEqual(before);
    expect(readRunLog(join(target, 'flow')).some((entry) => entry.kind === 'merge')).toBe(false);
  });

  it('names the flags it needs rather than guessing at them', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    await claimedItem(target);

    const noId = await invoke('merge', { target, loop: 'fix', branch: 'loop/fix/1' });
    expect(noId.refusals[0]).toContain('merge requires --id <id>');

    const noBranch = await invoke('merge', { target, loop: 'fix', id: '1' });
    expect(noBranch.refusals[0]).toContain('merging requires --branch <loop/fix.<id>>');

    const noLoop = await invoke('merge', { target, id: '1', branch: 'loop/fix/1' });
    expect(noLoop.refusals[0]).toContain('merge requires --loop <name>');
  });
});

describe('Task 4.4 — a landed fix is traceable to the evidence that landed it', () => {
  it('records the merge on the item, with the captured commands verbatim', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimedItem(target);

    await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id, branch: 'loop/fix/1', evidence: MERGE_EVIDENCE },
      { exec: ghExec().exec },
    );

    const merged = ledgerEvents(target).filter((event) => event.event === 'merged');
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id,
      loop: 'fix',
      owner: 'beat-1',
      detail: "merged 'loop/fix/1' via PR #7 (https://github.com/o/r/pull/7)",
    });
    expect((merged[0].evidence as { commands: unknown[] }).commands).toHaveLength(3);
    // and the item is NOT settled by its branch landing — closing is its own act
    const items = ledgerEvents(target).filter((event) => event.event === 'closed');
    expect(items).toHaveLength(0);
  });

  it('records the merge in the beat log — the one line saying a loop changed main', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimedItem(target);

    await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id, branch: 'loop/fix/1', evidence: MERGE_EVIDENCE },
      { exec: ghExec().exec },
    );

    const merges = readRunLog(join(target, 'flow')).filter((entry) => entry.kind === 'merge');
    expect(merges).toHaveLength(1);
    expect(merges[0]).toMatchObject({ loop: 'fix', owner: 'beat-1' });
    expect(merges[0].reason).toContain(`item ${id} merged`);
    expect(merges[0].reason).toContain('loop/fix/1 via PR #7');
  });

  it('a refused merge records nothing at all', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimedItem(target);
    const before = ledgerEvents(target);

    await invoke(
      'merge',
      { target, loop: 'fix', owner: 'beat-1', id, branch: 'main', evidence: MERGE_EVIDENCE },
      { exec: ghExec().exec },
    );

    expect(ledgerEvents(target)).toEqual(before);
    expect(readRunLog(join(target, 'flow')).some((entry) => entry.kind === 'merge')).toBe(false);
  });

  it('renders the same object for a person, evidence included', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const id = await claimedItem(target);

    const result = await invoke(
      'merge',
      {
        target,
        loop: 'fix',
        owner: 'beat-1',
        id,
        branch: 'loop/fix/1',
        evidence: MERGE_EVIDENCE,
        human: true,
      },
      { exec: ghExec().exec },
    );

    expect(result.stdout).toContain('merged: loop/fix/1 → PR #7 (https://github.com/o/r/pull/7)');
    expect(result.stdout).toContain('item: #1 a bug the loop found itself');
    expect(result.stdout).toContain('npm run typecheck → exit 0');
    expect(result.stdout.trim().startsWith('{')).toBe(false);
  });

  it(
    'is registered on the real CLI, where a refused merge reaches gh not at all',
    () => {
      const target = makeProject({ fix: CONSUMER_DIRECTIVE });

      const result = cli([
        'merge',
        '--loop',
        'fix',
        '--id',
        '1',
        '--branch',
        'main',
        '--evidence',
        MERGE_EVIDENCE,
        '--target',
        target,
      ]);
      expect(result.status).toBe(1);
      const refusals = result.combined.split('\n').filter((line) => line.includes('loop refused:'));
      expect(refusals).toHaveLength(1);
      expect(refusals[0]).toContain("'main' is outside them");
      expect(result.combined).not.toContain('{"');
    },
    E2E_TIMEOUT_MS,
  );
});

// ── the loop that ends itself ────────────────────────────
//
// "If there are no issues in the to-do anymore or in doing, the loop will
// stop." A standing consumer used to skip a quiet queue forever — correct, and
// indistinguishable from a loop that is working, which is why nobody could tell
// whether one was still going.
//
// The gate's own rule stands and is what these guard: asking whether you may
// run does not change the answer for whoever asks next, UNLESS the caller asked
// for exactly this and the queue was exactly empty.

describe('`loop next --stop-when-empty` — a loop that runs until the list is empty', () => {
  it('switches the loop off when the queue is empty, and says so in the verdict', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const result = await invoke('next', {
      target,
      loop: 'fix',
      owner: 'beat-1',
      stopWhenEmpty: true,
    });

    // Nothing RAN — the verdict is unchanged. What changed is that the loop is
    // now off, which is the half a reader could not see before.
    expect(result.json).toMatchObject({ verdict: 'skip', stopCondition: 'empty' });
    expect(String((result.json as Record<string, unknown>).reason)).toContain('switched off');

    const state = readLoopState(join(target, 'flow'), NOW);
    expect(state.loops.fix?.pause?.reason).toContain('nothing left in the list');
  });

  it('writes NOTHING without the flag — every existing caller behaves as it did', async () => {
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const result = await invoke('next', { target, loop: 'fix', owner: 'beat-1' });

    expect(result.json).toMatchObject({ verdict: 'skip', stopCondition: 'empty' });
    expect(String((result.json as Record<string, unknown>).reason)).not.toContain('switched off');
    expect(readLoopState(join(target, 'flow'), NOW).loops.fix?.pause).toBeUndefined();
  });

  it('a producer at its cap is a reason to wait, not a reason to be over', async () => {
    // The narrowness IS the guard: only `empty` ends a loop. A cap, a busy slot
    // or a queue that could not be read are all states that resolve themselves,
    // and switching a loop off for one would need a person to switch it back on
    // for no reason at all.
    const target = makeProject({ find: PRODUCER_DIRECTIVE });
    const result = await invoke('next', {
      target,
      loop: 'find',
      owner: 'beat-1',
      stopWhenEmpty: true,
    });

    expect((result.json as Record<string, unknown>).stopCondition).not.toBe('empty');
    expect(readLoopState(join(target, 'flow'), NOW).loops.find?.pause).toBeUndefined();
  });

  it('the switch-off is a STATE pause — the committed directive is untouched', async () => {
    // A person's `paused:` in the file is what the team agreed this loop is
    // for. A machine writing to it would turn "the list is empty today" into a
    // commit somebody has to undo.
    const target = makeProject({ fix: CONSUMER_DIRECTIVE });
    const before = readFileSync(join(target, 'flow', 'loops', 'fix.md'), 'utf-8');
    await invoke('next', { target, loop: 'fix', owner: 'beat-1', stopWhenEmpty: true });
    expect(readFileSync(join(target, 'flow', 'loops', 'fix.md'), 'utf-8')).toBe(before);
  });
})

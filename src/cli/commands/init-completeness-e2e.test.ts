/**
 * Live E2E for `planflow-ai init` completeness — the three install-time steps a
 * user had to perform BY HAND on a second machine, exercised through the REAL
 * built CLI (`dist/cli/index.js`) as a subprocess against throwaway projects.
 *
 * WHY A SUBPROCESS SUITE EXISTS NEXT TO THE UNIT TESTS. `path-rails.test.ts`,
 * `heartbeat.test.ts` and `shared.test.ts` prove each step in process with every
 * seam injected. None of them can prove the thing that actually broke: that the
 * SHIPPED binary, launched fresh in a project it has never seen, finishes the
 * job. The incident was a second machine — `planflow-ai: command not found`,
 * then `npm link` dying on a root-owned prefix, then a daemon still running
 * pre-upgrade code, then `no directive for loop 'fix'` because nothing had ever
 * provisioned `loops/`. Every one of those is a whole-process fact.
 *
 * SAFETY — this file runs a real installer, so isolation is the design, not a
 * detail. Each of these is enforced mechanically below, not by care:
 *
 *   - EVERY run passes an explicit `--target` inside the sandbox AND runs with
 *     `cwd` there (`runCli` asserts both), because an `init` whose cwd drifts
 *     re-provisions THIS repository — a recorded incident, not a hypothetical.
 *   - `HOME` points at a sandbox directory, so the shim rung can only ever
 *     write to a throwaway `~/.local/bin` and a shell profile it might touch is
 *     a throwaway one. The ladder test additionally asserts the REAL home came
 *     through byte-identical (Phase 2 resolves its defaults per CALL precisely
 *     so an injected HOME is honoured — this is where that claim is checked
 *     from a subprocess, which is the only place it matters).
 *   - `PLAN_FLOW_VAULT_DIR` points at a sandbox vault, so the real central
 *     vault is never written.
 *   - No real `npm link` is ever attempted: the ladder test's PATH carries a
 *     STUB npm that logs its argv and reports a root-owned prefix, and the log
 *     is asserted to contain no `link` at all. The other tests carry a stub
 *     `planflow-ai` so the ladder short-circuits at rung 1 on any machine.
 *   - The only daemon ever signalled is one whose PID was read from the
 *     sandbox's own pid file, or a fake `node` process this suite spawned. The
 *     machine's real daemon is never touched.
 *
 * ASSERTIONS RUN ON stdout+stderr COMBINED (allowed-pattern #15) — this CLI's
 * logger routes `error()` through `console.log`, so a stderr-only assertion
 * passes vacuously.
 *
 * The suite requires the built CLI. When `dist/cli/index.js` is absent it fails
 * loud rather than skipping: the built artifact IS the subject under test.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, relative, sep } from 'node:path';

const { getPackageRoot } = await import('../utils/files.js');
const { parseLoopDirective } = await import('../loop/directive-parser.js');

const PACKAGE_ROOT = getPackageRoot();
const CLI_PATH = join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

/** The version the installed CLI reports — never hardcoded, always the package's. */
const INSTALLED_VERSION = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf-8')) as { version: string }
).version;

/**
 * The shipped directive templates, read from the package rather than listed
 * here — the assertion is "init seeds what the package ships", and a hardcoded
 * list would quietly stop testing that the day a fourth loop is added.
 */
const TEMPLATE_FILES = readdirSync(join(PACKAGE_ROOT, 'templates', 'loops'))
  .filter((entry) => entry.endsWith('.md'))
  .sort();

const E2E_TIMEOUT_MS = 240_000;

/** Shell profile names the rails must never write. Seeded, then compared. */
const SHELL_PROFILES = ['.zshrc', '.bashrc', '.bash_profile', '.profile', '.zprofile'] as const;

/** Poll interval while waiting for a process to actually exit. */
const EXIT_POLL_MS = 100;

/** Bounded wait for a signalled process to disappear. */
const EXIT_TIMEOUT_MS = 10_000;

interface CliRun {
  stdout: string;
  stderr: string;
  status: number | null;
  /** stdout+stderr — the transcript a user actually sees (allowed-pattern #15). */
  all: string;
}

/** A stub binary: an executable `sh` script placed on a sandbox PATH. */
function writeStub(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`, 'utf-8');
  chmodSync(path, 0o755);
  return path;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number): Promise<boolean> {
  const deadline = Date.now() + EXIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, EXIT_POLL_MS));
  }
  return !isAlive(pid);
}

/** Every regular file under a directory, as sandbox-relative paths. */
function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else if (entry.isFile()) out.push(relative(base, full));
  }
  return out.sort();
}

/** name → bytes, for byte-identity assertions over a whole directory. */
function snapshotDir(dir: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const file of walk(dir)) snapshot[file] = readFileSync(join(dir, file), 'utf-8');
  return snapshot;
}

/** Existence + bytes of a file, tolerating absence — for untouched-ness checks. */
function fileState(path: string): string {
  return existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf-8') : '<absent>';
}

describe('init completeness E2E — real built CLI into throwaway projects', () => {
  let sandbox: string;
  let home: string;
  let vault: string;
  let project: string;
  let binDir: string;

  /** Fake processes this suite spawned, killed in cleanup no matter what. */
  let fakePids: number[];

  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(
        `init-completeness-e2e requires the built CLI at ${CLI_PATH} — run \`npm run build\` first`
      );
    }
    expect(TEMPLATE_FILES.length).toBeGreaterThan(0);
  });

  /** A bare git fixture project inside the sandbox, optionally with an origin. */
  function makeProject(name: string, origin?: string): string {
    const dir = join(sandbox, name);
    mkdirSync(dir, { recursive: true });
    const git = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf-8' });
    if (git.status !== 0) throw new Error(`git init failed: ${git.stderr}`);
    writeFileSync(join(dir, 'package.json'), `{"name":"${name}"}\n`);
    if (origin !== undefined) {
      const remote = spawnSync('git', ['remote', 'add', 'origin', origin], {
        cwd: dir,
        encoding: 'utf-8',
      });
      if (remote.status !== 0) throw new Error(`git remote add failed: ${remote.stderr}`);
    }
    return dir;
  }

  /**
   * Run the built CLI as a subprocess.
   *
   * The two `expect`s are LOAD-BEARING SAFETY, not assertions about behaviour:
   * a target or cwd outside the sandbox means this suite is about to provision
   * a real directory, so it fails before spawning anything.
   */
  function runCli(
    args: string[],
    opts: { cwd?: string; path?: string; stdin?: string } = {}
  ): CliRun {
    const cwd = opts.cwd ?? project;
    expect(cwd.startsWith(sandbox + sep)).toBe(true);
    const targetIndex = args.indexOf('--target');
    expect(targetIndex).toBeGreaterThanOrEqual(0);
    expect(args[targetIndex + 1]?.startsWith(sandbox + sep)).toBe(true);

    const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      env: {
        ...process.env,
        HOME: home,
        PLAN_FLOW_VAULT_DIR: vault,
        PATH: opts.path ?? `${binDir}${delimiter}${process.env.PATH ?? ''}`,
        // OPTED BACK IN, deliberately (#1848). The jest setup turns
        // fire-and-forget work off for every test, because a detached daemon
        // outlives the test and writes into a temp directory the suite is
        // deleting. THIS suite is the one that tests the daemon: it sandboxes
        // HOME and the vault, it knows every pid it starts, and it stops them.
        // So it is the one caller entitled to the real thing.
        PLANFLOW_NO_BACKGROUND_WORK: '',
      },
      timeout: E2E_TIMEOUT_MS,
      // STDIN IS PART OF THE SUBJECT. `input: ''` is an empty stream that has
      // already ended — what a CI step, a Makefile or an agent gives this
      // command, and what used to end the install mid-prompt at exit 0 (#1795).
      ...(opts.stdin === undefined ? {} : { input: opts.stdin }),
    });
    if (result.error) throw result.error;
    const stdout = result.stdout ?? '';
    const stderr = result.stderr ?? '';
    return { stdout, stderr, status: result.status, all: `${stdout}\n${stderr}` };
  }

  function initProject(target = project, opts: { path?: string } = {}): CliRun {
    return runCli(['init', '--claude', '--yes', '--target', target], {
      cwd: target,
      ...(opts.path === undefined ? {} : { path: opts.path }),
    });
  }

  const pidPath = (target: string): string => join(target, 'flow', '.heartbeat.pid');
  const sidecarPath = (target: string): string => join(target, 'flow', '.heartbeat.version');

  function daemonPid(target = project): number | null {
    const path = pidPath(target);
    if (!existsSync(path)) return null;
    const parsed = Number.parseInt(readFileSync(path, 'utf-8').trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Kill a PID that came from a SANDBOX pid file or from `spawnFake`.
   * The guard is the point: this suite must never be able to signal the real
   * heartbeat daemon on the developer's machine.
   */
  async function stopPid(pid: number | null): Promise<void> {
    if (pid === null || !isAlive(pid)) return;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return;
    }
    await waitForExit(pid);
  }

  /**
   * A long-lived process that is NOT a daemon — a stand-in for a stale one.
   *
   * DOUBLE-FORKED THROUGH `sh` ON PURPOSE. A process spawned directly by jest
   * is jest's child, and a child that dies stays a ZOMBIE until its parent
   * reaps it — `kill(pid, 0)` succeeds on a zombie, so the CLI's
   * `waitForPidToClear` would watch a corpse for its full 5s budget and report
   * "did not exit", testing jest's process bookkeeping instead of the restart.
   * Letting `sh` exit immediately reparents the process to init/launchd, which
   * reaps it — the same situation a real detached daemon is in.
   */
  function spawnFake(): number {
    const launched = spawnSync(
      '/bin/sh',
      ['-c', `${process.execPath} -e 'setInterval(() => {}, 1000)' >/dev/null 2>&1 & echo $!`],
      { encoding: 'utf-8' }
    );
    const pid = Number.parseInt((launched.stdout ?? '').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      throw new Error(`failed to spawn the fake daemon process: ${launched.stderr ?? ''}`);
    }
    fakePids.push(pid);
    return pid;
  }

  beforeEach(() => {
    fakePids = [];
    sandbox = mkdtempSync(join(tmpdir(), 'init-complete-e2e-'));
    home = join(sandbox, 'home');
    vault = join(sandbox, 'vault');
    binDir = join(sandbox, 'bin');
    mkdirSync(home, { recursive: true });
    mkdirSync(vault, { recursive: true });

    // Stubs that make the default runs hermetic on ANY machine:
    //   planflow-ai — already resolves, so the PATH ladder stops at rung 1 and
    //     no `npm link` is even considered (the ladder itself has its own test).
    //   graphify    — already installed, so the graphify rails never reach an
    //     install command and init's background derive cannot build a real graph
    //     in a temp directory.
    writeStub(binDir, 'planflow-ai', 'exit 0');
    writeStub(binDir, 'graphify', 'exit 0');

    project = makeProject('proj');
  });

  afterEach(async () => {
    // Any daemon this suite started lives in the sandbox; kill it by the PID the
    // sandbox itself recorded, never by name and never from the real project.
    for (const dir of existsSync(sandbox) ? readdirSync(sandbox) : []) {
      await stopPid(daemonPid(join(sandbox, dir)));
    }
    for (const pid of fakePids) await stopPid(pid);

    // Cleanup is best-effort and never the verdict on a test whose assertions
    // already passed — init fires background work that can out-live the CLI.
    try {
      rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 });
    } catch (error) {
      console.warn(
        `[init-completeness-e2e] sandbox cleanup lost a race, leaving ${sandbox}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  });

  // ── Task 4.1 — a provisioned project can actually run a beat ──────────────

  it(
    '(4.1) init seeds loops/ and every seeded directive parses — in process and through the shipped binary',
    () => {
      const init = initProject();
      expect(init.status).toBe(0);

      const loopsDir = join(project, 'loops');
      expect(readdirSync(loopsDir).sort()).toEqual(TEMPLATE_FILES);
      expect(init.all).toContain(
        `Loops: seeded ${TEMPLATE_FILES.length} paused directive(s) in loops/`
      );
      // THE LEDGER FORM WHATEVER THE REMOTE IS (18c5ea3b). The old wording —
      // "no GitHub remote resolved" — described a rule where a remote could
      // have chosen the list; it cannot any more, so the notice no longer
      // mentions git and neither does this.
      expect(init.all).toContain("queue: ledger (this project's own list)");

      // Every seeded file parses under the REAL parser, named by its own file.
      for (const file of TEMPLATE_FILES) {
        const name = file.slice(0, -'.md'.length);
        const directive = parseLoopDirective(readFileSync(join(loopsDir, file), 'utf-8'), file);
        expect(directive.loop).toBe(name);
        // Seeded, therefore paused: a loop nobody has read is pointed at a guess.
        expect(directive.paused).toBe(true);
        expect(directive.queue).toBe('ledger');
        expect(directive.repo).toBeUndefined();
        expect(directive.mission.length).toBeGreaterThan(0);
      }

      // …and through the binary a beat actually invokes. `loop status` is
      // fail-soft per row: a directive that refuses shows up as `directiveError`
      // rather than a non-zero exit, so the exit code alone would prove nothing.
      const status = runCli(['loop', 'status', '--target', project]);
      expect(status.status).toBe(0);
      const lines = status.stdout.trim().split('\n');
      const report = JSON.parse(lines[lines.length - 1]) as {
        loops: {
          loop: string;
          directiveError?: string;
          directivePaused?: boolean;
          queueKind?: string;
        }[];
      };
      expect(report.loops.map((row) => row.loop).sort()).toEqual(
        TEMPLATE_FILES.map((file) => file.slice(0, -'.md'.length))
      );
      for (const row of report.loops) {
        expect(row.directiveError).toBeUndefined();
        expect(row.directivePaused).toBe(true);
        expect(row.queueKind).toBe('ledger');
      }
    },
    E2E_TIMEOUT_MS
  );

  // THE LIST IS A CHOICE, NOT A CONSEQUENCE OF HAVING A REMOTE.
  //
  // This test used to assert the opposite — that a github.com origin bound the
  // seeded directives to `queue: github` + that repo. Reported live by someone
  // who had never chosen GitHub: their panel said "This project · queue" while
  // every run demanded `gh auth login`, because `init` had read their remote at
  // install time and decided for them. "The local project should be a local todo
  // list not github; the git should be checked only if the user select the git."
  //
  // A remote says where code is PUSHED. It says nothing about where this
  // project's work is LISTED, and reading one as the other is the silent guess
  // the thread-remote binding refuses by design (allowed-pattern #22). Pointing
  // a loop at GitHub is now something a person does — the panel's "Change", or
  // `loop point --queue github --repo owner/name`.
  it(
    '(4.1) seeding keeps the local list whatever the remote is — GitHub is chosen, never inferred',
    () => {
      for (const [name, origin] of [
        ['gh-proj', 'https://github.com/acme/widgets.git'],
        ['gl-proj', 'git@gitlab.com:acme/widgets.git'],
        ['none-proj', null],
      ] as const) {
        const dir = makeProject(name, origin ?? undefined);
        const init = initProject(dir);
        expect(init.status).toBe(0);
        expect(init.all).toContain("queue: ledger (this project's own list)");

        for (const file of TEMPLATE_FILES) {
          const content = readFileSync(join(dir, 'loops', file), 'utf-8');
          expect(content).toContain('queue: ledger');
          // `repo:` under `queue: ledger` is a directive that refuses to parse,
          // so the placeholder must stay a comment.
          expect(content).not.toMatch(/^repo: /m);
          const directive = parseLoopDirective(content, file);
          expect(directive.queue).toBe('ledger');
          expect(directive.repo).toBeUndefined();
        }
      }
    },
    E2E_TIMEOUT_MS
  );

  // ── Task 4.2 — seeding never overwrites ───────────────────────────────────

  it(
    '(4.2) a re-run over an edited directive changes nothing — edits survive and a deleted directive stays deleted',
    () => {
      expect(initProject().status).toBe(0);
      const loopsDir = join(project, 'loops');

      // The two things a user does to a seeded directory: steer one directive,
      // and throw away one they do not want.
      const edited = join(loopsDir, TEMPLATE_FILES[0]);
      const editedContent = `${readFileSync(edited, 'utf-8')
        .replace('paused: true', 'paused: false')
        .replace(/^mission: .*$/m, 'mission: MY OWN MISSION — must survive init')}\n<!-- hand edit -->\n`;
      writeFileSync(edited, editedContent, 'utf-8');

      const deleted = join(loopsDir, TEMPLATE_FILES[TEMPLATE_FILES.length - 1]);
      rmSync(deleted);

      const before = snapshotDir(loopsDir);
      const second = initProject();
      expect(second.status).toBe(0);
      expect(second.all).toContain('loops/ already has directives');
      expect(second.all).not.toContain('Loops: seeded');

      // Byte-identical across the whole directory…
      expect(snapshotDir(loopsDir)).toEqual(before);
      expect(readFileSync(edited, 'utf-8')).toBe(editedContent);
      // …and the deletion is a decision, not damage init re-repairs.
      expect(existsSync(deleted)).toBe(false);
    },
    E2E_TIMEOUT_MS
  );

  // ── Task 4.3 — a daemon running old code is restarted exactly once ────────

  it(
    '(4.3) a stale (pre-sidecar) daemon is restarted once, and the next run leaves the current one alone',
    async () => {
      expect(initProject().status).toBe(0);
      const started = daemonPid();
      expect(started).not.toBeNull();
      expect(readFileSync(sidecarPath(project), 'utf-8').trim()).toBe(INSTALLED_VERSION);

      // Retire the daemon init just started and put a FAKE long-lived process in
      // its place with NO version sidecar — exactly the shape of a daemon
      // started before this feature existed. (A fake, never the real daemon on
      // this machine, and never one this suite cannot account for.)
      await stopPid(started);
      const stale = spawnFake();
      writeFileSync(pidPath(project), String(stale), 'utf-8');
      rmSync(sidecarPath(project), { force: true });
      expect(isAlive(stale)).toBe(true);

      const restart = initProject();
      expect(restart.status).toBe(0);
      expect(restart.all).toContain(
        `Heartbeat daemon restarted — version unknown → ${INSTALLED_VERSION}`
      );

      // The stale process really died — a "restart" that leaves old code running
      // is the exact bug this step exists to fix.
      expect(await waitForExit(stale)).toBe(true);

      const restarted = daemonPid();
      expect(restarted).not.toBeNull();
      expect(restarted).not.toBe(stale);
      expect(isAlive(restarted as number)).toBe(true);
      expect(readFileSync(sidecarPath(project), 'utf-8').trim()).toBe(INSTALLED_VERSION);

      // …and exactly ONCE: the next run sees a matching sidecar and does nothing.
      const third = initProject();
      expect(third.status).toBe(0);
      expect(third.all).toContain(
        `Heartbeat daemon already running (PID: ${restarted}, version ${INSTALLED_VERSION})`
      );
      expect(third.all).not.toContain('Heartbeat daemon restarted');
      expect(daemonPid()).toBe(restarted);
    },
    E2E_TIMEOUT_MS
  );

  // ── Task 4.4 — the PATH ladder, from a subprocess ─────────────────────────

  it(
    '(4.4) the PATH ladder skips a root-owned npm prefix without attempting a link, writes a shim under the INJECTED home, and never writes a shell profile',
    () => {
      // A PATH built from scratch: a stub bin plus the system directories. It
      // carries no real `planflow-ai` (so the ladder must actually run) and no
      // real `npm`, `uv` or `pipx` (so nothing can be installed for real).
      const ladderBin = join(sandbox, 'ladder-bin');
      const npmLog = join(sandbox, 'npm-calls.log');
      writeStub(
        ladderBin,
        'npm',
        [
          `echo "$@" >> "${npmLog}"`,
          // A root-owned prefix — the documented second-machine failure. Its
          // `lib/node_modules` does not exist, so ownership is decided by the
          // nearest existing ancestor, /usr/lib, which root owns.
          'if [ "$1" = "prefix" ]; then echo "/usr"; exit 0; fi',
          'exit 0',
        ].join('\n')
      );
      writeStub(ladderBin, 'graphify', 'exit 0');
      // A `sudo` that only records that it was reached. Asserting the absence of
      // the WORD in the transcript would be worthless — the skip notice says
      // "(never sudo)" itself. Only "the command was never invoked" is a claim.
      const sudoLog = join(sandbox, 'sudo-calls.log');
      writeStub(ladderBin, 'sudo', [`echo "$@" >> "${sudoLog}"`, 'exit 1'].join('\n'));
      const ladderPath = [ladderBin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);

      // Seed the sandbox home's shell profiles — the rails must not touch them.
      for (const profile of SHELL_PROFILES) {
        writeFileSync(join(home, profile), `# sentinel ${profile}\n`, 'utf-8');
      }
      const profilesBefore = Object.fromEntries(
        SHELL_PROFILES.map((p) => [p, readFileSync(join(home, p), 'utf-8')])
      );

      // The REAL home — Phase 2 resolves its defaults per call so an injected
      // HOME wins. That claim only matters from a subprocess, so it is checked
      // here: these three facts must be identical afterwards.
      const realHome = homedir();
      const realBefore = {
        shim: fileState(join(realHome, '.local', 'bin', 'planflow-ai')),
        ...Object.fromEntries(SHELL_PROFILES.map((p) => [p, fileState(join(realHome, p))])),
      };

      const init = initProject(project, { path: ladderPath });
      expect(init.status).toBe(0);

      // The root-owned prefix is PREDICTED and skipped — never attempted, never sudo.
      expect(init.all).toContain(
        'npm global prefix /usr/lib is not writable by this user — skipping npm link (never sudo).'
      );
      expect(existsSync(sudoLog)).toBe(false);
      const npmCalls = existsSync(npmLog) ? readFileSync(npmLog, 'utf-8') : '';
      expect(npmCalls).toContain('prefix -g');
      expect(npmCalls).not.toContain('link');
      expect(existsSync('/usr/lib/node_modules')).toBe(false);

      // Rung 3 — an executable shim SCRIPT (never an alias: agents run
      // non-interactive shells) under the INJECTED home, naming this checkout.
      const shim = join(home, '.local', 'bin', 'planflow-ai');
      expect(existsSync(shim)).toBe(true);
      expect(statSync(shim).mode & 0o777).toBe(0o755);
      const shimContent = readFileSync(shim, 'utf-8');
      expect(shimContent.startsWith('#!/bin/sh')).toBe(true);
      expect(shimContent).toContain(`exec node "${join(PACKAGE_ROOT, 'dist', 'cli', 'index.js')}"`);
      expect(shimContent).not.toContain('alias');
      expect(init.all).toContain(`CLI: wrote \`planflow-ai\` shim to ${shim}`);

      // Rung 4 — the export line is PRINTED, and that is all. No profile in the
      // sandbox home was created or modified, and no file anywhere under it
      // (the shim included) contains an export line.
      const pathLine = `export PATH="${join(home, '.local', 'bin')}:$PATH"`;
      expect(init.all).toContain(pathLine);
      for (const profile of SHELL_PROFILES) {
        expect(readFileSync(join(home, profile), 'utf-8')).toBe(profilesBefore[profile]);
      }
      const homeFilesWithExport = walk(home).filter((file) =>
        readFileSync(join(home, file), 'utf-8').includes('export PATH')
      );
      expect(homeFilesWithExport).toEqual([]);

      // The real home came through untouched — the injected HOME really won.
      expect({
        shim: fileState(join(realHome, '.local', 'bin', 'planflow-ai')),
        ...Object.fromEntries(SHELL_PROFILES.map((p) => [p, fileState(join(realHome, p))])),
      }).toEqual(realBefore);
    },
    E2E_TIMEOUT_MS
  );
  /**
   * #1795 — a non-interactive `init` finishes, or it is not a success.
   *
   * `init --all` is interactive, and `rl.question()` on a stdin that has ended
   * NEVER SETTLES: the awaited promise stays pending, the event loop drains,
   * and the process exits **0** wherever the prompt happened to be. How much
   * got installed depended only on how many answers were on stdin — nothing at
   * all with stdin closed, `.claude` and no `flow/` with one answer piped —
   * and neither printed a word after the prompt or returned a non-zero code.
   *
   * This matters because the failing form is the DOCUMENTED one: `README.md`
   * and `CLAUDE.md` both give `init --all` with no `-y`, so a CI step following
   * this project's own instructions got exit 0 over an unprovisioned repo. And
   * a partial install is worse than none — `.claude` present with `flow/`
   * missing reads to a later reader as "already installed".
   *
   * The bar is PARITY, not "more files than before": the same end state `-y`
   * reaches. Anything less and the prompts have merely moved the stopping
   * point, which is exactly what the first attempt at this fix did — each
   * prompt builds its own `createInterface`, and stdin only ends once, so
   * racing the `close` event fixed the first prompt and left the second
   * hanging one step further in.
   */
  describe('a non-interactive install finishes (#1795)', () => {
    /** Every file an install produced, sandbox-relative and sorted. */
    function installed(target: string): string[] {
      return walk(target)
        .filter((file) => !file.startsWith(`.git${sep}`) && file !== '.git')
        .sort();
    }

    it.each([
      ['stdin closed', ''],
      ['one answer piped, prompts left after it', '1\n'],
    ])(
      'reaches the same end state as -y with %s',
      (_label, stdin) => {
        const reference = makeProject('noninteractive-y', 'https://github.com/acme/widgets.git');
        const subject = makeProject('noninteractive-subject', 'https://github.com/acme/widgets.git');

        const yes = runCli(['init', '--all', '--yes', '--target', reference], {
          cwd: reference,
          stdin: '',
        });
        const bare = runCli(['init', '--all', '--target', subject], { cwd: subject, stdin });

        expect(yes.status).toBe(0);
        // A success code over an install that did not happen is the one answer
        // that cannot be right — so the code AND the files are both asserted.
        expect(bare.status).toBe(0);
        expect(installed(subject)).toEqual(installed(reference));
        expect(installed(subject).length).toBeGreaterThan(0);
      },
      E2E_TIMEOUT_MS
    );

    it(
      'still honours an answer that WAS piped in — EOF is a default, not an override',
      () => {
        const shared = makeProject('noninteractive-shared', 'https://github.com/acme/widgets.git');
        const local = makeProject('noninteractive-local', 'https://github.com/acme/widgets.git');

        // "2" is the share-mode choice, and it is the answer that publishes a
        // project's brain — so it must never be reachable by accident, and
        // never lost when it was given on purpose.
        runCli(['init', '--all', '--target', shared], { cwd: shared, stdin: '2\n' });
        runCli(['init', '--all', '--target', local], { cwd: local, stdin: '' });

        expect(readFileSync(join(shared, 'flow', '.flowconfig'), 'utf-8')).toContain(
          'share: shared'
        );
        expect(readFileSync(join(local, 'flow', '.flowconfig'), 'utf-8')).toContain('share: local');
      },
      E2E_TIMEOUT_MS
    );
  });
});

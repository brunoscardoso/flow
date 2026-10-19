/**
 * Tests for the planflow-ai PATH rails
 *
 * Two things these tests must never do, because doing them is the failure the
 * rails exist to prevent:
 *   - run a real `npm link` or a real `which` (subprocess behavior is injected,
 *     and `node:child_process` is module-mocked for the default-deps case —
 *     NEVER a `process.env.PATH` stub, which children inherit from the real env
 *     and which therefore depends on what is installed on the machine)
 *   - write to the real `~/.local/bin` or any real shell profile (the home
 *     directory is injected and always a temp dir)
 */

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';

const execSyncMock = jest.fn<(command: string, options?: unknown) => string>();

jest.unstable_mockModule('node:child_process', () => ({
  execSync: execSyncMock,
  spawn: jest.fn(),
}));

const {
  canWriteDir,
  ensurePlanflowOnPath,
  isBrokenRailsShim,
  isEphemeralResolution,
  globalModulesDir,
  pathContainsDir,
  repairPlanflowShim,
  shimContent,
} = await import('./path-rails.js');
type PathRailsDeps = import('./path-rails.js').PathRailsDeps;

const CHECKOUT = '/opt/checkouts/plan-flow';

interface FakeExecOptions {
  /** Binaries `which <bin>` resolves for, mapped to the path it prints. */
  resolves: Map<string, string>;
  /** When true, `npm link` throws instead of succeeding. */
  failLink?: boolean;
  /** When set, `npm prefix -g` prints this; when null it throws. */
  npmPrefix?: string | null;
  /** Path `which planflow-ai` prints AFTER a successful link (null = still missing). */
  linkedPath?: string | null;
}

/** Build a fake `exec` dep plus a log of every command it was asked to run. */
function makeExec(options: FakeExecOptions): {
  exec: PathRailsDeps['exec'];
  calls: { command: string; cwd?: string }[];
} {
  const calls: { command: string; cwd?: string }[] = [];
  const resolves = new Map(options.resolves);
  const exec: PathRailsDeps['exec'] = (command: string, _timeoutMs: number, cwd?: string): string => {
    calls.push({ command, cwd });
    // `which` on POSIX, `where` on Windows — the rails pick the tool, the fake
    // answers either so the same scenario can be run on both platforms.
    const lookup = ['which ', 'where '].find((tool) => command.startsWith(tool));
    if (lookup) {
      const binary = command.slice(lookup.length);
      const resolved = resolves.get(binary);
      if (resolved !== undefined) return `${resolved}\n`;
      throw new Error(`${lookup.trim()}: no ${binary} in (...)`);
    }
    if (command === 'npm prefix -g') {
      if (options.npmPrefix === null || options.npmPrefix === undefined) {
        throw new Error('npm prefix failed');
      }
      return `${options.npmPrefix}\n`;
    }
    if (command === 'npm link') {
      if (options.failLink) throw new Error('npm ERR! code EACCES');
      if (options.linkedPath) resolves.set('planflow-ai', options.linkedPath);
      return '';
    }
    throw new Error(`unexpected command: ${command}`);
  };
  return { exec, calls };
}

function commandsOf(calls: { command: string }[]): string[] {
  return calls.map((call) => call.command);
}

function createHome(): string {
  return mkdtempSync(join(tmpdir(), 'plan-flow-path-rails-home-'));
}

// Rails print via the logger (console.log). Capture instead of emitting.
let logged: string[];

beforeEach(() => {
  logged = [];
  execSyncMock.mockReset();
  jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function transcript(): string {
  return logged.join('\n');
}

describe('ensurePlanflowOnPath', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = createHome();
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  // ── Task 2.1: detect, and do nothing when it already resolves ────────────
  describe('already resolves', () => {
    it('does nothing when `which planflow-ai` resolves', async () => {
      const { exec, calls } = makeExec({
        resolves: new Map([['planflow-ai', '/usr/local/bin/planflow-ai']]),
      });

      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => true,
        homeDir,
        pathValue: '/usr/local/bin',
        packageRoot: CHECKOUT,
      });

      expect(result.outcome).toBe('already-resolves');
      expect(result.notice).toContain('/usr/local/bin/planflow-ai');
      expect(result.pathLine).toBeNull();
      expect(result.shimPath).toBeNull();
      // Exactly one probe, and nothing else attempted.
      expect(commandsOf(calls)).toEqual(['which planflow-ai']);
      // No shim written anywhere under home.
      expect(readdirSync(homeDir)).toEqual([]);
    });

    it('does NOT count an npx-temporary resolution as installed', async () => {
      // `npx planflow-ai init` puts a temp bin on PATH for that one command.
      // Reporting success there leaves the next shell with command not found.
      const { exec } = makeExec({
        resolves: new Map([['planflow-ai', '/Users/x/.npm/_npx/abc123/node_modules/.bin/planflow-ai']]),
        npmPrefix: null,
      });

      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => false,
        homeDir,
        pathValue: '/usr/bin',
        packageRoot: CHECKOUT,
      });

      expect(result.outcome).toBe('shim-written');
    });

    it('classifies ephemeral resolutions', () => {
      expect(isEphemeralResolution('/Users/x/.npm/_npx/abc/node_modules/.bin/planflow-ai')).toBe(true);
      expect(isEphemeralResolution('/repo/node_modules/.bin/planflow-ai')).toBe(true);
      expect(isEphemeralResolution('/usr/local/bin/planflow-ai')).toBe(false);
      expect(isEphemeralResolution('/Users/x/.local/bin/planflow-ai')).toBe(false);
    });

    it('routes `which` through execSync when no exec is injected', async () => {
      // Default-deps path: the module-mocked child_process proves the real
      // rail calls execSync (and that nothing else ever runs for real).
      execSyncMock.mockReturnValue('/usr/local/bin/planflow-ai\n');

      const result = await ensurePlanflowOnPath({ homeDir, packageRoot: CHECKOUT });

      expect(result.outcome).toBe('already-resolves');
      expect(execSyncMock).toHaveBeenCalledTimes(1);
      expect(execSyncMock.mock.calls[0]?.[0]).toBe('which planflow-ai');
    });
  });

  // ── Task 2.2: refuse a root-owned prefix BEFORE attempting anything ──────
  describe('npm global prefix', () => {
    it('never attempts npm link when the global prefix is not user-writable', async () => {
      // A stand-in for the root-owned `/usr/local` that produced the original
      // `EACCES: permission denied, mkdir '/usr/local/lib/node_modules'`.
      const prefix = mkdtempSync(join(tmpdir(), 'plan-flow-prefix-'));
      mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
      const { exec, calls } = makeExec({
        resolves: new Map([['npm', '/usr/bin/npm']]),
        npmPrefix: prefix,
      });
      const canWrite = jest.fn<(dir: string) => boolean>().mockReturnValue(false);

      try {
        const result = await ensurePlanflowOnPath({
          exec,
          canWrite,
          homeDir,
          pathValue: '/usr/bin',
          packageRoot: CHECKOUT,
        });

        // The EACCES is PREDICTED, not caught: `npm link` was never run.
        expect(commandsOf(calls)).not.toContain('npm link');
        expect(canWrite).toHaveBeenCalledWith(join(prefix, 'lib', 'node_modules'));
        expect(result.outcome).toBe('shim-written');
        expect(transcript()).toContain('not writable by this user');
        expect(transcript()).toContain('never sudo');
        // And absolutely no sudo anywhere.
        expect(commandsOf(calls).join(' ')).not.toContain('sudo');
      } finally {
        rmSync(prefix, { recursive: true, force: true });
      }
    });

    it('links via npm when the prefix is writable', async () => {
      const { exec, calls } = makeExec({
        resolves: new Map([['npm', '/usr/bin/npm']]),
        npmPrefix: '/Users/x/.npm-global',
        linkedPath: '/Users/x/.npm-global/bin/planflow-ai',
      });

      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => true,
        homeDir,
        pathValue: '/Users/x/.npm-global/bin',
        packageRoot: CHECKOUT,
      });

      expect(result.outcome).toBe('linked-via-npm');
      expect(result.notice).toContain('/Users/x/.npm-global/bin/planflow-ai');
      // Linked from the checkout it is meant to expose.
      expect(calls.find((call) => call.command === 'npm link')?.cwd).toBe(CHECKOUT);
      // No shim needed when the link worked.
      expect(readdirSync(homeDir)).toEqual([]);
    });

    it('falls through to the shim when npm link fails', async () => {
      const { exec, calls } = makeExec({
        resolves: new Map([['npm', '/usr/bin/npm']]),
        npmPrefix: '/Users/x/.npm-global',
        failLink: true,
      });

      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => true,
        homeDir,
        pathValue: '/usr/bin',
        packageRoot: CHECKOUT,
      });

      expect(commandsOf(calls)).toContain('npm link');
      expect(result.outcome).toBe('shim-written');
    });

    it('falls through to the shim when npm link succeeds but the name still does not resolve', async () => {
      // A link into a prefix whose bin/ is not on PATH is not a resolution.
      const { exec } = makeExec({
        resolves: new Map([['npm', '/usr/bin/npm']]),
        npmPrefix: '/Users/x/.npm-global',
        linkedPath: null,
      });

      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => true,
        homeDir,
        pathValue: '/usr/bin',
        packageRoot: CHECKOUT,
      });

      expect(result.outcome).toBe('shim-written');
    });

    it('skips the prefix rung entirely when npm itself is missing', async () => {
      const { exec, calls } = makeExec({ resolves: new Map() });

      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => true,
        homeDir,
        pathValue: '/usr/bin',
        packageRoot: CHECKOUT,
      });

      expect(commandsOf(calls)).toEqual(['which planflow-ai', 'which npm']);
      expect(result.outcome).toBe('shim-written');
    });

    it('resolves the prefix directory npm link would have to write into', () => {
      // Nearest EXISTING ancestor: ownership of a directory that does not exist
      // yet is decided by the parent that would have to create it.
      const dir = mkdtempSync(join(tmpdir(), 'plan-flow-prefix-'));
      try {
        expect(globalModulesDir(dir)).toBe(dir);
        mkdirSync(join(dir, 'lib', 'node_modules'), { recursive: true });
        expect(globalModulesDir(dir)).toBe(join(dir, 'lib', 'node_modules'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── Task 2.3: a shim that names the checkout it points at ────────────────
  describe('shim', () => {
    async function writeShimViaRails(pathValue = '/usr/bin'): Promise<{ shimPath: string | null }> {
      const { exec } = makeExec({ resolves: new Map() });
      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => false,
        homeDir,
        pathValue,
        packageRoot: CHECKOUT,
      });
      return { shimPath: result.shimPath };
    }

    it('writes an executable shim to ~/.local/bin/planflow-ai', async () => {
      const { shimPath } = await writeShimViaRails();

      expect(shimPath).toBe(join(homeDir, '.local', 'bin', 'planflow-ai'));
      const content = readFileSync(shimPath as string, 'utf-8');
      expect(content.startsWith('#!/bin/sh\n')).toBe(true);
      expect(content).toContain(`exec node "${join(CHECKOUT, 'dist', 'cli', 'index.js')}" "$@"`);
      // Executable by the owner.
      expect(statSync(shimPath as string).mode & 0o111).not.toBe(0);
    });

    it('names the checkout inside the shim so a stale one is diagnosable', async () => {
      const { shimPath } = await writeShimViaRails();

      const content = readFileSync(shimPath as string, 'utf-8');
      expect(content).toContain(CHECKOUT);
      expect(content).toContain('written by plan-flow');
      expect(content).toContain('stale');
    });

    it('is a script, never a shell alias — aliases do not exist in agent shells', async () => {
      const { shimPath } = await writeShimViaRails();

      const content = readFileSync(shimPath as string, 'utf-8');
      expect(content).not.toMatch(/^\s*alias /m);
    });

    it('is idempotent — a second run leaves byte-identical content', async () => {
      const first = await writeShimViaRails();
      const before = readFileSync(first.shimPath as string, 'utf-8');

      const second = await writeShimViaRails();

      expect(second.shimPath).toBe(first.shimPath);
      expect(readFileSync(second.shimPath as string, 'utf-8')).toBe(before);
    });

    it('shimContent is a pure function of the checkout path', () => {
      expect(shimContent('/a/b')).toBe(shimContent('/a/b'));
      expect(shimContent('/a/b')).not.toBe(shimContent('/a/c'));
    });

    it('degrades to a notice when the shim cannot be written', async () => {
      // A home directory that is a regular file: mkdir under it fails.
      const notADir = join(homeDir, 'not-a-home');
      writeFileSync(notADir, 'x');
      const { exec } = makeExec({ resolves: new Map() });

      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => false,
        homeDir: notADir,
        pathValue: '/usr/bin',
        packageRoot: CHECKOUT,
      });

      expect(result.outcome).toBe('unavailable');
      expect(result.shimPath).toBeNull();
      expect(result.notice).toContain(join(CHECKOUT, 'dist', 'cli', 'index.js'));
      expect(transcript()).toContain('Could not put');
    });
  });

  // ── Task 2.4: print the PATH line, never write it ────────────────────────
  describe('PATH line', () => {
    it('prints the exact export line when the shim directory is not on PATH', async () => {
      const { exec } = makeExec({ resolves: new Map() });

      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => false,
        homeDir,
        pathValue: '/usr/bin:/bin',
        packageRoot: CHECKOUT,
      });

      const shimDir = join(homeDir, '.local', 'bin');
      expect(result.pathLine).toBe(`export PATH="${shimDir}:$PATH"`);
      expect(transcript()).toContain(`export PATH="${shimDir}:$PATH"`);
      expect(result.notice).toContain('export PATH=');
    });

    it('NEVER writes a shell profile', async () => {
      // The rails may print the line; writing it is the user's decision.
      const { exec } = makeExec({ resolves: new Map() });

      await ensurePlanflowOnPath({
        exec,
        canWrite: () => false,
        homeDir,
        pathValue: '/usr/bin',
        packageRoot: CHECKOUT,
      });

      for (const profile of ['.zshrc', '.bashrc', '.bash_profile', '.profile', '.config']) {
        expect(readdirSync(homeDir)).not.toContain(profile);
      }
      // Only the shim directory was created.
      expect(readdirSync(homeDir)).toEqual(['.local']);
    });

    it('asks for nothing when the shim directory is already on PATH', async () => {
      const { exec } = makeExec({ resolves: new Map() });
      const shimDir = join(homeDir, '.local', 'bin');

      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => false,
        homeDir,
        // Trailing slash: the same directory, spelled differently.
        pathValue: `/usr/bin:${shimDir}/`,
        packageRoot: CHECKOUT,
      });

      expect(result.outcome).toBe('shim-written');
      expect(result.pathLine).toBeNull();
      expect(transcript()).not.toContain('export PATH=');
    });

    it('compares PATH entries resolved, not textually', () => {
      expect(pathContainsDir('/usr/bin:/home/x/.local/bin', '/home/x/.local/bin')).toBe(true);
      expect(pathContainsDir('/usr/bin:/home/x/.local/bin/', '/home/x/.local/bin')).toBe(true);
      expect(pathContainsDir('/usr/bin::/bin', '/home/x/.local/bin')).toBe(false);
      expect(pathContainsDir('', '/home/x/.local/bin')).toBe(false);
    });
  });

  // ── B6: the Windows branch, asserted from a POSIX host (NFR3) ────────────
  describe('win32', () => {
    const WINDOWS_CHECKOUT = 'C:\\Users\\me\\Projects\\plan-flow';

    async function writeWindowsShim(pathValue = 'C:\\Windows\\System32'): Promise<{
      shimPath: string | null;
      pathLine: string | null;
      notice: string;
      calls: { command: string }[];
    }> {
      const { exec, calls } = makeExec({ resolves: new Map() });
      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => false,
        homeDir,
        pathValue,
        packageRoot: WINDOWS_CHECKOUT,
        platform: 'win32',
      });
      return { ...result, calls };
    }

    it('writes a `.cmd` shim — an extensionless file resolves to nothing', async () => {
      const { shimPath } = await writeWindowsShim();

      // PATHEXT is `.COM;.EXE;.BAT;.CMD;…`: without the extension the command
      // is simply missing, and the session never says so.
      expect(shimPath).toBe(join(homeDir, '.local', 'bin', 'planflow-ai.cmd'));
      expect(readdirSync(join(homeDir, '.local', 'bin'))).toEqual(['planflow-ai.cmd']);
    });

    it('writes cmd.exe content — CRLF, ASCII only, and an exit-code line', async () => {
      const { shimPath } = await writeWindowsShim();
      const content = readFileSync(shimPath as string, 'utf-8');

      expect(content.startsWith('@echo off\r\n')).toBe(true);
      expect(content).toContain(
        `node "${WINDOWS_CHECKOUT}\\dist\\cli\\index.js" %*`
      );
      // cmd.exe drops the child's exit code without this line, so every failed
      // CLI verb would report success.
      expect(content).toContain('exit /b %ERRORLEVEL%');
      expect(content).not.toContain('#!/bin/sh');
      // eslint-disable-next-line no-control-regex
      expect(/^[\x00-\x7F]*$/.test(content)).toBe(true);
    });

    it('SKIPS chmod on Windows rather than calling a no-op that reads as protection', async () => {
      const { shimPath } = await writeWindowsShim();

      // Running on POSIX, so the absence of the exec bit is observable: the
      // rails never chmodded. (On Windows the call would have been a lie.)
      expect(statSync(shimPath as string).mode & 0o111).toBe(0);
    });

    it('probes with `where`, never `which`', async () => {
      const { calls } = await writeWindowsShim();

      expect(commandsOf(calls)).toContain('where planflow-ai');
      expect(commandsOf(calls).some((command) => command.startsWith('which '))).toBe(false);
    });

    it('prints a PowerShell PATH line, never `export PATH`', async () => {
      const { pathLine, notice } = await writeWindowsShim();
      const shimDir = join(homeDir, '.local', 'bin');

      expect(pathLine).not.toBeNull();
      expect(pathLine).not.toContain('export PATH');
      expect(pathLine).toContain('SetEnvironmentVariable');
      expect(pathLine).toContain(shimDir);
      expect(transcript()).toContain('PowerShell');
      expect(notice).toContain('PowerShell');
    });

    it('says nothing about PATH when the shim directory is already on it', async () => {
      const shimDir = join(homeDir, '.local', 'bin');
      // Windows splits PATH on `;` and compares case-insensitively.
      const { pathLine } = await writeWindowsShim(
        `C:\\Windows\\System32;${shimDir.toUpperCase()}`
      );

      // The uppercased entry is the SAME directory on Windows.
      expect(pathLine).toBeNull();
    });

    it('leaves the POSIX shim untouched when both are written in turn', async () => {
      await writeWindowsShim();
      const { exec } = makeExec({ resolves: new Map() });
      await ensurePlanflowOnPath({
        exec,
        canWrite: () => false,
        homeDir,
        pathValue: '/usr/bin',
        packageRoot: CHECKOUT,
        platform: 'linux',
      });

      const posixShim = join(homeDir, '.local', 'bin', 'planflow-ai');
      expect(readFileSync(posixShim, 'utf-8').startsWith('#!/bin/sh\n')).toBe(true);
      expect(statSync(posixShim).mode & 0o111).not.toBe(0);
    });

    it('splits PATH on `;` and compares entries case-insensitively', () => {
      expect(
        pathContainsDir('C:\\Windows;C:\\Users\\me\\.local\\bin', 'C:\\Users\\me\\.local\\bin', 'win32')
      ).toBe(true);
      expect(
        pathContainsDir('C:\\Windows;c:\\users\\me\\.local\\bin\\', 'C:\\Users\\me\\.local\\bin', 'win32')
      ).toBe(true);
      // A `:`-joined Windows PATH is one nonsense entry, not two.
      expect(
        pathContainsDir('C:\\Windows:C:\\Users\\me\\.local\\bin', 'C:\\Users\\me\\.local\\bin', 'win32')
      ).toBe(false);
      // POSIX stays case-SENSITIVE — two different directories.
      expect(pathContainsDir('/home/X/.local/bin', '/home/x/.local/bin', 'linux')).toBe(false);
    });

    it('classifies backslash-spelled ephemeral resolutions', () => {
      // `where.exe` prints backslashes; the markers are spelled with `/`.
      expect(
        isEphemeralResolution(
          'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\.bin\\planflow-ai.cmd',
          'win32'
        )
      ).toBe(true);
      expect(
        isEphemeralResolution('C:\\Users\\me\\.local\\bin\\planflow-ai.cmd', 'win32')
      ).toBe(false);
    });

    it('does not veto every directory through a uid gate that means nothing on Windows', () => {
      // `fs.Stats.uid` is 0 for EVERY file on Windows and `process.getuid` does
      // not exist there, so the POSIX predicate would read "root-owned, not
      // running as root" for the whole filesystem and skip the npm link rung
      // unconditionally.
      const dir = mkdtempSync(join(tmpdir(), 'plan-flow-canwrite-'));
      try {
        expect(canWriteDir(dir, 'win32')).toBe(true);
        expect(canWriteDir(join(dir, 'does-not-exist'), 'win32')).toBe(false);
        // POSIX behaviour is unchanged for an ordinary user-owned directory.
        expect(canWriteDir(dir, 'linux')).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  // ── #1944: the app-bundle layout ships planflow-ai.mjs, not dist/cli/... ──
  describe('app bundle layout (#1944)', () => {
    it('writes a shim that execs the bundle entry that EXISTS, never dist/cli/index.js', async () => {
      // A packageRoot shaped like Contents/Resources/cli: one planflow-ai.mjs,
      // a planflow-ai package.json, NO dist/ tree. The bug wrote a shim at
      // <root>/dist/cli/index.js — a file that does not exist.
      const bundle = mkdtempSync(join(tmpdir(), 'plan-flow-bundle-'));
      writeFileSync(join(bundle, 'planflow-ai.mjs'), 'console.log("cli")');
      writeFileSync(join(bundle, 'package.json'), '{"name":"planflow-ai","type":"module"}');
      try {
        const { exec } = makeExec({ resolves: new Map() });
        const result = await ensurePlanflowOnPath({
          exec,
          canWrite: () => false,
          homeDir,
          pathValue: '/usr/bin',
          packageRoot: bundle,
          platform: 'linux',
        });

        const content = readFileSync(result.shimPath as string, 'utf-8');
        expect(content).toContain('planflow-ai.mjs');
        // The whole point of the fix: no dead dist/cli/index.js entry.
        expect(content).not.toContain('index.js');
      } finally {
        rmSync(bundle, { recursive: true, force: true });
      }
    });

    it('shimContent resolves the bundle entry when planflow-ai.mjs exists beside it', () => {
      const bundle = mkdtempSync(join(tmpdir(), 'plan-flow-bundle-'));
      writeFileSync(join(bundle, 'planflow-ai.mjs'), '');
      try {
        const content = shimContent(bundle, 'linux');
        expect(content).toContain('planflow-ai.mjs');
        expect(content).not.toContain('index.js');
      } finally {
        rmSync(bundle, { recursive: true, force: true });
      }
    });

    it('still uses the checkout entry when there is no bundle file beside the root', () => {
      // A real checkout has dist/cli/index.js and NO planflow-ai.mjs — unchanged.
      const content = shimContent(CHECKOUT, 'linux');
      expect(content).toContain(`${CHECKOUT}/dist/cli/index.js`);
      expect(content).not.toContain('planflow-ai.mjs');
    });
  });

  // ── #1944: self-heal a rails shim whose target entry has gone missing ─────
  describe('self-heal broken shim (#1944)', () => {
    // A minimal rails shim carrying the provenance line the detector keys on.
    const railsShim = (entry: string): string =>
      `#!/bin/sh\n# planflow-ai shim — written by plan-flow's \`planflow-ai init\`.\nexec node "${entry}" "$@"\n`;

    it('flags a rails shim whose exec target is missing, and clears a healthy one', () => {
      const shim = railsShim('/anywhere/dist/cli/index.js');
      expect(isBrokenRailsShim('x', () => shim, () => false)).toBe(true);
      expect(isBrokenRailsShim('x', () => shim, () => true)).toBe(false);
    });

    it('never claims a FOREIGN planflow-ai (no provenance line)', () => {
      const foreign = '#!/bin/sh\nexec node "/some/other/cli.js" "$@"\n';
      expect(isBrokenRailsShim('x', () => foreign, () => false)).toBe(false);
    });

    it('is "not broken" when the file cannot be read', () => {
      expect(
        isBrokenRailsShim('x', () => {
          throw new Error('EACCES');
        }, () => false)
      ).toBe(false);
    });

    it('rewrites a rails shim on PATH whose target has gone missing', async () => {
      const shimDir = join(homeDir, '.local', 'bin');
      mkdirSync(shimDir, { recursive: true });
      const shimPath = join(shimDir, 'planflow-ai');
      // Pre-existing broken shim: points at a dist/cli/index.js that isn't there.
      writeFileSync(shimPath, shimContent('/opt/gone/plan-flow', 'linux'));

      // init is now running from a real bundle (planflow-ai.mjs present).
      const bundle = mkdtempSync(join(tmpdir(), 'plan-flow-bundle-'));
      writeFileSync(join(bundle, 'planflow-ai.mjs'), '');
      try {
        const { exec } = makeExec({ resolves: new Map([['planflow-ai', shimPath]]) });
        const result = await ensurePlanflowOnPath({
          exec,
          canWrite: () => false,
          homeDir,
          pathValue: shimDir,
          packageRoot: bundle,
          platform: 'linux',
        });

        // NOT reported as a working install — it was rewritten.
        expect(result.outcome).toBe('shim-written');
        const rewritten = readFileSync(shimPath, 'utf-8');
        expect(rewritten).toContain('planflow-ai.mjs');
        expect(rewritten).not.toContain('index.js');
      } finally {
        rmSync(bundle, { recursive: true, force: true });
      }
    });

    it('leaves a HEALTHY rails shim alone (already-resolves, no rewrite)', async () => {
      const shimDir = join(homeDir, '.local', 'bin');
      mkdirSync(shimDir, { recursive: true });
      const shimPath = join(shimDir, 'planflow-ai');
      const bundle = mkdtempSync(join(tmpdir(), 'plan-flow-bundle-'));
      writeFileSync(join(bundle, 'planflow-ai.mjs'), '');
      writeFileSync(shimPath, shimContent(bundle, 'linux')); // entry exists
      try {
        const { exec, calls } = makeExec({ resolves: new Map([['planflow-ai', shimPath]]) });
        const result = await ensurePlanflowOnPath({
          exec,
          canWrite: () => false,
          homeDir,
          pathValue: shimDir,
          packageRoot: bundle,
          platform: 'linux',
        });

        expect(result.outcome).toBe('already-resolves');
        // Rung 1 returned immediately — nothing else was attempted.
        expect(commandsOf(calls)).toEqual(['which planflow-ai']);
      } finally {
        rmSync(bundle, { recursive: true, force: true });
      }
    });

    it('never rewrites a foreign planflow-ai resolved on PATH', async () => {
      const foreign = join(homeDir, 'foreign-planflow-ai');
      writeFileSync(foreign, '#!/bin/sh\nexec node "/some/other/cli.js" "$@"\n');
      const { exec } = makeExec({ resolves: new Map([['planflow-ai', foreign]]) });

      const result = await ensurePlanflowOnPath({
        exec,
        canWrite: () => false,
        homeDir,
        pathValue: '/usr/bin',
        packageRoot: CHECKOUT,
        platform: 'linux',
      });

      expect(result.outcome).toBe('already-resolves');
    });
  });

  it('never runs sudo on any rung', async () => {
    const { exec, calls } = makeExec({
      resolves: new Map([['npm', '/usr/bin/npm']]),
      npmPrefix: '/usr/local',
    });

    await ensurePlanflowOnPath({
      exec,
      canWrite: () => false,
      homeDir,
      pathValue: '/usr/bin',
      packageRoot: CHECKOUT,
    });

    expect(commandsOf(calls).some((command) => command.includes('sudo'))).toBe(false);
  });
});

// ── Stale shim repair (tasklist BUG 2026-10-05) ─────────────────────────────
// A shim init wrote can outlive its target: an app update replaced the bundle
// (which never had a `dist/`), or the checkout/scratch build it named was
// deleted. `which` still finds the FILE, so nothing noticed.
describe('stale shim repair', () => {
  let homeDir: string;
  let bundleRoot: string;

  beforeEach(() => {
    homeDir = createHome();
    // A real bundle layout: package.json + planflow-ai.mjs at the root, no dist/.
    bundleRoot = mkdtempSync(join(tmpdir(), 'plan-flow-bundle-'));
    writeFileSync(join(bundleRoot, 'package.json'), '{"name":"planflow-ai"}');
    writeFileSync(join(bundleRoot, 'planflow-ai.mjs'), '// bundle');
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(bundleRoot, { recursive: true, force: true });
  });

  const shimAt = (): string => join(homeDir, '.local', 'bin', 'planflow-ai');

  function seedShim(content: string): void {
    mkdirSync(join(homeDir, '.local', 'bin'), { recursive: true });
    writeFileSync(shimAt(), content, { mode: 0o755 });
  }

  it('a shim written from the bundle runs the bundle entry, not a dist/ that does not exist', () => {
    const content = shimContent(bundleRoot, 'darwin');
    expect(content).toContain(`exec node "${join(bundleRoot, 'planflow-ai.mjs')}" "$@"`);
    expect(content).not.toContain('dist/cli/index.js');
  });

  it('rewrites a plan-flow shim whose target no longer exists', () => {
    // The shape on the user's machine: an old app layout that is gone.
    const gone = '/Applications/Flow.app/Contents/Resources/cli';
    seedShim(shimContent(gone, 'darwin', () => false));
    expect(readFileSync(shimAt(), 'utf-8')).toContain(`${gone}/dist/cli/index.js`);

    const result = repairPlanflowShim({ homeDir, packageRoot: bundleRoot, platform: 'darwin' });

    expect(result.outcome).toBe('rewritten');
    expect(result.previousTarget).toBe(`${gone}/dist/cli/index.js`);
    const after = readFileSync(shimAt(), 'utf-8');
    expect(after).toContain(`exec node "${join(bundleRoot, 'planflow-ai.mjs')}" "$@"`);
    expect(statSync(shimAt()).mode & 0o111).not.toBe(0);
    expect(result.notice).toContain('rewrote the stale');
  });

  it('leaves a user-owned file at that path untouched, with one line saying so', () => {
    const mine = '#!/bin/sh\nexec /home/me/tools/my-planflow "$@"\n';
    seedShim(mine);
    const before = statSync(shimAt()).mtimeMs;

    const result = repairPlanflowShim({ homeDir, packageRoot: bundleRoot, platform: 'darwin' });

    expect(result.outcome).toBe('foreign');
    expect(result.notice).toBe(`CLI: ${shimAt()} was not written by plan-flow — left untouched.`);
    expect(result.notice).not.toContain('\n');
    expect(readFileSync(shimAt(), 'utf-8')).toBe(mine);
    expect(statSync(shimAt()).mtimeMs).toBe(before);
  });

  it('leaves a correct shim exactly as it is (content and mtime)', () => {
    seedShim(shimContent(bundleRoot, 'darwin'));
    const old = new Date('2026-01-01T00:00:00Z');
    utimesSync(shimAt(), old, old);
    const before = statSync(shimAt()).mtimeMs;

    const result = repairPlanflowShim({ homeDir, packageRoot: bundleRoot, platform: 'darwin' });

    expect(result.outcome).toBe('current');
    expect(result.notice).toBeNull();
    expect(statSync(shimAt()).mtimeMs).toBe(before);
  });

  it('leaves a plan-flow shim that names another LIVE checkout alone', () => {
    const otherCheckout = mkdtempSync(join(tmpdir(), 'plan-flow-other-checkout-'));
    try {
      mkdirSync(join(otherCheckout, 'dist', 'cli'), { recursive: true });
      writeFileSync(join(otherCheckout, 'dist', 'cli', 'index.js'), '');
      const theirs = shimContent(otherCheckout, 'darwin');
      seedShim(theirs);

      const result = repairPlanflowShim({ homeDir, packageRoot: bundleRoot, platform: 'darwin' });

      expect(result.outcome).toBe('other-live');
      expect(readFileSync(shimAt(), 'utf-8')).toBe(theirs);
    } finally {
      rmSync(otherCheckout, { recursive: true, force: true });
    }
  });

  it('never creates a shim that is not there', () => {
    const result = repairPlanflowShim({ homeDir, packageRoot: bundleRoot, platform: 'darwin' });
    expect(result.outcome).toBe('absent');
    expect(readdirSync(homeDir)).toEqual([]);
  });

  it('init repairs a stale shim even though `which` still finds the file', async () => {
    seedShim(shimContent('/deleted/scratch/build', 'darwin', () => false));
    const { exec, calls } = makeExec({ resolves: new Map([['planflow-ai', shimAt()]]) });

    const result = await ensurePlanflowOnPath({
      exec,
      canWrite: () => false,
      homeDir,
      pathValue: join(homeDir, '.local', 'bin'),
      packageRoot: bundleRoot,
      platform: 'darwin',
    });

    // State the positive first: the stale file WAS what `which` would answer.
    expect(result.outcome).toBe('shim-written');
    expect(result.shimPath).toBe(shimAt());
    expect(readFileSync(shimAt(), 'utf-8')).toContain(join(bundleRoot, 'planflow-ai.mjs'));
    expect(commandsOf(calls)).toEqual([]);
  });

  it('init never overwrites a user-owned file in rung 3, and says so', async () => {
    const mine = '#!/bin/sh\necho mine\n';
    seedShim(mine);
    const { exec } = makeExec({ resolves: new Map() });

    const result = await ensurePlanflowOnPath({
      exec,
      canWrite: () => false,
      homeDir,
      pathValue: '/usr/bin',
      packageRoot: bundleRoot,
      platform: 'darwin',
    });

    expect(result.outcome).toBe('unavailable');
    expect(result.notice).toContain('was not written by plan-flow — left untouched.');
    expect(readFileSync(shimAt(), 'utf-8')).toBe(mine);
  });
});

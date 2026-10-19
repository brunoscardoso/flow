/**
 * Tests for graphify install rails
 *
 * All subprocess behavior is dependency-injected — no real package manager
 * (uv/pipx) or `which` invocation ever runs in these tests.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { jest } from '@jest/globals';
import { ensureGraphify } from './graphify-rails.js';
import type { GraphifyRailsDeps } from './graphify-rails.js';

function createRepo(flowconfigLines?: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'plan-flow-graphify-rails-test-'));
  mkdirSync(join(dir, 'flow'), { recursive: true });
  if (flowconfigLines) {
    writeFileSync(join(dir, 'flow', '.flowconfig'), flowconfigLines.join('\n') + '\n');
  }
  return dir;
}

function readFlowconfig(repoRoot: string): string {
  return readFileSync(join(repoRoot, 'flow', '.flowconfig'), 'utf-8');
}

interface FakeExecOptions {
  /** Binaries that `which <bin>` resolves for. Mutated when installs succeed. */
  available: Set<string>;
  /** When true, install commands throw instead of succeeding. */
  failInstalls?: boolean;
}

/**
 * Build a fake `exec` dep: `which <bin>` succeeds only for available
 * binaries; successful installs add `graphify` to the available set.
 */
function makeExec(options: FakeExecOptions): { exec: GraphifyRailsDeps['exec']; calls: string[] } {
  const calls: string[] = [];
  const exec: GraphifyRailsDeps['exec'] = (command: string, _timeoutMs: number): string => {
    calls.push(command);
    if (command.startsWith('which ')) {
      const binary = command.slice('which '.length);
      if (options.available.has(binary)) return `/usr/local/bin/${binary}\n`;
      throw new Error(`which: no ${binary}`);
    }
    if (command === 'uv tool install graphifyy' || command === 'pipx install graphifyy') {
      if (options.failInstalls) throw new Error('install failed');
      options.available.add('graphify');
      return '';
    }
    throw new Error(`unexpected command: ${command}`);
  };
  return { exec, calls };
}

function makeSpawnDetached(): {
  spawnDetached: GraphifyRailsDeps['spawnDetached'];
  spawns: { command: string; args: string[]; cwd: string }[];
} {
  const spawns: { command: string; args: string[]; cwd: string }[] = [];
  const spawnDetached: GraphifyRailsDeps['spawnDetached'] = (command, args, cwd) => {
    spawns.push({ command, args, cwd });
  };
  return { spawnDetached, spawns };
}


// Suppress console output during tests (rails print via logger)
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('ensureGraphify', () => {
  let repoRoot: string;

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /**
   * #1808 — THESE RAILS WRITE NOTHING, and what they used to write is why.
   *
   * `engines.graphify` had five writers here and zero readers anywhere. The
   * derive gate asks `which graphify`; the documented `pending` state was
   * credited with keeping derive native-only, and nothing read it; the
   * documented `declined` value these rails never even wrote would not have
   * been honoured, so a user who set it by hand got graphify anyway, silently.
   *
   * Every assertion below that used to read `.flowconfig` now asserts the
   * OUTCOME and the NOTICE — the things a caller and a person actually receive.
   * The `upsertFlowconfigKey` behaviour those reads were incidentally covering
   * moved to `flowconfig-writer.test.ts`, where the helper still has a live
   * caller (`share`), rather than being deleted with its last exerciser.
   */
  function untouched(lines: string[]): void {
    expect(readFlowconfig(repoRoot)).toBe(`${lines.join('\n')}\n`);
  }

  it('does nothing when the binary already resolves', async () => {
    repoRoot = createRepo(['autopilot: true', 'engines.graphify: enabled']);
    const { exec, calls } = makeExec({ available: new Set(['graphify']) });
    const { spawnDetached, spawns } = makeSpawnDetached();

    const result = await ensureGraphify(repoRoot, { exec, spawnDetached });

    expect(result.outcome).toBe('already-installed');
    expect(calls).toEqual(['which graphify']);
    expect(spawns).toHaveLength(0);
    untouched(['autopilot: true', 'engines.graphify: enabled']);
  });

  it('installs via uv when uv is available, and fires the first graph build', async () => {
    repoRoot = createRepo(['autopilot: true']);
    const { exec, calls } = makeExec({ available: new Set(['uv']) });
    const { spawnDetached, spawns } = makeSpawnDetached();

    const result = await ensureGraphify(repoRoot, { exec, spawnDetached });

    expect(result.outcome).toBe('installed-via-uv');
    expect(calls).toContain('uv tool install graphifyy');
    expect(calls).not.toContain('pipx install graphifyy');
    expect(spawns).toEqual([{ command: 'graphify', args: ['update', '.'], cwd: repoRoot }]);
    untouched(['autopilot: true']);
  });

  it('falls back to pipx when uv is missing', async () => {
    repoRoot = createRepo(['autopilot: true']);
    const { exec, calls } = makeExec({ available: new Set(['pipx']) });
    const { spawnDetached, spawns } = makeSpawnDetached();

    const result = await ensureGraphify(repoRoot, { exec, spawnDetached });

    expect(result.outcome).toBe('installed-via-pipx');
    expect(calls).toContain('which uv');
    expect(calls).toContain('pipx install graphifyy');
    expect(spawns).toEqual([{ command: 'graphify', args: ['update', '.'], cwd: repoRoot }]);
    untouched(['autopilot: true']);
  });

  it('is pending with manual instructions when both package managers are missing', async () => {
    repoRoot = createRepo(['autopilot: true']);
    const { exec } = makeExec({ available: new Set() });
    const { spawnDetached, spawns } = makeSpawnDetached();

    const result = await ensureGraphify(repoRoot, { exec, spawnDetached });

    expect(result.outcome).toBe('pending');
    // The notice is where the install state lives now — a person can act on it.
    expect(result.notice).toContain('uv tool install graphifyy');
    expect(result.notice).toContain('pipx install graphifyy');
    expect(spawns).toHaveLength(0);
    untouched(['autopilot: true']);
  });

  it('is pending when the install command fails', async () => {
    repoRoot = createRepo(['autopilot: true']);
    const { exec } = makeExec({ available: new Set(['uv']), failInstalls: true });
    const { spawnDetached, spawns } = makeSpawnDetached();

    const result = await ensureGraphify(repoRoot, { exec, spawnDetached });

    expect(result.outcome).toBe('pending');
    expect(spawns).toHaveLength(0);
    untouched(['autopilot: true']);
  });

  it('installs when the binary is missing, whatever a legacy key says', async () => {
    repoRoot = createRepo(['engines.graphify: enabled']);
    const { exec, calls } = makeExec({ available: new Set(['uv']) });
    const { spawnDetached } = makeSpawnDetached();

    const result = await ensureGraphify(repoRoot, { exec, spawnDetached });

    expect(result.outcome).toBe('installed-via-uv');
    expect(calls).toContain('uv tool install graphifyy');
  });

  it('does not install when the binary exists and no key records it', async () => {
    repoRoot = createRepo(['autopilot: true']);
    const { exec, calls } = makeExec({ available: new Set(['graphify', 'uv']) });
    const { spawnDetached, spawns } = makeSpawnDetached();

    const result = await ensureGraphify(repoRoot, { exec, spawnDetached });

    expect(result.outcome).toBe('already-installed');
    expect(calls).not.toContain('uv tool install graphifyy');
    expect(spawns).toHaveLength(0);
    untouched(['autopilot: true']);
  });

  describe('always-on: a legacy consent value changes nothing (#142, #1808)', () => {
    it.each([
      ['declined', 'engines.graphify: declined'],
      ['pending', 'engines.graphify: pending'],
      ['enabled', 'engines.graphify: enabled'],
    ])('a legacy %s value is neither honoured nor rewritten', async (_label, line) => {
      // BOTH HALVES. It is not honoured — the binary is missing, so the rails
      // install regardless, with no prompt and no decline. And it is not
      // rewritten: the stale line is left exactly as the user's file has it,
      // because reconciling a key nothing reads is work that only creates the
      // impression the key matters.
      repoRoot = createRepo(['autopilot: true', line]);
      const { exec, calls } = makeExec({ available: new Set(['uv']) });
      const { spawnDetached, spawns } = makeSpawnDetached();

      const result = await ensureGraphify(repoRoot, { exec, spawnDetached });

      expect(result.outcome).toBe('installed-via-uv');
      expect(calls).toContain('uv tool install graphifyy');
      expect(spawns).toHaveLength(1);
      untouched(['autopilot: true', line]);
    });
  });

  describe("the user's flowconfig is not this command's to edit", () => {
    it('leaves a file it has no business in completely alone', async () => {
      const lines = [
        'autopilot: true',
        'commit: true',
        'push: false',
        'commands.lint: npm run lint',
      ];
      repoRoot = createRepo(lines);
      const { exec } = makeExec({ available: new Set() });
      const { spawnDetached } = makeSpawnDetached();

      await ensureGraphify(repoRoot, { exec, spawnDetached });

      untouched(lines);
    });

    it('does not CREATE .flowconfig for a project that has none', async () => {
      // The old rails wrote `engines.graphify: pending` into a file they had
      // just created, so a project with no config at all acquired one whose
      // single line meant nothing.
      repoRoot = createRepo(); // flow/ exists, no .flowconfig
      const { exec } = makeExec({ available: new Set() });
      const { spawnDetached } = makeSpawnDetached();

      const result = await ensureGraphify(repoRoot, { exec, spawnDetached });

      expect(result.outcome).toBe('pending');
      expect(existsSync(join(repoRoot, 'flow', '.flowconfig'))).toBe(false);
    });
  });
});

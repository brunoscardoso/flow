/**
 * The verb families' children are quiet, and their failures still speak (#1798).
 *
 * These run the REAL default execs against a real git, because the bug was
 * invisible to every test that injected a fake one: the fake never had a stderr
 * to inherit. What leaked was the shipped `execFileSync` option object, so that
 * is what is exercised here.
 */

import { spawnSync } from 'node:child_process';

const { getPackageRoot } = await import('./files.js');
const { QUIET_CHILD_STDIO } = await import('./child-stdio.js');
const { defaultLoopExec } = await import('../commands/loop.js');
const { defaultWorktreeExec } = await import('../commands/worktree.js');

const PACKAGE_ROOT = getPackageRoot();

/** A git invocation that always fails, the way the caught probes do. */
const ABSENT_REF = ['rev-parse', '--verify', 'refs/remotes/origin/definitely-not-a-ref'] as const;

describe('a child process this CLI runs never writes to our stderr (#1798)', () => {
  it.each([
    ['defaultLoopExec', defaultLoopExec],
    ['defaultWorktreeExec', defaultWorktreeExec],
  ])("%s keeps git's own words in the error it throws", (_name, exec) => {
    // THE HALF THAT IS EASY TO GET WRONG, so it is guarded first. Silencing the
    // terminal with `stdio: ['ignore','pipe','ignore']` — the shape the
    // neighbouring inline exec uses, and the obvious thing to copy — ALSO
    // empties `Error.message`: the throw becomes `Command failed: git rev-parse
    // …` and nothing else. Refusal reasons are built from that message (#1792),
    // so discarding stderr would trade a cosmetic leak for a diagnosis nobody
    // can read. This test fails on that fix and passes on the right one.
    let message = '';
    try {
      exec('git', [...ABSENT_REF], PACKAGE_ROOT);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Needed a single revision');
  });

  it('is one decision both families read, not two that can drift apart', () => {
    // The leak existed in BOTH execs, which is what a copied option object looks
    // like a year later (allowed-pattern #14).
    expect([...QUIET_CHILD_STDIO]).toEqual(['ignore', 'pipe', 'pipe']);
  });

  it('and the shape really is the thing that decides it', () => {
    // AN ABSENCE ASSERTION IS ONLY WORTH ITS CONTRAST. "Nothing on stderr" can
    // pass because the guard works or because the probe never spoke — so both
    // arms are run here, in child processes whose stderr is a pipe we can read.
    // The behavioural guards for each family are the end-to-end ones that drive
    // the real verbs (`worktree.test.ts`, `loop.test.ts`); this pins the option
    // object they depend on.
    expect(spawnCapturingStderr(false)).toContain('Needed a single revision');
    expect(spawnCapturingStderr(true)).toBe('');
  });
});

/**
 * Run a probe in a child node, with our stdio choice applied or not, and return
 * whatever reached THAT child's stderr.
 */
function spawnCapturingStderr(quiet: boolean): string {
  const script = `
    const { execFileSync } = require('node:child_process');
    try {
      execFileSync('git', ${JSON.stringify([...ABSENT_REF])}, {
        encoding: 'utf-8',
        cwd: ${JSON.stringify(PACKAGE_ROOT)},
        ${quiet ? `stdio: ${JSON.stringify([...QUIET_CHILD_STDIO])},` : ''}
      });
    } catch {}
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf-8',
    cwd: PACKAGE_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return (result.stderr ?? '').trim();
}

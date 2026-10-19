import { Command } from 'commander';

import { configureInitCommand } from './init-command-config.js';

/**
 * Guards the forward-compat fix: the Flow IDE runs `init` via an embedded copy
 * of this CLI that can lag the app. A newer app passing an unrecognized flag or
 * an extra argument must not hard-fail provisioning with "too many arguments
 * for 'init'…" / "unknown option …".
 */
function buildInit(action: () => void): Command {
  // exitOverride so a parse error throws (asserts intolerance) instead of
  // calling process.exit.
  return configureInitCommand(new Command('init')).exitOverride().action(action);
}

describe('configureInitCommand — forward compatibility', () => {
  it('tolerates EXCESS positional arguments (the reported error)', async () => {
    let calls = 0;
    const cmd = buildInit(() => {
      calls += 1;
    });
    await expect(
      cmd.parseAsync(['extra1', 'extra2', 'extra3'], { from: 'user' })
    ).resolves.toBeDefined();
    expect(calls).toBe(1);
  });

  it('tolerates UNKNOWN options', async () => {
    let calls = 0;
    const cmd = buildInit(() => {
      calls += 1;
    });
    await expect(
      cmd.parseAsync(['--claude', '--force', '--yes', '--future-flag'], { from: 'user' })
    ).resolves.toBeDefined();
    expect(calls).toBe(1);
  });

  it('still parses the recognized options it knows', async () => {
    let opts: Record<string, unknown> = {};
    const cmd = configureInitCommand(new Command('init'))
      .exitOverride()
      .action((o: Record<string, unknown>) => {
        opts = o;
      });
    await cmd.parseAsync(['--claude', '--yes'], { from: 'user' });
    expect(opts.claude).toBe(true);
    expect(opts.yes).toBe(true);
  });
});

/**
 * Tests for the CLI-side shim encoding (B6).
 *
 * Every assertion here runs on ANY host: the platform is an argument, never
 * `process.platform`, which is the whole reason these decisions were extracted
 * out of `path-rails.ts` (NFR3).
 *
 * The POSIX expectations are PINS, not descriptions. They are the exact bytes
 * `planflow-ai init` wrote before the Windows port, captured from the pre-port
 * `shimContent`. A diff here means the macOS/Linux shim changed — which is the
 * thing NFR1 forbids — so it must never be "updated to match".
 */

import {
  buildShimScript,
  bundleCliEntryPath,
  cliEntryPath,
  commandLookupTool,
  pathAdvice,
  resolveCliEntry,
  shimExecMode,
  shimFileName,
} from './platform-shim.js';

const POSIX_CHECKOUT = '/opt/checkouts/plan-flow';
const WINDOWS_CHECKOUT = 'C:\\Users\\me\\Projects\\plan-flow';

describe('shimFileName', () => {
  it('carries a PATHEXT extension on Windows and none on POSIX', () => {
    // PATHEXT is `.COM;.EXE;.BAT;.CMD;…` — an extensionless script resolves to
    // nothing there, and every beat then improvises a fallback silently.
    expect(shimFileName('win32')).toBe('planflow-ai.cmd');
    expect(shimFileName('darwin')).toBe('planflow-ai');
    expect(shimFileName('linux')).toBe('planflow-ai');
  });
});

describe('shimExecMode', () => {
  it('is 0o755 on POSIX and null on win32', () => {
    // Null is not "no mode" — it is the caller's instruction to SKIP chmod,
    // which on Windows is a no-op that reads as protection.
    expect(shimExecMode('darwin')).toBe(0o755);
    expect(shimExecMode('linux')).toBe(0o755);
    expect(shimExecMode('win32')).toBeNull();
  });
});

describe('cliEntryPath', () => {
  it('joins with the TARGET platform’s rules, not the host’s', () => {
    expect(cliEntryPath('linux', POSIX_CHECKOUT)).toBe(
      `${POSIX_CHECKOUT}/dist/cli/index.js`
    );
    expect(cliEntryPath('win32', WINDOWS_CHECKOUT)).toBe(
      `${WINDOWS_CHECKOUT}\\dist\\cli\\index.js`
    );
  });
});

describe('bundleCliEntryPath', () => {
  it('is the single-file bundle entry, joined with the TARGET platform’s rules', () => {
    expect(bundleCliEntryPath('linux', POSIX_CHECKOUT)).toBe(
      `${POSIX_CHECKOUT}/planflow-ai.mjs`
    );
    expect(bundleCliEntryPath('win32', WINDOWS_CHECKOUT)).toBe(
      `${WINDOWS_CHECKOUT}\\planflow-ai.mjs`
    );
  });
});

describe('resolveCliEntry', () => {
  // The #1944 regression: a bundle packageRoot must NOT be handed the checkout
  // layout. When the bundle's single-file entry exists, that is the entry;
  // otherwise the checkout's dist/cli/index.js.
  it('picks the bundle entry when it exists, the checkout entry otherwise', () => {
    expect(resolveCliEntry('linux', POSIX_CHECKOUT, true)).toBe(
      `${POSIX_CHECKOUT}/planflow-ai.mjs`
    );
    expect(resolveCliEntry('linux', POSIX_CHECKOUT, false)).toBe(
      `${POSIX_CHECKOUT}/dist/cli/index.js`
    );
    expect(resolveCliEntry('win32', WINDOWS_CHECKOUT, true)).toBe(
      `${WINDOWS_CHECKOUT}\\planflow-ai.mjs`
    );
    expect(resolveCliEntry('win32', WINDOWS_CHECKOUT, false)).toBe(
      `${WINDOWS_CHECKOUT}\\dist\\cli\\index.js`
    );
  });
});

describe('commandLookupTool', () => {
  it('is `where` on Windows and `which` everywhere else', () => {
    // `which` does not exist on Windows: without this branch rung 1 can never
    // succeed there, so an existing install is reported missing every time.
    expect(commandLookupTool('win32')).toBe('where');
    expect(commandLookupTool('darwin')).toBe('which');
    expect(commandLookupTool('linux')).toBe('which');
  });
});

describe('buildShimScript', () => {
  it('reproduces the PRE-PORT shim byte for byte on POSIX (NFR1)', () => {
    expect(buildShimScript('linux', POSIX_CHECKOUT)).toBe(
      [
        '#!/bin/sh',
        "# planflow-ai shim — written by plan-flow's `planflow-ai init`.",
        `# Points at this checkout: ${POSIX_CHECKOUT}`,
        '# If that checkout moved or was deleted, this shim is stale: delete this',
        '# file and re-run `planflow-ai init` from the checkout you want on PATH.',
        `exec node "${POSIX_CHECKOUT}/dist/cli/index.js" "$@"`,
        '',
      ].join('\n')
    );
    // darwin and linux are the same branch, and must stay so.
    expect(buildShimScript('darwin', POSIX_CHECKOUT)).toBe(
      buildShimScript('linux', POSIX_CHECKOUT)
    );
  });

  it('writes a cmd script on win32', () => {
    expect(buildShimScript('win32', WINDOWS_CHECKOUT)).toBe(
      [
        '@echo off',
        "rem planflow-ai shim - written by plan-flow's `planflow-ai init`.",
        `rem Points at this checkout: ${WINDOWS_CHECKOUT}`,
        'rem If that checkout moved or was deleted, this shim is stale: delete this',
        'rem file and re-run `planflow-ai init` from the checkout you want on PATH.',
        `node "${WINDOWS_CHECKOUT}\\dist\\cli\\index.js" %*`,
        'exit /b %ERRORLEVEL%',
        '',
      ].join('\r\n')
    );
  });

  it('uses CRLF and stays ASCII on win32, and neither on POSIX', () => {
    const windows = buildShimScript('win32', WINDOWS_CHECKOUT);
    // cmd.exe is only reliably tolerant of LF in trivial scripts, and the file
    // is read under the console code page rather than UTF-8.
    expect(windows).toContain('\r\n');
    // eslint-disable-next-line no-control-regex
    expect(/^[\x00-\x7F]*$/.test(windows)).toBe(true);

    const posix = buildShimScript('darwin', POSIX_CHECKOUT);
    expect(posix).not.toContain('\r');
    expect(posix).toContain('—');
  });

  it('propagates the CLI exit code on win32 (cmd.exe does not on its own)', () => {
    // Without this line every failed CLI verb reports success to its caller.
    expect(buildShimScript('win32', WINDOWS_CHECKOUT)).toContain('exit /b %ERRORLEVEL%');
    expect(buildShimScript('darwin', POSIX_CHECKOUT)).not.toContain('exit /b');
  });

  it('forwards all arguments in each platform’s own idiom', () => {
    expect(buildShimScript('darwin', POSIX_CHECKOUT)).toContain('"$@"');
    expect(buildShimScript('win32', WINDOWS_CHECKOUT)).toContain('%*');
  });

  it('names the checkout on both platforms so a stale shim is diagnosable', () => {
    for (const [platform, root] of [
      ['darwin', POSIX_CHECKOUT],
      ['win32', WINDOWS_CHECKOUT],
    ] as const) {
      const script = buildShimScript(platform, root);
      expect(script).toContain(root);
      expect(script).toContain('written by plan-flow');
      expect(script).toContain('stale');
      // A script, never an alias — aliases do not exist in agent shells.
      expect(script).not.toMatch(/^\s*alias /m);
    }
  });

  it('is a pure function of platform and checkout path', () => {
    expect(buildShimScript('win32', 'C:\\a')).toBe(buildShimScript('win32', 'C:\\a'));
    expect(buildShimScript('win32', 'C:\\a')).not.toBe(buildShimScript('win32', 'C:\\b'));
    expect(buildShimScript('win32', POSIX_CHECKOUT)).not.toBe(
      buildShimScript('darwin', POSIX_CHECKOUT)
    );
  });

  it('execs an explicit entry when given one (the bundle layout, #1944)', () => {
    // When the writer resolves the app-bundle entry, the shim execs
    // planflow-ai.mjs, NOT dist/cli/index.js — the whole point of the fix.
    const bundle = '/Applications/Flow.app/Contents/Resources/cli';
    const entry = `${bundle}/planflow-ai.mjs`;
    const posix = buildShimScript('darwin', bundle, entry);
    expect(posix).toContain(`exec node "${entry}" "$@"`);
    expect(posix).not.toContain('dist/cli/index.js');

    const winBundle = 'C:\\Users\\me\\AppData\\Local\\Programs\\Flow\\resources\\cli';
    const winEntry = `${winBundle}\\planflow-ai.mjs`;
    const windows = buildShimScript('win32', winBundle, winEntry);
    expect(windows).toContain(`node "${winEntry}" %*`);
    expect(windows).not.toContain('dist\\cli\\index.js');
  });

  it('defaults the entry to the checkout layout when omitted (NFR1 byte-identity)', () => {
    // The two-arg form is the pinned, pre-port behaviour — the default must be
    // the checkout entry so every existing caller is unchanged.
    expect(buildShimScript('darwin', POSIX_CHECKOUT)).toBe(
      buildShimScript('darwin', POSIX_CHECKOUT, `${POSIX_CHECKOUT}/dist/cli/index.js`)
    );
  });
});

describe('pathAdvice', () => {
  it('prints the exact POSIX export line (NFR1 pin)', () => {
    const advice = pathAdvice('darwin', '/home/x/.local/bin');
    expect(advice.line).toBe('export PATH="/home/x/.local/bin:$PATH"');
    expect(advice.warning).toBe(
      '/home/x/.local/bin is not on your PATH. Add this line to your shell profile yourself:'
    );
    expect(advice.noticeSuffix).toBe(
      'add `export PATH="/home/x/.local/bin:$PATH"` to your shell profile.'
    );
  });

  it('never offers `export PATH` on Windows, where it cannot work', () => {
    const advice = pathAdvice('win32', 'C:\\Users\\me\\.local\\bin');
    expect(advice.line).not.toContain('export PATH');
    expect(advice.line).toContain('SetEnvironmentVariable');
    expect(advice.line).toContain('C:\\Users\\me\\.local\\bin');
    // `setx` truncates at 1024 chars and bakes the machine PATH into the user
    // PATH — it must never be the advice given.
    expect(advice.line).not.toContain('setx');
    expect(advice.warning).toContain('PowerShell');
    expect(advice.noticeSuffix).toContain('PowerShell');
  });

  it('describes an action the user takes, on both platforms', () => {
    // The rails PRINT the line; running or writing it is always the user's call.
    expect(pathAdvice('darwin', '/x').warning).toContain('yourself');
    expect(pathAdvice('win32', 'C:\\x').warning).toContain('yourself');
  });
});

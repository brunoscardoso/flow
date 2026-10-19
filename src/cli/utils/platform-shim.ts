/**
 * Platform encoding of the `planflow-ai` shim written by `planflow-ai init` (B6).
 *
 * DELIBERATE DUPLICATION — `app/src/main/platform/shim.ts` encodes the same
 * three decisions for the IDE's own shim. The CLI and the app are separate npm
 * workspaces with separate bundles and cannot import across that boundary, so
 * the convention is held in two places ON PURPOSE (plan Key Changes #3). Do NOT
 * "fix" this by wiring a cross-workspace import.
 *
 * What legitimately differs between the two: the app's shim execs the bundled
 * CLI through Electron-as-Node, while this one execs a CHECKOUT's
 * `dist/cli/index.js` through the system `node`. Everything else — the `.cmd`
 * extension, CRLF, ASCII-only text, `exit /b %ERRORLEVEL%`, and a null exec
 * mode meaning "skip chmod" — mirrors the app-side decisions exactly.
 *
 * Why this is not cosmetic on Windows: `PATHEXT` is `.COM;.EXE;.BAT;.CMD;…`,
 * so an extensionless `#!/bin/sh` file named `planflow-ai` resolves to NOTHING
 * when cmd.exe or PowerShell looks up the command. The failure is silent — init
 * reports a shim written, and every beat prompt then improvises a fallback
 * because the binary it was told exists does not resolve.
 *
 * Every function is pure and takes the platform as an argument (NFR3), so both
 * branches are asserted from a test running on either host.
 */

import { posix as posixPath, win32 as win32Path } from 'node:path';

/** The command name every beat prompt and skill invokes. */
export const SHIM_BASE_NAME = 'planflow-ai';

/** rwxr-xr-x — POSIX needs the exec bit for the shim to run directly. */
const POSIX_SHIM_EXEC_MODE = 0o755;

/**
 * The shim's file name. Windows must carry a `PATHEXT` extension or the command
 * is unresolvable; `.cmd` (not `.bat`) is the modern form and is what npm
 * itself writes for its own bin shims.
 */
export function shimFileName(platform: NodeJS.Platform | string): string {
  return platform === 'win32' ? `${SHIM_BASE_NAME}.cmd` : SHIM_BASE_NAME;
}

/**
 * The mode to chmod the written shim to, or null where chmod is meaningless.
 * Windows has no exec bit — `fs.chmodSync` there is a no-op that READS as
 * protection, so the caller must skip it rather than call it and believe it did
 * something (the same class of lie as `chmod 0600` on credentials, B5).
 */
export function shimExecMode(platform: NodeJS.Platform | string): number | null {
  return platform === 'win32' ? null : POSIX_SHIM_EXEC_MODE;
}

/**
 * The single-file entry the app bundles the CLI into (`scripts/build-cli-bundle.mjs`
 * writes `app/resources/cli/planflow-ai.mjs`, shipped as
 * `Flow.app/Contents/Resources/cli/planflow-ai.mjs`). A bundle has NO `dist/` —
 * a shim written from it that named `dist/cli/index.js` pointed at nothing from
 * the moment it was written (tasklist BUG 2026-10-05).
 */
export const BUNDLE_ENTRY_FILE_NAME = 'planflow-ai.mjs';

/**
 * The CLI entry point a shim runs, joined with the TARGET platform's path
 * rules rather than the host's — so a win32 branch asserted from a POSIX test
 * still produces a genuine Windows path. Identical to `path.join` on POSIX.
 *
 * Two layouts exist, and the entry is the one this package root ACTUALLY has:
 * a checkout or npm install runs `dist/cli/index.js`; the app's bundle runs
 * `planflow-ai.mjs` at its root. `exists` is injected so both answers are
 * assertable without either layout on disk; a root with neither keeps the
 * checkout form (what every shim before the bundle existed was written with).
 */
export function cliEntryPath(
  platform: NodeJS.Platform | string,
  packageRoot: string,
  exists: (path: string) => boolean = () => false
): string {
  const joiner = platform === 'win32' ? win32Path.join : posixPath.join;
  const bundled = joiner(packageRoot, BUNDLE_ENTRY_FILE_NAME);
  if (exists(bundled)) return bundled;
  return joiner(packageRoot, 'dist', 'cli', 'index.js');
}

/**
 * Every shim plan-flow writes says so in its second line (`# planflow-ai shim —
 * written by plan-flow's …` on POSIX, `rem planflow-ai shim - written by …` on
 * Windows). That sentence is the MARKER: a file at the shim's path without it
 * is the user's own, and nothing here may overwrite it. Shims written before
 * this function existed carry the same sentence, so they are recognised too.
 */
export function isPlanflowShim(content: string): boolean {
  return /planflow-ai shim [—-] written by plan-flow's/.test(content);
}

/**
 * The CLI entry a plan-flow shim runs — the quoted path after `node` — or null
 * when the content names none (not a shim of ours, or hand-edited past reading).
 */
export function shimTargetOf(content: string): string | null {
  const match = /^(?:exec )?node "([^"]+)"/m.exec(content);
  return match === null ? null : match[1];
}

/**
 * The CLI entry point in the APP BUNDLE layout — a single file
 * `<packageRoot>/planflow-ai.mjs` (built by `scripts/build-cli-bundle.mjs`),
 * with NO `dist/` tree beside it. Joined with the target platform's rules, like
 * `cliEntryPath`.
 */
export function bundleCliEntryPath(
  platform: NodeJS.Platform | string,
  packageRoot: string
): string {
  const joiner = platform === 'win32' ? win32Path.join : posixPath.join;
  return joiner(packageRoot, 'planflow-ai.mjs');
}

/**
 * The entry a shim should exec for `packageRoot`, resolved to the file that
 * ACTUALLY exists. Two legitimate layouts ship under a `planflow-ai` package
 * root: a source checkout / npm install (`dist/cli/index.js`), and the app
 * bundle (`planflow-ai.mjs`, no `dist/`). Hard-coding the checkout layout is
 * #1944 — a shim written from the bundle pointed at a nonexistent
 * `dist/cli/index.js` and every verb died with MODULE_NOT_FOUND.
 *
 * Pure: `bundleEntryExists` is the caller's filesystem answer, never read here
 * (NFR3) — the fs check lives in `path-rails.ts`, which already does fs.
 */
export function resolveCliEntry(
  platform: NodeJS.Platform | string,
  packageRoot: string,
  bundleEntryExists: boolean
): string {
  return bundleEntryExists
    ? bundleCliEntryPath(platform, packageRoot)
    : cliEntryPath(platform, packageRoot);
}

/**
 * The command that resolves a binary by name on a platform. `which` does not
 * exist on Windows; `where.exe` is the in-box equivalent and prints every match,
 * newline-separated, exiting non-zero when there is none.
 *
 * Without this branch rung 1 of the rails can never succeed on Windows: `which`
 * always fails, so an already-installed `planflow-ai` is reported as missing and
 * a redundant shim is written over a working install.
 */
export function commandLookupTool(platform: NodeJS.Platform | string): string {
  return platform === 'win32' ? 'where' : 'which';
}

/**
 * The shim script's exact text.
 *
 * NFR1: the POSIX branch reproduces the pre-port output byte for byte — same
 * shebang, same em dash, same `"$@"`, same trailing newline.
 *
 * The Windows branch differs in four ways that all matter:
 *  - CRLF line endings — cmd.exe is only reliably tolerant of LF in trivial
 *    scripts, and there is nothing to gain by betting on it.
 *  - ASCII only — the file is read under the console code page, which is not
 *    UTF-8 by default; an em dash in a `rem` line is a needless risk.
 *  - `%*` forwards all arguments, the cmd.exe counterpart of `"$@"`.
 *  - `exit /b %ERRORLEVEL%` — cmd.exe does NOT propagate a child's exit code
 *    out of a script on its own, so without it every failed CLI verb would
 *    report success to whatever ran the shim.
 */
export function buildShimScript(
  platform: NodeJS.Platform | string,
  packageRoot: string,
  entryOrExists: string | ((path: string) => boolean) = () => false
): string {
  // The entry itself (`resolveCliEntry`, #1944), or a filesystem probe that
  // picks the layout this package root actually has (`cliEntryPath`).
  const entry =
    typeof entryOrExists === 'string' ? entryOrExists : cliEntryPath(platform, packageRoot, entryOrExists);
  if (platform === 'win32') {
    return [
      '@echo off',
      `rem ${SHIM_BASE_NAME} shim - written by plan-flow's \`${SHIM_BASE_NAME} init\`.`,
      `rem Points at this checkout: ${packageRoot}`,
      'rem If that checkout moved or was deleted, this shim is stale: delete this',
      `rem file and re-run \`${SHIM_BASE_NAME} init\` from the checkout you want on PATH.`,
      `node "${entry}" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    `# ${SHIM_BASE_NAME} shim — written by plan-flow's \`${SHIM_BASE_NAME} init\`.`,
    `# Points at this checkout: ${packageRoot}`,
    '# If that checkout moved or was deleted, this shim is stale: delete this',
    `# file and re-run \`${SHIM_BASE_NAME} init\` from the checkout you want on PATH.`,
    `exec node "${entry}" "$@"`,
    '',
  ].join('\n');
}

/** What init PRINTS when the shim directory is not on PATH. Never written. */
export interface PathAdvice {
  /** The exact line the user must run or add themselves. */
  line: string;
  /** The warning that precedes it. */
  warning: string;
  /** The tail of init's one-line notice, after the shim path. */
  noticeSuffix: string;
}

/**
 * The PATH instruction for a platform. `export PATH=...` is meaningless in
 * cmd.exe and PowerShell, so printing it on Windows would be advice that cannot
 * work — a quieter version of the failure these rails exist to prevent.
 *
 * The Windows form deliberately uses `[Environment]::SetEnvironmentVariable`
 * against the USER scope rather than `setx`: `setx` truncates at 1024
 * characters and, when fed `%PATH%`, bakes the machine PATH into the user PATH.
 *
 * The absolute rule is unchanged on both platforms — the line is PRINTED, never
 * executed and never written into a profile.
 */
export function pathAdvice(
  platform: NodeJS.Platform | string,
  shimDir: string
): PathAdvice {
  if (platform === 'win32') {
    const line =
      `[Environment]::SetEnvironmentVariable('Path', ` +
      `[Environment]::GetEnvironmentVariable('Path', 'User') + ';${shimDir}', 'User')`;
    return {
      line,
      warning: `${shimDir} is not on your PATH. Run this in PowerShell yourself (it is never run for you):`,
      noticeSuffix: `run \`${line}\` in PowerShell to add it to your PATH.`,
    };
  }
  const line = `export PATH="${shimDir}${posixPath.delimiter}$PATH"`;
  return {
    line,
    warning: `${shimDir} is not on your PATH. Add this line to your shell profile yourself:`,
    noticeSuffix: `add \`${line}\` to your shell profile.`,
  };
}

/**
 * How a test spawns this repo's TypeScript entry through `tsx`.
 *
 * NPM'S `.bin` ENTRY IS NOT A JAVASCRIPT FILE ON WINDOWS. On POSIX, npm links
 * `node_modules/.bin/tsx` straight at the package's own `dist/cli.mjs`, so
 * `node node_modules/.bin/tsx` happens to work — the thing Node opens is real
 * JavaScript. Windows has no symlinks to spend, so npm writes three literal
 * shims there instead: an extensionless `sh` script, a `.cmd`, and a `.ps1`.
 * Handing the first of those to `node` makes it parse shell as JavaScript:
 *
 *     node_modules\.bin\tsx:2
 *     basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
 *               ^^^^^^^
 *     SyntaxError: missing ) after argument list
 *
 * Every subprocess E2E in this repo spawned that path, so on Windows they all
 * failed identically, at the shim rather than at the code under test — a whole
 * class of tests that could not fail for a real reason. It is the same fact
 * `platform-shim.ts` already carries about `PATHEXT`, met from the other side:
 * there an extensionless shim resolves to nothing, here it resolves to
 * something Node cannot read.
 *
 * The fix is to stop asking for the shim and ask for the module it stands in
 * for. `dist/cli.mjs` is what the `.bin` entry points at on every platform, so
 * this is the same program on all of them — one path, no branch, nothing that
 * behaves differently on the host that happened to run the suite.
 */

import { join } from 'node:path';

/**
 * The tsx entry to hand `node` — the package's own module, never its `.bin`
 * shim. Pure: joins from the caller's package root and touches no filesystem.
 */
export function tsxRunnerPath(packageRoot: string): string {
  return join(packageRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

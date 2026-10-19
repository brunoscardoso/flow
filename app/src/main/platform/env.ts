// Platform encoding of the PATH environment variable (B1).
//
// Two POSIX assumptions live in `withShimPath` today, and both break on
// Windows in ways that look like nothing is wrong:
//
//  1. The separator is hardcoded `:`. On Windows the separator is `;`, so a
//     `:` join fuses the shim directory and the ENTIRE system PATH into one
//     nonsense entry — the agent session loses `git`, `node`, everything, and
//     the env still contains a plausible-looking PATH.
//  2. The key is hardcoded `PATH`. Windows env keys are case-insensitive but
//     `process.env` surfaces them with their real casing (usually `Path`), and
//     an object spread is case-SENSITIVE: `{ ...env, PATH: x }` on an env that
//     already has `Path` produces BOTH keys. Which one a spawned process sees
//     is then up to the spawn implementation.
//
// Pure and platform-parameterized so both branches are testable off-platform
// (NFR3). `path.win32` / `path.posix` give the real delimiters without asking
// the host which platform it is.

import { posix as posixPath, win32 as win32Path } from 'path'

/**
 * The delimiter that separates PATH entries on a platform: `;` on Windows,
 * `:` elsewhere. Sourced from Node's own `path` submodules rather than
 * literals so there is one authority for it.
 */
export function pathDelimiter(platform: NodeJS.Platform | string): string {
  return platform === 'win32' ? win32Path.delimiter : posixPath.delimiter
}

/**
 * The key under which THIS env object holds its PATH.
 *
 * On Windows, resolve case-insensitively against the keys already present, so
 * writing back reuses the existing key (`Path`) instead of adding a second one
 * (`PATH`). Falls back to `Path` — the casing Windows itself uses — when the
 * env has no PATH at all. On POSIX the key is exactly `PATH`, case-sensitively,
 * and no lookup is warranted.
 */
export function pathEnvKey(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | string,
): string {
  if (platform !== 'win32') {
    return 'PATH'
  }
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') {
      return key
    }
  }
  return 'Path'
}

/**
 * Joins PATH entries with the platform's delimiter, dropping empty and absent
 * parts so a missing existing PATH degrades to just the remaining entries
 * rather than producing a leading/trailing separator (which POSIX shells read
 * as "the current directory" — an actual security wart, not just untidiness).
 */
export function joinPath(
  platform: NodeJS.Platform | string,
  ...parts: Array<string | undefined | null>
): string {
  const delimiter = pathDelimiter(platform)
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(delimiter)
}

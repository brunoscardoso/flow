// Where better-sqlite3 is, and whether it still needs compiling.
//
// ONE code path for a fact two scripts act on (allowed-pattern #14):
// `postinstall.mjs` decides whether to rebuild on install, `rebuild-native.mjs`
// does the rebuild — and both used to hard-code `app/node_modules/better-sqlite3`
// and assume a compile was required.
//
// Neither assumption survives:
//
//   • PLACEMENT is npm's call. Whether the module lands in the app workspace or
//     hoists to the repo root depends on what else is in the tree, and it moves
//     between installs. The electron rail in postinstall already checked both.
//
//   • COMPILING is version-dependent. better-sqlite3 ≥ 13 runs on the N-API,
//     ships one prebuilt binary per platform INSIDE its npm tarball, and is
//     ABI-stable across Node and Electron — nothing to rebuild, on any
//     platform, with no C++ toolchain. Verified live: v13.0.3's shipped
//     `prebuilds/win32-x64.node` loads under Electron 43 on Windows.
//     (≤ 12 used prebuild-install against GitHub RELEASE ASSETS, which publish
//     no `electron-v148` build — that is the fact the compile-always path was
//     built on, and looking at those same assets is what made v13 look like it
//     had no prebuilds either. It moved them into the package.)

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Locate the better-sqlite3 the Electron app loads.
 *
 * @param {string} repoRoot
 * @returns {{ dir: string, version: string, shipsPrebuilds: boolean } | null}
 *   null when there is no better-sqlite3 in the tree (e.g. the published CLI,
 *   which does not install the app workspace).
 */
export function findBetterSqlite3(repoRoot) {
  const dir = [
    join(repoRoot, 'app', 'node_modules', 'better-sqlite3'),
    join(repoRoot, 'node_modules', 'better-sqlite3'),
  ].find((candidate) => existsSync(candidate))

  if (!dir) return null

  let version = ''
  let hasInstallScript = false
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    version = typeof pkg.version === 'string' ? pkg.version : ''
    hasInstallScript = typeof pkg.scripts?.install === 'string'
  } catch {
    /* unreadable package.json — treat as a source build and let node-gyp speak */
  }

  // The two facts together: a co-located binary for this platform, and no
  // install script that would otherwise fetch or compile one.
  const shipsPrebuilds = !hasInstallScript && existsSync(join(dir, 'prebuilds'))

  return { dir, version, shipsPrebuilds }
}

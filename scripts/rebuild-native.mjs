#!/usr/bin/env node
// Rebuilds the Flow app's native modules against the Electron version pinned
// in app/package.json, by running node-gyp directly inside
// app/node_modules/better-sqlite3.
//
// Why not @electron/rebuild: this repo is an npm workspace, and its module
// walker follows node resolution up to the repo root, rebuilding EVERY copy of
// a module it finds by name rather than the one the app loads. That is what
// broke the build while a ROOT better-sqlite3@9 existed (planflow-brain's
// plain-Node dependency, C++17 gyp) alongside the app's v12: the walker
// compiled the root copy against Electron 43 headers requiring C++20 and
// failed. That second copy is gone with the brain index, but the walker's
// behaviour is not, and a future workspace dep could reintroduce a duplicate.
// Direct node-gyp against the one module the packaged app actually loads
// (app/node_modules/better-sqlite3, v12, C++20 gyp) is deterministic, matches
// how the module was originally wired, and does not depend on there being
// exactly one copy — see forbidden-pattern #8.
//
// node-pty is intentionally NOT rebuilt: it ships N-API prebuilds
// (prebuilds/darwin-arm64) that work under Electron as-is. Its only quirk is
// the spawn-helper exec bit — see scripts/fix-native-perms.mjs.
//
// Usage: node scripts/rebuild-native.mjs   (or `npm run rebuild -w app`)

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBetterSqlite3 } from './native-modules.mjs'

const ELECTRON_HEADERS_URL = 'https://electronjs.org/headers'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(repoRoot, 'app')

const sqlite = findBetterSqlite3(repoRoot)
if (!sqlite) {
  console.error(`[rebuild-native] better-sqlite3 not found — run npm install first`)
  process.exit(1)
}
// better-sqlite3 ≥ 13 is N-API and ships a prebuilt binary per platform in its
// own package — ABI-stable across Node and Electron, so there is nothing to
// compile. See scripts/native-modules.mjs.
if (sqlite.shipsPrebuilds) {
  console.log(
    `[rebuild-native] better-sqlite3 ${sqlite.version} ships N-API prebuilds — ` +
      `nothing to rebuild for Electron`,
  )
  process.exit(0)
}
const moduleDir = sqlite.dir

const appPkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
const electronVersion = appPkg.devDependencies?.electron
if (!electronVersion || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
  console.error(
    `[rebuild-native] app/package.json must pin electron to an exact version ` +
      `(found: ${String(electronVersion)}). Ranges break header resolution.`,
  )
  process.exit(1)
}

console.log(
  `[rebuild-native] node-gyp rebuild in ${moduleDir} ` +
    `against Electron ${electronVersion} (${process.arch})`,
)

// Windows has no bare `npx` — the shim is `npx.cmd`, and spawnSync without a
// shell does not resolve PATHEXT, so the bare name fails with ENOENT before
// node-gyp ever runs.
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

const result = spawnSync(
  npx,
  [
    'node-gyp',
    'rebuild',
    `--target=${electronVersion}`,
    `--arch=${process.arch}`,
    `--dist-url=${ELECTRON_HEADERS_URL}`,
  ],
  { cwd: moduleDir, stdio: 'inherit' },
)

if (result.status !== 0) {
  if (result.error) console.error(`[rebuild-native] could not run ${npx}: ${result.error.message}`)
  console.error(`[rebuild-native] node-gyp failed (exit ${result.status})`)
  process.exit(result.status ?? 1)
}

const builtBinary = join(moduleDir, 'build', 'Release', 'better_sqlite3.node')
if (!existsSync(builtBinary)) {
  console.error(`[rebuild-native] build reported success but ${builtBinary} is missing`)
  process.exit(1)
}

console.log(`[rebuild-native] done — ${builtBinary}`)

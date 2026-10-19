// Jest launcher for the app workspace — runs Jest under ELECTRON'S Node.
//
// WHY: app/node_modules/better-sqlite3 is compiled for the Electron ABI
// (NODE_MODULE_VERSION 148) by scripts/rebuild-native.mjs so the packaged
// app works. Plain-Node Jest cannot load that binary (ERR_DLOPEN_FAILED).
// Instead of ABI-flipping the binary back and forth (which would break the
// packaged app whenever tests run), we launch Jest with
// `ELECTRON_RUN_AS_NODE=1 <electron-binary> jest ...` — Electron's embedded
// Node shares the Electron ABI, so tests exercise the REAL better-sqlite3
// the app ships with, and the binary is never rebuilt.
//
// Jest worker processes inherit ELECTRON_RUN_AS_NODE via the environment
// and spawn from process.execPath (the Electron binary), so they also run
// as Node. Any extra CLI args are passed through to Jest:
//   npm run test -w app -- src/main/credentials.test.ts
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// `require('electron')` from plain Node resolves to the Electron binary path.
const electronBinary = require('electron')
const jestBin = require.resolve('jest/bin/jest')

const result = spawnSync(electronBinary, [jestBin, ...process.argv.slice(2)], {
  cwd: appDir,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
})

if (result.error) {
  console.error('[run-jest] Failed to launch Electron-as-Node:', result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)

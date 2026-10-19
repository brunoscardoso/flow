#!/usr/bin/env node
// App-workspace postinstall — makes a fresh `npm install` "just work" by
// making sure both native modules can load under Electron and restoring
// node-pty's spawn-helper exec bit. Without this, a clone can end up with a
// better-sqlite3 built for plain Node and an Electron app that crashes at load
// with ERR_DLOPEN_FAILED / NODE_MODULE_VERSION mismatch — the classic "builds
// on my machine" trap.
//
// better-sqlite3 ≥ 13 makes the rebuild unnecessary: it is N-API and ships a
// prebuilt binary per platform inside its own package (see
// scripts/native-modules.mjs). The compile path below is what ≤ 12 needs.
//
// Design:
//   • Idempotent + fast: skips when the binary is already built for the pinned
//     Electron version (a marker file), so routine installs don't recompile.
//   • Non-fatal: a rebuild failure (e.g. missing C++ toolchain) prints clear,
//     OS-specific guidance but does NOT abort `npm install`, so constrained
//     environments (CI, sandboxes) still complete. The app won't run until the
//     rebuild succeeds, but the fix is one documented command away.
//   • Escape hatch: PLANFLOW_SKIP_NATIVE_REBUILD=1 skips entirely.
//   • Loud rails: a silent-success setup is the failure mode this guards. An
//     `npm install` that exits 0 without downloading Electron's binary is
//     named here with its remediation, instead of surfacing later as an app
//     that will not start.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findBetterSqlite3 } from './native-modules.mjs'

const scriptsDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptsDir, '..')
const appDir = join(repoRoot, 'app')
const sqlite = findBetterSqlite3(repoRoot)
const moduleDir = sqlite?.dir ?? ''
const binary = moduleDir ? join(moduleDir, 'build', 'Release', 'better_sqlite3.node') : ''

function log(msg) {
  console.log(`[postinstall] ${msg}`)
}

/** Prints a boxed, loud message to stderr. Width is fixed; lines are padded. */
function box(title, lines) {
  const width = 74
  const pad = (s) => `│ ${s}${' '.repeat(Math.max(0, width - 2 - s.length))} │`
  console.error(
    [
      '',
      `┌─ ${title} ${'─'.repeat(Math.max(0, width - 3 - title.length))}┐`,
      ...lines.map(pad),
      `└${'─'.repeat(width)}┘`,
      '',
    ].join('\n'),
  )
}

// ── Electron binary rail ─────────────────────────────────────────────────────
// Observed live: a workspace `npm install` completes with EXIT 0 while
// node_modules/electron/dist/ was never downloaded (proxy, mirror, or a
// blocked/skipped postinstall — see allowed-pattern #9). Nothing complains
// until the app refuses to start with no useful message. Checked BEFORE the
// better-sqlite3 early-exit below, because the two are independent failures.
checkElectronBinary()

function checkElectronBinary() {
  // Hoisting decides which node_modules holds it; check both.
  const electronDir = [
    join(repoRoot, 'node_modules', 'electron'),
    join(appDir, 'node_modules', 'electron'),
  ].find((dir) => existsSync(dir))

  // No electron in the tree at all — not an app-workspace install.
  if (!electronDir) return
  if (existsSync(join(electronDir, 'dist'))) return

  const rel = electronDir.slice(repoRoot.length + 1).split('\\').join('/')
  box('Flow: Electron binary was never downloaded', [
    `${rel}/dist/ is missing — \`npm install\` reported`,
    'success but the Electron download step never ran. The app cannot start.',
    '',
    'Fix it with:',
    `  node ${rel}/install.js`,
    '',
    'If that fails behind a proxy or firewall, set a mirror first:',
    `  ELECTRON_MIRROR=<your mirror> node ${rel}/install.js`,
  ])
}

// PLANFLOW_SKIP_NATIVE_REBUILD skips the REBUILD, not the rails above it: the
// Electron download is a separate step with a separate failure.
if (process.env['PLANFLOW_SKIP_NATIVE_REBUILD'] === '1') {
  log('skipping native rebuild (PLANFLOW_SKIP_NATIVE_REBUILD=1)')
  process.exit(0)
}

// Not a full app-workspace install (e.g. the published CLI) — nothing to do.
if (!sqlite) {
  process.exit(0)
}

// better-sqlite3 ≥ 13 is N-API: one prebuilt binary per platform ships inside
// its own npm package and loads unchanged under Node and Electron. No compile,
// no toolchain, nothing to mark. node-pty's exec bit still needs restoring.
if (sqlite.shipsPrebuilds) {
  log(`better-sqlite3 ${sqlite.version} ships N-API prebuilds — no Electron rebuild needed`)
  runPerms()
  process.exit(0)
}

// Pinned Electron version — the ABI we must build against.
let electronVersion = ''
try {
  electronVersion = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'))
    .devDependencies?.electron
} catch {
  /* fall through — rebuild-native re-validates and errors clearly */
}

const marker = join(moduleDir, 'build', 'Release', '.flow-electron-abi')
// Fast path: already built for this Electron version.
if (electronVersion && existsSync(binary) && existsSync(marker)) {
  try {
    if (readFileSync(marker, 'utf8').trim() === electronVersion) {
      log(`better-sqlite3 already built for Electron ${electronVersion} — skipping`)
      runPerms()
      process.exit(0)
    }
  } catch {
    /* stale/unreadable marker — fall through and rebuild */
  }
}

log(`rebuilding native modules for Electron ${electronVersion || '(pinned)'}…`)
const rebuild = spawnSync(process.execPath, [join(scriptsDir, 'rebuild-native.mjs')], {
  stdio: 'inherit',
})
if (rebuild.status === 0) {
  if (electronVersion) {
    try {
      writeFileSync(marker, `${electronVersion}\n`)
    } catch {
      /* marker is an optimization only */
    }
  }
  runPerms()
  process.exit(0)
}

// Rebuild failed — guide the user, but don't abort the whole install.
//
// Reached only on better-sqlite3 ≤ 12, where compiling IS the expected path on
// every platform: those versions fetch prebuilds via prebuild-install from the
// GitHub RELEASE ASSETS, which publish no `electron-v148` (Electron 43) build.
// So a missing C++ toolchain is the only thing this message can be about.
//
// Those same release assets are why v13 was read as having no prebuilds at all
// (checked 2026-08-14): v13 moved them INTO the npm package, where the earlier
// check never looked. Verified live on Windows — v13.0.3's shipped
// prebuilds/win32-x64.node loads under Electron 43 with no toolchain present.
box('Flow: native module rebuild failed', [
  'better-sqlite3 is compiled from source for Electron on EVERY platform —',
  'no Electron 43 prebuild is published, so there is nothing to download.',
  'This failed because the C++ build toolchain is missing or incomplete.',
  '',
  'Install the toolchain, then run:  npm run rebuild -w app',
  '  • macOS:    xcode-select --install',
  '  • Linux:    apt-get install build-essential python3',
  '  • Windows:  Visual Studio Build Tools with the',
  '              "Desktop development with C++" workload, plus Python 3',
  '              (winget install Microsoft.VisualStudio.2022.BuildTools',
  '               then select the C++ workload in the installer)',
  '',
  'Until then the Electron app will fail to start.',
])
process.exit(0)

function runPerms() {
  spawnSync(process.execPath, [join(scriptsDir, 'fix-native-perms.mjs')], { stdio: 'inherit' })
}

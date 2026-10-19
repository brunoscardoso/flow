#!/usr/bin/env node
// Restores the executable bit on node-pty's `spawn-helper` prebuilds.
//
// Why this exists: node-pty's postinstall script normally sets the exec bit
// on its darwin spawn-helper binaries. Sandboxed environments with an
// allow-scripts policy (e.g. Claude Code) block package postinstall scripts,
// so after any `npm install` the helper can come back non-executable and
// every terminal spawn fails with EACCES. Idempotent — safe to run any time.
//
// Usage: node scripts/fix-native-perms.mjs
// (also runs as part of `npm run rebuild -w app`)

import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const EXEC_BITS = 0o111

/** All node_modules roots that can carry a node-pty install. */
const nodePtyRoots = [
  join(repoRoot, 'node_modules', 'node-pty'),
  join(repoRoot, 'app', 'node_modules', 'node-pty'),
]

let fixed = 0
let checked = 0

for (const ptyRoot of nodePtyRoots) {
  const prebuilds = join(ptyRoot, 'prebuilds')
  if (!existsSync(prebuilds)) continue

  for (const platformDir of readdirSync(prebuilds)) {
    const helper = join(prebuilds, platformDir, 'spawn-helper')
    if (!existsSync(helper)) continue

    checked += 1
    const mode = statSync(helper).mode
    if ((mode & EXEC_BITS) === EXEC_BITS) continue

    chmodSync(helper, mode | EXEC_BITS)
    fixed += 1
    console.log(`[fix-native-perms] +x ${helper}`)
  }
}

console.log(
  `[fix-native-perms] done — ${checked} spawn-helper(s) checked, ${fixed} fixed`,
)

#!/usr/bin/env node
/**
 * Prepare guard for the workspace root.
 *
 * The root `prepare` lifecycle script builds the planflow-ai CLI. After the
 * repo became an npm workspace (root CLI + `app/` Electron package), plain
 * `npm install` at the root would rebuild the CLI on every app-focused
 * install. This guard skips the CLI build when:
 *
 *   - the install explicitly targets a workspace (`npm install -w app`,
 *     detected via the `npm_config_workspace` env var), or
 *   - `PLANFLOW_SKIP_PREPARE=1` is set explicitly.
 *
 * Publishing is unaffected: `npm publish` / `npm pack` at the root run
 * `prepare` without a workspace target, so the CLI is always built for the
 * publish flow.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const workspaceTarget = process.env.npm_config_workspace

if (workspaceTarget && workspaceTarget.length > 0) {
  console.log(`[prepare] Skipping CLI build (workspace-targeted install: ${workspaceTarget})`)
  process.exit(0)
}

if (process.env.PLANFLOW_SKIP_PREPARE === '1') {
  console.log('[prepare] Skipping CLI build (PLANFLOW_SKIP_PREPARE=1)')
  process.exit(0)
}

// A fresh `npm install` runs this `prepare` script, but the TypeScript toolchain
// may not be fully materialized yet (the `.bin/tsc` shim can exist before
// `typescript/lib/tsc.js` lands, or a partial/corrupt install leaves it missing)
// — in which case `tsc` throws MODULE_NOT_FOUND and would hard-fail the whole
// install. Don't block install on the CLI build: if tsc isn't resolvable, skip
// with a warning and let the user run `npm run build` afterward. Publish/pack
// installs devDependencies first, so tsc IS present there and the build runs.
if (!tscIsAvailable()) {
  console.warn(
    '[prepare] TypeScript not resolvable yet — skipping CLI build. ' +
      'Run `npm run build` once install completes.',
  )
  process.exit(0)
}

const result = spawnSync('npm', ['run', 'build'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

const failed = result.error != null || (result.status ?? 1) !== 0
if (!failed) {
  process.exit(0)
}

const reason = result.error ? result.error.message : `tsc exited with ${result.status}`
// Only publish/pack must ENFORCE the build. A failure during `npm install` /
// `npm ci` — e.g. the workspace hoist race where the just-verified `tsc` is
// momentarily unresolvable to the build subprocess — must NOT break the install.
// Warn and finish; the user runs `npm run build` once install settles.
const enforcing = ['publish', 'pack'].includes(process.env.npm_command ?? '')
if (enforcing) {
  console.error(`[prepare] CLI build failed: ${reason}`)
  process.exit(result.status ?? 1)
}
console.warn(
  `[prepare] CLI build failed during install (${reason}) — skipping so install can finish. ` +
    'Run `npm run build` once install completes.',
)
process.exit(0)

/**
 * True only when TypeScript is fully installed and its compiler entry
 * (`typescript/lib/tsc.js`) is physically present — the exact file the `tsc`
 * bin `require()`s. Resolving `typescript/package.json` and checking `lib/tsc.js`
 * beside it catches the partial-install case where the `.bin/tsc` shim exists
 * but the package body does not.
 */
function tscIsAvailable() {
  try {
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve('typescript/package.json')
    return existsSync(join(dirname(pkgPath), 'lib', 'tsc.js'))
  } catch {
    return false
  }
}

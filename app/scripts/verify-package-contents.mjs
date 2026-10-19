#!/usr/bin/env node
/**
 * WHAT A PACKAGED FLOW MAY CONTAIN.
 *
 * Usage: node scripts/verify-package-contents.mjs <path to Flow.app | win-unpacked dir>
 *
 * The app payload (Contents/Resources/app on macOS, resources/app on Windows)
 * must hold the compiled bundle, its runtime dependencies and package.json —
 * nothing else. v0.1.10 shipped the entire app/ folder: src/, e2e/, scripts/,
 * docs/, test-results/, tsconfigs and a dev script holding the ingest key,
 * because electron-builder.yml's per-platform `files` blocks held only
 * exclusions and electron-builder then added its own "include everything"
 * default. Nobody noticed, because the app ran perfectly.
 *
 * A check, not a hope: `release` and `install:local` both run this on the
 * artifact they built, and refuse when anything else is in it.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ALLOWED = new Set(['out', 'node_modules', 'package.json'])

const target = process.argv[2]
if (!target) {
  console.error('verify-package-contents: pass the packaged app (Flow.app or a win-unpacked dir)')
  process.exit(1)
}
const candidates = [join(target, 'Contents', 'Resources', 'app'), join(target, 'resources', 'app')]
const payload = candidates.find((dir) => existsSync(dir))
if (payload === undefined) {
  console.error(`verify-package-contents: no app payload under ${target}`)
  process.exit(1)
}
const entries = readdirSync(payload)
const extra = entries.filter((name) => !ALLOWED.has(name))
const missing = [...ALLOWED].filter((name) => !entries.includes(name))
if (extra.length > 0 || missing.length > 0) {
  console.error('verify-package-contents refused:')
  if (extra.length > 0) console.error(`  - the app carries files it must not ship: ${extra.join(', ')}`)
  if (missing.length > 0) console.error(`  - the app is missing: ${missing.join(', ')}`)
  process.exit(1)
}
console.log(`verify-package-contents OK: ${entries.sort().join(', ')}`)

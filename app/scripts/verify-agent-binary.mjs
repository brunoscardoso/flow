// Preflight + postflight guard for the agent SDK's native `claude` binary.
//
// Live incident (2026-07-23): the hoisted
// node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/ dir lost its
// ~237MB `claude` binary (only LICENSE/package.json remained — npm never
// re-verifies extracted contents), and v0.1.7 PACKAGED AND SHIPPED that
// gutted dependency. Every learn/chat session in the installed app then
// failed with "Native CLI binary for darwin-arm64 not found".
//
// Usage:
//   node scripts/verify-agent-binary.mjs            → check the dev tree (pre-build)
//   node scripts/verify-agent-binary.mjs <appDir>   → check a packaged app (post-build)
//   … --target <platform>-<arch>                    → check the TARGET's package, not the host's
//
//     macOS:   node scripts/verify-agent-binary.mjs "dist/mac-arm64/Flow.app"
//     Windows: node scripts/verify-agent-binary.mjs --target win32-x64 "dist/win-unpacked"
//
// Second live incident (2026-09-24): a downloaded v0.1.10 Windows installer
// shipped WITHOUT claude-agent-sdk-win32-x64 (124MB installer vs ~175MB for a
// good one) and every chat failed with "Native CLI binary for win32-x64 not
// found". npm installs only the HOST's optional platform package, so an
// `electron-builder --win` run on a Mac has no Windows binary to pack — and a
// host-derived check passes on the Mac binary it does have. `--target` makes
// the check ask about the artifact being built, not the machine building it.
//
// Fails HARD (exit 1) when the binary is missing, undersized, or not
// executable — a broken bundle must never reach electron-builder or a release.
//
// Platform derivation goes through ../shared/sdk-platform.mjs — the SAME
// module src/main/agent/account-resolver.ts resolves the binary with at
// runtime. That shared source is the point: a verifier that validated a
// different package than the resolver looks for would pass on a bundle the
// app cannot run, which is exactly the failure this guard exists to catch.

import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SDK_BINARY_MIN_BYTES, sdkBinaryName, sdkPackageName } from '../shared/sdk-platform.mjs'

/** Re-exported for callers of this script; the value lives in shared/sdk-platform.mjs. */
export const MIN_BYTES = SDK_BINARY_MIN_BYTES

/**
 * Where the SDK's platform package lands inside a PACKAGED app.
 *
 * macOS ships a .app bundle, so the payload sits under Contents/Resources.
 * Windows (and Linux) ship a flat unpacked directory whose payload is
 * resources/app. `asar: false` is what makes `app/` a real directory on both.
 *
 * @param {string} appDir - dist/mac-arm64/Flow.app | dist/win-unpacked
 * @param {NodeJS.Platform | string} platform
 * @param {string} pkg - e.g. @anthropic-ai/claude-agent-sdk-win32-x64
 * @returns {string}
 */
export function packagedPkgDir(appDir, platform, pkg) {
  const resourcesPath =
    platform === 'darwin' ? join(appDir, 'Contents', 'Resources') : join(appDir, 'resources')
  return join(resourcesPath, 'app', 'node_modules', pkg)
}

/**
 * Inspect the binary without exiting — returns the failure reason, or null
 * plus the size when it is intact.
 *
 * @param {string} pkgDir
 * @param {NodeJS.Platform | string} platform
 * @returns {{ ok: true, binary: string, bytes: number } | { ok: false, reason: string }}
 */
export function inspectBinary(pkgDir, platform) {
  const binary = join(pkgDir, sdkBinaryName(platform))
  if (!existsSync(binary)) return { ok: false, reason: `${binary} does not exist` }

  const stats = statSync(binary)
  if (stats.size < MIN_BYTES) {
    return {
      ok: false,
      reason: `${binary} is ${stats.size} bytes — expected ≥${MIN_BYTES} (truncated/stub)`,
    }
  }
  // NTFS has no POSIX exec bit — Node reports 0o666 for every readable file on
  // Windows, so an exec-bit check there would fail on a perfectly good .exe.
  // Runnability on Windows is decided by the .exe extension, already asserted
  // by sdkBinaryName().
  if (platform !== 'win32' && (stats.mode & 0o111) === 0) {
    return { ok: false, reason: `${binary} is not executable` }
  }
  return { ok: true, binary, bytes: stats.size }
}

function fail(reason) {
  console.error(`verify-agent-binary FAILED: ${reason}`)
  console.error(
    `Recover with: rm -rf node_modules/@anthropic-ai/claude-agent-sdk* && npm install (workspace root)`,
  )
  process.exit(1)
}

function check(pkgDir, label, platform) {
  const result = inspectBinary(pkgDir, platform)
  if (!result.ok) fail(`${label}: ${result.reason}`)
  console.log(
    `verify-agent-binary OK (${label}): ${(result.bytes / 1e6).toFixed(0)}MB — ${result.binary}`,
  )
}

/**
 * Split CLI args into the optional `--target <platform>-<arch>` and the
 * optional positional appDir. No target → the host's platform/arch.
 *
 * @param {string[]} args
 * @returns {{ platform: string, arch: string, appDir: string | undefined } | { error: string }}
 */
export function parseArgs(args) {
  let target = null
  const positional = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target') {
      target = args[++i]
      if (target === undefined) return { error: '--target needs a value like win32-x64' }
    } else {
      positional.push(args[i])
    }
  }
  if (target === null) {
    return { platform: process.platform, arch: process.arch, appDir: positional[0] }
  }
  const dash = target.lastIndexOf('-')
  if (dash <= 0) return { error: `--target '${target}' is not <platform>-<arch> (e.g. win32-x64)` }
  return { platform: target.slice(0, dash), arch: target.slice(dash + 1), appDir: positional[0] }
}

function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if ('error' in parsed) fail(parsed.error)
  const { platform, arch, appDir } = parsed
  const pkg = sdkPackageName(platform, arch)
  if (pkg === null) {
    fail(
      `the agent SDK publishes no native package for ${platform}-${arch} — Flow cannot be packaged for this target`,
    )
  }
  const crossTarget = platform !== process.platform || arch !== process.arch

  if (appDir) {
    // Post-package: the binary inside the built app.
    check(packagedPkgDir(appDir, platform, pkg), 'packaged app', platform)
  } else {
    // Pre-build: wherever npm hoisted the platform package (root or app tree).
    const require = createRequire(import.meta.url)
    let pkgDir = null
    try {
      pkgDir = dirname(require.resolve(`${pkg}/package.json`))
    } catch {
      fail(
        crossTarget
          ? `${pkg} is not installed — npm only installs the build host's (${process.platform}-${process.arch}) native package, so a ${platform}-${arch} artifact built here would ship without the agent binary. Build it on ${platform}-${arch}.`
          : `${pkg} is not installed (optional dep dropped — was npm run with --omit=optional?)`,
      )
    }
    check(pkgDir, 'dev tree', platform)
  }
}

// Importable for verification without running the CLI body (which exits the
// process). Only the direct `node scripts/verify-agent-binary.mjs` invocation
// runs main().
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
}

// SDK platform derivation — the ONE place that knows how the Claude Agent SDK
// names its per-platform native packages and the executable inside them.
//
// WHY plain .mjs at the workspace root rather than TypeScript under src/:
// two very different consumers must agree or the app ships a bundle it cannot
// use. The main process (TypeScript, bundled by electron-vite) resolves the
// binary at runtime; the packaging scripts (`scripts/*.mjs`, plain Node ESM,
// never compiled) verify that the same binary is present and intact. A
// TypeScript module is invisible to the scripts, and a script-local copy
// drifts. One `.mjs` with a sibling `.d.mts` is importable by both.
//
// Naming scheme (verified 2026-08-14 against @anthropic-ai/claude-agent-sdk
// 0.3.204's optionalDependencies):
//   @anthropic-ai/claude-agent-sdk-{darwin,win32}-{x64,arm64}
//   @anthropic-ai/claude-agent-sdk-linux-{x64,arm64}[-musl]
//
// Pure and side-effect free: both functions take the platform/arch as
// arguments rather than reading `process`, so a test on macOS can assert the
// Windows branch (NFR3).

/** npm scope + base name every platform package extends. */
const SDK_PACKAGE_PREFIX = '@anthropic-ai/claude-agent-sdk'

/**
 * Platform/arch pairs the SDK publishes a package for. Anything outside this
 * table returns null rather than a plausible-looking package name that would
 * fail later as a confusing MODULE_NOT_FOUND (NFR5 — fail by name).
 *
 * linux-*-musl exists too, but selecting it needs libc detection, not
 * platform+arch — and Linux is an explicit Non-Goal of the Windows port.
 */
const SUPPORTED = {
  darwin: ['arm64', 'x64'],
  win32: ['x64', 'arm64'],
  linux: ['x64', 'arm64'],
}

/**
 * The SDK's native package for a platform/arch, or null when the SDK
 * publishes none. `sdkPackageName('darwin', 'arm64')` is exactly the string
 * `account-resolver.ts` hardcoded before this module existed.
 *
 * @param {NodeJS.Platform | string} platform
 * @param {string} arch
 * @returns {string | null}
 */
export function sdkPackageName(platform, arch) {
  const archs = SUPPORTED[platform]
  if (archs === undefined || !archs.includes(arch)) {
    return null
  }
  return `${SDK_PACKAGE_PREFIX}-${platform}-${arch}`
}

/**
 * The executable's file name inside that package. Windows needs the `.exe`
 * suffix — an extensionless file is not runnable there, and `require.resolve`
 * of the POSIX name simply misses.
 *
 * @param {NodeJS.Platform | string} platform
 * @returns {string}
 */
export function sdkBinaryName(platform) {
  return platform === 'win32' ? 'claude.exe' : 'claude'
}

/**
 * Convenience for both consumers: the `<package>/<binary>` specifier that
 * `require.resolve` takes, or null on an unsupported platform/arch.
 *
 * @param {NodeJS.Platform | string} platform
 * @param {string} arch
 * @returns {string | null}
 */
export function sdkBinarySpecifier(platform, arch) {
  const pkg = sdkPackageName(platform, arch)
  return pkg === null ? null : `${pkg}/${sdkBinaryName(platform)}`
}

/**
 * The real binary is ~235-247MB; anything under this is a stub or a truncated
 * copy. Shared so the packaging verifier and the runtime provisioner reject
 * the same thing.
 */
export const SDK_BINARY_MIN_BYTES = 100 * 1024 * 1024

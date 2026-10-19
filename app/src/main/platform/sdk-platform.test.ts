// Tests for app/shared/sdk-platform.mjs.
//
// The module under test deliberately lives OUTSIDE src/ (the packaging
// scripts must import it uncompiled), while Jest's roots are `<rootDir>/src`.
// So the test lives here, next to the rest of the platform layer, and reaches
// up — which also proves the thing the module exists to prove: that the
// TypeScript main process can import the exact same file the .mjs scripts do.

import { sdkBinaryName, sdkBinarySpecifier, sdkPackageName } from '../../../shared/sdk-platform.mjs'

describe('sdkPackageName', () => {
  it('returns the darwin-arm64 package account-resolver.ts hardcodes today', () => {
    // NFR1: Phase 2 swaps the hardcoded literal for this call — if the two
    // ever disagree, sign-in breaks in the packaged mac app.
    expect(sdkPackageName('darwin', 'arm64')).toBe('@anthropic-ai/claude-agent-sdk-darwin-arm64')
  })

  it('returns the win32 packages the SDK publishes', () => {
    expect(sdkPackageName('win32', 'x64')).toBe('@anthropic-ai/claude-agent-sdk-win32-x64')
    expect(sdkPackageName('win32', 'arm64')).toBe('@anthropic-ai/claude-agent-sdk-win32-arm64')
  })

  it('covers the remaining published platform/arch pairs', () => {
    expect(sdkPackageName('darwin', 'x64')).toBe('@anthropic-ai/claude-agent-sdk-darwin-x64')
    expect(sdkPackageName('linux', 'x64')).toBe('@anthropic-ai/claude-agent-sdk-linux-x64')
    expect(sdkPackageName('linux', 'arm64')).toBe('@anthropic-ai/claude-agent-sdk-linux-arm64')
  })

  it('returns null rather than a plausible name for unpublished combinations', () => {
    expect(sdkPackageName('win32', 'ia32')).toBeNull()
    expect(sdkPackageName('freebsd', 'x64')).toBeNull()
    expect(sdkPackageName('darwin', 'ppc64')).toBeNull()
  })
})

describe('sdkBinaryName', () => {
  it('is claude.exe on win32 and claude everywhere else', () => {
    expect(sdkBinaryName('win32')).toBe('claude.exe')
    expect(sdkBinaryName('darwin')).toBe('claude')
    expect(sdkBinaryName('linux')).toBe('claude')
  })
})

describe('sdkBinarySpecifier', () => {
  it('composes the require.resolve specifier per platform', () => {
    expect(sdkBinarySpecifier('darwin', 'arm64')).toBe(
      '@anthropic-ai/claude-agent-sdk-darwin-arm64/claude',
    )
    expect(sdkBinarySpecifier('win32', 'x64')).toBe(
      '@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe',
    )
  })

  it('propagates null from an unsupported platform/arch', () => {
    expect(sdkBinarySpecifier('win32', 'ia32')).toBeNull()
  })
})

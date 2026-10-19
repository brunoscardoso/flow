/**
 * Platform-aware label for the OS file manager (#1063).
 *
 * Finder on macOS, Explorer on Windows, a generic "file manager" elsewhere.
 * Shared by every reveal affordance (file-tree, git panel, editor tabs,
 * attachments) so the wording stays consistent and lives in ONE place.
 *
 * The platform is read from the authoritative value the preload bridge
 * surfaces (`window.flowPlatform` === main's `process.platform`), falling back
 * to the renderer's `navigator.platform` sniff only when the bridge is absent
 * (e.g. under unit test). The pure `revealLabelFor` mapping is the unit-tested
 * core.
 */

/** Pure mapping from a platform string to the reveal label. Accepts a Node
 *  `process.platform` value ('darwin' | 'win32' | …) OR a legacy
 *  `navigator.platform` string ('MacIntel', 'Win32', …). */
export function revealLabelFor(platform: string): string {
  const p = platform.toLowerCase()
  if (p === 'darwin' || p.startsWith('mac')) return 'Reveal in Finder'
  if (p === 'win32' || p.startsWith('win')) return 'Reveal in Explorer'
  return 'Reveal in file manager'
}

/** The authoritative platform surfaced by preload, or the navigator fallback. */
export function currentRevealPlatform(): string {
  const fromBridge = (globalThis as { flowPlatform?: string }).flowPlatform
  if (fromBridge) return fromBridge
  return (globalThis as { navigator?: { platform?: string } }).navigator?.platform ?? ''
}

/** Platform-aware reveal label for the current OS. */
export function revealLabel(): string {
  return revealLabelFor(currentRevealPlatform())
}

/**
 * Pure view model for the project accent picker (thread sidebar group
 * headers). DOM-free so the swatch/selection logic is unit-testable under
 * plain jest: the curated 8-swatch palette + an "Auto" entry that clears the
 * override back to the deterministic hash accent. No custom color wheel by
 * design — the curated palette is what stays legible on both themes.
 */
import { PROJECT_ACCENT_PALETTE, overrideSlot, resolveAccent } from '../project-accent'

export interface AccentSwatchOption {
  /** The palette color this swatch stores (`#rrggbb`). */
  color: string
  /** What the swatch is painted with — theme-aware. */
  paint: string
  /** True when this swatch is the root's current override. */
  selected: boolean
}

export interface AccentPickerModel {
  /** The 8 curated palette swatches, in palette order. */
  swatches: AccentSwatchOption[]
  /** True when no override is set — the hash accent ("Auto") applies. */
  autoSelected: boolean
  /** What the root currently paints with (its pick, or its own accent). */
  currentColor: string
}

/**
 * Build the picker model for one root: every palette swatch, the one matching
 * the current override marked selected, and "Auto" selected when there is no
 * override (or the persisted value is malformed/foreign — resolveAccent
 * ignores those, so the model must agree and show Auto).
 */
export function accentPickerModel(rootPath: string, override: string | null): AccentPickerModel {
  const current = resolveAccent(rootPath, override)
  const overrideActive = override !== null && /^#[0-9a-f]{6}$/i.test(override)
  const pickedSlot = overrideActive ? overrideSlot(override) : null
  return {
    swatches: PROJECT_ACCENT_PALETTE.map((entry) => ({
      color: entry.color,
      paint: entry.paint,
      selected: entry.slot === pickedSlot,
    })),
    autoSelected: !overrideActive,
    currentColor: current.color,
  }
}

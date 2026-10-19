// Per-project accent color (multi-project-threads Phase 2; one palette with
// the Workspace map since 2026-10-06 — see PALETTE).
// A thread's attached roots each get a stable color identity — used for
// tree-section headers, git groups, terminal tabs, editor-tab dots, review
// rows, and composer @-mention results in later phases. Hashing the FULL
// rootPath (not the basename) matters: two unrelated roots can share a
// basename (e.g. ~/work/app and ~/oss/app, see project-label.ts #426), and
// those must be free to land on different accents rather than being forced
// identical by an input that ignores the parent path. Precedence: a colour a
// person picked (project settings) → the project's slot in its Workspace (its
// country's colour on the map) → the hash of its full path.

/** A project's resolved accent. */
export interface ProjectAccent {
  /** Hue in degrees (0-360), for callers that want to derive tints/shades. */
  hue: number
  /**
   * What to paint with. A palette colour is a theme-aware reference
   * (`var(--fl-project-hue-N, #hex)`), so the same project reads right on
   * both grounds; a custom colour someone stored is its own `#rrggbb`.
   */
  color: string
  /** The palette slot, or null for a custom colour. */
  slot: number | null
}

/** One palette colour, as a picker offers it and an override stores it. */
export interface PaletteColour {
  slot: number
  hue: number
  /** The canonical `#rrggbb` an override stores (the dark-theme value). */
  color: string
  /** The theme-aware reference to paint with. */
  paint: string
}

/**
 * THE PROJECT PALETTE — the Workspace map's eight hues (decision
 * workspace-blueprint), one per project EVERYWHERE a project is named: the
 * file tree's bar, the switcher's folder, tabs, git groups, chips and the
 * map (user call 2026-10-06: "the colors … according to the color we are
 * using on the app, like [the map]"). This replaced the pastel set of
 * 2026-07-28; a project that had picked one of those keeps its choice,
 * mapped to the matching hue (LEGACY_OVERRIDES). Theme-aware: the tokens
 * `--fl-project-hue-0..7` (theme/tokens.css) hold a lifted value for the dark
 * ground and a darkened one for the light.
 */
const PALETTE: readonly { name: string; hue: number; color: string }[] = [
  { name: 'blue', hue: 212, color: '#5aa8ff' },
  { name: 'teal', hue: 171, color: '#45c4b0' },
  { name: 'violet', hue: 258, color: '#a98bf5' },
  { name: 'amber', hue: 33, color: '#e0a458' },
  { name: 'rose', hue: 341, color: '#e07a9a' },
  { name: 'green', hue: 106, color: '#7cc46a' },
  { name: 'cyan', hue: 192, color: '#4fc3e0' },
  { name: 'sand', hue: 30, color: '#c9a27a' },
]

/** The pastel picks of the old palette → the slot of the same colour family. */
const LEGACY_OVERRIDES: Readonly<Record<string, number>> = {
  '#a7b8ec': 0,
  '#93d2c8': 1,
  '#c5aee8': 2,
  '#eccaa1': 3,
  '#e3aed6': 4,
  '#b8d3a1': 5,
  '#9ccfe3': 6,
  '#b3c1d1': 7,
}

export const PROJECT_HUE_COUNT = PALETTE.length

/** The theme-aware paint for a slot. */
export function slotPaint(slot: number): string {
  const index = ((Math.trunc(slot) % PALETTE.length) + PALETTE.length) % PALETTE.length
  return `var(--fl-project-hue-${String(index)}, ${PALETTE[index].color})`
}

/** Every palette colour, in slot order — what a picker offers. */
export const PROJECT_ACCENT_PALETTE: readonly PaletteColour[] = PALETTE.map(({ hue, color }, slot) => ({
  slot,
  hue,
  color,
  paint: slotPaint(slot),
}))

function slotAccent(slot: number): ProjectAccent {
  const index = ((Math.trunc(slot) % PALETTE.length) + PALETTE.length) % PALETTE.length
  return { hue: PALETTE[index].hue, color: slotPaint(index), slot: index }
}

/**
 * FNV-1a 32-bit — small, dependency-free, and stable across JS engines
 * (only bitwise/Math.imul integer ops, no locale or float rounding paths).
 * Not cryptographic; that's fine, this only needs to spread inputs evenly.
 */
function fnv1aHash(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

// ── Workspace slots ──────────────────────────────────────────────────────────
// A project in a Workspace wears its POSITION there (workspace.json order) —
// the same slot the map gives its country, on every machine. Recorded here by
// whoever reads the Workspaces (project-accent-workspaces.ts); a root with no
// slot falls back to the hash of its full path.
const accentSlots = new Map<string, number>()

/**
 * The project's accent before any pick: its Workspace slot, else a stable
 * hash of its FULL path (never the basename — two roots named `app` must be
 * free to differ).
 */
export function projectAccent(rootPath: string): ProjectAccent {
  const slot = accentSlots.get(rootPath)
  return slotAccent(slot ?? fnv1aHash(rootPath) % PALETTE.length)
}

/** Shape of a persisted override string — `#rrggbb`. */
const OVERRIDE_COLOR_PATTERN = /^#[0-9a-f]{6}$/i

/** The slot an override names, or null for a custom colour. */
export function overrideSlot(override: string): number | null {
  const lower = override.toLowerCase()
  const index = PALETTE.findIndex((entry) => entry.color === lower)
  if (index >= 0) return index
  return LEGACY_OVERRIDES[lower] ?? null
}

/**
 * Resolve a root's accent with an optional user override: a well-formed
 * override wins (a palette colour — or an old pastel one — as its slot's
 * theme-aware paint; anything else as itself); null/undefined (or a malformed
 * value) falls back to the project's own accent. Pure.
 */
export function resolveAccent(rootPath: string, override?: string | null): ProjectAccent {
  if (typeof override === 'string' && OVERRIDE_COLOR_PATTERN.test(override)) {
    const slot = overrideSlot(override)
    if (slot !== null) return slotAccent(slot)
    return { hue: projectAccent(rootPath).hue, color: override.toLowerCase(), slot: null }
  }
  return projectAccent(rootPath)
}

/**
 * Record every local project's Workspace slot (root path → position). Roots
 * not in the map lose theirs (a project that left its Workspace). Repaints the
 * roots whose slot changed.
 */
export function setAccentSlots(slots: ReadonlyMap<string, number>): void {
  const touched = new Set<string>()
  for (const [root, slot] of accentSlots) {
    if (slots.get(root) !== slot) touched.add(root)
  }
  for (const [root, slot] of slots) {
    if (accentSlots.get(root) !== slot) touched.add(root)
  }
  accentSlots.clear()
  for (const [root, slot] of slots) accentSlots.set(root, slot)
  for (const root of touched) registerAccentProperty(root)
}

// ── Override registry (renderer-wide, one code path) ────────────────────────
// The persisted override (workspaces.accent_color) reaches the renderer on two
// seams — RegisteredProject.accentColor (rootsChanged) and ThreadScopeEntry.accent
// (threadScopeChanged). Whichever surface sees it records it here, and EVERY
// consumer that paints via ensureAccentProperty resolves through it — so a
// call site without the override at hand (terminal tabs, pending-changes
// strip, git groups) still paints the user's color, and a live change
// re-registers the shared CSS custom property, repainting every var() user
// without any surface re-rendering.
const accentOverrides = new Map<string, string>()

/**
 * Record `rootPath`'s override (null clears it → "Auto") and refresh the
 * root's CSS custom property so existing var() references repaint live.
 */
export function setAccentOverride(rootPath: string, override: string | null): void {
  if (override !== null && OVERRIDE_COLOR_PATTERN.test(override)) {
    accentOverrides.set(rootPath, override)
  } else {
    accentOverrides.delete(rootPath)
  }
  registerAccentProperty(rootPath)
}

/** The currently-registered override for `rootPath`, or null ("Auto"). */
export function accentOverrideFor(rootPath: string): string | null {
  return accentOverrides.get(rootPath) ?? null
}

/**
 * Sync the registry from a roots payload (rootsChanged / initial load): each
 * root's override is set or cleared to match persistence. Roots not in the
 * payload are left untouched (a partial payload must not clear overrides).
 */
export function applyAccentOverrides(
  roots: ReadonlyArray<{ rootPath: string; accentColor?: string | null }>,
): void {
  for (const root of roots) {
    setAccentOverride(root.rootPath, root.accentColor ?? null)
  }
}

const ACCENT_PROPERTY_PREFIX = '--fl-project-accent-'

/**
 * The CSS custom-property NAME for `rootPath`'s accent — unique per root
 * (derived from the full hash, not the 8-bucket palette index, so two roots
 * sharing a palette bucket still get distinct property names). Pure; does
 * not touch the DOM.
 */
export function accentProperty(rootPath: string): string {
  const hash = fnv1aHash(rootPath)
  return `${ACCENT_PROPERTY_PREFIX}${hash.toString(16).padStart(8, '0')}`
}

// The jest tsconfig (tsconfig.test.json → tsconfig.node.json) intentionally
// omits the DOM lib — main-process code must never reference DOM globals.
// This module lives in src/renderer and needs ONE DOM call, so it duck-types
// the sliver of `Document` it actually uses instead of pulling in the full
// DOM lib (which would make `document` a bare, unguarded global here too).
interface MinimalDocument {
  documentElement: { style: { setProperty(name: string, value: string): void } }
}

/** (Re-)register `rootPath`'s resolved accent (override-aware) on `<html>`. */
function registerAccentProperty(rootPath: string): void {
  const doc = (globalThis as { document?: MinimalDocument }).document
  if (!doc) return
  const { color } = resolveAccent(rootPath, accentOverrides.get(rootPath) ?? null)
  doc.documentElement.style.setProperty(accentProperty(rootPath), color)
}

/**
 * DOM utility: registers `rootPath`'s accent color as a custom property on
 * `<html>` and returns a `var(...)` reference ready to drop into inline
 * styles or CSS. Override-aware: pass the override when the call site has it
 * (a ThreadScopeEntry's `accent ?? null`) — `undefined` means "not known
 * here" and resolves from the registry, while an explicit string/null also
 * SYNCS the registry, so a later no-argument call can never revert a live
 * override. Re-registering on change updates the property in place — every
 * existing var() reference repaints. Guarded for non-DOM contexts (e.g.
 * accidental import under plain-node Jest) so it degrades to a no-op `var()`
 * reference instead of throwing.
 */
export function ensureAccentProperty(rootPath: string, override?: string | null): string {
  if (override !== undefined) {
    setAccentOverride(rootPath, override)
  } else {
    registerAccentProperty(rootPath)
  }
  return `var(${accentProperty(rootPath)})`
}

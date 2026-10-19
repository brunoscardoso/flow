// Shell layout persistence model (#454). saveLayoutState() faithfully writes the
// user's panel layout, but loadLayoutState() used to rebuild the object with ONLY
// `splits` and `collapsed` — silently dropping `sideTab`, `terminalVisible`, and
// `sidebarVisible`, so those three prefs reset to defaults on every restart (and got
// re-saved, clobbering the good values). normalizeLayoutState is the single, pure
// validation path for a parsed candidate — DOM-free so every field is unit-testable.
//
// Responsive-layout (#580, Phase 1) extends this: each state now carries a
// `panelLayout` (side/order/visibility of the movable panels), and the persisted
// SHAPE moves from a single global object to a per-root record (ShellLayoutStore,
// version 5) so each project restores its own arrangement. A legacy v3 global object
// migrates once into the active root's slot (migrateLegacyLayout).
//
// Activity-bar (#activity-bar, Phase 1) adds `activeRailItem` and `sidebarOpen`
// to ShellLayoutState, with legacy `sideTab` migration on first load.
import { normalizePanelLayout, type PanelLayout } from './panel-layout'
import { type RailItem, resolveRailItem } from './sidetab-state'

/**
 * "The Source Control pane may have come into view — look again."
 *
 * A bare ping, carrying no payload on purpose: the DOM is the one truth about
 * what is on screen, and a boolean travelling beside it is a second copy that
 * can disagree with it. The shell fires this after any change that could have
 * revealed or hidden the pane; the pane's own code reads its element and
 * decides (see git/landing-refresh-model.ts).
 *
 * It exists because a thread's checkout is watched by nothing — it is
 * deliberately never a registered project root — so the one honest moment to
 * re-read what is waiting in it is when a person turns to look.
 */
export const SOURCE_CONTROL_VISIBILITY_EVENT = 'flow:source-control-visibility'

export interface ShellLayoutState {
  splits: Record<string, number[]>
  collapsed: Record<string, boolean>
  /** @deprecated Kept for one migration cycle — use `activeRailItem`. Persisted
   *  raw value; `resolveRailItem` migrates legacy ids ('git'/'review' → 'source-control',
   *  #335). Kept as a string so a legacy value survives load to be migrated rather
   *  than dropped. */
  sideTab?: string
  /** Source Control view mode — flat Changes vs phase-grouped Phases (#335). */
  sideViewMode?: 'changes' | 'phases'
  /** @deprecated Kept for one migration cycle. Whether the terminal pane is shown
   *  (default true). */
  terminalVisible?: boolean
  /** Whether the threads sidebar is shown (default true). */
  sidebarVisible?: boolean
  /** Responsive-layout model (#580) — side/order/visibility of the movable panels
   *  + editor visibility + focus mode. Absent/corrupt → DEFAULT_PANEL_LAYOUT. */
  panelLayout?: PanelLayout
  /** Active rail item in the activity bar (default: 'files'). */
  activeRailItem?: RailItem
  /** Whether the activity bar sidebar is open (default: true). */
  sidebarOpen?: boolean
}

/** Current per-root persistence shape (#580). rootId → that project's layout. */
export interface ShellLayoutStore {
  version: 5
  roots: Record<string, ShellLayoutState>
}

const LAYOUT_STORE_VERSION = 5 as const

function isSizesRecord(value: unknown): value is Record<string, number[]> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every(
      (sizes) => Array.isArray(sizes) && sizes.every((n) => typeof n === 'number'),
    )
  )
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((flag) => typeof flag === 'boolean')
  )
}

/** All known rail item ids — the 3 live sidebar items plus legacy values preserved
 *  on load so `resolveRailItem` can migrate them. */
const KNOWN_RAIL_ITEMS = new Set([
  'threads',
  'files',
  'source-control',
  // Retired: the worktree panel moved onto the explorer's project row, where
  // the state it reports already lived. Kept KNOWN so a persisted layout that
  // still names it migrates instead of reading as corrupt.
  'worktrees',
  // Legacy aliases — migrated by resolveRailItem on read.
  'loops',
  'git',
  'review',
  'terminal',
  'tasks',
  'blueprint',
])

/** Live sidebar-switching rail item ids only — excludes legacy aliases. */
const LIVE_RAIL_ITEMS = new Set<RailItem>([
  'threads',
  'files',
  'source-control',
])

function isKnownRailItem(value: unknown): value is RailItem {
  return typeof value === 'string' && LIVE_RAIL_ITEMS.has(value as RailItem)
}

/** Preserved for consumers that reference the old name — delegates to the new set. */
function isKnownSideTab(value: unknown): value is string {
  return typeof value === 'string' && KNOWN_RAIL_ITEMS.has(value)
}

function isSideViewMode(value: unknown): value is 'changes' | 'phases' {
  return value === 'changes' || value === 'phases'
}

/**
 * Validate a parsed layout candidate into a ShellLayoutState, preserving ALL
 * persisted keys. Each field is guarded defensively so corrupt state still falls
 * back to defaults (undefined for the optional prefs → the shell's own defaults
 * apply), consistent with the record guards.
 */
export function normalizeLayoutState(parsed: unknown): ShellLayoutState {
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      splits: {},
      collapsed: {},
      panelLayout: normalizePanelLayout(undefined),
      activeRailItem: 'threads',
      sidebarOpen: true,
    }
  }
  const candidate = parsed as Partial<ShellLayoutState>
  return {
    splits: isSizesRecord(candidate.splits) ? candidate.splits : {},
    collapsed: isBooleanRecord(candidate.collapsed) ? candidate.collapsed : {},
    sideTab: isKnownSideTab(candidate.sideTab) ? candidate.sideTab : undefined,
    sideViewMode: isSideViewMode(candidate.sideViewMode) ? candidate.sideViewMode : undefined,
    terminalVisible:
      typeof candidate.terminalVisible === 'boolean' ? candidate.terminalVisible : undefined,
    sidebarVisible:
      typeof candidate.sidebarVisible === 'boolean' ? candidate.sidebarVisible : undefined,
    // Absent or corrupt → DEFAULT_PANEL_LAYOUT (normalizePanelLayout is fail-soft).
    panelLayout: normalizePanelLayout(candidate.panelLayout),
    // Prefer the new `activeRailItem` field; fall back to migrating the legacy
    // `sideTab` value on first load so existing persisted prefs are preserved.
    activeRailItem: isKnownRailItem(candidate.activeRailItem)
      ? candidate.activeRailItem
      : resolveRailItem(candidate.sideTab),
    sidebarOpen: typeof candidate.sidebarOpen === 'boolean' ? candidate.sidebarOpen : true,
  }
}

/**
 * Fail-soft validation of a parsed v5 store. A non-object, wrong version, or bad
 * `roots` map → an empty store. Each root's state is validated via
 * normalizeLayoutState; non-string keys and non-object values are dropped.
 */
export function normalizeLayoutStore(parsed: unknown): ShellLayoutStore {
  const empty: ShellLayoutStore = { version: LAYOUT_STORE_VERSION, roots: {} }
  if (typeof parsed !== 'object' || parsed === null) return empty
  const candidate = parsed as Partial<ShellLayoutStore>
  if (candidate.version !== LAYOUT_STORE_VERSION) return empty
  if (typeof candidate.roots !== 'object' || candidate.roots === null) return empty

  const roots: Record<string, ShellLayoutState> = {}
  for (const [rootId, state] of Object.entries(candidate.roots)) {
    if (typeof rootId !== 'string' || rootId.length === 0) continue
    roots[rootId] = normalizeLayoutState(state)
  }
  return { version: LAYOUT_STORE_VERSION, roots }
}

/**
 * One-time migration of the legacy v3 single-global ShellLayoutState into the v5
 * per-root store, keyed under the active root. The legacy object never carried a
 * panelLayout or activeRailItem, so the active root gets today's DEFAULT_PANEL_LAYOUT
 * and activity-bar defaults. Fail-soft: garbage input still yields a valid store
 * with a normalized (default) slot.
 */
export function migrateLegacyLayout(v3Global: unknown, activeRootId: string): ShellLayoutStore {
  const migrated = normalizeLayoutState(v3Global)
  // Legacy states predate panelLayout — anchor the active root to today's layout.
  // normalizePanelLayout(undefined) returns a fresh deep clone of the default.
  migrated.panelLayout = normalizePanelLayout(undefined)
  // Legacy states predate the activity bar — set explicit defaults.
  migrated.activeRailItem = 'threads'
  migrated.sidebarOpen = true
  return { version: LAYOUT_STORE_VERSION, roots: { [activeRootId]: migrated } }
}

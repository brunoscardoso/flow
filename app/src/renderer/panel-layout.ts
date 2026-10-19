// Responsive-layout model (#580, Phase 1). The DOM-free heart of the feature:
// a panel/side/order/visible model, its pure reducers, and a split-build plan
// the shell renders into the root split. Nothing here touches the DOM, window,
// document, or electron — every field and reducer is unit-testable in isolation.
//
// Invariants (discovery NFR2/NFR3, plan P1):
//  - Exactly one immovable center: the editor. The only movable panel is
//    conversation; the activity-bar sidebar (threads, files, source-control) is
//    driven by RailItem in sidetab-state, out of this model.
//  - Fail-soft: an unknown/corrupt model falls back to DEFAULT_PANEL_LAYOUT.
//  - Non-empty: hiding the editor + every panel must never yield a blank shell —
//    enforceNonEmpty forces the editor back on.
//
// Focus-mode model: focusMode is a SEPARATE overlay flag, never a save/restore of
// individual `visible` flags. A panel is EFFECTIVELY shown iff `visible && !focusMode`,
// so leaving focus mode restores each panel's own visibility exactly, for free.

/** The lateral panel that can move between the left/right of the editor.
 *  Threads moved into the activity-bar sidebar; only conversation remains movable. */
export type MovablePanelId = 'conversation'

/** Which side of the immovable center editor a panel sits on. */
export type PanelSide = 'left' | 'right'

export interface MovablePanelState {
  id: MovablePanelId
  side: PanelSide
  /** Ordering WITHIN a side (ascending). Only relative order matters. */
  order: number
  /** The panel's own persisted visibility, independent of focus mode. */
  visible: boolean
}

export interface PanelLayout {
  panels: MovablePanelState[]
  /** Whether the immovable center editor is shown. */
  editorVisible: boolean
  /** Overlay flag: when on, every panel is effectively hidden (see effectivePanels). */
  focusMode: boolean
  /**
   * #1351: whether a surface OUTSIDE this model is rendering — today the
   * activity sidebar, which is open by default and driven by RailItem in
   * sidetab-state. The non-empty guard could not see it, so it fired in states
   * where the shell would obviously not be blank: ⌘⌥D became a dead key with
   * Chat hidden, and ⌘⌥C silently re-opened the editor you had hidden.
   *
   * Optional: an older persisted layout (and any caller that doesn't know)
   * keeps the previous, conservative behaviour.
   */
  otherSurfacesVisible?: boolean
  /**
   * #1538: whether the immovable center actually RENDERS anything — it has a
   * tab, or a terminal is docked in it. `editorVisible` is a request, not an
   * outcome: #675 collapses an empty editor stack, so a layout could carry
   * `editorVisible: true` and still paint nothing. The guard trusted the flag
   * and therefore never fired on the one state that really is blank — chat,
   * terminal and sidebar all put away on a window with zero tabs.
   *
   * Optional, exactly like `otherSurfacesVisible`: absent means "assume it
   * renders", which is the behaviour every caller had before.
   */
  editorHasContent?: boolean
  /**
   * The right side fills the window between the sidebar and the window edge:
   * an overlay flag, like `focusMode`, that takes ONLY the conversation off
   * screen — the conversation's own `visible` is untouched, so leaving the
   * mode restores it exactly. Meaningful only while the editor is shown (see
   * effectivePanels). Persisted per scope; optional so every layout written
   * before it reads as "not expanded". Reducers live in expand-right-model.ts.
   */
  rightExpanded?: boolean
}

const LEFT: PanelSide = 'left'
const RIGHT: PanelSide = 'right'

/**
 * TODAY's arrangement, modeled: conversation left(0); editor shown; focus mode off.
 * Threads moved into the activity-bar sidebar — it is no longer a MovablePanelId.
 * The activity-bar sidebar (threads/files/source-control) is driven by RailItem
 * in sidetab-state — not a MovablePanelId.
 */
export const DEFAULT_PANEL_LAYOUT: PanelLayout = {
  panels: [
    { id: 'conversation', side: LEFT, order: 0, visible: true },
  ],
  editorVisible: true,
  focusMode: false,
}

const MOVABLE_PANEL_IDS: readonly MovablePanelId[] = ['conversation']

export function isMovablePanelId(value: unknown): value is MovablePanelId {
  return typeof value === 'string' && (MOVABLE_PANEL_IDS as readonly string[]).includes(value)
}

function isPanelSide(value: unknown): value is PanelSide {
  return value === LEFT || value === RIGHT
}

/** Deep-clone a layout so reducers never mutate their input. */
function cloneLayout(layout: PanelLayout): PanelLayout {
  return {
    panels: layout.panels.map((panel) => ({ ...panel })),
    editorVisible: layout.editorVisible,
    focusMode: layout.focusMode,
    // BOTH OPTIONAL FLAGS SURVIVE THE CLONE. They were listed field-by-field
    // here and simply not listed, so every reducer handed enforceNonEmpty a
    // layout that had forgotten what the shell told it — reviving #1351's
    // symptom B (a chat toggle silently re-opening a hidden editor) inside the
    // reducers, one call before applyLayout re-supplied the flag it had
    // already acted on. `undefined` stays undefined, so callers that never set
    // them are unchanged.
    ...(layout.otherSurfacesVisible === undefined
      ? {}
      : { otherSurfacesVisible: layout.otherSurfacesVisible }),
    ...(layout.editorHasContent === undefined
      ? {}
      : { editorHasContent: layout.editorHasContent }),
    ...(layout.rightExpanded === undefined ? {} : { rightExpanded: layout.rightExpanded }),
  }
}

/** Highest existing order on a side, or -1 when the side is empty. */
function maxOrderOnSide(panels: MovablePanelState[], side: PanelSide): number {
  return panels
    .filter((panel) => panel.side === side)
    .reduce((max, panel) => Math.max(max, panel.order), -1)
}

/**
 * The panels that should actually render: their own `visible` AND focus mode off.
 * Sorted by side then order for a deterministic result. When focusMode is on this
 * is always empty (the editor still renders iff editorVisible).
 */
export function effectivePanels(layout: PanelLayout): MovablePanelState[] {
  if (layout.focusMode) return []
  // The right side expanded: the conversation steps aside — but only while
  // the editor is there to take its width, never into an empty middle.
  const chatSteppedAside = layout.rightExpanded === true && layout.editorVisible
  return layout.panels
    .filter((panel) => panel.visible && !(chatSteppedAside && panel.id === 'conversation'))
    .sort((a, b) => (a.side === b.side ? a.order - b.order : a.side < b.side ? -1 : 1))
}

/**
 * Non-empty invariant (NFR2 / R5): if a layout would render NOTHING — no effective
 * panels AND the editor hidden — force the editor back on so the shell is never
 * blank. Returns the layout unchanged when it already renders something. Applied
 * inside every reducer that can hide things.
 */
export function rendersSomething(layout: PanelLayout): boolean {
  return (
    // #1538: the editor counts only when it will actually paint. `editorVisible`
    // is the REQUEST; `editorHasContent` is the outcome, and an empty editor
    // stack (no tab, no docked terminal) renders a blank rectangle. Absent
    // means "assume it renders" — the pre-#1538 reading, kept for every caller
    // and every persisted layout that predates the field.
    (layout.editorVisible && layout.editorHasContent !== false) ||
    effectivePanels(layout).length > 0 ||
    // #1351: the activity sidebar (threads / files / source-control) renders
    // too, and it is open by default at 306px — but it is driven by RailItem
    // in sidetab-state, deliberately outside this model, so the guard could
    // not see it and fired in states where the shell would obviously not be
    // blank. Silently, and with two user-visible symptoms:
    //
    //   A — ⌘⌥D was a DEAD KEY whenever Chat was hidden. Editor stays, no
    //       toast, no notice; press it four times and nothing happens.
    //   B — ⌘⌥C, a CHAT toggle, silently re-opened the editor you had
    //       deliberately hidden. One keystroke, two panels changed.
    //
    // Callers that know the sidebar's state pass it; the default preserves the
    // old conservative behaviour for callers that don't.
    layout.otherSurfacesVisible === true
  )
}

export function enforceNonEmpty(layout: PanelLayout): PanelLayout {
  if (rendersSomething(layout)) return layout
  // The editor is the only surface this model can force back on. When it is
  // already on and simply has nothing to paint (#1538), this is a no-op by
  // design — the model cannot conjure a tab. `rendersSomething` stays false,
  // which is the signal the shell reads to paint its empty-panel
  // watermark instead of a blank rectangle.
  return { ...layout, editorVisible: true }
}

/**
 * Move a panel to `side`, appended to the END of that side's order. Re-normalizes
 * both sides' orders to compact 0..n sequences so ordering stays deterministic.
 * No-op-safe: an unknown id returns a faithful clone.
 */
export function assignSide(layout: PanelLayout, id: MovablePanelId, side: PanelSide): PanelLayout {
  const next = cloneLayout(layout)
  const target = next.panels.find((panel) => panel.id === id)
  if (target !== undefined) {
    target.side = side
    // Park it after the current max on the target side, then compact.
    target.order = maxOrderOnSide(
      next.panels.filter((panel) => panel.id !== id),
      side,
    ) + 1
    compactOrders(next.panels)
  }
  return enforceNonEmpty(next)
}

/** Compact each side's `order` values into a stable 0..n ascending sequence. */
function compactOrders(panels: MovablePanelState[]): void {
  for (const side of [LEFT, RIGHT] as const) {
    panels
      .filter((panel) => panel.side === side)
      .sort((a, b) => a.order - b.order)
      .forEach((panel, index) => {
        panel.order = index
      })
  }
}

/**
 * Move a focused panel one step: 'left'/'right' flips the panel to that side
 * (appended to the end), matching a keyboard "move panel left/right" action.
 * Flipping to the side it already occupies still re-appends (idempotent placement).
 */
export function moveFocused(
  layout: PanelLayout,
  id: MovablePanelId,
  dir: 'left' | 'right',
): PanelLayout {
  return assignSide(layout, id, dir === 'left' ? LEFT : RIGHT)
}

/** Flip a panel's own visibility. Enforces the non-empty invariant. */
export function togglePanel(layout: PanelLayout, id: MovablePanelId): PanelLayout {
  const next = cloneLayout(layout)
  const target = next.panels.find((panel) => panel.id === id)
  if (id === 'conversation' && next.rightExpanded === true && next.editorVisible) {
    // The chat is off screen because the right side is expanded: a chat toggle
    // means "show it", never a flip of a flag nobody can see.
    next.rightExpanded = false
    if (target !== undefined) target.visible = true
    return enforceNonEmpty(next)
  }
  if (target !== undefined) {
    target.visible = !target.visible
  }
  return enforceNonEmpty(next)
}

/** Flip the center editor's visibility. Enforces the non-empty invariant. */
export function toggleEditor(layout: PanelLayout): PanelLayout {
  const next = cloneLayout(layout)
  next.editorVisible = !next.editorVisible
  // Hiding the right side leaves the expanded mode — and brings the chat back,
  // so the middle is never left empty.
  if (!next.editorVisible && next.rightExpanded === true) {
    next.rightExpanded = false
    next.panels = next.panels.map((panel) =>
      panel.id === 'conversation' ? { ...panel, visible: true } : panel,
    )
  }
  return enforceNonEmpty(next)
}

/**
 * Turn focus mode on/off. Focus mode is an overlay flag — turning it on hides all
 * panels effectively (via effectivePanels), turning it off restores each panel's
 * own `visible` exactly, with no saved/restored per-panel state. Enforces the
 * non-empty invariant (focus mode with a hidden editor would blank the shell).
 */
export function setFocusMode(layout: PanelLayout, on: boolean): PanelLayout {
  const next = cloneLayout(layout)
  next.focusMode = on
  return enforceNonEmpty(next)
}

/** Restore the default arrangement (today's layout). */
export function resetLayout(): PanelLayout {
  return cloneLayout(DEFAULT_PANEL_LAYOUT)
}

export interface SplitPlan {
  left: MovablePanelId[]
  center: 'editor' | null
  right: MovablePanelId[]
}

/**
 * The exact plan the shell renders into the root split:
 *   [ …left panels in order · editor(center) · …right panels in order ]
 * Left/right are the effective panels on each side sorted by order; center is
 * 'editor' when editorVisible, else null. Pure and deterministic.
 */
export function buildSplitPlan(layout: PanelLayout): SplitPlan {
  const effective = effectivePanels(layout)
  const bySide = (side: PanelSide): MovablePanelId[] =>
    effective
      .filter((panel) => panel.side === side)
      .sort((a, b) => a.order - b.order)
      .map((panel) => panel.id)
  return {
    left: bySide(LEFT),
    center: layout.editorVisible ? 'editor' : null,
    right: bySide(RIGHT),
  }
}

/**
 * Fail-soft validation of a parsed PanelLayout candidate. Anything corrupt or
 * absent → DEFAULT_PANEL_LAYOUT. A partially-valid candidate keeps only its valid
 * movable panels; if the set of valid panel ids is incomplete, we fall back to the
 * default so the shell never renders with a missing panel it can't reconstruct.
 */
export function normalizePanelLayout(parsed: unknown): PanelLayout {
  if (typeof parsed !== 'object' || parsed === null) return cloneLayout(DEFAULT_PANEL_LAYOUT)
  const candidate = parsed as Partial<PanelLayout>
  if (!Array.isArray(candidate.panels)) return cloneLayout(DEFAULT_PANEL_LAYOUT)

  const validPanels: MovablePanelState[] = []
  const seen = new Set<MovablePanelId>()
  for (const raw of candidate.panels) {
    if (typeof raw !== 'object' || raw === null) continue
    const panel = raw as Partial<MovablePanelState>
    if (
      isMovablePanelId(panel.id) &&
      !seen.has(panel.id) &&
      isPanelSide(panel.side) &&
      typeof panel.order === 'number' &&
      Number.isFinite(panel.order) &&
      typeof panel.visible === 'boolean'
    ) {
      validPanels.push({ id: panel.id, side: panel.side, order: panel.order, visible: panel.visible })
      seen.add(panel.id)
    }
  }
  // Every movable panel must be present; a missing one can't be reconstructed, so
  // fall back to the default arrangement rather than render a broken shell.
  if (seen.size !== MOVABLE_PANEL_IDS.length) return cloneLayout(DEFAULT_PANEL_LAYOUT)

  compactOrders(validPanels)
  const normalized: PanelLayout = {
    panels: validPanels,
    editorVisible: typeof candidate.editorVisible === 'boolean' ? candidate.editorVisible : true,
    // Focus mode is a transient whole-UI overlay, never restored across a
    // reload — restoring it strands the user in a panel-less, menu-less shell
    // with no discoverable exit (#616). Always start with it OFF.
    focusMode: false,
    // Remembered per scope, unlike focus mode: it is a layout the person chose
    // for this thread, and the right side it expands is on screen with it.
    // Only `true` survives, and only beside a shown editor.
    ...(candidate.rightExpanded === true && candidate.editorVisible !== false
      ? { rightExpanded: true }
      : {}),
  }
  return enforceNonEmpty(normalized)
}

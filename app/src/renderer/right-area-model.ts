/**
 * THE RIGHT-HAND AREA — put away and brought back with one button. DOM-free.
 *
 * The window's right side is the editor area: its tabs (a file, Blueprint,
 * Tasks, Settings…), the chrome icons on its top bar, and the terminal docked
 * under it. The titlebar's right corner carries a toggle for it, the mirror of
 * the sidebar toggle in the left corner (user, 2026-10-06): one press minimizes
 * the whole column and the conversation takes the freed width; the next press
 * brings it back exactly as it was.
 *
 * It is the panel model's own `editorVisible` flag, not a second copy of it —
 * so it persists with the rest of the layout (per project and thread, through
 * the shell's layout store), ⌘⌥D and this button can never disagree, and every
 * surface that already reveals the editor before opening into it (a file,
 * Settings, the Blueprint — `flow:show-editor`) brings the area back too.
 *
 * Two rules live here because the button must never be a dead key:
 *
 *  - PRESSED means ON SCREEN. `editorVisible` is a request; an empty editor
 *    with nothing beside it is collapsed by the shell (#675). The button
 *    reflects what the person sees, not what was asked for.
 *  - PUTTING IT AWAY LEAVES SOMETHING. The panel model's non-empty guard
 *    would force a hidden editor straight back on when nothing else renders
 *    (chat hidden, sidebar closed) — the press would do nothing at all. The
 *    area exists to hand its width to the conversation, so in that one state
 *    the conversation comes back to take it.
 */
import { enforceNonEmpty, toggleEditor, type PanelLayout } from './panel-layout'

export interface RightAreaContext {
  /** Whether the editor stack is in the window right now (the shell measures it). */
  rendered: boolean
  /** Whether a surface outside the panel model (the activity sidebar) renders. */
  otherSurfacesVisible: boolean
}

/** The toggle's pressed state: the area is on screen, and focus mode — the
 *  editor-only overlay, where this toggle is inert — is not what put it there. */
export function rightAreaShown(layout: PanelLayout, context: RightAreaContext): boolean {
  return context.rendered && layout.editorVisible && !layout.focusMode
}

/** Put the right-hand area away, leaving the conversation to take its width. */
export function collapseRightArea(layout: PanelLayout, context: RightAreaContext): PanelLayout {
  // Hiding the right side while it is expanded leaves the expanded mode, and
  // the chat comes back to take the width (expand-right-model.ts).
  const wasExpanded = layout.rightExpanded === true
  const hidden: PanelLayout = {
    ...layout,
    panels: layout.panels.map((panel) =>
      wasExpanded && panel.id === 'conversation' ? { ...panel, visible: true } : { ...panel },
    ),
    editorVisible: false,
    ...(wasExpanded ? { rightExpanded: false } : {}),
    otherSurfacesVisible: context.otherSurfacesVisible,
  }
  const guarded = enforceNonEmpty(hidden)
  if (!guarded.editorVisible) return guarded
  // The guard would put the editor straight back: nothing else renders. Bring
  // the conversation back to take the width instead of ignoring the press.
  return {
    ...hidden,
    panels: hidden.panels.map((panel) =>
      panel.id === 'conversation' ? { ...panel, visible: true } : panel,
    ),
  }
}

/** Bring the right-hand area back. */
export function expandRightArea(layout: PanelLayout): PanelLayout {
  return layout.editorVisible ? layout : toggleEditor(layout)
}

/**
 * One press of the toggle (or ⌘⌥B). Inert under focus mode — the overlay shows
 * the editor alone, and a change behind it would only rewrite the layout the
 * person gets back on exit (the shell's focus-mode swallow rule).
 */
export function toggleRightArea(layout: PanelLayout, context: RightAreaContext): PanelLayout {
  if (layout.focusMode) return layout
  return rightAreaShown(layout, context)
    ? collapseRightArea(layout, context)
    : expandRightArea(layout)
}

/** The toggle's tooltip — the consequence of pressing it, in words. */
export function rightAreaToggleTitle(shown: boolean): string {
  return shown ? 'Hide the editor area (⌘⌥B)' : 'Show the editor area (⌘⌥B)'
}

/**
 * THE READING COLUMN WHILE THE AREA IS AWAY. The conversation takes the freed
 * width, but its text does not: the transcript, its header and the composer
 * cap on `--fl-conv-column`, centred, and with the area put away the cap
 * narrows to this — the freed width becomes margin on both sides of a
 * readable column (user, 2026-10-06: "roughly 640–680px").
 */
export const COLLAPSED_READING_COLUMN_PX = 680

/**
 * Keep one pane at the width it has now when the split around it changes.
 * The sidebar must never grow to fill the width the right-hand area gave up
 * (nor shrink when it comes back): `fraction` is its current share of the
 * split, and the other panes share what is left in their own proportions.
 * Returns `sizes` unchanged when the request cannot be honoured.
 */
export function keepPaneFraction(sizes: readonly number[], index: number, fraction: number): number[] {
  if (index < 0 || index >= sizes.length || sizes.length < 2) return [...sizes]
  if (!Number.isFinite(fraction) || fraction <= 0 || fraction >= 1) return [...sizes]
  const others = sizes.reduce((sum, size, i) => (i === index ? sum : sum + size), 0)
  if (!(others > 0)) return [...sizes]
  const rest = 1 - fraction
  return sizes.map((size, i) => (i === index ? fraction : (size / others) * rest))
}

/**
 * EXPAND THE RIGHT SIDE — the chat steps aside, the right side fills. DOM-free.
 *
 * The titlebar's right corner carries, beside the hide-the-right-side toggle,
 * a second button (user, 2026-10-09): one press takes ONLY the chat column
 * (feed + composer) off screen; the left sidebar stays, and the right side —
 * its tabs, the Blueprint, the terminal docked under it — takes the freed
 * width. The next press gives the chat its column back, exactly as it was.
 *
 * The state is one overlay flag on the panel model, `rightExpanded`, the
 * sibling of `focusMode`: the conversation's own `visible` is never touched,
 * so leaving restores it for free, and it persists with the rest of the
 * layout per project and thread. The rules:
 *
 *  - ENTERING with the right side hidden shows it first, then expands.
 *  - The middle is NEVER EMPTY: hiding the right side while expanded leaves
 *    the mode and the chat comes back (panel-layout toggleEditor /
 *    right-area-model collapseRightArea), and anything whose purpose is the
 *    chat (a new thread, a chat toggle) shows it.
 *  - Inert under focus mode, like every other panel mutator.
 *  - Escape leaves the mode only when nothing nearer wants the key.
 */
import { enforceNonEmpty, toggleEditor, type PanelLayout } from './panel-layout'

/** The button's pressed state: expanded, and not hidden behind focus mode. */
export function rightExpandedShown(layout: PanelLayout): boolean {
  return layout.rightExpanded === true && layout.editorVisible && !layout.focusMode
}

/** Expand: show the right side if it is away, then step the chat aside. */
export function enterRightExpanded(layout: PanelLayout): PanelLayout {
  const shown = layout.editorVisible ? layout : toggleEditor(layout)
  return enforceNonEmpty({
    ...shown,
    panels: shown.panels.map((panel) => ({ ...panel })),
    rightExpanded: true,
  })
}

/** Leave: the chat comes back. If the chat had also been put away on its
 *  own, it comes back too — the button said "Show the chat". */
export function leaveRightExpanded(layout: PanelLayout): PanelLayout {
  return enforceNonEmpty({
    ...layout,
    panels: layout.panels.map((panel) =>
      panel.id === 'conversation' ? { ...panel, visible: true } : { ...panel },
    ),
    rightExpanded: false,
  })
}

/** One press of the button. Inert under focus mode. */
export function toggleRightExpanded(layout: PanelLayout): PanelLayout {
  if (layout.focusMode) return layout
  return rightExpandedShown(layout) ? leaveRightExpanded(layout) : enterRightExpanded(layout)
}

/** Whether the chat column is on screen under this layout (a request that
 *  needs the chat — new thread, open thread — asks this, not `visible`). */
export function chatOnScreen(layout: PanelLayout): boolean {
  if (layout.focusMode) return false
  const conversation = layout.panels.find((panel) => panel.id === 'conversation')
  if (conversation === undefined || !conversation.visible) return false
  return !(layout.rightExpanded === true && layout.editorVisible)
}

/** Bring the chat on screen, whichever reason put it away (reveal only). */
export function revealChat(layout: PanelLayout): PanelLayout {
  if (chatOnScreen(layout) || layout.focusMode) return layout
  return leaveRightExpanded(layout)
}

/** The button's accessible name and tooltip — the consequence of pressing. */
export function rightExpandedLabel(expanded: boolean): string {
  return expanded ? 'Show the chat' : 'Expand the right side'
}

/** The button's glyph: arrows out to expand, arrows in to give the chat back. */
export function rightExpandedIcon(expanded: boolean): 'expand-diagonal' | 'collapse-diagonal' {
  return expanded ? 'collapse-diagonal' : 'expand-diagonal'
}

export interface ExpandedEscapeContext {
  /** The right side is expanded (rightExpandedShown). */
  expanded: boolean
  /** Someone already handled this key (event.defaultPrevented). */
  handled: boolean
  /** A registered modal overlay is open (settings, wizard, palette, board). */
  modalOpen: boolean
  /** A menu or popover is on screen. */
  popupOpen: boolean
  /** A Monaco widget that dismisses on Escape is visible. */
  editorWidgetOpen: boolean
  /** Focus is in a field with its own Escape use (terminal, code editor, input). */
  focusInEditable: boolean
}

/** Should this Escape leave the expanded mode? Only when nothing nearer wants it. */
export function shouldLeaveExpandedOnEscape(context: ExpandedEscapeContext): boolean {
  if (!context.expanded || context.handled) return false
  return !context.modalOpen && !context.popupOpen && !context.editorWidgetOpen && !context.focusInEditable
}

/** Generic menus and popovers that own Escape while visible — checked in
 *  addition to the focus-mode list (focus-escape.ts), by on-screen boxes. */
export const ESCAPE_OWNING_GENERIC_POPUPS = [
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
] as const

/** Focus targets that use Escape themselves. */
export const ESCAPE_OWNING_FOCUS_TARGETS = [
  '.fl-term-host',
  '.monaco-editor',
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
] as const

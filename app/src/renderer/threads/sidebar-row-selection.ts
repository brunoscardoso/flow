// Which persistent selection decoration a sidebar row asks <fl-list> for, so
// the decoration survives the list being unfocused (#1881). DOM-free →
// unit-testable.
//
// WHY THE ROW CAN'T LEAN ON <fl-list>'s `.selected` (#1881). The list marks the
// active row via `selectedIndex`, but its shadow CSS paints that row with
// `--fl-color-surface-raised` — the SAME background as `:hover` — and only tints
// it with the accent when the LIST ITSELF holds focus (`:host(:focus)
// .row.selected`). While a person is in the chat, which is the normal state, the
// sidebar is unfocused: the thread they are on then looks exactly like any row
// under the pointer, and the only surviving cue is a medium font-weight nobody
// reported seeing — "I don't know which thread I'm on".
//
// WHY IT IS A CLASS AND NO LONGER A STYLE (2026-09-08). The first fix painted
// the accent bar and fill onto the row's own inline style — that is, onto the
// element the sidebar renders INTO the row, which sits inside the row's 8px
// padding and is only as tall as its content. The result was a 300×20 accent
// rectangle floating inside the row's own 316×28 grey fill: two boxes, one
// selection ("we have kind of double-selecting … a blue thing or a gray thing").
// The row is the only element that is exactly the row, so <fl-list> paints it
// and this only says which paint to use.

/** The decoration <fl-list> paints for a marked row (its `fl-row-*` classes). */
export type SidebarRowMark = 'fl-row-current' | 'fl-row-marked' | null

export interface SidebarRowSelection {
  /** The thread this row stands for is the OPEN one (`activeThreadId`). */
  active: boolean
  /** The row is in the ⌘-click multi-select set (#730). */
  multiSelected: boolean
}

/**
 * The class a thread/task row carries for its selection state, or `null` when
 * the row is neither open nor multi-selected. Active wins over multi-select so
 * the open thread is never dimmed to a mere member of a selection.
 */
export function sidebarRowMark(state: SidebarRowSelection): SidebarRowMark {
  if (state.active) return 'fl-row-current'
  if (state.multiSelected) return 'fl-row-marked'
  return null
}

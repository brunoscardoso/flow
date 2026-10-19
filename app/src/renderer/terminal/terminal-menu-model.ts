/**
 * Terminal context-menu MODEL (#1149) — DOM-free, so the action set is
 * unit-testable under the node jest env; terminal-menu.ts renders it.
 *
 * The action set is derived, not hardcoded on/off: an item that cannot do
 * anything (Copy with no selection, Paste on a read-only agent tab) renders
 * DISABLED rather than missing, so the menu's shape doesn't change under the
 * cursor between two right-clicks in the same terminal.
 */

/** What the menu can do — decided from terminal state. */
export interface TerminalMenuState {
  /** Non-empty selection in the terminal. */
  hasSelection: boolean
  /** The shell accepts input (a read-only agent tab does not). */
  writable: boolean
  /** Room for another pane beside this one (#1133). */
  splittable: boolean
}

export interface TerminalMenuItem {
  id: 'copy' | 'paste' | 'select-all' | 'clear' | 'split'
  label: string
  disabled: boolean
}

/**
 * The menu's items for one right-click. Copy needs a selection; Paste and Clear
 * need a writable shell; Select All is always available (an empty buffer
 * selects nothing, harmlessly); Split needs room in the row.
 */
export function terminalMenuItems(state: TerminalMenuState): TerminalMenuItem[] {
  return [
    { id: 'copy', label: 'Copy', disabled: !state.hasSelection },
    { id: 'paste', label: 'Paste', disabled: !state.writable },
    { id: 'select-all', label: 'Select All', disabled: false },
    { id: 'clear', label: 'Clear', disabled: !state.writable },
    // #1133: VS Code parity — Split is on the terminal's own menu, not only
    // the header. Disabled (not missing) at the pane cap, per the rule above.
    { id: 'split', label: 'Split Terminal', disabled: !state.splittable },
  ]
}

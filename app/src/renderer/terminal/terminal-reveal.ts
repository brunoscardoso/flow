// Reveal / auto-start decision for the terminal panel (#439). Opening the panel
// with no terminal auto-starts one (VS Code parity), but the guard counted an
// EXITED tab as an existing terminal — so after the only shell exits, reopening
// the panel showed a dead "(exited)" tab and never spawned a fresh shell, silently
// swallowing keystrokes. A live tab is one that is in the active project's scope
// AND whose shell has not exited. DOM-free → unit-testable.

export interface TabScope {
  /** The tab's owning project root (undefined for an unscoped terminal). */
  projectRoot: string | undefined
  /** Whether the tab's shell process has exited. */
  exited: boolean
}

/** Whether a tab is a LIVE shell for the current project scope (visible, not exited). */
export function isLiveVisibleTab(tab: TabScope, activeProjectRoot: string | null): boolean {
  if (tab.exited) return false
  return activeProjectRoot === null || tab.projectRoot === activeProjectRoot
}

/** Whether any tab is a live shell — false means reveal should auto-start one (#439). */
export function hasLiveVisibleTab(
  tabs: readonly TabScope[],
  activeProjectRoot: string | null,
): boolean {
  return tabs.some((tab) => isLiveVisibleTab(tab, activeProjectRoot))
}

/**
 * The `exited` state a tab restored from `terminal:list` starts in (#446). Main now
 * surfaces `exited` on TerminalInfo, so a window reopened from the dock rebuilds a
 * dead shell as already-exited instead of live — otherwise the boot guard counts it
 * as a live tab, skips auto-start, and the user types into a dead PTY.
 */
export function initialTabExited(info: { exited?: boolean }): boolean {
  return info.exited ?? false
}

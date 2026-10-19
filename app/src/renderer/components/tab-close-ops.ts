/**
 * Pure close-operation targets for the tab-strip context menu (#735).
 * DOM-free so the "which tabs close" decision unit-tests under node-env jest;
 * fl-tabs renders the menu and emits one `fl-tab-close` per returned id, so
 * every owner's existing close handler works unchanged.
 */

export type TabCloseOp = 'close' | 'others' | 'left' | 'right' | 'all'

export interface CloseOpTab {
  id: string
  closable?: boolean
}

/** Ordered menu entries with their labels — single source for the UI. */
export const TAB_CLOSE_OPS: ReadonlyArray<{ op: TabCloseOp; label: string }> = [
  { op: 'close', label: 'Close' },
  { op: 'others', label: 'Close Others' },
  { op: 'left', label: 'Close to the Left' },
  { op: 'right', label: 'Close to the Right' },
  { op: 'all', label: 'Close All' },
]

/**
 * The ids an operation closes, anchored on `targetId`, in strip order.
 * Non-closable tabs are never included (they'd be dead events). An unknown
 * target yields nothing (the strip re-rendered under the menu).
 */
export function closeTargets(
  tabs: readonly CloseOpTab[],
  targetId: string,
  op: TabCloseOp,
): string[] {
  const index = tabs.findIndex((tab) => tab.id === targetId)
  if (index === -1) return []
  const closable = (tab: CloseOpTab): boolean => tab.closable === true
  switch (op) {
    case 'close':
      return closable(tabs[index]) ? [targetId] : []
    case 'others':
      return tabs.filter((tab, i) => i !== index && closable(tab)).map((tab) => tab.id)
    case 'left':
      return tabs.slice(0, index).filter(closable).map((tab) => tab.id)
    case 'right':
      return tabs.slice(index + 1).filter(closable).map((tab) => tab.id)
    case 'all':
      return tabs.filter(closable).map((tab) => tab.id)
  }
}

/**
 * Which operations are actionable for a target (disabled entries grey out
 * instead of being dead clicks — the #412/#709 inert-not-silent invariant).
 */
export function enabledOps(tabs: readonly CloseOpTab[], targetId: string): Set<TabCloseOp> {
  const enabled = new Set<TabCloseOp>()
  for (const { op } of TAB_CLOSE_OPS) {
    if (closeTargets(tabs, targetId, op).length > 0) enabled.add(op)
  }
  return enabled
}

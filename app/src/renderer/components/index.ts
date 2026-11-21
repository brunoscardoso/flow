/**
 * Flow base component kit — importing this module registers every
 * custom element (side effect of each module's `customElements.define`).
 */
export { FlIcon, type IconName } from './fl-icon'
export { FlButton } from './fl-button'
export { FlCard } from './fl-card'
export { FlLoading, loadingMark, workingMark } from './fl-loading'
export { FlPanel, type PanelToggleDetail } from './fl-panel'
export {
  FlTabs,
  type TabDescriptor,
  type TabSelectDetail,
  type TabCloseDetail,
  type TabRevealDetail,
  type TabRenameDetail,
  type TabCaretDetail,
  type TabAddDetail,
} from './fl-tabs'
export { FlList, type ListItemDetail } from './fl-list'
export { FlSplit, type SplitResizeDetail } from './fl-split'

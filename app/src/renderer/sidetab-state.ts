// Activity-bar rail item resolution (#198, #335, #activity-bar). The side panel
// is now driven by an activity bar with three sidebar-switching rail items:
// Threads, Files, Source Control. Tasks and Blueprint are action buttons on the
// rail that open as editor tabs — they are NOT RailItem sidebar items.
// Source Control (#335) folds the former separate Git and Review tabs into one
// panel with a Changes/Phases view-mode toggle, so legacy persisted 'git'/'review'
// values migrate to it.

export type RailItem = 'threads' | 'files' | 'source-control' | 'worktrees'

/** @deprecated Use `RailItem` — kept for one migration cycle. */
export type SideTab = RailItem

/**
 * Resolve the initial active rail item from the persisted `activeRailItem` (or
 * legacy `sideTab`). 'threads', 'files', and 'source-control' pass through;
 * the legacy 'git' and 'review' values (from before they were unified, #335)
 * migrate to 'source-control'; legacy 'tasks', 'blueprint', and 'terminal'
 * (old sidebar items that are now editor tabs / removed from sidebar) fall back
 * to 'threads'; anything else (undefined, unknown stale value) falls back to 'threads'.
 */
export function resolveRailItem(persisted: string | undefined): RailItem {
  if (persisted === 'threads') return 'threads'
  if (persisted === 'files') return 'files'
  // SEARCH IS NOT A PANE ANY MORE. It moved into the Files pane, between the
  // worktree panel and the tree (user, 2026-09-18: "lets move the search to
  // file explorer tab, between the worktree and the file explorer") — so a
  // session that left it selected lands where the search now lives, rather than
  // on the default.
  if (persisted === 'search') return 'files'
  if (persisted === 'source-control' || persisted === 'git' || persisted === 'review') {
    return 'source-control'
  }
  // 'loops' WAS A SIDEBAR ITEM AND IS NOW A LEGACY VALUE (loops-on-the-board,
  // Phase 7, Task 7.4). Loops live on the Tasks board — the queue is Todo, the
  // gate is Blocked, the hunt is a card in Doing, and pause-all is the board's
  // header strip. A user whose last session left this persisted lands on
  // threads, exactly as the other retired sidebar items do; migrating them to a
  // board that is an editor tab, not a sidebar pane, would open a tab nobody
  // asked for on every launch.
  // Legacy sidebar items that no longer live in the sidebar → default to threads.
  return 'threads'
}

/** @deprecated Use `resolveRailItem` — kept for one migration cycle. */
export function resolveSideTab(persisted: string | undefined): RailItem {
  return resolveRailItem(persisted)
}

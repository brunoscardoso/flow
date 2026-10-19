// Thread-sidebar search feedback (#326): a no-match search names the query, so
// the person knows the search ran and matched nothing. A pure decision;
// thread-sidebar.ts (which imports '../components' and can't load under the
// node jest env) applies it.

/**
 * Text for the sidebar empty state. During a search it names the query so the
 * user knows the search ran and matched nothing; otherwise it's the first-run
 * hint — which must track the ACTUAL blocker (#978): with no project root
 * open, "No threads yet" describes the wrong problem (and the sidebar's own
 * Add-project button was removed in #128, so it points at the titlebar
 * switcher instead). `hasRoots` defaults to true so search-only callers keep
 * their shape.
 */
export function emptySidebarMessage(searching: boolean, query: string, hasRoots = true): string {
  if (searching) return `No threads match “${query}”`
  // The titlebar's "Open Project…" went with the project switcher
  // (Workspaces, 2026-10-06): adding one is the Workspace menu's "Add
  // project…" now, so that is the control this names.
  if (!hasRoots) return 'Open a project to start — Add project… in the Workspace menu'
  return 'No threads yet'
}

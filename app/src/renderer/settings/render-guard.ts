// Re-entrancy guard for SettingsView.#render (#308). #render is async with awaits
// (accounts.list + activeProject + getModelRouting, then the project section's own
// IPC) and fires from TWO independent triggers — open() and the accounts.onChanged
// subscription. With no guard, two calls landing close together interleaved across
// their awaits and BOTH appended to #body, duplicating the "This project" / "Model
// routing" / "Getting Started" sections (and wiping the Accounts section). Each render
// captures a monotonic generation; after every await it checks it's still the latest
// before touching the DOM, and older (superseded) renders bail. This pure predicate is
// that check; the view builds into a detached fragment and swaps it in atomically once.

/** Whether a render generation may still commit to the DOM — true only when it is
 *  the most recent render issued. A superseded (older) render must bail. */
export function isLatestRender(gen: number, latest: number): boolean {
  return gen === latest
}

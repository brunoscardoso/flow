/**
 * Unwrap Electron's IPC error plumbing from user-facing messages (#731).
 *
 * A main-process handler that throws `new Error('Paste an issue URL…')` reaches
 * the renderer as `Error invoking remote method 'tasks:importIssue': Error:
 * Paste an issue URL…` — channel name and doubled `Error:` prefix included.
 * The main process goes to real trouble to craft friendly messages; surfacing
 * the wrapper leaks plumbing and buries the actual guidance. This is the ONE
 * unwrap code path (allowed-pattern #14) — error banners render what it
 * returns, never the raw `error.message`.
 *
 * Pure and DOM-free so it tests under the node-env jest.
 */

/**
 * `Error invoking remote method '<channel>': [SomeError: ]` — Electron's wrapper.
 *
 * THE CLASS NAME IS PART OF THE PLUMBING. The wrapper carries whatever the main
 * process's error was CALLED, and main names its errors for main's own benefit:
 * a Jira import that could not find the issue reached the New-task banner as
 * "IssueFetchError: jira request failed — issue not found or no access". The
 * sentence after the colon is the crafted one; everything before it is how the
 * throw was implemented.
 *
 * Only a name that IS or ENDS IN `Error` is stripped. A message may legitimately open
 * with a capitalised word and a colon ("Jira: check the site URL"), and eating
 * that would be this helper editing the guidance rather than unwrapping it.
 */
const IPC_WRAPPER = /^Error invoking remote method '[^']*':\s*(?:(?:[A-Z][A-Za-z0-9]*)?Error:\s*)?/

/**
 * The human message inside an IPC rejection: strips Electron's remote-method
 * wrapper (and its doubled `Error:` prefix) when present, passes anything else
 * through untouched. Non-Error values stringify; opaque objects degrade to
 * 'Unknown error'.
 */
export function ipcErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  if (raw === '[object Object]') return 'Unknown error'
  return raw.replace(IPC_WRAPPER, '')
}

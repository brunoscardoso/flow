/**
 * WHOSE PAGE THE BROWSER IS SHOWING — the pure half of the embedded browser's
 * place in a conversation's tab set.
 *
 * There is one `<webview>` per window, and each conversation has its own tab
 * set. A switch closes the outgoing set's browser tab but leaves the guest
 * running, so without this the next conversation to open the browser found the
 * previous one's page on screen — and its console and network captures in
 * "Add all". The browser therefore remembers which conversation OWNS it, and
 * passing to another conversation clears the captures and either goes to that
 * conversation's saved page or starts blank.
 *
 * DOM-free: `browser-tab.ts` applies the decision.
 */
import { sameScope, type TabScopeKey } from '../tab-scope-model'

export interface BrowserAdoption {
  /** Empty the capture buffer before the new owner sees it. */
  clearCaptures: boolean
  /** What the guest should show: a page, a blank page, or what it has. */
  load: { kind: 'url'; url: string } | { kind: 'blank' } | { kind: 'keep' }
}

export function adoptBrowserScope(input: {
  /** The conversation whose page the guest holds now (null: none yet). */
  owner: TabScopeKey | null
  /** The conversation taking the browser. */
  next: TabScopeKey | null
  /** That conversation's saved page — only a tab-set restore has one. */
  saved: string | null
  /** The page the guest is on. */
  current: string | null
  /** True for a tab-set restore, false for a person's press. */
  restoring: boolean
  /** Whether the guest has ever been given a page. */
  hasNavigated: boolean
}): BrowserAdoption {
  const sameOwner = sameScope(input.owner, input.next)
  const goToSaved =
    input.restoring && input.saved !== null && input.saved !== input.current
      ? ({ kind: 'url', url: input.saved } as const)
      : null
  if (sameOwner) {
    // Its own page, its own captures: a set coming back, or the same
    // conversation reopening a browser it closed.
    return { clearCaptures: false, load: goToSaved ?? { kind: 'keep' } }
  }
  // Another conversation's page must not show, and its captures must not be
  // offered. A guest that has never loaded anything has nothing to hide — its
  // first open keeps the usual first-open behaviour.
  const hide = input.hasNavigated && !(input.restoring && input.saved !== null && input.saved === input.current)
  return {
    clearCaptures: true,
    load: goToSaved ?? (hide ? { kind: 'blank' } : { kind: 'keep' }),
  }
}

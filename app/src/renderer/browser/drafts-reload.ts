/**
 * What the built-in browser does when the drafts observer reports a change —
 * DOM-free, so the decision is tested apart from the webview.
 *
 *   - The canvas page of that canvas is on screen: tell it which files changed;
 *     it reloads only those frames and keeps its zoom and position.
 *   - A screen of that canvas is open alone (or its tokens, or its layout): the
 *     page IS the changed file, so it reloads.
 *   - Anything else: nothing.
 *
 * Off screen, changes are merged and applied on the way back in
 * (allowed-pattern #17): nothing reloads for a page nobody can see.
 *
 * While the guest is LOADING, changes are held the same way and applied when
 * the load stops, against the page that loaded. A reload issued mid-navigation
 * cancels it: measured 2026-11-19, an agent's write to a screen landing just as
 * Back was pressed on that screen reloaded it in place, and Back was lost.
 */
import { DRAFT_TOKENS_FILE, parseDraftPageUrl, type DraftsChangedEvent } from '../../shared/ui-drafts'

export type DraftReloadAction =
  | { kind: 'none' }
  | { kind: 'canvas'; files: string[] }
  | { kind: 'page' }

export function draftReloadAction(currentUrl: string | null, event: DraftsChangedEvent): DraftReloadAction {
  if (currentUrl === null || event.files.length === 0) return { kind: 'none' }
  const page = parseDraftPageUrl(currentUrl)
  if (page === null || page.root !== event.rootPath || page.canvas !== event.canvas) return { kind: 'none' }
  if (page.kind === 'canvas') return { kind: 'canvas', files: [...event.files] }
  if (page.kind === 'screen') {
    const touched = event.files.includes(`${page.screen}.html`) || event.files.includes(DRAFT_TOKENS_FILE)
    return touched ? { kind: 'page' } : { kind: 'none' }
  }
  return event.files.includes(page.file) ? { kind: 'page' } : { kind: 'none' }
}

/** Changes held while the browser is off screen: one entry per canvas, files merged. */
export function mergeDraftChange(pending: DraftsChangedEvent[], event: DraftsChangedEvent): DraftsChangedEvent[] {
  const index = pending.findIndex((entry) => entry.rootPath === event.rootPath && entry.canvas === event.canvas)
  if (index < 0) return [...pending, { rootPath: event.rootPath, canvas: event.canvas, files: [...event.files] }]
  const merged = { ...pending[index], files: [...new Set([...pending[index].files, ...event.files])] }
  return pending.map((entry, at) => (at === index ? merged : entry))
}

/** The script the browser runs in the canvas page: the page's own door, with the file names as data. */
export function canvasChangedScript(files: string[]): string {
  return `window.flowCanvas ? window.flowCanvas.changed(${JSON.stringify(files)}) : null`
}

/** Apply a drafts change now, or hold it: off screen, or while a navigation is in flight. */
export function draftChangeTiming(state: { onScreen: boolean; loading: boolean }): 'now' | 'hold' {
  return state.onScreen && !state.loading ? 'now' : 'hold'
}

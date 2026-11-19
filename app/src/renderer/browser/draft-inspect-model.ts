/**
 * Where an inspect toggle and a pick go in the built-in browser — DOM-free.
 *
 *   - On a draft CANVAS the screens are frames the stock picker cannot see
 *     into, so the toggle goes to the canvas page's own inspect; on every other
 *     page (a draft screen open alone included) it goes to the stock picker.
 *   - A pick of a draft element edits the canvas and screen the PAGE ADDRESS
 *     names. The project and canvas never come from the page's message, and in
 *     the single-screen view neither does the screen.
 */
import { parseDraftPageUrl } from '../../shared/ui-drafts'

export type InspectRoute = 'canvas' | 'page'

export function inspectRoute(currentUrl: string | null): InspectRoute {
  return currentUrl !== null && parseDraftPageUrl(currentUrl)?.kind === 'canvas' ? 'canvas' : 'page'
}

/** The draft screen a pick edits. */
export interface DraftPanelTarget {
  rootPath: string
  canvas: string
  screen: string
  view: 'canvas' | 'single'
}

/**
 * The screen a pick on the current page edits, or null when the page is not a
 * draft canvas or screen. `screen` is the pick's: decided by the canvas for a
 * frame pick; for a screen open alone the address decides, and a pick naming
 * another screen is refused.
 */
export function draftPanelTarget(currentUrl: string | null, screen: string): DraftPanelTarget | null {
  if (currentUrl === null) return null
  const page = parseDraftPageUrl(currentUrl)
  if (page === null) return null
  if (page.kind === 'canvas') return { rootPath: page.root, canvas: page.canvas, screen, view: 'canvas' }
  if (page.kind === 'screen' && page.screen === screen) {
    return { rootPath: page.root, canvas: page.canvas, screen: page.screen, view: 'single' }
  }
  return null
}

/**
 * HOW A LOAD IS SHOWN. A real browser keeps the page it has on screen until
 * the next one paints; covering it on every load made each click inside the
 * page (and every redirect of a sign-in) flash a full "Loading…" screen.
 *
 * - No page yet (first open, a blank start, after a failed load): the
 *   full loading screen — there is nothing beneath it to keep.
 * - A page on screen: it stays, and a thin bar at the top says a load runs.
 */
export type LoadIndicator = 'screen' | 'bar'

export function loadIndicator(hasPage: boolean): LoadIndicator {
  return hasPage ? 'bar' : 'screen'
}

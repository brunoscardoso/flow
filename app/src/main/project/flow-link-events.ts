/**
 * "A project's `flow` link may have moved" — one signal, raised by main when a
 * Workspace change rewrote links (a migration, a link, a move, a delete, a
 * join) and heard by every watcher that follows `<root>/flow`.
 *
 * A link replaced by another link is not an event chokidar reliably reports
 * (a vault link became a Workspace link and the watchers kept watching the old
 * folder), so the watchers re-check the link's target when told. Cheap: a
 * watcher whose link did not change does nothing.
 */

type Listener = () => void

const listeners = new Set<Listener>()

/** Subscribe; returns the unsubscribe. */
export function onFlowLinksChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Tell every `flow` watcher to re-check where its link points. */
export function announceFlowLinksChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch (error) {
      console.error('[FlowLinks] a watcher failed to re-check its link', error)
    }
  }
}

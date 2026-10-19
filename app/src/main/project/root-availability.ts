// Availability partition for persisted project roots (#263). #259 stopped
// DELETING a persisted root whose directory isn't reachable at boot (unmounted
// external/network drive, launch-before-mount race) — it skips it for the session
// and keeps it in persistence. But the skip was silent (console.warn only), so the
// project just vanished from the sidebar with no way to tell "lost" from "temporarily
// offline". This pure helper splits persisted roots into reachable vs not, given an
// injected reachability predicate (fs stat in prod, a stub in tests), and stamps the
// unreachable ones `available: false` so the sidebar can render them greyed-out.
import type { RegisteredProject } from '../../shared/ipc-contract'

export interface PartitionedRoots {
  /** Reachable roots — watched + operated on this session (marked available). */
  available: RegisteredProject[]
  /** Unreachable roots — kept in persistence, flagged for the greyed sidebar row. */
  unavailable: RegisteredProject[]
}

/**
 * Split persisted roots by whether their directory is currently reachable.
 * Available roots are stamped `available: true`; unavailable ones `available: false`.
 */
export function partitionByAvailability(
  persisted: readonly RegisteredProject[],
  isReachable: (rootPath: string) => boolean,
): PartitionedRoots {
  const available: RegisteredProject[] = []
  const unavailable: RegisteredProject[] = []
  for (const root of persisted) {
    if (isReachable(root.rootPath)) available.push({ ...root, available: true })
    else unavailable.push({ ...root, available: false })
  }
  return { available, unavailable }
}

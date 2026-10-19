/**
 * The thin runtime around the pure `feed-density` model — the app-wide store of
 * the reader's chosen conversation density, and the one place it is written.
 *
 * WHY HERE AND NOT IN `.flowconfig` (plan_chat-feed-signal_v1, Q-1): density is
 * a per-USER reading preference. `flow/.flowconfig` is per PROJECT and it is
 * committed to the repository, so putting it there would make a person reading
 * two projects set it twice, and would ship one reader's choice to everyone
 * else on the team.
 *
 * WHY THIS MECHANISM AND NOT `app_settings` + an IPC pair: the app already has
 * an app-level, per-user, renderer-only preference of exactly this shape — the
 * theme (`../theme/theme-controller.ts`, #399): persisted in localStorage, read
 * synchronously at first paint, published to live surfaces through a listener
 * set, and rendered as a `<select>` in Settings › Appearance. Density is its
 * peer in every respect — it is appearance, it is app-wide, and the main
 * process has no use for it — so this module is that mechanism applied again,
 * deliberately down to the shape of its API (`get…` / `set…` / `on…Changed`),
 * rather than a second mechanism invented beside it. The SQLite `app_settings`
 * table is where preferences MAIN must read live (default provider, model
 * routing, worktree defaults); nothing outside this window needs to know how
 * a reader folds their feed.
 */
import {
  DEFAULT_FEED_DENSITY,
  isFeedDensity,
  type FeedDensity,
} from './feed-density'

/** localStorage key for the persisted density. Namespaced like `flow:theme-mode`. */
export const FEED_DENSITY_STORAGE_KEY = 'flow:conversation-density'

type DensityListener = (density: FeedDensity) => void

const listeners = new Set<DensityListener>()
let current: FeedDensity | null = null

function readPersisted(): FeedDensity {
  try {
    const raw = localStorage.getItem(FEED_DENSITY_STORAGE_KEY)
    return isFeedDensity(raw) ? raw : DEFAULT_FEED_DENSITY
  } catch {
    // Private-mode / disabled storage — fall back to the default, never throw.
    return DEFAULT_FEED_DENSITY
  }
}

/**
 * The reader's current density. Lazily hydrated on first read, so no
 * initialization call has to be sequenced into the shell's boot — unlike the
 * theme, nothing here has to be stamped before first paint.
 */
export function getFeedDensity(): FeedDensity {
  if (current === null) current = readPersisted()
  return current
}

/** Change the density: persist it and notify every live pane. */
export function setFeedDensity(density: FeedDensity): void {
  if (getFeedDensity() === density) return
  current = density
  try {
    localStorage.setItem(FEED_DENSITY_STORAGE_KEY, density)
  } catch {
    // Non-persistent storage — the in-memory choice still drives this session.
  }
  for (const listener of listeners) listener(density)
}

/**
 * Subscribe to density changes. Returns an unsubscribe.
 *
 * This is what makes the setting apply to a conversation the reader is looking
 * at RIGHT NOW rather than the next one they open: the pane repaints from the
 * entries it already holds (Phase 5.4).
 */
export function onFeedDensityChanged(listener: DensityListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Test seam: drop the hydrated value and every listener. */
export function resetFeedDensityForTests(): void {
  current = null
  listeners.clear()
}

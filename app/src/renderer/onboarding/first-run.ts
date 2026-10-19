// First-run decision (#48) — pure, DOM-free so it unit-tests under the CJS node
// jest. The onboarding wizard shows on launch whenever an essential is missing
// (no Claude account connected, or no project open) AND the user hasn't already
// completed it. Once completed, it stays out of the way even if a prerequisite
// is later removed — the user opted out by finishing it.

export interface FirstRunState {
  /** Number of connected Claude accounts (accounts:list length). */
  accountCount: number
  /** Number of open project roots (project:list length). */
  rootCount: number
  /** Whether the onboarding wizard has been completed before. */
  completed: boolean
}

/**
 * True when the onboarding wizard should be shown at launch. Missing an account
 * or a project triggers it; a prior completion suppresses it.
 */
export function needsOnboarding(state: FirstRunState): boolean {
  if (state.completed) return false
  return state.accountCount === 0 || state.rootCount === 0
}

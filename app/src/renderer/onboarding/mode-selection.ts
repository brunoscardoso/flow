// Onboarding "Choose a mode" selection highlight (#320). The mode step stored its
// choice only in the DOM (the clicked button's primary class), so navigating Back to
// the step — which re-renders it — showed NO mode highlighted even though the choice
// was retained in wizard state (Next stayed enabled). Its sibling steps (Connect,
// Open a project) re-derive their confirmed state on every render; this makes the mode
// step do the same. Pure so it's unit-testable; steps.ts applies it during render.
import type { AutonomyMode } from './wizard-controller'

/** Whether a mode choice should render highlighted, given the wizard's stored
 *  selection. Derived from state (not held only in the DOM), so the highlight
 *  survives a re-render on Back-navigation. */
export function isSelectedMode(
  choiceMode: AutonomyMode,
  selected: AutonomyMode | null,
): boolean {
  return selected === choiceMode
}

/**
 * The autonomy mode the wizard should pre-select from persisted onboarding
 * state (#716). Connect and Project both auto-detect existing state; the Mode
 * step ignored the saved `autonomyBypassDefault`, rendering unselected + gated
 * — so re-picking the "safe-looking" Manual silently overwrote a saved
 * Autonomous (a safety-relevant preference). Not gated on `completed`: a user
 * who picked a mode but quit before finishing has a real saved preference too,
 * and on a true first run this pre-selects the safe default (Manual) — standard
 * wizard UX, with no silent-overwrite risk in that direction.
 */
export function savedModeFromOnboarding(state: {
  autonomyBypassDefault: boolean
}): AutonomyMode {
  return state.autonomyBypassDefault ? 'autonomous' : 'manual'
}

/**
 * The mode to pre-select for the ACTIVE PROJECT (#1206).
 *
 * An autonomy mode is TWO writes: `autonomyBypassDefault` (app-wide, written on
 * Finish) and `config.autopilot` (per-project, written on click). #716's
 * reflection read only the first — so the step pre-selected, confirmed and
 * walked past a mode derived from a store it does not write. The moment the two
 * disagree (a second project; autopilot toggled in Flow settings or via
 * `/flow autopilot=…`), the wizard stated the wrong autonomy for the project
 * the user is in, and accepting it wrote nothing.
 *
 * So the PROJECT's own autopilot decides whenever we could read it. The
 * app-wide default is the fallback for "no project yet", which is the only
 * situation it actually describes.
 */
export function savedModeForProject(
  projectAutopilot: boolean | null,
  onboarding: { autonomyBypassDefault: boolean },
): AutonomyMode {
  if (projectAutopilot !== null) return projectAutopilot ? 'autonomous' : 'manual'
  return savedModeFromOnboarding(onboarding)
}

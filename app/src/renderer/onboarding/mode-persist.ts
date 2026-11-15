// Onboarding "Before the agent acts" persistence payload (#229). The choice maps
// to ONE app setting: autonomyBypassDefault, a boolean — whether a new
// conversation skips the ask before the agent acts. It used to write the
// project's autopilot too; autopilot is now chosen in each conversation, so the
// wizard no longer touches a project's file at all. Written on Finish only
// (onboarding/index.ts), never on click (#1116/#1077).

import type { AutonomyMode } from './wizard-controller'

export interface ModePersistPayload {
  /** App-settings write — a real boolean. */
  onboarding: { autonomyBypassDefault: boolean }
}

/** The exact settings payload for a choice. */
export function modePersistPayload(mode: AutonomyMode): ModePersistPayload {
  return { onboarding: { autonomyBypassDefault: mode === 'autonomous' } }
}

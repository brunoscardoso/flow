// Onboarding autonomy-mode persistence payloads (#229). The user's choice maps
// to app settings (autonomyBypassDefault, a boolean) AND to .flowconfig
// (autopilot, a STRING 'true'/'false' — flowconfig values are strings). Getting
// the boolean-vs-string mapping right for each mode is exactly the kind of
// thing that's easy to flip, so it's isolated here as ONE pure, unit-tested
// function shared by both writers — which live at different times (#1116/#1077):
// the mode step writes `config` on click (visible, per-project); the wizard's
// onComplete writes `onboarding` on Finish (the app-wide bypass is
// confirm-gated — never committed by an unconfirmed or failed run).

import type { AutonomyMode } from './wizard-controller'

export interface ModePersistPayload {
  /** App-settings write — a real boolean. */
  onboarding: { autonomyBypassDefault: boolean }
  /** .flowconfig write — autopilot is a string flag. */
  config: { autopilot: 'true' | 'false' }
}

/** The exact settings + flowconfig payloads for an autonomy mode. */
export function modePersistPayload(mode: AutonomyMode): ModePersistPayload {
  const autonomous = mode === 'autonomous'
  return {
    onboarding: { autonomyBypassDefault: autonomous },
    config: { autopilot: autonomous ? 'true' : 'false' },
  }
}

// Onboarding entry (#48) — decide at launch whether the first-run wizard is
// needed and, if so, open it. Called from main.ts after the shell mounts.

import { needsOnboarding } from './first-run'
import { modePersistPayload } from './mode-persist'
import { createOnboardingSteps } from './steps'
import { OnboardingWizard } from './wizard-view'

/** Build + open the wizard. Shared by first-run and manual "Getting Started". */
async function openWizard(): Promise<void> {
  const wizard = new OnboardingWizard({
    steps: createOnboardingSteps(),
    onComplete: (state) => {
      // Finish is the COMMIT for the app-wide permission-prompt bypass
      // (#1116/#1077): the mode step holds the pick in wizard state and writes
      // only the visible per-project autopilot flag on click; the app-level
      // autonomyBypassDefault flips here, in the same write that marks
      // onboarding complete — so an abandoned (Skip/Escape) or failed run
      // never leaves new threads silently skipping permission prompts.
      const request: { completed: boolean; autonomyBypassDefault?: boolean } = { completed: true }
      if (state.mode !== null) {
        request.autonomyBypassDefault = modePersistPayload(state.mode).onboarding
          .autonomyBypassDefault
      }
      // #1356: RETURN the promise. This used to swallow the rejection into
      // console.error while the wizard closed regardless, so a failed write —
      // of the one safety-relevant thing onboarding owns — was indistinguishable
      // from success. The wizard now awaits it and stays open on failure.
      return window.flow.settings.setOnboarding(request).then(() => undefined)
    },
  })
  wizard.open()
}

/** Manually (re-)open the onboarding wizard — the "Getting Started" entry. */
export function startOnboarding(): void {
  void openWizard()
}

/** Show the onboarding wizard when a prerequisite (account/project) is missing. */
export async function maybeStartOnboarding(): Promise<void> {
  let onboarding
  let accountCount = 0
  let rootCount = 0
  try {
    const [state, accounts, roots] = await Promise.all([
      window.flow.settings.getOnboarding(),
      window.flow.accounts.list(),
      window.flow.project.list(),
    ])
    onboarding = state
    accountCount = accounts.length
    rootCount = roots.length
  } catch {
    return // never block boot on onboarding
  }

  if (!needsOnboarding({ accountCount, rootCount, completed: onboarding.completed })) return
  await openWizard()
}

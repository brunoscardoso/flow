/**
 * RAISE THE TELEMETRY QUESTION, IF IT IS TIME.
 *
 * The decision belongs to main — it holds the use-day count and how many times
 * the question has been raised — so this asks and obeys rather than deciding.
 * A renderer that worked it out for itself could re-ask somebody who had
 * already answered in another window.
 *
 * FAIL-SILENT. An older preload without the channel, or a main process that
 * cannot answer, means no prompt: the question is in Settings either way, and
 * nothing is collected until it is answered. A missing dialog costs a data
 * point; a thrown error on startup costs the window.
 */
import { showConsentPrompt } from './consent-prompt-view'

/** A short settle so the prompt does not land on top of a still-painting app. */
const SETTLE_MS = 2500

export async function maybeAskAboutTelemetry(): Promise<void> {
  try {
    const settings = window.flow.settings
    if (settings.shouldAskTelemetry === undefined) return
    if (!(await settings.shouldAskTelemetry())) return
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    // Checked AGAIN after the wait: another window may have asked and been
    // answered while this one was settling.
    if (!(await settings.shouldAskTelemetry())) return
    await showConsentPrompt({
      setConsent: (agreed) => settings.setTelemetryConsent({ agreed }),
      recordAsk: () => settings.recordTelemetryAsk(),
    })
  } catch {
    // The question lives in Settings; a failure here is not the user's problem.
  }
}

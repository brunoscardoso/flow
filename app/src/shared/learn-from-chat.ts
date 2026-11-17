/**
 * Learning from chat — whether Flow learns the area a conversation worked in
 * when a turn ends (user, 2026-11-17: "that should be a config … because this
 * use more token, and we need to confirm this if the user wants that").
 *
 * One app-wide answer, asked once in onboarding and changeable in Settings.
 * NOT ASKED IS OFF: learning spends tokens on a run nobody requested, so the
 * person has to say yes before the first one starts.
 */

/** The stored answer: `null` when nobody has been asked yet. */
export type LearnFromChatAnswer = boolean | null

/** Whether a turn's end may start a learn. Only an explicit yes does. */
export function learnFromChatEnabled(answer: LearnFromChatAnswer): boolean {
  return answer === true
}

/** Every word the onboarding step and the Settings section say (#12: no keys, no paths). */
export const LEARN_FROM_CHAT_COPY = {
  title: 'Learn from your conversations',
  question:
    'When a conversation changes an area of your project, Flow can learn that area and add it to the blueprint. Each one is an extra agent run, so it uses more tokens.',
  on: { label: 'Learn automatically', description: 'Keep the blueprint up to date as you work. Uses more tokens.' },
  off: { label: 'Not now', description: 'Nothing runs on its own. You can still learn an area from the board.' },
  settingsHeading: 'Learning from conversations',
  settingsHelp: 'Learn the area a conversation changed when it ends, and add it to the blueprint. Each learn is an extra agent run.',
  notAsked: 'Off until you choose.',
  saveFailed: 'Flow could not save this setting. Try again.',
} as const

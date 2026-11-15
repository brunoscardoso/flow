/**
 * The words for the two per-conversation switches — whether the agent asks
 * before it acts, and whether autopilot chains the flow — and for the app-wide
 * default a new conversation starts from (Settings › Agent and the first-run
 * wizard). One file, so the composer chip, the new-conversation page, Settings
 * and onboarding never describe the same choice in two ways.
 *
 * DOM-free (app jest is CJS ts-jest under node): views import from here.
 * No command, file path or config key may appear in any of these strings
 * (forbidden-pattern #12) — the test scans every exported string.
 */

/** What a chip shows for one conversation. Label = the STATE; title = what pressing does. */
export interface SwitchFace {
  label: string
  title: string
  on: boolean
}

export function askingFace(bypassPermissions: boolean): SwitchFace {
  return bypassPermissions
    ? {
        label: "Doesn't ask",
        title: 'The agent acts without waiting for you here. Press to be asked first again.',
        on: true,
      }
    : {
        label: 'Asks first',
        title: 'The agent waits for your answer before it edits or runs anything here. Press to stop asking.',
        on: false,
      }
}

export function autopilotFace(autopilot: boolean): SwitchFace {
  return autopilot
    ? {
        label: 'Autopilot on',
        title: 'This conversation chains discovery, plan and build on its own. Press to turn it off.',
        on: true,
      }
    : {
        label: 'Autopilot off',
        title: 'Press to let this conversation chain discovery, plan and build on its own.',
        on: false,
      }
}

/** Turning asking OFF is confirmed once; turning it back ON never is. */
export function needsAskingConfirm(currentBypass: boolean, nextBypass: boolean): boolean {
  return !currentBypass && nextBypass
}

export const STOP_ASKING_CONFIRM = {
  title: 'Stop asking in this conversation?',
  body: 'The agent will edit files and run commands here without waiting for you. You can turn asking back on at any time.',
  keep: 'Keep asking',
  confirm: "Don't ask",
} as const

export const ASKING_SWITCH_FAILED = "The switch didn't take. Nothing changed in this conversation."
export const AUTOPILOT_SWITCH_FAILED = "Autopilot couldn't be changed. Nothing changed in this conversation."

/** One choice of the app-wide default, shown as a radio card. */
export interface DefaultChoice {
  /** The stored value: true = new conversations don't ask. */
  bypass: boolean
  label: string
  description: string
}

export const BEFORE_AGENT_ACTS = 'Before the agent acts'

export const ASK_CHOICES: readonly DefaultChoice[] = [
  { bypass: false, label: 'Ask me first', description: 'Flow shows each edit and command and waits for your answer.' },
  {
    bypass: true,
    label: "Don't ask",
    description: 'The agent edits files and runs commands without stopping. Use it on projects you trust.',
  },
]

export const SETTINGS_AGENT = {
  heading: 'New conversations',
  help: 'How a conversation starts. Each one can change it on its own, from the box you type in.',
  footnote: 'Conversations that are already open keep what they have. Autopilot is chosen in each conversation.',
  saveFailed: "The default couldn't be saved. New conversations still start the way they did.",
} as const

export const ONBOARDING_ASK = {
  title: BEFORE_AGENT_ACTS,
  description: 'This is how new conversations start. You can change it in Settings, or in any conversation.',
} as const

/** Every user-visible string above, for the forbidden-pattern #12 scan. */
export const CONVERSATION_SWITCH_STRINGS: readonly string[] = [
  ...[false, true].flatMap((value) => {
    const a = askingFace(value)
    const b = autopilotFace(value)
    return [a.label, a.title, b.label, b.title]
  }),
  ...Object.values(STOP_ASKING_CONFIRM),
  ASKING_SWITCH_FAILED,
  AUTOPILOT_SWITCH_FAILED,
  BEFORE_AGENT_ACTS,
  ...ASK_CHOICES.flatMap((choice) => [choice.label, choice.description]),
  ...Object.values(SETTINGS_AGENT),
  ...Object.values(ONBOARDING_ASK),
]

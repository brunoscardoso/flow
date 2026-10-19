// User-facing feedback for Settings actions (#216, #217). Account actions and
// integration token save/clear were bare promise chains with no user feedback on
// rejection — a silent dead click (and unhandled rejection), forbidden pattern
// #2. These pure builders turn a failure into a toast; the view dispatches it via
// the `flow:notify` event → NotificationCenter, mirroring git/editor/terminal.

import type { IntegrationProvider } from '../../shared/ipc-contract'
import { ipcErrorMessage } from '../ipc-error'

export interface SettingsToast {
  title: string
  body: string
  level: 'info' | 'error'
}

/** Readable text from an unknown thrown value — routed through the ONE IPC
 *  unwrap path (#731/#988) so toasts never leak Electron's remote-method wrapper. */
export function errorText(error: unknown): string {
  return ipcErrorMessage(error)
}

/** Which account action failed — each gets its own title. */
export type AccountAction = 'remove' | 'set-default' | 'assign' | 're-login'

const ACCOUNT_ACTION_TITLE: Record<AccountAction, string> = {
  remove: "Couldn't remove account",
  'set-default': "Couldn't set default account",
  assign: "Couldn't assign account",
  're-login': "Couldn't re-login account",
}

/** A failed account action → toast carrying the underlying error. */
export function accountActionFailedToast(action: AccountAction, error: unknown): SettingsToast {
  return {
    title: ACCOUNT_ACTION_TITLE[action],
    body: errorText(error),
    level: 'error',
  }
}

const PROVIDER_LABEL: Record<IntegrationProvider, string> = {
  github: 'GitHub',
  jira: 'Jira',
  azure: 'Azure DevOps',
}

/** A failed integration token save (Connect / Update token) → toast (#217). */
export function tokenSaveFailedToast(provider: IntegrationProvider, error: unknown): SettingsToast {
  return {
    title: `Couldn't save ${PROVIDER_LABEL[provider]} token`,
    body: errorText(error),
    level: 'error',
  }
}

/** A failed integration token clear (Disconnect) → toast (#217). */
export function tokenClearFailedToast(provider: IntegrationProvider, error: unknown): SettingsToast {
  return {
    title: `Couldn't disconnect ${PROVIDER_LABEL[provider]}`,
    body: errorText(error),
    level: 'error',
  }
}

/**
 * A completed Disconnect → toast (#1505). The only feedback this action gave was
 * the pill going grey — the same repaint a plain refresh produces — for the
 * permanent destruction of a credential the app cannot show or hand back.
 */
export function tokenClearedToast(provider: IntegrationProvider): SettingsToast {
  return {
    title: `Disconnected ${PROVIDER_LABEL[provider]}`,
    body: 'The stored token was deleted from this machine.',
    level: 'info',
  }
}

/**
 * A failed worktree-defaults save → toast (worktree_settings_ui).
 *
 * The row goes back to the value the store still holds, so without this the
 * only evidence of the failure is a control quietly springing back — the same
 * repaint a successful write produces, which is #1158's bug wearing a different
 * panel. No key, path or command in the words (forbidden-pattern #12).
 */
export function worktreeDefaultSaveFailedToast(label: string, error: unknown): SettingsToast {
  return {
    title: `Couldn't save "${label}"`,
    body: `${errorText(error)} — the setting is unchanged.`,
    level: 'error',
  }
}

/** A failed "Model routing (Auto)" save → toast (#307). The dropdowns revert to the
 *  last-persisted routing, so this tells the user their change wasn't saved. */
export function modelRoutingSaveFailedToast(error: unknown): SettingsToast {
  return {
    title: "Couldn't save model routing",
    body: `${errorText(error)} — reverted to the last saved routing.`,
    level: 'error',
  }
}

/**
 * A failed telemetry-consent save → toast (client-identity).
 *
 * The switch springs back to what the store still holds, and on THIS setting a
 * silent spring-back is the worst of the family: a person who just turned
 * sharing off and saw the switch return to off would reasonably believe they
 * had turned it off. The words say which way it is still set.
 */
export function telemetryConsentSaveFailedToast(intended: boolean, error: unknown): SettingsToast {
  return {
    title: "Couldn't save that setting",
    body: `${errorText(error)} — usage data is still ${intended ? 'not being shared' : 'being shared'}.`,
    level: 'error',
  }
}

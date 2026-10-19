/**
 * THE WAY INTO SETTINGS → WORKSPACES from a Workspace's no-access / error
 * notification. The toast's button dispatches `WORKSPACE_SETTINGS_EVENT`
 * (main names it in `knowledge-sync/pause-notice.ts`; a test pins the two
 * together), and this turns it into the settings page's own open, on the
 * Workspaces group.
 */

/** The toast action's event — mirrored from `main/knowledge-sync/pause-notice.ts`. */
export const WORKSPACE_SETTINGS_EVENT = 'flow:open-workspace-settings'

/** The settings page's open event and the group a Workspace's settings live in. */
const OPEN_SETTINGS_EVENT = 'flow:open-settings'
const WORKSPACES_GROUP = 'workspaces'

/** The slice of `document` this needs — structural, so a test can hand in a fake. */
export interface EventTargetLike {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
  dispatchEvent(event: Event): boolean
}

/** Forward the notification's action to Settings → Workspaces. Returns the unsubscribe. */
export function initWorkspaceSettingsLink(target: EventTargetLike): () => void {
  const listener = (): void => {
    target.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { group: WORKSPACES_GROUP } }))
  }
  target.addEventListener(WORKSPACE_SETTINGS_EVENT, listener)
  return () => target.removeEventListener(WORKSPACE_SETTINGS_EVENT, listener)
}

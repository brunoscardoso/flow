/**
 * ONE NOTIFICATION WHEN A WORKSPACE'S SYNC PAUSES — and only then.
 *
 * The engine reports a status whenever a Workspace's sync changes, which
 * includes every routine retry and every offline spell. None of those deserve
 * a toast: Flow handles them on its own. A pause (a decision, a merged
 * version), refused access and an error need a person, and each is announced
 * once, on the TRANSITION into it.
 *
 * TEXT: the engine's own sentence, which names the Workspace and nothing else
 * (forbidden-pattern #12). Pure: the caller does the broadcasting.
 */

import type { FlowNotification } from '../../shared/ipc-contract'
import type { WorkspaceSyncStatus } from '../../shared/workspaces-contract'

// ── Workspace sync ──────────────────────────────────────────────────────────

/**
 * The renderer event a Workspace pause's action dispatches — the Workspace
 * settings section and its collision card answer it (Phase 10).
 */
export const WORKSPACE_SYNC_EVENT = 'flow:open-workspace-sync'

/**
 * The renderer event a Workspace's no-access / error action dispatches: opens
 * Settings → Workspaces (`renderer/settings/workspace-settings-link.ts`,
 * mirrored there; a test pins the two together). Not the sync event — there
 * is nothing to choose on the collision card when sync cannot run at all.
 */
export const WORKSPACE_SETTINGS_EVENT = 'flow:open-workspace-settings'

/** What a Workspace's toast chip says when its name is not known — never the slug. */
export const UNNAMED_WORKSPACE_LABEL = 'Workspace'

/** A Workspace has no root path; its notifications are keyed by this. */
export function workspaceNotificationRoot(slug: string): string {
  return `workspace:${slug}`
}

/**
 * The notification for a Workspace status, or null when it needs nobody.
 * `paused` (a decision or a merged version), `no-access` (the shared
 * repository refused this person) and `error` (sync can't run) need a person; the body is the engine's own sentence, which names the Workspace and
 * nothing else (forbidden-pattern #12).
 */
export function workspacePauseNotification(
  slug: string,
  status: WorkspaceSyncStatus,
  timestamp: string,
  name: string | null = null,
): FlowNotification | null {
  if (status.detail === null) return null
  const label = name !== null && name.trim() !== '' ? name : UNNAMED_WORKSPACE_LABEL
  const detail = { slug }
  if (status.state === 'paused') {
    return {
      kind: 'state-change',
      rootId: workspaceNotificationRoot(slug),
      label,
      title: 'Workspace sync paused',
      body: status.detail,
      timestamp,
      level: 'warn',
      action: { label: 'Review the changes', event: WORKSPACE_SYNC_EVENT, detail },
    }
  }
  if (status.state === 'no-access') {
    return {
      kind: 'state-change',
      rootId: workspaceNotificationRoot(slug),
      label,
      title: 'Workspace sync has no access',
      body: status.detail,
      timestamp,
      level: 'error',
      action: { label: 'Open Workspace settings', event: WORKSPACE_SETTINGS_EVENT, detail },
    }
  }
  if (status.state === 'error') {
    return {
      kind: 'state-change',
      rootId: workspaceNotificationRoot(slug),
      label,
      title: "Workspace sync can't run",
      body: status.detail,
      timestamp,
      level: 'error',
      action: { label: 'Open Workspace settings', event: WORKSPACE_SETTINGS_EVENT, detail },
    }
  }
  return null
}

export interface WorkspacePauseNotifier {
  /** Fold one status in; answers the notification to raise, or null. */
  observe(slug: string, status: WorkspaceSyncStatus, timestamp: string, name?: string | null): FlowNotification | null
  forget(slug: string): void
}

/**
 * Announces only TRANSITIONS into a pause or an error. `syncing` is not a
 * state of its own here: a paused Workspace the person syncs again and that is
 * still paused on the same question is the same pause, not a new one. Leaving
 * for anything else (synced, offline…) and coming back is new.
 */
export function createWorkspacePauseNotifier(): WorkspacePauseNotifier {
  const last = new Map<string, string>()
  return {
    observe(slug, status, timestamp, name) {
      if (status.state === 'syncing') return null
      const key = `${status.state}\u0000${status.detail ?? ''}`
      const previous = last.get(slug)
      last.set(slug, key)
      if (previous === key) return null
      return workspacePauseNotification(slug, status, timestamp, name ?? null)
    },
    forget(slug) {
      last.delete(slug)
    },
  }
}

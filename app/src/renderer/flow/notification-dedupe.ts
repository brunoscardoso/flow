// Blocked-prompt de-duplication (#231). A blocked task's prompt arrives on TWO
// channels — a flow:notification push AND a pendingPrompt on flow:stateChanged —
// and each prompt id must toast exactly once, whichever lands first. The state
// path was guarded but the notification path always forwarded, so when state
// landed first the later push re-toasted: a duplicate inbox entry AND a rebuilt
// prompt card with an empty textarea, wiping a reply the user was typing. This
// pure gate makes the notification path honor the same dedup. DOM-free so the
// race is unit-testable.

import type { FlowNotification } from '../../shared/ipc-contract'

export interface NotificationGate {
  /** Whether to forward the notification to the center (raise the toast/card). */
  forward: boolean
  /** A blocked-prompt id to record as shown, or null (nothing to record). */
  recordPromptId: string | null
}

/**
 * Decide whether an incoming notification should be forwarded. A blocked-prompt
 * with a promptId already marked shown (delivered first via the other channel)
 * is DROPPED so its live card — and the reply being typed into it — is preserved.
 * Everything else (non-blocked-prompt, or a first-seen prompt) forwards, and a
 * first-seen prompt id is returned for the caller to record.
 */
/**
 * Whether a notification renders as a STICKY blocked-prompt card — the one that
 * carries the reply box, is never auto-dismissed, and must NOT get the generic
 * dismiss (X). That X permanently strands the only in-app way to answer a still-
 * blocked task, with no way to rebuild the card (#423).
 */
export function isStickyPrompt(
  notification: Pick<FlowNotification, 'kind' | 'promptId'>,
): boolean {
  return notification.kind === 'blocked-prompt' && Boolean(notification.promptId)
}

/**
 * Whether the toast stack must sit ABOVE the inbox panel (#459, #769). The toast
 * stack and the inbox share the same fixed screen region; the inbox is normally on
 * top, but any toast that REQUIRES a click must always be reachable: a sticky
 * blocked-prompt card carries the only reply affordance (#459/#463), and a
 * persistent actionable toast carries the action it exists to offer (#769 — the
 * sibling case #463 missed). While either is live, the stack elevates above the
 * open inbox. DOM-free so the invariant is unit-testable.
 */
export function shouldElevateToasts(livePromptCount: number, liveActionToastCount = 0): boolean {
  return livePromptCount + liveActionToastCount > 0
}

export interface ShownPromptRegistry {
  /** Whether this prompt id already toasted (either channel). */
  has(promptId: string): boolean
  /** Record a prompt id as shown for a root. */
  record(promptId: string, rootId: string): void
  /** Forget every prompt id shown for a root — call when the root's state is
   *  dropped. Returns how many ids were pruned. */
  pruneRoot(rootId: string): number
}

/**
 * Root-aware replacement for the plain shown-prompt-id Set (#970). The prompt
 * id derives from the prompt FILE'S MTIME (`hb-<mtimeMs>` in the main-process
 * observer), so an untouched prompt keeps the same id forever: when a root was
 * removed and re-added, the un-pruned Set deduped the re-delivered prompt away
 * and no reply card was rebuilt — a still-blocked task with no in-app way to
 * answer it. Tracking promptId → rootId lets the caller prune a dropped root's
 * ids so its pending prompt re-toasts when the root comes back. DOM-free so
 * the remove/re-add race is unit-testable.
 */
export function createShownPromptRegistry(): ShownPromptRegistry {
  const rootByPromptId = new Map<string, string>()
  return {
    has(promptId) {
      return rootByPromptId.has(promptId)
    },
    record(promptId, rootId) {
      rootByPromptId.set(promptId, rootId)
    },
    pruneRoot(rootId) {
      let pruned = 0
      for (const [promptId, owner] of rootByPromptId) {
        if (owner === rootId) {
          rootByPromptId.delete(promptId)
          pruned += 1
        }
      }
      return pruned
    },
  }
}

export function blockedPromptGate(
  notification: Pick<FlowNotification, 'kind' | 'promptId'>,
  alreadyShown: (promptId: string) => boolean,
): NotificationGate {
  if (notification.kind !== 'blocked-prompt' || !notification.promptId) {
    return { forward: true, recordPromptId: null }
  }
  if (alreadyShown(notification.promptId)) {
    return { forward: false, recordPromptId: null }
  }
  return { forward: true, recordPromptId: notification.promptId }
}

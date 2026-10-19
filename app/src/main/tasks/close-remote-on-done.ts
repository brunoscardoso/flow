// close-remote-on-done — when a PROMOTED remote task is dragged to Done, close
// its tracker ticket.
//
// The reaction lives here, store/IPC-free and dependency-injected, for the same
// reason task-lane-sync.ts does: it unit-tests without a database, Electron, or a
// network, and it keeps the "when does a Done move close a remote?" rule in ONE
// code path (allowed-pattern #14) rather than in the four renderer callers that can
// reach the Done lane. The IPC handler (tasks:update) wires it to the real
// AppSettingsStore, IntegrationsManager and the flow:notification broadcast.
//
// FAIL-SOFT BY CONTRACT: the close is a side effect of the lane move, never a gate
// on it. The handler fires this and ignores the returned promise; every failure
// becomes a toast, and the card stays in Done regardless.

import type { CloseIssueResult } from '../integrations/integrations-manager'
import { parseIssueRef, type IssueProvider, type IssueRef } from '../issue-ref'
import type { TaskRecord } from '../store/task-store'

/** The tracker's name, for the sentence the toast prints. */
const PROVIDER_LABEL: Record<IssueProvider, string> = {
  jira: 'Jira',
  github: 'GitHub',
  azure: 'Azure DevOps',
}

/** The slice of the world the reaction needs — each injected so the whole thing
 *  tests offline. */
export interface CloseRemoteOnDoneDeps {
  /** The `close_remote_on_done` setting — false means behave exactly as before. */
  isEnabled(): boolean
  /** IntegrationsManager.closeIssue — fail-soft, never throws. */
  closeIssue(ref: IssueRef, opts: { comment?: string }): Promise<CloseIssueResult>
  /** Announce the outcome (a flow:notification toast, in production). */
  notify(outcome: {
    rootId: string
    title: string
    body: string
    level: 'info' | 'warn'
  }): void
}

/**
 * Close the remote ticket iff a promoted tracker task just moved INTO Done.
 *
 * Returns the in-flight promise so a test can await it; the IPC handler ignores it
 * (fire-and-forget). Returns null — and does NOTHING — for every case that must
 * not close a remote:
 *  - not a transition into done (`record.lane !== 'done'`, or it was already done)
 *  - a manual card OR an agent-todo mirror (both carry `source: 'manual'`)
 *  - the setting is off
 *  - nothing on the record parses as a tracker ref
 *
 * The order matters: the transition check is first so re-saving a Done task (a
 * rename, a `suggestDone` clear) never re-closes and re-comments.
 */
export function closeRemoteOnDone(
  prev: TaskRecord | null,
  record: TaskRecord,
  deps: CloseRemoteOnDoneDeps,
): Promise<void> | null {
  if (record.lane !== 'done') return null
  if (prev !== null && prev.lane === 'done') return null
  if (record.source === 'manual') return null
  if (!deps.isEnabled()) return null
  // Prefer the full URL (github.com/o/r/issues/n) but fall back to the dedup key
  // (o/r#n) — both parse; a card with neither is not a tracker card.
  const ref = parseIssueRef(record.externalUrl ?? record.externalKey ?? '')
  if (ref === null) return null

  const comment = composeCloseComment(record)
  return deps
    .closeIssue(ref, { comment })
    .then((result) => {
      if (result.ok) {
        deps.notify({
          rootId: record.projectRoot,
          title: 'Remote ticket closed',
          body: `Closed ${result.key} on ${PROVIDER_LABEL[result.provider]}.`,
          level: 'info',
        })
      } else {
        deps.notify({
          rootId: record.projectRoot,
          title: "Couldn't close the remote ticket",
          body: result.reason,
          level: 'warn',
        })
      }
    })
    .catch((error: unknown) => {
      // closeIssue is documented never to throw; this guard keeps a future change
      // from leaking an unhandled rejection out of a fire-and-forget call (#114).
      deps.notify({
        rootId: record.projectRoot,
        title: "Couldn't close the remote ticket",
        body: error instanceof Error ? error.message : String(error),
        level: 'warn',
      })
    })
}

/** The note posted with the close, so the tracker timeline says who closed it and
 *  why — the card was moved to Done in Flow. */
function composeCloseComment(record: TaskRecord): string {
  const title = record.title.trim()
  const named = title.length > 0 ? ` — "${title}"` : ''
  return `Closed from Flow: this task${named} was moved to Done.`
}

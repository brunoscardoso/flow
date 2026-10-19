/**
 * The Workspace dialogs — New, Join, Rename, Delete, Move to…, Move it in,
 * Open Project — the seam the switcher presses.
 *
 * The switcher asks through one event, `flow:workspace-dialog`; the dialogs
 * (settings/workspace-dialogs-view.ts) listen, call `preventDefault()` and
 * open. With no listener, the person is told in plain words that it is not
 * ready, rather than pressing an item that silently does nothing.
 */

import {
  WORKSPACE_DIALOG_EVENT,
  unansweredDialogNotice,
  type WorkspaceDialogKind,
  type WorkspaceDialogRequest,
} from './workspace-switcher-model'

export { WORKSPACE_DIALOG_EVENT, type WorkspaceDialogKind, type WorkspaceDialogRequest }

/** Ask for a Workspace dialog. Returns true when a listener opened one. */
export function openWorkspaceDialog(request: WorkspaceDialogRequest, target: EventTarget = document): boolean {
  const kind: WorkspaceDialogKind = request.kind
  const event = new CustomEvent<WorkspaceDialogRequest>(WORKSPACE_DIALOG_EVENT, {
    detail: request,
    cancelable: true,
  })
  const notCancelled = target.dispatchEvent(event)
  if (!notCancelled) return true
  const notice = unansweredDialogNotice(kind)
  document.dispatchEvent(
    new CustomEvent('flow:notify', {
      detail: {
        kind: 'state-change',
        rootId: '',
        title: notice.title,
        body: notice.body,
        timestamp: new Date().toISOString(),
        level: 'info',
      },
    }),
  )
  return false
}

/**
 * Hot-exit flush handshake (#1443).
 *
 * The renderer persists the editor's tabs + unsaved buffers from `beforeunload`
 * (#1072), which is enough for an in-place reload: the main process stays up, so
 * the queued `project:saveOpenFiles` still has a receiver. Quit is different —
 * `before-quit` is intercepted and `disposeMainProcess()` runs to completion
 * (disposeIpc, then db.close) BEFORE the window unloads. The write landed
 * nowhere, and the tab came back on the next launch looking CLEAN: a silent loss
 * disguised as no loss at all.
 *
 * So teardown asks first and waits for an answer, rather than hoping one race
 * beats another. Bounded and fail-open by construction: a wedged, crashed, or
 * simply absent renderer costs the user their unsaved buffer, never their quit.
 */

/** A window this can address — structural, so tests need no Electron. */
export interface FlushTarget {
  isDestroyed(): boolean
  webContents: { send(channel: string, payload: Record<string, never>): void }
}

/** How long teardown waits for the renderer to say it has persisted. */
export const FLUSH_TIMEOUT_MS = 1_500

let pendingAck: (() => void) | null = null

/**
 * The renderer's ack (`project:editorContextFlushed`). Safe to call at any
 * time — an ack nobody is waiting for is simply dropped.
 */
export function notifyEditorContextFlushed(): void {
  const resolve = pendingAck
  pendingAck = null
  resolve?.()
}

/**
 * Ask live windows to persist their editor state, and resolve once the first
 * one acks — or once `timeoutMs` elapses, whichever comes first.
 *
 * Resolves immediately when there is nothing to ask: no window, or every window
 * already destroyed (the ordinary case for a quit that follows a window close).
 */
export function flushEditorContext(
  targets: readonly FlushTarget[],
  timeoutMs: number = FLUSH_TIMEOUT_MS,
): Promise<void> {
  const live = targets.filter((target) => !target.isDestroyed())
  if (live.length === 0) return Promise.resolve()

  return new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (pendingAck === finish) pendingAck = null
      resolve()
    }
    const timer = setTimeout(() => {
      console.warn('[Main] editor-context flush did not ack — quitting anyway')
      finish()
    }, timeoutMs)
    // Unref so a pending flush timer can never be the reason the process lingers.
    timer.unref?.()
    pendingAck = finish

    for (const target of live) {
      try {
        target.webContents.send('project:flushEditorContext', {})
      } catch (error) {
        // A window torn down between the filter and here is not an error worth
        // failing a quit over; the timeout still bounds the wait.
        console.warn('[Main] Failed to request editor-context flush:', error)
      }
    }
  })
}

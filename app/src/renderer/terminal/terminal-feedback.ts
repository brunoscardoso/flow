// User-facing feedback for terminal-panel actions (#209). Terminal create/attach
// failures were swallowed to console only: clicking + (or ⌘/Ctrl+Shift+`) when the
// PTY can't spawn did nothing visible — a silent dead click (forbidden pattern
// #2). These pure builders turn a failure into a toast; the panel dispatches it
// via the `flow:notify` event → NotificationCenter, mirroring git/editor.

import { ipcErrorMessage } from '../ipc-error'

export interface TerminalToast {
  title: string
  body: string
  level: 'info' | 'error'
}

/** Readable text from an unknown thrown value — routed through the ONE IPC
 *  unwrap path (#731/#988) so toasts never leak Electron's remote-method wrapper. */
export function errorText(error: unknown): string {
  return ipcErrorMessage(error)
}

/** api.terminal.create rejected (PTY spawn failed, shell missing, root gone). */
export function terminalCreateFailedToast(error: unknown): TerminalToast {
  return {
    title: "Couldn't open terminal",
    body: errorText(error),
    level: 'error',
  }
}

/** The xterm view failed to attach to an otherwise-created terminal (blank host). */
export function terminalAttachFailedToast(error: unknown): TerminalToast {
  return {
    title: "Couldn't open terminal",
    body: `The terminal view failed to load — ${errorText(error)}.`,
    level: 'error',
  }
}

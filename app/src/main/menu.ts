/**
 * Application menu installer (#673). The template itself — including both
 * platform branches — lives in `menu-template.ts`, which is pure and testable
 * off-platform; this module only binds it to electron and installs it.
 */
import { app, BrowserWindow, clipboard, Menu, shell } from 'electron'
import { buildMenuTemplate } from './menu-template'
import { readSlowLog, recordSlow, slowLogPath } from './ipc/slow-handler'

/** How much of the log the clipboard action hands over — enough to cover the
 *  session somebody is complaining about, small enough to paste. */
const REPORT_BYTES = 64 * 1024

export function installApplicationMenu(): void {
  const template = buildMenuTemplate(process.platform, {
    appName: app.name,
    sendToFocused: (channel, payload) => {
      // The focused window — or, when none is key (Flow is the active app but
      // its window is not focused, e.g. just after a dialog closed, or a window
      // opened in the background), the app's window. A menu command that finds
      // no focused window was a silent dead item: Settings… opened nothing.
      const target =
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ??
        null
      target?.webContents.send(channel, payload)
    },
    // The evidence for "it is slow", reachable without a terminal.
    copyPerformanceReport: () => {
      const text = readSlowLog(REPORT_BYTES)
      clipboard.writeText(
        text.trim().length > 0
          ? `Flow ${app.getVersion()} — performance log\n\n${text}`
          : `Flow ${app.getVersion()} — nothing has been slow enough to record yet.`,
      )
    },
    showPerformanceLog: () => {
      const path = slowLogPath()
      if (path === null) return
      // Reveal needs the file to exist, and a fresh session may not have been
      // slow yet — this line both creates it and stamps when somebody looked.
      recordSlow('[menu] performance log opened')
      shell.showItemInFolder(path)
    },
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/**
 * The application-menu TEMPLATE, split out of `menu.ts` (Windows support,
 * Phase 7) so both platform branches are testable off-platform: this module
 * imports electron only as a TYPE, takes the platform as an argument, and takes
 * its two electron touchpoints (`app.name`, "send to the focused window") as
 * injected dependencies. `menu.ts` stays the thin installer.
 *
 * macOS is unchanged. The non-mac branch gains what a Windows menu bar is
 * expected to have and what this template was missing:
 *   - a Help menu carrying About. `role: 'about'` lived ONLY in the macOS app
 *     menu, so on Windows — which has no application menu — About was
 *     unreachable from anywhere in the app.
 *   - no Window ▸ Zoom. `role: 'zoom'` is macOS-only; on Windows it rendered as
 *     an enabled item that did nothing, which is a dead click.
 * It already correctly omits the app menu, Services, Hide and Hide Others (all
 * macOS-only roles) and hosts Settings under File, VS Code style (#1159).
 */
import type { MenuItemConstructorOptions } from 'electron'

export interface MenuTemplateDeps {
  /** `app.name` — the macOS application-menu label. */
  appName: string
  /** Push an IPC message to the FOCUSED window only; a background window must
   *  not close its tabs or raise an overlay nobody is looking at. */
  sendToFocused: (channel: string, payload: unknown) => void
  /** Reveal the performance log in the OS file manager. Optional so a caller
   *  that has no log (a test, an older host) simply gets no menu item rather
   *  than a dead click. */
  showPerformanceLog?: () => void
  /** Put the performance log's recent tail on the clipboard — how somebody
   *  reporting slowness hands over the evidence without opening a terminal. */
  copyPerformanceReport?: () => void
}

/**
 * Build the menu template for a platform.
 *
 * #673: without an explicit menu Electron installs its default one, whose Close
 * Window role owns ⌘W / Ctrl+W — so closing "a tab" closed the whole window.
 * This template keeps the standard roles but claims ⌘W for **Close Tab**; Close
 * Window stays reachable on ⇧⌘W / Shift+Ctrl+W, VS Code style.
 */
export function buildMenuTemplate(
  platform: NodeJS.Platform | string,
  deps: MenuTemplateDeps,
): MenuItemConstructorOptions[] {
  const isMac = platform === 'darwin'

  /** Settings… — the item every desktop app has, on the accelerator every user
   *  tries first (#1159). Opens the SAME overlay the titlebar accounts control
   *  and the palette's "Open Settings" open; the renderer owns the surface. */
  const settingsItem: MenuItemConstructorOptions = {
    label: 'Settings…',
    accelerator: 'CmdOrCtrl+,',
    click: () => {
      deps.sendToFocused('settings:open', null)
    },
  }

  const fileSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Close Tab',
      accelerator: 'CmdOrCtrl+W',
      click: () => {
        deps.sendToFocused('editor:closeActiveTab', null)
      },
    },
    { role: 'close', accelerator: isMac ? 'Shift+Cmd+W' : 'Shift+Ctrl+W' },
  ]
  if (!isMac) {
    // Windows/Linux keep Settings under File, VS Code style — there is no
    // application menu to host it (#1159).
    fileSubmenu.push({ type: 'separator' }, settingsItem, { type: 'separator' }, { role: 'quit' })
  }

  // Electron's `appMenu` role is a fixed composite with NO Preferences item, so
  // the macOS app menu is spelled out to put Settings… in its conventional
  // place: right under About, above Services (#1159).
  const macAppMenu: MenuItemConstructorOptions = {
    label: deps.appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settingsItem,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }

  /**
   * #1338: Edit ▸ Undo / Redo / Select All were SILENT DEAD CLICKS in the code
   * editor, while Cut / Copy / Paste worked in the very same buffer.
   *
   * Monaco 0.55 takes input through the EditContext API — its focused node is
   * `<div class="native-edit-context">`, not a textarea — so Blink's `undo` /
   * `selectAll` edit commands have no editable target and no-op, while
   * clipboard events still arrive as events Monaco listens for. (This is why
   * VS Code does not use `role: 'editMenu'` either.) The items were never
   * greyed out, so it read as a dead click — and the sharp edge is that
   * Edit ▸ Cut can empty your file while Edit ▸ Undo cannot put it back.
   *
   * These three now ASK the renderer, which routes to Monaco when the editor
   * has focus and falls back to the native command for Flow's own inputs.
   * Cut/Copy/Paste keep their roles: they already work everywhere.
   */
  const editAction = (
    label: string,
    accelerator: string,
    action: 'undo' | 'redo' | 'selectAll',
  ): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => {
      deps.sendToFocused('editor:editAction', action)
    },
  })

  const editSubmenu: MenuItemConstructorOptions[] = [
    editAction('Undo', 'CmdOrCtrl+Z', 'undo'),
    editAction('Redo', isMac ? 'Shift+Command+Z' : 'Control+Y', 'redo'),
    { type: 'separator' },
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    editAction('Select All', 'CmdOrCtrl+A', 'selectAll'),
  ]

  /**
   * Help ▸ the performance record.
   *
   * "The app is slow" is unanswerable without evidence, and every way of
   * getting that evidence used to run through a terminal — which is both a
   * thing this app exists to avoid and a thing most people reporting slowness
   * will not do. Copy puts the recent log on the clipboard; Show opens the
   * folder it lives in. Neither says a path or a command out loud (#12).
   */
  const diagnosticsItems: MenuItemConstructorOptions[] = [
    ...(deps.copyPerformanceReport
      ? [
          {
            label: 'Copy Performance Report',
            click: () => {
              deps.copyPerformanceReport?.()
            },
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    ...(deps.showPerformanceLog
      ? [
          {
            label: 'Show Performance Log',
            click: () => {
              deps.showPerformanceLog?.()
            },
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
  ]

  const helpSubmenu: MenuItemConstructorOptions[] = [
    // macOS reaches About through the application menu above; Windows/Linux
    // have no application menu, so Help carries it — where Windows users look.
    ...(isMac ? [] : ([{ role: 'about' }] satisfies MenuItemConstructorOptions[])),
    ...(diagnosticsItems.length > 0 && !isMac
      ? ([{ type: 'separator' }] satisfies MenuItemConstructorOptions[])
      : []),
    ...diagnosticsItems,
  ]

  return [
    ...(isMac ? [macAppMenu] : []),
    { label: 'File', submenu: fileSubmenu },
    { label: 'Edit', submenu: editSubmenu },
    { role: 'viewMenu' },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        // `zoom` and `front` are macOS-only roles — on Windows they render as
        // live items that do nothing.
        ...(isMac
          ? ([
              { role: 'zoom' },
              { type: 'separator' },
              { role: 'front' },
            ] satisfies MenuItemConstructorOptions[])
          : []),
      ],
    },
    // Help exists on BOTH platforms now: it is where the performance record
    // lives, and macOS had no Help menu at all.
    ...(helpSubmenu.length > 0
      ? ([{ role: 'help', submenu: helpSubmenu }] satisfies MenuItemConstructorOptions[])
      : []),
  ]
}

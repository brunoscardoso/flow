import type { MenuItemConstructorOptions } from 'electron'
import { buildMenuTemplate, type MenuTemplateDeps } from './menu-template'

/** Menu template shape on both platforms (Windows support, Phase 7). The
 *  template is pure and takes the platform as an argument, so the Windows
 *  branch is asserted from a Mac and the macOS branch from Windows. */

function deps(sent: Array<[string, unknown]> = []): MenuTemplateDeps {
  return {
    appName: 'Flow',
    sendToFocused: (channel, payload) => {
      sent.push([channel, payload])
    },
  }
}

/** Deps that CAN produce the performance record, recording which action ran. */
function depsWithDiagnostics(ran: string[]): MenuTemplateDeps {
  return {
    ...deps(),
    copyPerformanceReport: () => ran.push('copy'),
    showPerformanceLog: () => ran.push('show'),
  }
}

function labels(template: MenuItemConstructorOptions[]): string[] {
  return template.map((item) => item.label ?? (item.role as string) ?? '')
}

function submenuOf(
  template: MenuItemConstructorOptions[],
  label: string,
): MenuItemConstructorOptions[] {
  const found = template.find((item) => item.label === label || item.role === label)
  if (!found || !Array.isArray(found.submenu)) {
    throw new Error(`no submenu for ${label}`)
  }
  return found.submenu
}

/** Every role reachable in the template, at any depth. */
function roles(items: MenuItemConstructorOptions[]): string[] {
  const out: string[] = []
  for (const item of items) {
    if (item.role) out.push(item.role)
    if (Array.isArray(item.submenu)) out.push(...roles(item.submenu))
  }
  return out
}

describe('buildMenuTemplate — macOS', () => {
  const template = buildMenuTemplate('darwin', deps())

  it('leads with the application menu named after the app', () => {
    expect(labels(template)).toEqual(['Flow', 'File', 'Edit', 'viewMenu', 'Window'])
  })

  it('keeps the macOS-only roles in the app menu', () => {
    const appMenu = submenuOf(template, 'Flow')
    expect(roles(appMenu)).toEqual([
      'about',
      'services',
      'hide',
      'hideOthers',
      'unhide',
      'quit',
    ])
  })

  it('keeps Window ▸ Zoom and Front, and does NOT add a Help menu', () => {
    expect(roles(submenuOf(template, 'Window'))).toEqual(['minimize', 'zoom', 'front'])
    expect(labels(template)).not.toContain('help')
  })

  it('claims Cmd+W for Close Tab and leaves Close Window on Shift+Cmd+W (#673)', () => {
    const file = submenuOf(template, 'File')
    expect(file[0]?.label).toBe('Close Tab')
    expect(file[0]?.accelerator).toBe('CmdOrCtrl+W')
    expect(file[1]?.role).toBe('close')
    expect(file[1]?.accelerator).toBe('Shift+Cmd+W')
  })

  it('hosts Settings… in the app menu, not under File (#1159)', () => {
    expect(submenuOf(template, 'Flow').some((i) => i.label === 'Settings…')).toBe(true)
    expect(submenuOf(template, 'File').some((i) => i.label === 'Settings…')).toBe(false)
  })
})

describe('buildMenuTemplate — Windows', () => {
  const template = buildMenuTemplate('win32', deps())

  it('is a complete File/Edit/View/Window/Help bar with no application menu', () => {
    expect(labels(template)).toEqual(['File', 'Edit', 'viewMenu', 'Window', 'help'])
  })

  it('carries none of the macOS-only roles', () => {
    for (const macOnly of ['services', 'hide', 'hideOthers', 'unhide', 'front', 'zoom']) {
      expect(roles(template)).not.toContain(macOnly)
    }
  })

  it('reaches About through Help — the app menu that used to carry it is absent', () => {
    expect(roles(submenuOf(template, 'help'))).toEqual(['about'])
  })

  it('hosts Settings… and Quit under File, VS Code style (#1159)', () => {
    const file = submenuOf(template, 'File')
    expect(file.some((i) => i.label === 'Settings…')).toBe(true)
    expect(file.some((i) => i.role === 'quit')).toBe(true)
  })

  it('claims Ctrl+W for Close Tab and leaves Close Window on Shift+Ctrl+W (#673)', () => {
    const file = submenuOf(template, 'File')
    expect(file[0]?.label).toBe('Close Tab')
    expect(file[0]?.accelerator).toBe('CmdOrCtrl+W')
    expect(file[1]?.accelerator).toBe('Shift+Ctrl+W')
  })

  it('routes Undo/Redo/Select All to the renderer, with the Windows Redo key (#1338)', () => {
    const edit = submenuOf(template, 'Edit')
    expect(edit.map((i) => i.label ?? i.role)).toEqual([
      'Undo',
      'Redo',
      undefined,
      'cut',
      'copy',
      'paste',
      'Select All',
    ])
    expect(edit[1]?.accelerator).toBe('Control+Y')
  })
})

describe('buildMenuTemplate — click routing', () => {
  it('sends every custom item to the FOCUSED window only', () => {
    const sent: Array<[string, unknown]> = []
    const template = buildMenuTemplate('win32', deps(sent))
    const file = submenuOf(template, 'File')
    const edit = submenuOf(template, 'Edit')

    file[0]?.click?.(undefined as never, undefined, undefined as never)
    file[3]?.click?.(undefined as never, undefined, undefined as never) // Settings…
    edit[0]?.click?.(undefined as never, undefined, undefined as never) // Undo

    expect(sent).toEqual([
      ['editor:closeActiveTab', null],
      ['settings:open', null],
      ['editor:editAction', 'undo'],
    ])
  })
})

/**
 * Help ▸ the performance record.
 *
 * Reported as "the performance is killing my usage": the evidence existed, in a
 * file, on their own machine, reachable only by typing a path into a terminal —
 * which is exactly what this app promises people they will not have to do.
 */
describe('the performance record is reachable from the menu', () => {
  it.each(['darwin', 'win32'])('%s offers copy and reveal under Help', (platform) => {
    const ran: string[] = []
    const template = buildMenuTemplate(platform, depsWithDiagnostics(ran))
    const help = submenuOf(template, 'help')
    const items = help.filter((item) => typeof item.label === 'string').map((item) => item.label)
    expect(items).toContain('Copy Performance Report')
    expect(items).toContain('Show Performance Log')

    for (const item of help) {
      if (item.label === 'Copy Performance Report') {
        item.click?.(undefined as never, undefined, undefined as never)
      }
    }
    expect(ran).toEqual(['copy'])
  })

  it('offers no dead items when the host cannot produce a report', () => {
    // A menu entry that cannot act is a dead click wearing a button's clothes.
    const template = buildMenuTemplate('darwin', deps())
    expect(template.find((item) => item.role === 'help')).toBeUndefined()
  })

  it('keeps About where Windows users look for it', () => {
    const help = submenuOf(buildMenuTemplate('win32', depsWithDiagnostics([])), 'help')
    expect(help.some((item) => item.role === 'about')).toBe(true)
  })
})

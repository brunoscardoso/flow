/**
 * The Workspace switcher — the dropdown at the top of the window. Workspaces
 * are always on (decision 2026-10-06), so it is THE switcher: there is no
 * project switcher beside it.
 *
 *   · the button: the Workspace being looked at, its hover text the
 *     Workspace's projects and sync status
 *   · the menu: every Workspace — the current one listing its projects (each
 *     with its settings and "Move to…" one press away) and offering Rename… /
 *     Delete… — then the projects that need attention, then New Workspace… /
 *     Join a Workspace… / Open Project…
 *
 * Every decision is in `workspace-switcher-model.ts`; the state in
 * `workspace-scope.ts`. This file appends elements and routes presses. It
 * borrows the project switcher's look (its inner `.fl-project-*` classes,
 * shell.ts) so the two are the same control to the eye.
 */

import { ensureAccentProperty, slotPaint } from '../project-accent'
import { attachMenuKeyboard } from '../menu-keyboard'
import { projectLabel } from '../project-label'
import { isRootAvailable } from '../../shared/root-selection'
import { openWorkspaceDialog } from './workspace-dialogs'
import { workspaceScope, type WorkspaceScopeState } from './workspace-scope'
import {
  DEFAULT_TAG,
  DELETE_WORKSPACE_LABEL,
  JOIN_WORKSPACE_LABEL,
  NEW_WORKSPACE_LABEL,
  RENAME_WORKSPACE_LABEL,
  PROJECT_MENU_EVENT,
  moveProjectLabel,
  projectActionsLabel,
  switcherLabel,
  switcherMenu,
  switcherTitle,
  type SwitcherMenuEntry,
} from './workspace-switcher-model'

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.dataset['flWorkspaceSwitcher'] = ''
  style.textContent = `
    .fl-ws-switcher {
      -webkit-app-region: no-drag;
      position: relative;
      display: inline-flex;
    }
    .fl-ws-switcher .fl-project-menu { min-width: 260px; max-width: 360px; }
    /* In the rail: an icon button like its neighbours; the menu opens below it. */
    .fl-ws-rail .fl-ws-rail-label {
      position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
    }
    .fl-ws-rail .fl-project-current.fl-rail-item { padding: 0; gap: 0; }
    .fl-ws-rail .fl-project-current.fl-rail-item[aria-expanded="true"] { color: var(--fl-color-accent); }
    /* Scoped under the switcher: the shared .fl-project-item rule (shell.ts)
       is injected later and would otherwise put the name and its detail on
       one line. */
    .fl-ws-switcher .fl-ws-item {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 1px;
      white-space: normal;
    }
    /* A Workspace row: its name with the sync status to the right on ONE line,
       and the pencil beside them (user, 2026-10-06). */
    .fl-ws-item-row { display: flex; align-items: center; gap: 0; padding-right: var(--fl-space-xs); }
    /* The row's icons sit close together (user, 2026-10-06). */
    .fl-ws-item-row > .fl-ws-project-settings { width: 18px; }
    .fl-ws-item-row > .fl-ws-item { margin-right: var(--fl-space-xs); }
    .fl-ws-switcher .fl-ws-item-row .fl-ws-item {
      flex: 1;
      min-width: 0;
      flex-direction: row;
      align-items: baseline;
      gap: var(--fl-space-sm);
    }
    .fl-ws-item-row .fl-ws-item-detail { margin-left: auto; flex: none; max-width: 55%; }
    .fl-ws-item-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fl-ws-switcher .fl-ws-item.active .fl-ws-item-name { color: var(--fl-color-accent); }
    .fl-ws-item-detail {
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    /* The open Workspace's projects: rows on the SAME grid as every other menu
       item (font, height, left edge), a folder icon marking them as its
       contents, and their buttons in the pencil's column (user, 2026-10-06). */
    .fl-ws-projects { display: flex; flex-direction: column; padding: 0 0 var(--fl-space-xs); }
    .fl-ws-project {
      display: flex;
      align-items: center;
      gap: var(--fl-space-xs);
      min-height: 26px;
      padding: 0 var(--fl-space-xs) 0 var(--fl-space-sm);
      border-radius: var(--fl-radius-sm);
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text);
    }
    .fl-ws-project:hover { background: var(--fl-color-accent-muted); }
    .fl-ws-project-open { cursor: pointer; }
    .fl-ws-project-open:focus-visible { outline: none; background: var(--fl-color-accent-muted); }
    .fl-ws-project-icon { flex: none; color: var(--fl-color-text-secondary); }
    .fl-ws-project-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fl-ws-project-note { flex: none; font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }
    .fl-ws-project-settings {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      cursor: pointer;
    }
    .fl-ws-project-settings:hover,
    .fl-ws-project-settings:focus-visible { color: var(--fl-color-text); background: var(--fl-color-accent-muted); }
    .fl-ws-heading {
      margin-top: var(--fl-space-xs);
      padding: var(--fl-space-xs) var(--fl-space-sm) 2px;
      border-top: var(--fl-border-width) solid var(--fl-color-border);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
      user-select: none;
    }
    .fl-ws-action { color: var(--fl-color-text-secondary); }
    .fl-ws-item-tag {
      margin-left: var(--fl-space-xs);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-ws-note { padding: var(--fl-space-xs) var(--fl-space-sm); font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }
    .fl-ws-switcher .fl-ws-attention {
      display: flex; flex-direction: column; align-items: stretch; gap: 1px; white-space: normal;
    }
    .fl-ws-action-first {
      margin-top: var(--fl-space-xs);
      border-top: var(--fl-border-width) solid var(--fl-color-border);
    }
  `
  document.head.appendChild(style)
}

/**
 * Ask for one project's actions — archive its threads, remove it, its colour,
 * a new thread in it. The thread sidebar owns that menu; this is its door since
 * the per-project sidebar headers went (2026-10-06). Anchored on the switcher's
 * own rail button, which stays on screen after the switcher closes.
 */
function openProjectActions(rootPath: string, anchor: HTMLElement): void {
  document.dispatchEvent(
    new CustomEvent<{ rootPath: string; anchor: HTMLElement }>(PROJECT_MENU_EVENT, {
      detail: { rootPath, anchor },
    }),
  )
}

/** Open a project's own settings (the same event the sidebar's project menu sends). */
function openProjectSettings(rootPath: string): void {
  document.dispatchEvent(new CustomEvent<{ rootPath: string }>('flow:open-flow-settings', { detail: { rootPath } }))
}

/** Build the switcher. */
export function buildWorkspaceSwitcher(): HTMLElement {
  injectStyles()
  const wrap = document.createElement('div')
  // The look is borrowed from the old project switcher's inner classes.
  wrap.className = 'fl-ws-switcher'

  // AN ICON IN THE SIDEBAR'S RAIL, first before Threads / Files / Source
  // Control (user, 2026-10-06: "move this workspace selector to here, make it
  // the first option, remove the label"). The name stays in the button as
  // visually hidden text (its accessible name) and in the hover title.
  wrap.classList.add('fl-ws-rail')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'fl-project-current fl-rail-item'
  button.setAttribute('aria-haspopup', 'menu')
  const icon = document.createElement('fl-icon')
  icon.setAttribute('name', 'layers')
  icon.setAttribute('size', '15')
  const label = document.createElement('span')
  label.className = 'fl-project-name fl-ws-rail-label'
  button.append(icon, label)
  wrap.appendChild(button)

  let state: WorkspaceScopeState | null = null
  let currentClose: (() => void) | null = null

  function rootLabel(root: string, current: WorkspaceScopeState): string {
    return projectLabel(root, current.registered.map((entry) => entry.rootPath))
  }

  function paint(current: WorkspaceScopeState): void {
    const scope = current.scope
    label.textContent = switcherLabel(scope, current.placement?.migrating !== false)
    icon.setAttribute('name', 'layers')
    button.title = switcherTitle(scope, current.workspaces, current.syncStatus)
    button.setAttribute('aria-label', scope.kind === 'workspace' ? `Workspace: ${scope.name}` : label.textContent ?? '')
  }

  function menuButton(className: string, onPress: () => void): HTMLButtonElement {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = className
    item.addEventListener('click', () => onPress())
    return item
  }

  function renderEntry(entry: SwitcherMenuEntry, menu: HTMLElement, close: () => void, firstAction: boolean): void {
    switch (entry.kind) {
      case 'workspace': {
        const item = menuButton('fl-project-item fl-ws-item', () => {
          close()
          void workspaceScope.selectWorkspace(entry.slug)
        })
        if (entry.active) item.classList.add('active')
        item.dataset['workspace'] = entry.slug
        const name = document.createElement('span')
        name.className = 'fl-ws-item-name'
        name.textContent = entry.name
        // The tag says which one is Default once it carries another name.
        if (entry.isDefault && entry.name !== DEFAULT_TAG) {
          const tag = document.createElement('span')
          tag.className = 'fl-ws-item-tag'
          tag.textContent = DEFAULT_TAG
          name.appendChild(tag)
        }
        item.title = entry.detail === '' ? entry.name : `${entry.name}\n${entry.detail}`
        item.append(name)
        if (entry.detail !== '') {
          const detail = document.createElement('span')
          detail.className = 'fl-ws-item-detail'
          detail.textContent = entry.detail
          item.append(detail)
        }
        // The row: the Workspace (name, status on the right) and, for the open
        // one, a pencil that renames it — a button beside the select button,
        // never inside it.
        const row = document.createElement('div')
        row.className = 'fl-ws-item-row'
        row.appendChild(item)
        const slug = entry.slug
        const iconAction = (action: 'new' | 'join', label: string, iconName: string, dataAction: string, open: () => void): void => {
          if (!entry.actions.includes(action)) return
          const btn = menuButton('fl-ws-project-settings', () => {
            close()
            open()
          })
          btn.dataset['action'] = dataAction
          btn.setAttribute('aria-label', label)
          btn.title = label
          const glyph = document.createElement('fl-icon')
          glyph.setAttribute('name', iconName)
          glyph.setAttribute('size', '12')
          btn.appendChild(glyph)
          row.appendChild(btn)
        }
        // Order (user, 2026-10-06): rename, new, delete, join — join last.
        if (entry.actions.includes('rename')) {
          const rename = menuButton('fl-ws-project-settings fl-ws-rename', () => {
            close()
            openWorkspaceDialog({ kind: 'rename', slug })
          })
          rename.dataset['manage'] = 'rename'
          rename.setAttribute('aria-label', RENAME_WORKSPACE_LABEL)
          rename.title = RENAME_WORKSPACE_LABEL
          const pencil = document.createElement('fl-icon')
          pencil.setAttribute('name', 'pencil')
          pencil.setAttribute('size', '12')
          rename.appendChild(pencil)
          row.appendChild(rename)
        }
        iconAction('new', NEW_WORKSPACE_LABEL, 'plus', 'new-workspace', () => openWorkspaceDialog({ kind: 'create' }))
        if (entry.actions.includes('delete')) {
          const remove = menuButton('fl-ws-project-settings fl-ws-delete', () => {
            close()
            openWorkspaceDialog({ kind: 'delete', slug })
          })
          remove.dataset['manage'] = 'delete'
          remove.setAttribute('aria-label', DELETE_WORKSPACE_LABEL)
          remove.title = DELETE_WORKSPACE_LABEL
          const bin = document.createElement('fl-icon')
          bin.setAttribute('name', 'trash')
          bin.setAttribute('size', '12')
          remove.appendChild(bin)
          row.appendChild(remove)
        }
        iconAction('join', JOIN_WORKSPACE_LABEL, 'link', 'join-workspace', () => openWorkspaceDialog({ kind: 'join' }))
        menu.appendChild(row)
        if (entry.projects.length > 0) {
          const list = document.createElement('div')
          list.className = 'fl-ws-projects'
          for (const project of entry.projects) {
            const row = document.createElement('div')
            row.className = 'fl-ws-project'
            const folder = document.createElement('fl-icon')
            folder.className = 'fl-ws-project-icon'
            folder.setAttribute('name', 'folder')
            folder.setAttribute('size', '12')
            // THE PROJECT'S COLOUR — the one the file tree, tabs and the map
            // wear: a picked one, else its place in the Workspace.
            folder.style.color = project.root === null ? slotPaint(project.slot) : ensureAccentProperty(project.root)
            row.appendChild(folder)
            const projectName = document.createElement('span')
            projectName.className = 'fl-ws-project-name'
            projectName.textContent = project.name
            row.appendChild(projectName)
            if (project.note !== null) {
              const note = document.createElement('span')
              note.className = 'fl-ws-project-note'
              note.textContent = project.note
              row.appendChild(note)
            }
            if (project.canMove) {
              const from = entry.slug
              const move = menuButton('fl-ws-project-settings', () => {
                close()
                openWorkspaceDialog({ kind: 'move-project', from, projectId: project.id, projectName: project.name })
              })
              move.dataset['move'] = project.id
              move.setAttribute('aria-label', moveProjectLabel(project.name))
              move.title = moveProjectLabel(project.name)
              const arrow = document.createElement('fl-icon')
              arrow.setAttribute('name', 'chevron-right')
              arrow.setAttribute('size', '12')
              move.appendChild(arrow)
              row.appendChild(move)
            }
            const root = project.root
            if (root !== null) {
              const settings = menuButton('fl-ws-project-settings', () => {
                close()
                openProjectSettings(root)
              })
              settings.setAttribute('aria-label', `${project.name} settings`)
              settings.title = `${project.name} settings`
              const gear = document.createElement('fl-icon')
              gear.setAttribute('name', 'settings')
              gear.setAttribute('size', '12')
              settings.appendChild(gear)
              row.appendChild(settings)
              // THE PROJECT'S OTHER ACTIONS — archive all, remove, colour, new
              // thread. A visible `⋯` beside the gear, and the same menu on a
              // right-click of the row.
              const showActions = (): void => {
                close()
                openProjectActions(root, button)
              }
              const actions = menuButton('fl-ws-project-settings fl-ws-project-actions', showActions)
              actions.dataset['actions'] = project.id
              actions.setAttribute('aria-label', projectActionsLabel(project.name))
              actions.title = 'Project actions'
              const dots = document.createElement('fl-icon')
              dots.setAttribute('name', 'more-horizontal')
              dots.setAttribute('size', '12')
              actions.appendChild(dots)
              row.appendChild(actions)
              row.addEventListener('contextmenu', (event) => {
                event.preventDefault()
                showActions()
              })
              // THE WHOLE ROW opens the project's settings (user, 2026-10-06);
              // the gear stays as the visible cue and the move arrow keeps its
              // own action. Keyboard: the row is focusable and answers Enter.
              row.classList.add('fl-ws-project-open')
              row.tabIndex = 0
              row.setAttribute('role', 'button')
              row.setAttribute('aria-label', `${project.name} settings`)
              const openSettings = (): void => {
                close()
                openProjectSettings(root)
              }
              row.addEventListener('click', (event) => {
                if ((event.target as Element).closest('button') !== null) return
                openSettings()
              })
              row.addEventListener('keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                openSettings()
              })
            }
            list.appendChild(row)
          }
          menu.appendChild(list)
        }
        return
      }
      case 'heading': {
        const heading = document.createElement('div')
        heading.className = 'fl-ws-heading'
        heading.textContent = entry.text
        heading.setAttribute('role', 'presentation')
        menu.appendChild(heading)
        return
      }
      case 'note': {
        const note = document.createElement('div')
        note.className = 'fl-ws-note'
        note.textContent = entry.text
        note.setAttribute('role', 'presentation')
        menu.appendChild(note)
        return
      }
      case 'attention': {
        const root = entry.root
        const item = menuButton('fl-project-item fl-ws-attention', () => {
          close()
          if (entry.action === 'move-in') openWorkspaceDialog({ kind: 'move-in', root })
          else void window.flow.workspaces?.retryPlacement({ rootPath: root }).catch(() => undefined)
        })
        item.dataset['attention'] = entry.action
        const name = document.createElement('span')
        name.className = 'fl-ws-item-name'
        name.textContent = entry.label
        const detail = document.createElement('span')
        detail.className = 'fl-ws-item-detail'
        detail.textContent = entry.text
        item.title = `${entry.label}\n${entry.text}`
        item.append(name, detail)
        menu.appendChild(item)
        return
      }
      case 'action': {
        const item = menuButton(`fl-project-item fl-ws-action${firstAction ? ' fl-ws-action-first' : ''}`, () => {
          close()
          if (entry.action === 'new-workspace') openWorkspaceDialog({ kind: 'create' })
          else if (entry.action === 'join-workspace') openWorkspaceDialog({ kind: 'join' })
          else openWorkspaceDialog({ kind: 'open-project' })
        })
        item.dataset['action'] = entry.action
        item.textContent = entry.label
        menu.appendChild(item)
      }
    }
  }

  /** Re-fills the open menu from the latest state; null while the menu is closed. */
  let refillOpenMenu: ((next: WorkspaceScopeState) => void) | null = null

  function menuEntries(current: WorkspaceScopeState): SwitcherMenuEntry[] {
    return switcherMenu({
      workspaces: current.workspaces,
      scope: current.scope,
      registered: current.registered.map((root) => ({ rootPath: root.rootPath, available: isRootAvailable(root) })),
      membership: current.membership,
      activeRoot: current.activeRoot,
      syncStatus: current.syncStatus,
      placement: current.placement,
      label: (root) => rootLabel(root, current),
    })
  }

  function openMenu(): void {
    if (currentClose !== null) {
      currentClose()
      return
    }
    const current = state
    if (current === null) return
    const menu = document.createElement('div')
    menu.className = 'fl-project-menu'
    menu.setAttribute('role', 'menu')
    let detachKeyboard: (() => void) | null = null
    const close = (): void => {
      menu.remove()
      button.setAttribute('aria-expanded', 'false')
      detachKeyboard?.()
      detachKeyboard = null
      document.removeEventListener('mousedown', onDown, true)
      currentClose = null
      refillOpenMenu = null
    }
    const onDown = (event: MouseEvent): void => {
      if (!wrap.contains(event.target as Node)) close()
    }
    // THE OPEN MENU FOLLOWS THE STATE. It used to be a snapshot of the moment
    // it opened: opened while the Workspaces were still being read (a fresh
    // start) it never corrected itself, and a Workspace made in a terminal
    // never appeared.
    let shown = ''
    const fill = (next: WorkspaceScopeState): void => {
      const entries = menuEntries(next)
      const signature = JSON.stringify(entries)
      if (signature === shown) return
      shown = signature
      const focused = [...menu.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement)
      menu.replaceChildren()
      let seenAction = false
      for (const entry of entries) {
        renderEntry(entry, menu, close, entry.kind === 'action' && !seenAction)
        if (entry.kind === 'action') seenAction = true
      }
      if (focused >= 0) menu.querySelectorAll('button')[focused]?.focus()
    }
    fill(current)
    document.addEventListener('mousedown', onDown, true)
    detachKeyboard = attachMenuKeyboard(menu, { close, anchor: button, stopPropagation: true })
    currentClose = close
    refillOpenMenu = fill
    wrap.appendChild(menu)
    // THE RAIL CLIPS (overflow: hidden), so the menu is placed against the
    // WINDOW from the button's own box — below it, kept inside the viewport.
    const anchor = button.getBoundingClientRect()
    menu.style.position = 'fixed'
    menu.style.top = `${Math.round(anchor.bottom + 4)}px`
    menu.style.left = `${Math.round(Math.max(8, Math.min(anchor.left, window.innerWidth - menu.offsetWidth - 8)))}px`
    button.setAttribute('aria-expanded', 'true')
    // Opening the menu is the moment to look again: a Workspace made or
    // joined outside the app (a terminal) has announced nothing.
    void workspaceScope.refresh()
  }

  button.addEventListener('click', () => openMenu())

  workspaceScope.subscribe((next) => {
    state = next
    paint(next)
    refillOpenMenu?.(next)
  })

  return wrap
}

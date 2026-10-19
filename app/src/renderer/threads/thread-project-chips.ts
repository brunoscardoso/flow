/**
 * The open thread's projects, as chips above the composer (Workspaces Phase 9).
 *
 *   · its own project first — not removable, it is where the thread lives
 *   · every project it carries beyond that — added by its first message (the
 *     context gate) or by the person — each with a ×
 *   · "+" — add any project of the Workspace that has a checkout here
 *   · an offer from a later message — "Add Backend?" with the reason, accepted
 *     or put away in one press; nothing is attached until accepted
 *
 * Adding or removing is the ordinary attach (`threads:setRoots`): the agent
 * reads the new set on its next turn. Doing it before the thread's first turn
 * is a hand-pick, and the first send then says so (`skipContextGate`).
 *
 * Shown only while Workspaces are on and the thread's project is in one; every
 * other thread sees exactly the composer it always had. Decisions live in
 * `thread-project-chips-model.ts`. No thread or task broadcast is subscribed to
 * here — the conversation column already re-reads the open thread when one
 * touches it and hands the fresh summary in (`setThread`).
 */

import type { ThreadSummary } from '../../shared/ipc-contract'
import type { ThreadContextOfferEvent } from '../../shared/workspaces-contract'
import { workspaceScope, type WorkspaceScopeState } from './workspace-scope'
import {
  ADD_PROJECT_LABEL,
  NOTHING_TO_ADD,
  addableProjects,
  chipsVisible,
  offerChip,
  rootsAfterAdd,
  rootsAfterRemove,
  skipGateOnSend,
  threadProjectChips,
} from './thread-project-chips-model'
import { attachMenuKeyboard, restoreFocusAfterAction } from '../menu-keyboard'
import type { BasicDiscoveryStatus } from '../../shared/basic-discovery'

export interface ThreadProjectChips {
  element: HTMLElement
  /** The open thread (or none). A fresh summary for the same thread re-renders it. */
  setThread(thread: ThreadSummary | null): void
  /** Whether the next send of `thread` carries the hand-pick. */
  skipGate(thread: ThreadSummary): boolean
}

let stylesInjected = false

function injectStyles(): void {
  if (stylesInjected) return
  stylesInjected = true
  const style = document.createElement('style')
  style.dataset['flProjectChips'] = ''
  style.textContent = `
    .fl-project-chips {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--fl-space-xs);
      position: relative;
    }
    .fl-project-chips[hidden] { display: none; }
    .fl-project-chip { background: var(--fl-color-surface-raised); }
    .fl-project-chip.primary { background: var(--fl-color-accent-muted); }
    .fl-project-chip.offer { border-style: dashed; background: transparent; }
    /* Attached but not yet read by the agent: its basic discovery is running. */
    .fl-project-chip.learning { border-style: dashed; }
    .fl-project-chip-learning { flex: none; color: var(--fl-color-text-secondary); }
    /* The offer names its project in full; in a narrow column the REASON gives
     * way. Both are chip labels, which shrink alike — "Add fro…" hid the one
     * thing the person must read to decide. */
    .fl-project-chip.offer > .fl-composer-chip-label:first-child { flex: none; }
    .fl-project-chip-reason { flex: 1 1 auto; min-width: 0; color: var(--fl-color-text-secondary); }
    .fl-project-chip-accept {
      flex: none;
      padding: 0 var(--fl-space-xs);
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-accent);
      font: inherit;
      cursor: pointer;
    }
    .fl-project-chip-accept:hover { text-decoration: underline; }
    .fl-project-chip-add {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: var(--fl-border-width) dashed var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text-secondary);
      cursor: pointer;
    }
    .fl-project-chip-add:hover,
    .fl-project-chip-add:focus-visible { color: var(--fl-color-text); border-color: var(--fl-color-accent); }
    .fl-project-chip-menu {
      position: absolute;
      bottom: calc(100% + 4px);
      left: 0;
      z-index: 40;
      min-width: 200px;
      display: flex;
      flex-direction: column;
      padding: var(--fl-space-xs);
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
    }
    .fl-project-chip-menu button {
      padding: var(--fl-space-xs) var(--fl-space-sm);
      border: none;
      border-radius: var(--fl-radius-sm);
      background: transparent;
      color: var(--fl-color-text);
      font-family: var(--fl-font-ui);
      font-size: var(--fl-text-ui-size);
      text-align: left;
      cursor: pointer;
    }
    .fl-project-chip-menu button:hover,
    .fl-project-chip-menu button:focus-visible { background: var(--fl-color-accent-muted); }
    .fl-project-chip-menu-empty {
      padding: var(--fl-space-xs) var(--fl-space-sm);
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
    }
  `
  document.head.appendChild(style)
}

function notifyFailure(body: string): void {
  document.dispatchEvent(
    new CustomEvent('flow:notify', {
      detail: {
        kind: 'state-change',
        rootId: '',
        title: 'Projects not changed',
        body,
        timestamp: new Date().toISOString(),
        level: 'error',
      },
    }),
  )
}

export function createThreadProjectChips(): ThreadProjectChips {
  injectStyles()
  const element = document.createElement('div')
  element.className = 'fl-project-chips'
  element.hidden = true
  element.setAttribute('aria-label', 'Projects in this conversation')

  let thread: ThreadSummary | null = null
  let scope: WorkspaceScopeState | null = null
  /** Roots the gate added, per thread (from `threads:contextChosen`). */
  const gateAdded = new Map<string, Set<string>>()
  /** The pending offer, per thread. */
  const offers = new Map<string, ThreadContextOfferEvent>()
  /** Threads whose projects the person changed before their first turn. */
  const handPicked = new Set<string>()
  let closeMenu: (() => void) | null = null
  let busy = false
  /** Each project's basic-discovery status, as main last said (learn:basicDiscoveryChanged). */
  const discovery = new Map<string, BasicDiscoveryStatus>()
  /** The thread whose projects' statuses were last asked for. */
  let askedFor = ''

  const api = window.flow

  async function apply(roots: string[]): Promise<void> {
    const current = thread
    if (current === null || busy) return
    busy = true
    try {
      if (current.sdkSessionId === null) handPicked.add(current.id)
      const updated = await api.threads.setRoots({ threadId: current.id, roots })
      if (thread?.id === updated.id) {
        thread = updated
        askStatuses(updated)
        render()
      }
    } catch (error) {
      console.error('flow: could not change the conversation’s projects', error)
      notifyFailure('The conversation’s projects could not be changed. Try again in a moment.')
    } finally {
      busy = false
    }
  }

  function chip(text: string, className: string, title: string): HTMLSpanElement {
    const pill = document.createElement('span')
    pill.className = `fl-composer-chip fl-project-chip ${className}`.trim()
    pill.title = title
    const label = document.createElement('span')
    label.className = 'fl-composer-chip-label'
    label.textContent = text
    pill.appendChild(label)
    return pill
  }

  function dismissButton(label: string, onPress: () => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'fl-composer-chip-dismiss'
    button.setAttribute('aria-label', label)
    button.title = label
    const icon = document.createElement('fl-icon')
    icon.setAttribute('name', 'close')
    icon.setAttribute('size', '10')
    button.appendChild(icon)
    button.addEventListener('click', (event) => {
      event.stopPropagation()
      onPress()
    })
    return button
  }

  function openAddMenu(anchor: HTMLElement): void {
    if (closeMenu !== null) {
      closeMenu()
      return
    }
    const current = thread
    const state = scope
    if (current === null || state === null) return
    const workspace = workspaceScope.workspaceOf(current.projectRoot)
    const addable = addableProjects({
      workspace,
      thread: current,
      registeredRoot: (project) => (workspace === null ? null : workspaceScope.registeredRoot(workspace.slug, project.id)),
    })
    const menu = document.createElement('div')
    menu.className = 'fl-project-chip-menu'
    menu.setAttribute('role', 'menu')
    let detach: (() => void) | null = null
    const close = (): void => {
      menu.remove()
      detach?.()
      document.removeEventListener('mousedown', onDown, true)
      closeMenu = null
      menuThread = null
    }
    const onDown = (event: MouseEvent): void => {
      if (!menu.contains(event.target as Node) && event.target !== anchor) close()
    }
    if (addable.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'fl-project-chip-menu-empty'
      empty.textContent = NOTHING_TO_ADD
      menu.appendChild(empty)
    }
    for (const project of addable) {
      const item = document.createElement('button')
      item.type = 'button'
      item.textContent = project.name
      item.addEventListener('click', () => {
        close()
        // Choosing redraws the chips, "+" included, and the menu that held focus
        // is gone (#1300): hand the keyboard to the new "+", unless the person
        // has already moved on.
        void apply(rootsAfterAdd(current, project.root)).then(() =>
          restoreFocusAfterAction(() =>
            document.activeElement === null || document.activeElement === document.body
              ? element.querySelector<HTMLElement>('.fl-project-chip-add')
              : null,
          ),
        )
      })
      menu.appendChild(item)
    }
    element.appendChild(menu)
    document.addEventListener('mousedown', onDown, true)
    detach = attachMenuKeyboard(menu, { close, anchor, stopPropagation: true })
    closeMenu = close
    menuThread = current.id
  }

  /** What the chips last drew — a re-render that would draw the same is skipped. */
  let drawn = ''
  /** The thread the open "+" menu was opened for. */
  let menuThread: string | null = null

  function render(): void {
    const current = thread
    const state = scope
    const inWorkspace =
      current !== null && state !== null && typeof state.membership.get(current.projectRoot) === 'string'
    const visible = chipsVisible({
      inWorkspace,
      hasThread: current !== null,
    })
    const chips =
      visible && current !== null
        ? threadProjectChips({
            thread: current,
            gateAdded: gateAdded.get(current.id) ?? new Set(),
            name: (root) => workspaceScope.nameOf(root),
            status: (root) => discovery.get(root) ?? null,
          })
        : []
    const offerNow = current === null ? null : offerChip(offers.get(current.id) ?? null, current.id, current)
    // EVERY SCOPE CHANGE CALLS THIS — a sync status, a membership read — and
    // most change nothing drawn here. Redrawing anyway closed the open "+" menu
    // under the person's pointer (live: a finished turn's sync closed it).
    const signature = JSON.stringify({ visible, thread: current?.id ?? null, chips, offer: offerNow, addable: addableSignature(current) })
    if (signature === drawn) return
    drawn = signature
    // Drawn again — the menu is rebuilt for the same thread, not dropped.
    const reopenMenu = closeMenu !== null && current !== null && menuThread === current.id
    // A chip's own button (remove, Add, dismiss) is destroyed by the redraw it
    // caused, which would leave the keyboard on <body> (#1300).
    const hadFocus = element.contains(document.activeElement)
    closeMenu?.()
    element.hidden = !visible
    element.replaceChildren()
    if (!visible || current === null) return
    for (const entry of chips) {
      const pill = chip(entry.name, `${entry.source}${entry.learning === null ? '' : ' learning'}`, entry.title)
      pill.dataset['root'] = entry.root
      if (entry.learning !== null) {
        const learning = document.createElement('span')
        learning.className = 'fl-composer-chip-label fl-project-chip-learning'
        learning.textContent = entry.learning
        pill.appendChild(learning)
      }
      if (entry.removable) {
        pill.appendChild(
          dismissButton(`Remove ${entry.name} from this conversation`, () => {
            void apply(rootsAfterRemove(current, entry.root))
          }),
        )
      }
      element.appendChild(pill)
    }
    const offer = offerNow
    if (offer !== null) {
      const pill = chip(offer.label, 'offer', offer.reason)
      const reason = document.createElement('span')
      reason.className = 'fl-composer-chip-label fl-project-chip-reason'
      reason.textContent = offer.reason
      pill.appendChild(reason)
      const accept = document.createElement('button')
      accept.type = 'button'
      accept.className = 'fl-project-chip-accept'
      accept.textContent = 'Add'
      accept.setAttribute('aria-label', offer.acceptLabel)
      accept.addEventListener('click', () => {
        offers.delete(current.id)
        void apply(rootsAfterAdd(current, offer.root))
      })
      pill.appendChild(accept)
      pill.appendChild(
        dismissButton(offer.dismissLabel, () => {
          offers.delete(current.id)
          render()
        }),
      )
      element.appendChild(pill)
    }
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'fl-project-chip-add'
    add.setAttribute('aria-label', ADD_PROJECT_LABEL)
    add.title = ADD_PROJECT_LABEL
    const plus = document.createElement('fl-icon')
    plus.setAttribute('name', 'plus')
    plus.setAttribute('size', '12')
    add.appendChild(plus)
    add.addEventListener('click', () => openAddMenu(add))
    element.appendChild(add)
    if (hadFocus && !element.contains(document.activeElement)) add.focus()
    if (reopenMenu) openAddMenu(add)
  }

  /** What the "+" menu would offer for `current` — part of what a redraw compares. */
  function addableSignature(current: ThreadSummary | null): string[] {
    if (current === null) return []
    const workspace = workspaceScope.workspaceOf(current.projectRoot)
    return addableProjects({
      workspace,
      thread: current,
      registeredRoot: (project) => (workspace === null ? null : workspaceScope.registeredRoot(workspace.slug, project.id)),
    }).map((project) => project.root)
  }

  workspaceScope.subscribe((state) => {
    scope = state
    render()
  })

  api.threads.onContextChosen?.((event) => {
    const roots = gateAdded.get(event.threadId) ?? new Set<string>()
    for (const project of event.added) roots.add(project.root)
    gateAdded.set(event.threadId, roots)
    if (thread?.id !== event.threadId) return
    // The gate attached before the session started — read the thread again so
    // its chips show what the agent will actually read.
    void api.threads
      .get({ threadId: event.threadId })
      .then((fresh) => {
        if (fresh !== null && thread?.id === fresh.id) {
          thread = fresh
          render()
        }
      })
      .catch((error: unknown) => console.warn('flow: could not re-read the conversation', error))
  })
  api.threads.onContextOffer?.((event) => {
    offers.set(event.threadId, event)
    if (thread?.id === event.threadId) render()
  })

  /** Ask main where this thread's projects stand — once per thread and project set. */
  function askStatuses(current: ThreadSummary | null): void {
    if (current === null) return
    const roots = [current.projectRoot, ...current.additionalRoots]
    const key = `${current.id}\u0000${roots.join('\u0000')}`
    if (key === askedFor) return
    askedFor = key
    void api.learn
      .basicDiscoveryState?.({ roots })
      .then((answer) => {
        let changed = false
        for (const [root, status] of Object.entries(answer)) {
          if (discovery.get(root) === status) continue
          discovery.set(root, status)
          changed = true
        }
        if (changed) render()
      })
      .catch((error: unknown) => console.warn('flow: could not read the projects’ learning state', error))
  }

  api.learn.onBasicDiscoveryChanged?.(({ rootId, status }) => {
    discovery.set(rootId, status)
    const current = thread
    if (current !== null && [current.projectRoot, ...current.additionalRoots].includes(rootId)) render()
  })

  return {
    element,
    setThread(next) {
      thread = next
      askStatuses(next)
      render()
    },
    skipGate(target) {
      return skipGateOnSend({ handPicked: handPicked.has(target.id), hasStarted: target.sdkSessionId !== null })
    },
  }
}

/**
 * The composer's connectors chip and the chat's connector list
 * (plan_connectors, Phase 6, FR-2/3).
 *
 * A chip after the autopilot chip: up to three overlapping connector icons,
 * "<N> connectors", and a small warning dot when a connector that is on needs
 * sign-in or is not working. Pressing it opens "Connectors for this chat"
 * above it: a filter, rows grouped by where each connector comes from, a
 * switch per row (or Sign in, or a "Not working" pill), and Manage connectors,
 * which opens Settings at the Connectors group.
 *
 * Two modes, one view:
 *   - thread: a switch writes the chat's choice at once (`setForThread`);
 *   - draft:  the new-chat page keeps the names switched off and hands them
 *             over (`draftOff`) to be written once the chat exists.
 *
 * Every decision is in `connector-chip-model.ts`; this file only draws it. The
 * list comes from the one store (`connector-store.ts`) and is re-read on open,
 * and on `connectors:changed` only while the chip is on screen
 * (allowed-pattern #17). The chip is hidden when the project has no
 * connectors, and when the chat's runtime is not Claude (the per-chat list is
 * Claude-only).
 */
import '../components'
import type { ConnectorChangeEvent, ConnectorListAnswer } from '../../shared/connectors'
import { openAnchoredPopover, type AnchoredPopover } from './anchored-popover'
import {
  changeConcerns,
  connectorChipView,
  onOfTotal,
  emptySentence,
  signInOutcomeSentence,
  type ConnectorChipRow,
  type ConnectorChipView,
  type ConnectorScopeKey,
} from './connector-chip-model'
import { connectorIconLoader, createConnectorIcon } from './connector-icon'
import { connectorStore, isOnScreen } from './connector-store'

export interface ConnectorChipOptions {
  mode: 'thread' | 'draft'
  /** The host's own chip class, so the chip sits in its row like its neighbours. */
  className: string
}

export interface ConnectorChipHandle {
  readonly element: HTMLButtonElement
  /** The project (and chat) the chip is about; null hides it. */
  setScope(scope: ConnectorScopeKey | null): void
  /** False hides the chip (the runtime has no per-chat connector list). */
  setAvailable(available: boolean): void
  /** draft mode: the listed names switched off on this page. */
  draftOff(): string[]
  /** draft mode: every connector on again (a fresh page). */
  resetDraft(): void
  dispose(): void
}

/** A row's sign-in in progress, or how it last ended. */
type SignInState =
  | { kind: 'waiting' }
  | { kind: 'finish-in-browser' }
  | { kind: 'error'; sentence: string }

const SETTINGS_EVENT = 'flow:open-settings'

export function createConnectorChip(options: ConnectorChipOptions): ConnectorChipHandle {
  injectConnectorChipStyles()
  const { mode } = options

  const element = document.createElement('button')
  element.type = 'button'
  element.className = `${options.className} fl-connector-chip`
  element.hidden = true
  element.setAttribute('aria-haspopup', 'dialog')
  const iconsBox = document.createElement('span')
  iconsBox.className = 'fl-connector-chip-icons'
  const label = document.createElement('span')
  label.className = 'fl-connector-chip-label'
  const dot = document.createElement('span')
  dot.className = 'fl-connector-chip-dot'
  dot.hidden = true
  element.append(iconsBox, label, dot)

  let scope: ConnectorScopeKey | null = null
  let available = false
  let answer: ConnectorListAnswer | null = null
  let drawnIcons = ''
  const draft = new Set<string>()
  const signIns = new Map<string, SignInState>()
  const busy = new Set<string>()
  let problem: string | null = null
  let popover: AnchoredPopover | null = null
  let panelParts: { count: HTMLElement; filter: HTMLInputElement; list: HTMLElement; problem: HTMLElement } | null = null

  const view = (): ConnectorChipView =>
    connectorChipView({
      entries: answer?.entries ?? [],
      mode,
      draftOff: draft,
      filter: panelParts?.filter.value ?? '',
    })

  const sameScope = (a: ConnectorScopeKey | null, b: ConnectorScopeKey | null): boolean =>
    a?.projectRoot === b?.projectRoot && a?.threadId === b?.threadId

  const paintChip = (): void => {
    const current = view()
    const show = available && scope !== null && current.visible
    element.hidden = !show
    if (!show) {
      popover?.close()
      return
    }
    label.textContent = current.label
    dot.hidden = !current.attention
    element.title = current.attention
      ? `${onOfTotal(current)}. A connector needs your attention.`
      : `${onOfTotal(current)} for this chat`
    element.setAttribute('aria-label', `Connectors: ${current.label}${current.attention ? ', one needs your attention' : ''}`)
    const key = current.icons.map((icon) => icon.name).join('\u0000')
    if (key !== drawnIcons) {
      drawnIcons = key
      iconsBox.replaceChildren()
      const load = connectorIconLoader()
      for (const icon of current.icons) {
        iconsBox.appendChild(
          createConnectorIcon({ name: icon.name, displayName: icon.displayName, size: 16, ...(load !== undefined ? { load } : {}) }),
        )
      }
    }
    iconsBox.hidden = current.icons.length === 0
  }

  const paint = (): void => {
    paintChip()
    paintPanel()
  }

  /** Read the list for the current scope; `force` skips a still-good cache. */
  const load = async (force: boolean): Promise<void> => {
    const asked = scope
    if (asked === null || !available) return
    const read = force ? connectorStore.refresh(asked) : connectorStore.ensure(asked)
    const next = await read
    if (!sameScope(asked, scope)) return
    answer = next
    paint()
  }

  // ── The popover ─────────────────────────────────────────────────────────

  const open = (): void => {
    if (popover !== null || scope === null) return
    popover = openAnchoredPopover({
      anchor: element,
      className: 'fl-connector-menu',
      ariaLabel: 'Connectors for this chat',
      onClose: () => {
        popover = null
        panelParts = null
        problem = null
      },
    })
    const panel = popover.panel

    const head = document.createElement('div')
    head.className = 'fl-connector-menu-head'
    const title = document.createElement('span')
    title.className = 'fl-connector-menu-title'
    title.textContent = 'Connectors for this chat'
    const count = document.createElement('span')
    count.className = 'fl-connector-menu-count'
    head.append(title, count)

    const filter = document.createElement('input')
    filter.type = 'search'
    filter.className = 'fl-connector-menu-filter'
    filter.placeholder = 'Filter connectors'
    filter.setAttribute('aria-label', 'Filter connectors')
    filter.addEventListener('input', () => paintPanel())

    const problemLine = document.createElement('p')
    problemLine.className = 'fl-connector-menu-problem'
    problemLine.hidden = true

    const list = document.createElement('div')
    list.className = 'fl-connector-menu-list'

    const foot = document.createElement('div')
    foot.className = 'fl-connector-menu-foot'
    const note = document.createElement('span')
    note.className = 'fl-connector-menu-note'
    note.textContent = 'Off here stays on for other chats.'
    const manage = document.createElement('fl-button')
    manage.setAttribute('small', '')
    const manageLabel = document.createElement('span')
    manageLabel.textContent = 'Manage connectors'
    manage.appendChild(manageLabel)
    manage.addEventListener('click', () => {
      popover?.close()
      document.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: { group: 'connectors' } }))
    })
    foot.append(note, manage)

    panel.append(head, filter, problemLine, list, foot)
    panelParts = { count, filter, list, problem: problemLine }
    paintPanel()
    filter.focus()
    // Opening the list is the moment its status matters: read it fresh.
    void load(true)
  }

  element.addEventListener('click', () => {
    if (popover !== null) popover.close()
    else open()
  })

  const paintPanel = (): void => {
    if (panelParts === null || popover === null) return
    const current = view()
    panelParts.count.textContent = onOfTotal(current)
    const sentence = problem ?? answer?.error ?? null
    panelParts.problem.hidden = sentence === null
    panelParts.problem.textContent = sentence ?? ''
    panelParts.list.replaceChildren()
    if (current.noMatch) {
      const none = document.createElement('p')
      none.className = 'fl-connector-menu-empty'
      none.textContent = 'No connector matches that.'
      panelParts.list.appendChild(none)
    }
    const loadIcon = connectorIconLoader()
    for (const group of current.groups) {
      const heading = document.createElement('div')
      heading.className = 'fl-connector-menu-group'
      heading.textContent = group.label
      panelParts.list.appendChild(heading)
      for (const row of group.rows) panelParts.list.appendChild(rowElement(row, loadIcon))
    }
    const hiddenLine = emptySentence(current)
    if (hiddenLine !== null) {
      const more = document.createElement('p')
      more.className = 'fl-connector-menu-empty'
      more.textContent = hiddenLine
      panelParts.list.appendChild(more)
    }
    popover.reposition()
  }

  const rowElement = (row: ConnectorChipRow, loadIcon: ReturnType<typeof connectorIconLoader>): HTMLElement => {
    const box = document.createElement('div')
    box.className = 'fl-connector-row'
    box.appendChild(
      createConnectorIcon({ name: row.name, displayName: row.displayName, size: 22, ...(loadIcon !== undefined ? { load: loadIcon } : {}) }),
    )
    const text = document.createElement('div')
    text.className = 'fl-connector-row-text'
    const name = document.createElement('span')
    name.className = 'fl-connector-row-name'
    name.textContent = row.displayName
    const detail = document.createElement('span')
    detail.className = 'fl-connector-row-detail'
    const state = signIns.get(row.name)
    detail.textContent =
      state?.kind === 'waiting'
        ? 'Finish signing in in your browser.'
        : state?.kind === 'finish-in-browser'
          ? 'Finish signing in on Claude.ai, then check again.'
          : state?.kind === 'error'
            ? state.sentence
            : row.detail
    detail.classList.toggle('is-error', state?.kind === 'error')
    detail.title = detail.textContent
    text.append(name, detail)
    box.appendChild(text)
    box.appendChild(controlElement(row, state))
    return box
  }

  const controlElement = (row: ConnectorChipRow, state: SignInState | undefined): HTMLElement => {
    if (row.control === 'not-working') {
      const pill = document.createElement('span')
      pill.className = 'fl-connector-pill'
      pill.textContent = 'Not working'
      pill.title = row.detail
      return pill
    }
    if (row.control === 'sign-in') {
      const button = document.createElement('fl-button')
      button.setAttribute('small', '')
      const text = document.createElement('span')
      if (state?.kind === 'waiting') {
        text.textContent = 'Waiting'
        button.setAttribute('disabled', '')
      } else if (state?.kind === 'finish-in-browser') {
        text.textContent = 'Check again'
        button.addEventListener('click', () => void checkAgain(row))
      } else {
        text.textContent = 'Sign in'
        button.addEventListener('click', () => void signIn(row))
      }
      button.appendChild(text)
      return button
    }
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'fl-connector-switch'
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-checked', String(row.on))
    toggle.setAttribute('aria-label', `${row.displayName} for this chat`)
    toggle.classList.toggle('is-on', row.on)
    toggle.disabled = !row.toggleable || busy.has(row.name)
    if (!row.toggleable) toggle.title = row.detail
    toggle.addEventListener('click', () => void flip(row))
    return toggle
  }

  // ── Actions ─────────────────────────────────────────────────────────────

  const flip = async (row: ConnectorChipRow): Promise<void> => {
    if (!row.toggleable || busy.has(row.name)) return
    problem = null
    if (mode === 'draft') {
      if (row.on) draft.add(row.name)
      else draft.delete(row.name)
      paint()
      return
    }
    const threadId = scope?.threadId
    const api = window.flow?.connectors
    if (threadId === undefined || api === undefined) return
    busy.add(row.name)
    paintPanel()
    try {
      const result = await api.setForThread({ threadId, name: row.name, on: !row.on })
      if (!result.ok) problem = result.reason
    } catch (error) {
      console.error('flow: turning a connector on or off failed', error)
      problem = `${row.displayName} could not be changed for this chat. Try again.`
    }
    busy.delete(row.name)
    await load(true)
    paint()
  }

  const signIn = async (row: ConnectorChipRow): Promise<void> => {
    const asked = scope
    const api = window.flow?.connectors
    if (asked === null || api === undefined) return
    signIns.set(row.name, { kind: 'waiting' })
    paintPanel()
    let result: Awaited<ReturnType<typeof api.signIn>>
    try {
      result = await api.signIn({
        projectRoot: asked.projectRoot,
        name: row.name,
        ...(asked.threadId !== undefined ? { threadId: asked.threadId } : {}),
      })
    } catch (error) {
      console.error('flow: starting a connector sign-in failed', error)
      result = { ok: false, reason: `Signing in to ${row.displayName} could not be started. Try again.` }
    }
    if (!result.ok) signIns.set(row.name, { kind: 'error', sentence: result.reason })
    else if (result.state === 'connected') {
      signIns.delete(row.name)
      await load(true)
    } else if (result.state === 'finish-in-browser') signIns.set(row.name, { kind: 'finish-in-browser' })
    // `waiting` stays until `connectors:changed` says how the sign-in ended.
    paint()
  }

  const checkAgain = async (row: ConnectorChipRow): Promise<void> => {
    const asked = scope
    const api = window.flow?.connectors
    if (asked === null || api === undefined) return
    signIns.delete(row.name)
    try {
      const result = await api.reconnect({
        projectRoot: asked.projectRoot,
        name: row.name,
        ...(asked.threadId !== undefined ? { threadId: asked.threadId } : {}),
      })
      if (!result.ok) signIns.set(row.name, { kind: 'error', sentence: result.reason })
    } catch (error) {
      console.error('flow: retrying a connector failed', error)
    }
    await load(true)
    paint()
  }

  // ── Changes ─────────────────────────────────────────────────────────────

  const onChange = (event: ConnectorChangeEvent): void => {
    if (scope === null || !changeConcerns(event, scope)) return
    if (event.signIn !== undefined && signIns.has(event.signIn.name)) {
      const entry = answer?.entries.find((candidate) => candidate.name === event.signIn?.name)
      const sentence = signInOutcomeSentence(entry?.displayName ?? event.signIn.name, event.signIn.outcome)
      if (sentence === null) signIns.delete(event.signIn.name)
      else signIns.set(event.signIn.name, { kind: 'error', sentence })
      paintPanel()
    }
    // Off screen the store has marked the list stale; the next open or scope
    // change reads it. Nothing is fetched for a chip nobody can see.
    if (popover !== null || isOnScreen(element)) void load(true)
  }
  const unsubscribe = connectorStore.subscribe(onChange)

  return {
    element,
    setScope(next) {
      if (sameScope(next, scope)) return
      scope = next
      answer = next === null ? null : (connectorStore.get(next) ?? null)
      signIns.clear()
      busy.clear()
      problem = null
      popover?.close()
      if (mode === 'thread') connectorStore.setActive(next)
      paint()
      void load(false)
    },
    setAvailable(next) {
      if (next === available) return
      available = next
      paint()
      if (available) void load(false)
    },
    draftOff() {
      const listed = new Set((answer?.entries ?? []).map((entry) => entry.name))
      return [...draft].filter((name) => listed.has(name))
    },
    resetDraft() {
      draft.clear()
      paint()
    },
    dispose() {
      unsubscribe()
      popover?.close()
    },
  }
}

// ── Styles (light DOM) ─────────────────────────────────────────────────────
// An array of lines, not a template literal: a backtick inside one breaks this
// repo's build with a misleading parse error.

let connectorChipStylesInjected = false

function injectConnectorChipStyles(): void {
  if (connectorChipStylesInjected) return
  connectorChipStylesInjected = true
  const style = document.createElement('style')
  style.textContent = [
    '.fl-connector-chip { display: inline-flex; align-items: center; gap: var(--fl-space-xs); }',
    '.fl-connector-chip[hidden] { display: none; }',
    '.fl-connector-chip-icons { display: inline-flex; align-items: center; }',
    '.fl-connector-chip-icons[hidden] { display: none; }',
    /* Overlapping, each ringed in the composer ground so the edges read. */
    '.fl-connector-chip-icons .fl-connector-icon { box-shadow: 0 0 0 1.5px var(--fl-color-bg); }',
    '.fl-connector-chip-icons .fl-connector-icon + .fl-connector-icon { margin-left: -5px; }',
    '.fl-connector-chip-dot {',
    '  width: 6px;',
    '  height: 6px;',
    '  border-radius: 50%;',
    '  background: var(--fl-color-warning);',
    '  flex: none;',
    '}',
    '.fl-connector-chip-dot[hidden] { display: none; }',
    '.fl-connector-menu {',
    '  width: min(340px, calc(100vw - var(--fl-space-xl)));',
    '  display: flex;',
    '  flex-direction: column;',
    '  gap: var(--fl-space-sm);',
    '  padding: var(--fl-space-md);',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-md);',
    '  background: var(--fl-color-surface);',
    '  box-shadow: var(--fl-shadow-md);',
    '  font-family: var(--fl-font-ui);',
    '  font-size: var(--fl-text-ui-size);',
    '  color: var(--fl-color-text);',
    '  max-height: 70vh;',
    '  box-sizing: border-box;',
    '}',
    '.fl-connector-menu:focus { outline: none; }',
    '.fl-connector-menu-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--fl-space-sm); }',
    '.fl-connector-menu-title { font-weight: var(--fl-text-ui-weight-medium); }',
    '.fl-connector-menu-count { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); white-space: nowrap; }',
    '.fl-connector-menu-filter {',
    '  width: 100%;',
    '  box-sizing: border-box;',
    '  padding: var(--fl-space-xs) var(--fl-space-sm);',
    '  border: var(--fl-border-width) solid var(--fl-color-border);',
    '  border-radius: var(--fl-radius-sm);',
    '  background: var(--fl-color-surface-raised);',
    '  color: var(--fl-color-text);',
    '  font-family: var(--fl-font-ui);',
    '  font-size: var(--fl-text-ui-size);',
    '}',
    '.fl-connector-menu-filter:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 1px; }',
    '.fl-connector-menu-problem, .fl-connector-menu-empty {',
    '  margin: 0;',
    '  font-size: var(--fl-text-caption-size);',
    '  line-height: var(--fl-line-height-dense);',
    '}',
    '.fl-connector-menu-problem { color: var(--fl-color-error); }',
    '.fl-connector-menu-problem[hidden] { display: none; }',
    '.fl-connector-menu-empty { color: var(--fl-color-text-secondary); }',
    '.fl-connector-menu-list { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; min-height: 0; }',
    '.fl-connector-menu-group {',
    '  margin-top: var(--fl-space-xs);',
    '  padding: 0 var(--fl-space-xs);',
    '  font-size: 11px;',
    '  font-weight: var(--fl-text-ui-weight-medium);',
    '  letter-spacing: 0.04em;',
    '  text-transform: uppercase;',
    '  color: var(--fl-color-text-secondary);',
    '}',
    '.fl-connector-row {',
    '  display: flex;',
    '  align-items: center;',
    '  gap: var(--fl-space-sm);',
    '  padding: var(--fl-space-xs);',
    '  border-radius: var(--fl-radius-row);',
    '}',
    '.fl-connector-row:hover { background: var(--fl-color-surface-raised); }',
    '.fl-connector-row-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }',
    '.fl-connector-row-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.fl-connector-row-detail {',
    '  font-size: var(--fl-text-caption-size);',
    '  color: var(--fl-color-text-secondary);',
    '  white-space: nowrap;',
    '  overflow: hidden;',
    '  text-overflow: ellipsis;',
    '}',
    '.fl-connector-row-detail.is-error { color: var(--fl-color-error); }',
    '.fl-connector-pill {',
    '  flex: none;',
    '  display: inline-flex;',
    '  align-items: center;',
    '  gap: 4px;',
    '  padding: 1px var(--fl-space-sm);',
    '  border-radius: 999px;',
    '  font-size: var(--fl-text-caption-size);',
    '  color: var(--fl-color-error);',
    '  border: var(--fl-border-width) solid var(--fl-color-error);',
    '  white-space: nowrap;',
    '}',
    '.fl-connector-switch {',
    '  flex: none;',
    '  position: relative;',
    '  width: 28px;',
    '  height: 16px;',
    '  padding: 0;',
    '  border: none;',
    '  border-radius: 999px;',
    '  background: var(--fl-color-surface-selected);',
    '  cursor: pointer;',
    '}',
    '.fl-connector-switch::after {',
    "  content: '';",
    '  position: absolute;',
    '  top: 2px;',
    '  left: 2px;',
    '  width: 12px;',
    '  height: 12px;',
    '  border-radius: 50%;',
    '  background: var(--fl-color-bg);',
    '  transition: transform 120ms ease;',
    '}',
    '.fl-connector-switch.is-on { background: var(--fl-color-accent); }',
    '.fl-connector-switch.is-on::after { transform: translateX(12px); }',
    '.fl-connector-switch:disabled { opacity: 0.5; cursor: default; }',
    '.fl-connector-switch:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 1px; }',
    '.fl-connector-menu-foot {',
    '  display: flex;',
    '  align-items: center;',
    '  justify-content: space-between;',
    '  gap: var(--fl-space-sm);',
    '  padding-top: var(--fl-space-sm);',
    '  border-top: var(--fl-border-width) solid var(--fl-color-border);',
    '}',
    '.fl-connector-menu-note { font-size: var(--fl-text-caption-size); color: var(--fl-color-text-secondary); }',
  ].join('\n')
  document.head.appendChild(style)
}

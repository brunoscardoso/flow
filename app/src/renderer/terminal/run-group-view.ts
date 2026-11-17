/**
 * THE LAUNCHPAD — the pill at the start of the terminal tab bar ("Launchpad ▾",
 * with Reload all and Stop all beside it once running steps have started), or
 * a dashed "Set up Launchpad" before a setup exists, which opens the setup
 * page straight away with one empty step (the page carries the suggestions
 * and "Ask the agent to set it up").
 *
 * "Launchpad ▾" opens a menu: the conversation's one-time actions grouped by
 * project (each runs once, in its own tab — after an ask when it asks first),
 * then "Run all running steps" and "Edit Launchpad".
 *
 * The scope is the conversation on screen (the terminal panel's owner scope):
 * its project and its thread. Main owns every Run (allowed-pattern #14) — this
 * sends intents and draws what main reports.
 *
 * Cost (allowed-pattern #17, forbidden-pattern #14): `run:updated` fires on
 * transitions only, and an update for another scope is dropped at once. An
 * update for this scope is folded in without any IPC; the setup is re-read
 * (one `run:get`) only when the panel is on screen — an off-screen panel marks
 * itself stale and re-reads on the way back in.
 */
import type { FlowApi } from '../../shared/ipc-contract'
import {
  runScopeKey,
  type RunGroupState,
  type RunScope,
  type RunSuggestion,
  type RunView,
} from '../../shared/run-setup'
import { markModalOverlay } from '../modal-overlay'
import { baseName } from '../project-label'
import {
  askAgentPrompt,
  launchpadMenu,
  launchpadMenuEntries,
  moveMenuFocus,
  onceAsk,
  pendingTabAction,
  pillFace,
  RUN_STRINGS,
  type LaunchpadMenuEntry,
  type RunDotTone,
} from './run-group-model'
import { RunSetupPanel } from './run-setup-panel'

export interface RunGroupDeps {
  api: FlowApi
  /** The terminal area the setup panel docks in (positioned). */
  dock: HTMLElement
  /** True while the terminal panel is on screen. */
  isOnScreen(): boolean
  /** The group's state moved — the tab strip re-renders. */
  onChange(): void
  /** Show a terminal's tab (now, or as soon as it arrives). */
  focusTerminal(terminalId: string): void
}

/** The colour token for each dot tone — Flow's existing status colours. */
export const RUN_TONE_COLOR: Record<RunDotTone, string> = {
  ok: 'var(--fl-color-success)',
  busy: 'var(--fl-color-warning)',
  bad: 'var(--fl-color-error)',
  off: 'var(--fl-color-text-secondary)',
}

function icon(name: string, size: string): HTMLElement {
  const glyph = document.createElement('fl-icon')
  glyph.setAttribute('name', name)
  glyph.setAttribute('size', size)
  return glyph
}

export class RunGroupView {
  /** Goes before the tab strip in the terminal header. */
  readonly element: HTMLElement
  readonly #deps: RunGroupDeps
  #scope: RunScope | null = null
  #view: RunView | null = null
  #stale = true
  #seq = 0
  #inflight = false
  #suggestions: RunSuggestion[] | null = null
  readonly #panel: RunSetupPanel
  /** The open Launchpad menu, and how to close it. */
  #menu: { element: HTMLElement; close: () => void } | null = null
  /** The open ask before a one-time action runs. */
  #ask: { close: () => void } | null = null

  constructor(deps: RunGroupDeps) {
    injectRunStyles()
    this.#deps = deps
    this.element = document.createElement('div')
    this.element.className = 'fl-run-group'
    this.element.hidden = true
    this.#panel = new RunSetupPanel({
      host: deps.dock,
      save: (change) => {
        const run = deps.api.run
        if (run === undefined || this.#scope === null) {
          return Promise.resolve({ ok: false as const, reason: RUN_STRINGS.failedToAct })
        }
        return run.save({ scope: this.#scope, change })
      },
      state: () => this.#view?.state ?? null,
      startRun: () => this.#act((run, scope) => run.start({ scope })),
      askAgent: () => this.#askAgent(),
      onSaved: (view) => this.#setView(view),
      onClosed: () => this.#renderPill(),
    })
    deps.api.run?.onUpdated((state) => this.#onUpdated(state))
  }

  /** The group's state, for the tab strip; null when there is no Run here. */
  get state(): RunGroupState | null {
    return this.#view?.state ?? null
  }

  /** The conversation on screen changed (or there is none). */
  setScope(scope: RunScope | null): void {
    const same =
      scope !== null && this.#scope !== null && scope.rootPath === this.#scope.rootPath && scope.threadId === this.#scope.threadId
    if (same || (scope === null && this.#scope === null)) return
    this.#scope = scope === null ? null : { rootPath: scope.rootPath, threadId: scope.threadId }
    this.#view = null
    this.#suggestions = null
    this.#stale = true
    this.#inflight = false
    this.#seq += 1
    this.#closeMenu()
    this.#ask?.close()
    if (this.#panel.isOpen) this.#panel.close()
    this.#renderPill()
    this.#deps.onChange()
    this.#refresh()
  }

  /** The panel came on screen: pay any read owed while it was hidden. */
  shown(): void {
    if (this.#stale) this.#refresh()
  }

  /** A step tab with no terminal was clicked. */
  activatePending(stepKey: string): void {
    const state = this.state
    const step = state?.steps.find((candidate) => candidate.key === stepKey)
    if (state === null || step === undefined) return
    const action = pendingTabAction(step, state)
    if (action === 'start-run') this.#act((run, scope) => run.start({ scope }))
    else if (action === 'reload-step') this.#act((run, scope) => run.reload({ scope, stepKey }))
  }

  /** Reload one step (its tab's Reload). A blocked step starts anyway. */
  reloadStep(stepKey: string): void {
    this.#act((run, scope) => run.reload({ scope, stepKey }))
  }

  // ─── reading ───────────────────────────────────────────────────────────────

  #matches(scopeKey: string): boolean {
    if (this.#scope === null) return false
    return (
      scopeKey === this.#view?.state.scopeKey ||
      scopeKey === this.#view?.resolution.scopeKey ||
      scopeKey === runScopeKey(this.#scope)
    )
  }

  #refresh(): void {
    const run = this.#deps.api.run
    const scope = this.#scope
    if (run === undefined || scope === null) return
    if (!this.#deps.isOnScreen()) {
      this.#stale = true
      return
    }
    const seq = ++this.#seq
    this.#stale = false
    this.#inflight = true
    run
      .get({ scope })
      .then((view) => {
        if (seq === this.#seq) this.#setView(view)
      })
      .catch((error: unknown) => {
        if (seq !== this.#seq) return
        console.warn('flow: could not read the Launchpad', error)
        this.#stale = true
      })
      .finally(() => {
        if (seq === this.#seq) this.#inflight = false
      })
  }

  #setView(view: RunView): void {
    this.#view = view
    this.#renderPill()
    this.#deps.onChange()
    if (this.#panel.isOpen) this.#panel.setView(view)
  }

  #onUpdated(state: RunGroupState): void {
    if (!this.#matches(state.scopeKey)) return // another scope — nothing here draws it
    const view = this.#view
    if (view === null) {
      if (!this.#inflight) this.#refresh()
      return
    }
    this.#view = { ...view, state }
    this.#renderPill()
    this.#deps.onChange()
    this.#panel.stateChanged()
    // A step main knows and this setup does not: the setup changed elsewhere.
    const known = new Set(view.resolution.steps.map((step) => step.key))
    if (!this.#inflight && state.steps.some((step) => !known.has(step.key))) this.#refresh()
  }

  // ─── acting ────────────────────────────────────────────────────────────────

  #act(
    intent: (run: NonNullable<FlowApi['run']>, scope: RunScope) => Promise<RunGroupState>,
    options: { failure?: string; then?: (state: RunGroupState) => void } = {},
  ): void {
    const run = this.#deps.api.run
    const scope = this.#scope
    if (run === undefined || scope === null) return
    intent(run, scope)
      .then((state) => {
        this.#onUpdated(state)
        options.then?.(state)
      })
      .catch((error: unknown) => {
        console.warn('flow: a Launchpad request failed', error)
        document.dispatchEvent(
          new CustomEvent('flow:notify', {
            detail: {
              kind: 'state-change',
              rootId: scope.rootPath,
              title: RUN_STRINGS.launchpad,
              body: options.failure ?? RUN_STRINGS.failedToAct,
              timestamp: new Date().toISOString(),
              level: 'error',
            },
          }),
        )
      })
  }

  // ─── one-time actions ──────────────────────────────────────────────────────

  /** A one-time action was pressed: ask first when it asks first, then run it. */
  #pressOnce(stepKey: string): void {
    const view = this.#view
    const step = view?.resolution.once?.find((candidate) => candidate.key === stepKey)
    if (view === null || step === undefined || step.unavailable !== undefined) return
    const live = view.state.once?.find((entry) => entry.key === stepKey)
    // Already running: show it; never a second copy (main refuses one too).
    if (live !== undefined && live.status === 'running' && live.terminalId !== null) {
      this.#deps.focusTerminal(live.terminalId)
      return
    }
    if (step.confirm === true) this.#openAsk(step)
    else this.#runOnce(stepKey)
  }

  #runOnce(stepKey: string): void {
    this.#act((run, scope) => run.once({ scope, stepKey }), {
      failure: RUN_STRINGS.failedToRunOnce,
      then: (state) => {
        const terminalId = state.once?.find((entry) => entry.key === stepKey)?.terminalId ?? null
        if (terminalId !== null) {
          this.#panel.tuck()
          this.#deps.focusTerminal(terminalId)
        }
      },
    })
  }

  /** The ask before a one-time action that asks first: Cancel, or Run (focused). */
  #openAsk(step: NonNullable<RunView['resolution']['once']>[number]): void {
    this.#ask?.close()
    const copy = onceAsk(step)
    const overlay = document.createElement('div')
    overlay.className = 'fl-run-ask-overlay'
    // A modal: the terminal must not take the keyboard while the ask is open (#683, #1430).
    markModalOverlay(overlay)
    const box = document.createElement('div')
    box.className = 'fl-run-ask'
    box.setAttribute('role', 'alertdialog')
    box.setAttribute('aria-modal', 'true')
    const title = document.createElement('div')
    title.className = 'fl-run-ask-title'
    title.id = `fl-run-ask-title-${Date.now()}`
    title.textContent = copy.title
    box.setAttribute('aria-labelledby', title.id)
    const where = document.createElement('p')
    where.className = 'fl-run-ask-where'
    where.textContent = copy.where
    const command = document.createElement('pre')
    command.className = 'fl-run-ask-command'
    command.textContent = copy.command
    const actions = document.createElement('div')
    actions.className = 'fl-run-ask-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'fl-run-btn'
    cancel.textContent = RUN_STRINGS.confirmCancel
    const go = document.createElement('button')
    go.type = 'button'
    go.className = 'fl-run-btn primary'
    go.textContent = RUN_STRINGS.confirmRun
    actions.append(cancel, go)
    box.append(title, where, command, actions)
    overlay.appendChild(box)
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const close = (): void => {
      overlay.remove()
      document.removeEventListener('keydown', onKey, true)
      if (this.#ask?.close === close) this.#ask = null
      previous?.focus?.()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
      } else if (event.key === 'Tab') {
        // Keep the keyboard inside the ask: two buttons, round and round.
        event.preventDefault()
        ;(document.activeElement === go ? cancel : go).focus()
      }
    }
    cancel.addEventListener('click', close)
    go.addEventListener('click', () => {
      close()
      this.#runOnce(step.key)
    })
    overlay.addEventListener('mousedown', (event) => {
      if (event.target === overlay) close()
    })
    document.addEventListener('keydown', onKey, true)
    document.body.appendChild(overlay)
    this.#ask = { close }
    go.focus()
  }

  // ─── the menu ──────────────────────────────────────────────────────────────

  #closeMenu(): void {
    this.#menu?.close()
  }

  #toggleMenu(anchor: HTMLElement): void {
    if (this.#menu !== null) {
      this.#closeMenu()
      return
    }
    const menu = launchpadMenu(this.#view)
    const entries = launchpadMenuEntries(menu)
    const element = document.createElement('div')
    element.className = 'fl-run-menu'
    element.setAttribute('role', 'menu')
    element.setAttribute('aria-label', RUN_STRINGS.launchpad)
    const buttons: HTMLButtonElement[] = []
    const activate = (entry: LaunchpadMenuEntry): void => {
      close()
      if (entry.kind === 'once') this.#pressOnce(entry.key)
      else if (entry.kind === 'run-all') this.#act((api, scope) => api.start({ scope }))
      else if (entry.kind === 'reload-all') this.#act((api, scope) => api.reload({ scope }))
      else if (entry.kind === 'stop-all') this.#act((api, scope) => api.stop({ scope }))
      else this.#openSetup({ addOnce: entry.kind === 'add' })
    }
    const row = (entry: LaunchpadMenuEntry, className: string, disabled = false): HTMLButtonElement => {
      const node = document.createElement('button')
      node.type = 'button'
      node.className = className
      node.setAttribute('role', 'menuitem')
      node.tabIndex = -1
      node.disabled = disabled
      if (!disabled) {
        node.addEventListener('click', (event) => {
          event.stopPropagation()
          activate(entry)
        })
        buttons.push(node)
      }
      return node
    }

    const header = document.createElement('div')
    header.className = 'fl-run-menu-head'
    header.textContent = RUN_STRINGS.menuOnce
    element.appendChild(header)
    if (menu.empty) {
      const none = document.createElement('div')
      none.className = 'fl-run-menu-empty'
      none.textContent = RUN_STRINGS.noOnce
      element.appendChild(none)
      const add = row({ kind: 'add' }, 'fl-run-menu-item small')
      add.append(icon('plus', '12'), document.createTextNode(RUN_STRINGS.addOnce))
      element.appendChild(add)
    }
    for (const group of menu.groups) {
      const label = document.createElement('div')
      label.className = 'fl-run-menu-group'
      label.textContent = group.projectName
      element.appendChild(label)
      for (const item of group.items) {
        const node = row({ kind: 'once', key: item.key }, 'fl-run-menu-item once', item.disabled)
        node.title = item.title
        node.classList.toggle('running', item.running)
        const lead = icon(item.running ? 'spinner' : 'play', '12')
        if (item.running) lead.setAttribute('spin', '')
        const text = document.createElement('span')
        text.className = 'fl-run-menu-text'
        const nameLine = document.createElement('span')
        nameLine.className = 'fl-run-menu-name'
        nameLine.textContent = item.name
        if (item.asksFirst) {
          const tag = document.createElement('span')
          tag.className = 'fl-run-menu-tag'
          tag.textContent = RUN_STRINGS.asksFirst
          nameLine.appendChild(tag)
        }
        const command = document.createElement('span')
        command.className = 'fl-run-menu-command'
        command.textContent = item.command
        text.append(nameLine, command)
        node.append(lead, text)
        element.appendChild(node)
      }
    }
    const divider = document.createElement('div')
    divider.className = 'fl-run-menu-divider'
    element.appendChild(divider)
    if (menu.runAll.shown) {
      const runAll = row({ kind: 'run-all' }, 'fl-run-menu-item small', menu.runAll.disabled)
      runAll.title = menu.runAll.title
      runAll.append(icon('play', '12'), document.createTextNode(RUN_STRINGS.runAll))
      element.appendChild(runAll)
    }
    if (menu.reloadAll) {
      const reload = row({ kind: 'reload-all' }, 'fl-run-menu-item small')
      reload.title = RUN_STRINGS.reloadAllTitle
      reload.append(icon('refresh', '12'), document.createTextNode(RUN_STRINGS.reloadAll))
      element.appendChild(reload)
    }
    if (menu.stopAll) {
      const stop = row({ kind: 'stop-all' }, 'fl-run-menu-item small')
      stop.title = RUN_STRINGS.stopAllTitle
      stop.append(icon('square', '12'), document.createTextNode(RUN_STRINGS.stopAll))
      element.appendChild(stop)
    }
    const edit = row({ kind: 'edit' }, 'fl-run-menu-item small')
    edit.append(icon('settings', '12'), document.createTextNode(RUN_STRINGS.editLaunchpad))
    element.appendChild(edit)

    // Fixed under the pill (above it when there is no room below), so a short
    // terminal panel never clips it.
    const anchorBox = anchor.getBoundingClientRect()
    element.style.left = `${Math.max(4, Math.min(anchorBox.left, window.innerWidth - 284))}px`
    element.style.top = `${anchorBox.bottom + 4}px`
    document.body.appendChild(element)
    const menuBox = element.getBoundingClientRect()
    if (menuBox.bottom > window.innerHeight - 4 && anchorBox.top - menuBox.height - 4 >= 4) {
      element.style.top = `${anchorBox.top - menuBox.height - 4}px`
    }

    let focus = -1
    const focusAt = (index: number): void => {
      focus = index
      buttons[index]?.focus()
    }
    // The pill re-draws on every state change, so the live button is looked up, not kept.
    const liveAnchor = (): HTMLElement | null => this.element.querySelector<HTMLElement>('.fl-run-pill-run')
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close()
        liveAnchor()?.focus()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        focusAt(moveMenuFocus(focus, buttons.length, event.key))
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
        if (at >= 0) {
          event.preventDefault()
          buttons[at]!.click()
        }
      } else if (event.key === 'Tab') {
        close()
      }
    }
    const onOutside = (event: MouseEvent): void => {
      const target = event.target as Node | null
      // A press on the pill's own button toggles the menu itself (its click handler).
      if (target !== null && (element.contains(target) || (liveAnchor()?.contains(target) ?? false))) return
      close()
    }
    const close = (): void => {
      element.remove()
      document.removeEventListener('keydown', onKey, true)
      document.removeEventListener('mousedown', onOutside, true)
      liveAnchor()?.setAttribute('aria-expanded', 'false')
      if (this.#menu?.element === element) this.#menu = null
      liveAnchor()?.closest('.fl-run-pill')?.classList.toggle('open', this.#panel.isOpen)
    }
    document.addEventListener('keydown', onKey, true)
    document.addEventListener('mousedown', onOutside, true)
    anchor.setAttribute('aria-expanded', 'true')
    this.#menu = { element, close }
    anchor.closest('.fl-run-pill')?.classList.add('open')
    // The first one-time action (else the first item) takes the keyboard.
    if (entries.length > 0) focusAt(0)
  }

  async #loadSuggestions(): Promise<RunSuggestion[]> {
    if (this.#suggestions !== null) return this.#suggestions
    const run = this.#deps.api.run
    const scope = this.#scope
    if (run === undefined || scope === null) return []
    try {
      this.#suggestions = await run.suggest({ scope })
    } catch (error) {
      console.warn('flow: could not read the Launchpad suggestions', error)
      this.#suggestions = []
    }
    return this.#suggestions
  }

  /** A terminal tab was chosen: tuck the setup away, keeping its unsaved edits. */
  tuckSetup(): void {
    this.#panel.tuck()
  }

  #toggleSetup(): void {
    if (this.#panel.isOpen) {
      this.#panel.close()
      return
    }
    this.#openSetup()
  }

  /**
   * Open the setup page (or bring back a tucked one with its unsaved edits).
   * `addOnce`: with a new one-time action to fill in.
   */
  #openSetup(options: { addOnce?: boolean } = {}): void {
    if (this.#panel.isOpen || this.#panel.isTucked) {
      if (this.#panel.isTucked) this.#panel.untuck()
      if (options.addOnce === true) this.#panel.addOnceAction()
      this.#renderPill()
      return
    }
    const view = this.#view
    if (view === null) return
    this.#panel.open(view, { suggestions: this.#suggestions ?? [] })
    if (options.addOnce === true) this.#panel.addOnceAction()
    this.#renderPill()
    void this.#loadSuggestions().then((found) => {
      if (this.#panel.isOpen && this.#view === view) this.#panel.setSuggestions(found)
    })
  }

  /**
   * "Ask the agent to set it up": a message in this conversation, sent through
   * the composer like the chat cards' buttons, which the person can read and
   * interrupt. Null without a conversation — the button says why.
   */
  #askAgent(): (() => void) | null {
    const scope = this.#scope
    const view = this.#view
    if (scope === null || scope.threadId === null || view === null) return null
    const threadId = scope.threadId
    return () => {
      const scopeName = view.resolution.project.name || baseName(scope.rootPath)
      const names = view.resolution.places.map((place) => place.name)
      const found = this.#suggestions ?? []
      this.#panel.close()
      document.dispatchEvent(
        new CustomEvent('flow:send-prompt', { detail: { threadId, text: askAgentPrompt(scopeName, found, names) } }),
      )
    }
  }

  // ─── drawing ───────────────────────────────────────────────────────────────

  #renderPill(): void {
    const root = this.element
    const face = pillFace(this.#deps.api.run === undefined ? null : this.#view)
    root.textContent = ''
    root.hidden = face.mode === 'hidden'
    root.classList.toggle('set-up', face.mode === 'set-up')
    if (face.mode === 'hidden') return

    if (face.mode === 'set-up') {
      const start = document.createElement('button')
      start.type = 'button'
      start.className = 'fl-run-setup-entry'
      start.title = RUN_STRINGS.setUpTitle
      start.append(document.createTextNode(RUN_STRINGS.setUp))
      start.addEventListener('click', () => this.#toggleSetup())
      root.append(start)
      return
    }

    const pill = document.createElement('div')
    pill.className = 'fl-run-pill'
    pill.setAttribute('role', 'group')
    pill.setAttribute('aria-label', RUN_STRINGS.launchpad)
    // Accent only while its menu or its setup is open (user decision 2026-11-15).
    pill.classList.toggle('open', this.#menu !== null || this.#panel.isOpen)
    // "Launchpad ▾": the menu of one-time actions, Run all and Edit.
    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'fl-run-pill-run'
    open.title = RUN_STRINGS.launchpadTitle
    open.setAttribute('aria-haspopup', 'menu')
    open.setAttribute('aria-expanded', String(this.#menu !== null))
    open.append(document.createTextNode(RUN_STRINGS.launchpad), icon('chevron-down', '10'))
    open.classList.toggle('active', this.#panel.isOpen)
    open.addEventListener('click', (event) => {
      event.stopPropagation()
      this.#toggleMenu(open)
    })
    open.addEventListener('keydown', (event) => {
      if ((event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') && this.#menu === null) {
        event.preventDefault()
        this.#toggleMenu(open)
      }
    })
    pill.appendChild(open)
    // Reload all and Stop all live in the menu (user decision 2026-11-15): the
    // pill is only the Launchpad name and its chevron.
    root.append(pill)
  }
}


// ─── styles (Flow tokens only) ───────────────────────────────────────────────

let runStylesInjected = false

function injectRunStyles(): void {
  if (runStylesInjected) return
  runStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-run-group { display: inline-flex; align-items: center; flex: none; gap: var(--fl-space-xs); padding-right: var(--fl-space-xs); }
    .fl-run-group[hidden] { display: none; }
    .fl-run-setup-entry {
      display: inline-flex; align-items: center; gap: var(--fl-space-xs);
      height: 26px; padding: 0 8px;
      border: none;
      border-radius: var(--fl-radius-row);
      background: transparent; color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui); font-size: 12px;
      cursor: pointer; white-space: nowrap;
    }
    /* Borderless like its neighbours (polish, 2026-11-17): a soft fill on hover. */
    .fl-run-setup-entry:hover { color: var(--fl-color-text); background: var(--fl-color-surface-raised); }
    .fl-run-pill {
      display: inline-flex; align-items: center; gap: var(--fl-space-xs);
      height: 26px; padding: 0 8px;
      border: var(--fl-border-width) solid transparent;
      border-radius: var(--fl-radius-row);
      background: transparent;
      font-family: var(--fl-font-ui); font-size: 12px;
      white-space: nowrap;
    }
    /* Borderless like the header's other buttons (mockup option A, 2026-11-17). */
    .fl-run-pill:hover { background: var(--fl-color-surface-raised); }
    .fl-run-pill.open { border-color: var(--fl-color-accent); background: var(--fl-color-accent-muted); }
    .fl-run-pill-label, .fl-run-pill-run { font-weight: var(--fl-text-ui-weight-medium); color: var(--fl-color-text); }
    .fl-run-pill-run {
      display: inline-flex; align-items: center; gap: var(--fl-space-xs);
      border: none; background: transparent; padding: 0; cursor: pointer;
      font: inherit; font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-run-pill-run:hover, .fl-run-pill-run.active { color: var(--fl-color-accent); }
    .fl-run-pill-run:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 2px; border-radius: var(--fl-radius-sm); }

    .fl-run-menu {
      position: fixed; z-index: 900; min-width: 280px; max-width: min(420px, calc(100vw - 8px));
      max-height: calc(100vh - 16px); overflow-y: auto; box-sizing: border-box;
      padding: var(--fl-space-xs); display: flex; flex-direction: column; gap: 1px;
      background: var(--fl-color-surface-raised); color: var(--fl-color-text);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-md);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
    }
    .fl-run-menu-head {
      padding: var(--fl-space-xs) var(--fl-space-sm); color: var(--fl-color-text-secondary);
      font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium);
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .fl-run-menu-group { padding: var(--fl-space-xs) var(--fl-space-sm) 0; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-run-menu-empty { padding: 0 var(--fl-space-sm) var(--fl-space-xs); color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-run-menu-item {
      display: flex; align-items: center; gap: var(--fl-space-sm); width: 100%; min-height: 44px; box-sizing: border-box;
      padding: var(--fl-space-xs) var(--fl-space-sm); border: none; border-radius: var(--fl-radius-sm);
      background: transparent; color: var(--fl-color-text); text-align: left; cursor: pointer;
      font: inherit;
    }
    .fl-run-menu-item.small { min-height: 32px; }
    .fl-run-menu-item:hover:not(:disabled), .fl-run-menu-item:focus-visible { background: var(--fl-color-accent-muted); outline: none; }
    .fl-run-menu-item:disabled { opacity: 0.5; cursor: default; }
    .fl-run-menu-item.once > fl-icon { color: var(--fl-color-accent); }
    .fl-run-menu-item.running > fl-icon { color: var(--fl-color-warning); }
    .fl-run-menu-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .fl-run-menu-name { display: inline-flex; align-items: center; gap: var(--fl-space-sm); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-run-menu-command { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fl-color-text-secondary); font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size); }
    .fl-run-menu-tag {
      padding: 0 var(--fl-space-xs); border-radius: var(--fl-radius-pill);
      border: var(--fl-border-width) solid var(--fl-color-warning); color: var(--fl-color-warning);
      font-size: var(--fl-text-caption-size); font-weight: normal; line-height: 1.4;
    }
    .fl-run-menu-divider { height: var(--fl-border-width); background: var(--fl-color-separator); margin: var(--fl-space-xs) 0; }

    .fl-run-ask-overlay {
      position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
      background: rgba(0, 0, 0, 0.35);
    }
    .fl-run-ask {
      width: min(460px, calc(100vw - 32px)); box-sizing: border-box; padding: var(--fl-space-lg);
      display: flex; flex-direction: column; gap: var(--fl-space-sm);
      background: var(--fl-color-surface-raised); color: var(--fl-color-text);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-md);
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35); font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
    }
    .fl-run-ask-title { font-weight: var(--fl-text-ui-weight-medium); }
    .fl-run-ask-where { margin: 0; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-run-ask-command {
      margin: 0; padding: var(--fl-space-sm); border-radius: var(--fl-radius-sm); white-space: pre-wrap; word-break: break-all;
      background: var(--fl-color-bg); border: var(--fl-border-width) solid var(--fl-color-border);
      font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size);
    }
    .fl-run-ask-actions { display: flex; justify-content: flex-end; gap: var(--fl-space-sm); margin-top: var(--fl-space-xs); }
    .fl-run-ask .fl-run-btn:focus-visible { outline: 2px solid var(--fl-color-focus-ring); outline-offset: 2px; }

    .fl-run-section { display: flex; flex-direction: column; gap: var(--fl-space-xs); }
    .fl-run-section + .fl-run-section { margin-top: var(--fl-space-md); }
    .fl-run-section-head { display: flex; flex-direction: column; gap: 2px; }
    .fl-run-section-name { font-weight: var(--fl-text-ui-weight-medium); }
    .fl-run-check { display: inline-flex; align-items: center; gap: var(--fl-space-xs); cursor: pointer; }
    .fl-run-check input { margin: 0; accent-color: var(--fl-color-accent); }
    .fl-run-pill-summary { color: var(--fl-color-text-secondary); }
    .fl-run-pill-btn, .fl-run-icon-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 18px; padding: 0; border: none;
      border-radius: var(--fl-radius-sm); background: transparent;
      color: var(--fl-color-text-secondary); cursor: pointer;
    }
    .fl-run-pill-btn:hover, .fl-run-icon-btn:hover { background: var(--fl-color-surface-raised); color: var(--fl-color-text); }
    .fl-run-icon-btn:disabled { opacity: 0.35; cursor: default; background: transparent; }
    .fl-run-pill-setup {
      height: 18px; padding: 0 var(--fl-space-sm); border: none;
      border-radius: var(--fl-radius-sm); background: transparent;
      color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size); cursor: pointer;
    }
    .fl-run-pill-setup:hover { color: var(--fl-color-text); background: var(--fl-color-surface-raised); }
    .fl-run-pill-setup.active { background: var(--fl-color-accent); color: var(--fl-color-on-accent); }

    .fl-run-setup {
      position: absolute; inset: 0; z-index: 5;
      width: 100%; box-sizing: border-box; container-type: inline-size;
      display: block; padding: 0 var(--fl-space-lg); overflow-y: auto;
      background: var(--fl-color-bg);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size); color: var(--fl-color-text);
    }
    .fl-run-page {
      max-width: 960px; margin: 0 auto; min-height: 100%; box-sizing: border-box;
      display: flex; flex-direction: column; gap: var(--fl-space-md); padding-top: var(--fl-space-lg);
    }
    .fl-run-setup-head { display: flex; align-items: flex-start; gap: var(--fl-space-sm); }
    .fl-run-setup-titles { display: flex; flex-direction: column; gap: 2px; }
    .fl-run-setup-title { font-weight: var(--fl-text-ui-weight-medium); font-size: var(--fl-text-ui-size); }
    .fl-run-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--fl-space-lg); align-items: start; }
    .fl-run-main, .fl-run-aside { display: flex; flex-direction: column; gap: var(--fl-space-sm); min-width: 0; }

    .fl-run-grow { flex: 1 1 auto; }
    .fl-run-muted { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); margin: 0; }
    .fl-run-note { margin: 0; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); line-height: 1.5; }
    .fl-run-label { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); white-space: nowrap; }
    .fl-run-segment { display: inline-flex; border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm); overflow: hidden; }
    .fl-run-segment-btn {
      height: 22px; padding: 0 var(--fl-space-sm); border: none; background: transparent;
      color: var(--fl-color-text-secondary); font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size); cursor: pointer; white-space: nowrap;
    }
    .fl-run-segment-btn + .fl-run-segment-btn { border-left: var(--fl-border-width) solid var(--fl-color-border); }
    .fl-run-segment-btn.active { background: var(--fl-color-accent-muted); color: var(--fl-color-text); }
    .fl-run-segment-btn:disabled { opacity: 0.45; cursor: default; }
    .fl-run-steps { display: flex; flex-direction: column; gap: var(--fl-space-xs); }
    .fl-run-card {
      display: flex; align-items: stretch; gap: var(--fl-space-sm);
      padding: var(--fl-space-sm);
      background: var(--fl-color-surface);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
    }
    .fl-run-card:focus-within { border-color: var(--fl-color-accent); }
    .fl-run-card.dragging { opacity: 0.5; }
    .fl-run-card.skipped .fl-run-card-body { opacity: 0.55; }
    .fl-run-card-move { flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; }
    .fl-run-card-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: var(--fl-space-xs); }
    .fl-run-card-line { display: flex; align-items: center; gap: var(--fl-space-sm); min-width: 0; }
    .fl-run-card-line.small { flex-wrap: wrap; row-gap: var(--fl-space-xs); column-gap: var(--fl-space-md); }
    .fl-run-card-tools { flex: none; display: flex; align-items: center; gap: var(--fl-space-xs); align-self: flex-start; }
    .fl-run-toggle {
      flex: none; width: 30px; height: 16px; border-radius: 8px; position: relative; padding: 0; cursor: pointer;
      border: var(--fl-border-width) solid var(--fl-color-border); background: var(--fl-color-surface-raised);
      transition: background var(--fl-transition-fast), border-color var(--fl-transition-fast);
    }
    .fl-run-toggle-knob {
      position: absolute; top: 1px; left: 1px; width: 12px; height: 12px; border-radius: 50%;
      background: var(--fl-color-text-secondary); transition: transform var(--fl-transition-fast), background var(--fl-transition-fast);
    }
    .fl-run-toggle.on { background: var(--fl-color-accent); border-color: var(--fl-color-accent); }
    .fl-run-toggle.on .fl-run-toggle-knob { transform: translateX(14px); background: #fff; }
    .fl-run-toggle:hover { border-color: var(--fl-color-focus-ring); }
    .fl-run-inline { display: inline-flex; align-items: center; gap: var(--fl-space-xs); min-width: 0; }
    .fl-run-name { flex: 0 0 160px; width: 160px; font-weight: var(--fl-text-ui-weight-medium); }
    .fl-run-command { flex: 1 1 auto; width: 100%; }
    .fl-run-port { width: 72px; }
    .fl-run-skipped { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); font-style: italic; }
    .fl-run-handle {
      flex: none; width: 8px; height: 14px; cursor: grab;
      background-image: radial-gradient(circle, var(--fl-color-text-secondary) 1px, transparent 1.2px);
      background-size: 4px 4px; opacity: 0.6;
    }
    .fl-run-handle.inert { cursor: default; opacity: 0.25; }
    .fl-run-input {
      height: 26px; box-sizing: border-box; padding: 0 var(--fl-space-sm); min-width: 0;
      background: var(--fl-color-bg); color: var(--fl-color-text);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
    }
    .fl-run-input.small { height: 22px; font-size: var(--fl-text-caption-size); padding: 0 var(--fl-space-xs); width: auto; max-width: 180px; }
    .fl-run-input.mono { font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size); }
    .fl-run-input:focus { outline: none; border-color: var(--fl-color-focus-ring); }
    .fl-run-input:disabled { opacity: 0.6; }
    .fl-run-chip {
      height: 24px; padding: 0 var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-pill);
      background: var(--fl-color-surface-raised); color: var(--fl-color-text);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size); cursor: pointer;
    }
    .fl-run-chip.dashed { background: transparent; border-style: dashed; }
    .fl-run-chip:hover { border-color: var(--fl-color-accent); }
    .fl-run-add { align-self: flex-start; }
    .fl-run-suggested { display: flex; flex-direction: column; gap: var(--fl-space-xs); }
    .fl-run-suggested:empty { display: none; }
    .fl-run-section-title { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium); margin-top: var(--fl-space-xs); }
    .fl-run-suggest-list { display: flex; flex-direction: column; gap: 2px; }
    .fl-run-suggest-list.scroll { max-height: 280px; overflow-y: auto; }
    .fl-run-group-title { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); font-weight: var(--fl-text-ui-weight-medium); padding: var(--fl-space-xs) 0 0; }
    .fl-run-suggest-row {
      display: flex; align-items: center; gap: var(--fl-space-sm);
      padding: var(--fl-space-xs) var(--fl-space-sm); border-radius: var(--fl-radius-sm);
      background: var(--fl-color-surface);
    }
    .fl-run-suggest-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .fl-run-suggest-command { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size); }
    .fl-run-added { white-space: nowrap; }
    .fl-run-link {
      align-self: flex-start; padding: 0; border: none; background: transparent;
      color: var(--fl-color-accent); font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size); cursor: pointer;
    }
    .fl-run-link:hover { text-decoration: underline; }
    .fl-run-link:disabled { color: var(--fl-color-text-secondary); cursor: default; text-decoration: none; }
    .fl-run-setup-foot { display: flex; flex-direction: column; gap: var(--fl-space-xs); }
    .fl-run-foot-text { display: flex; flex-direction: column; gap: 2px; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); line-height: 1.45; }
    .fl-run-foot-actions { display: flex; align-items: center; flex-wrap: wrap; gap: var(--fl-space-sm); }
    .fl-run-saves-for { display: inline-flex; align-items: center; gap: var(--fl-space-xs); }
    .fl-run-error { color: var(--fl-color-error); }
    .fl-run-btn {
      flex: none; height: 28px; padding: 0 var(--fl-space-md);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm);
      background: transparent; color: var(--fl-color-text);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size); cursor: pointer;
    }
    .fl-run-btn.small { height: 22px; padding: 0 var(--fl-space-sm); font-size: var(--fl-text-caption-size); }
    .fl-run-btn:hover { background: var(--fl-color-surface-raised); }
    .fl-run-btn.primary { background: var(--fl-color-accent); border-color: var(--fl-color-accent); color: var(--fl-color-on-accent); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-run-btn:disabled { opacity: 0.45; cursor: default; }
    .fl-run-setup[hidden] { display: none; }
    .fl-run-step-hints { display: flex; flex-direction: column; gap: 1px; margin-left: 168px; }
    .fl-run-step-hints[hidden] { display: none; }
    .fl-run-hint {
      display: flex; align-items: baseline; gap: var(--fl-space-sm); min-width: 0; text-align: left;
      padding: 3px var(--fl-space-sm); border: none; border-radius: var(--fl-radius-sm);
      background: transparent; color: var(--fl-color-text); cursor: pointer; font-family: var(--fl-font-ui);
    }
    .fl-run-hint:hover, .fl-run-hint:focus-visible { background: var(--fl-color-surface-raised); outline: none; }
    .fl-run-hint-command { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size); }
    .fl-run-hint-source { flex: none; white-space: nowrap; }
    @container (max-width: 520px) {
      .fl-run-step-hints { margin-left: 0; }
      .fl-run-card-line:not(.small) { flex-wrap: wrap; }
      .fl-run-name { flex: 1 1 100%; width: auto; }
    }
  `
  document.head.appendChild(style)
}

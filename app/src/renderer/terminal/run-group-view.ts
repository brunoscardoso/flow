/**
 * THE RUN GROUP — the pill at the start of the terminal tab bar (Run · "4
 * running" · Reload all · Stop all · Setup), or a dashed "Set up Run" before a
 * setup exists, which opens the setup panel straight away with one empty step
 * (the panel carries the suggestions and "Ask the agent to set it up").
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
import { baseName } from '../project-label'
import { askAgentPrompt, pendingTabAction, pillFace, RUN_STRINGS, type RunDotTone } from './run-group-model'
import { RunSetupPanel } from './run-setup-panel'

export interface RunGroupDeps {
  api: FlowApi
  /** The terminal area the setup panel docks in (positioned). */
  dock: HTMLElement
  /** True while the terminal panel is on screen. */
  isOnScreen(): boolean
  /** The group's state moved — the tab strip re-renders. */
  onChange(): void
}

/** The colour token for each dot tone — Flow's existing status colours. */
export const RUN_TONE_COLOR: Record<RunDotTone, string> = {
  ok: 'var(--fl-color-success)',
  busy: 'var(--fl-color-warning)',
  bad: 'var(--fl-color-error)',
  off: 'var(--fl-color-text-secondary)',
}

function iconButton(icon: string, label: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = 'fl-run-pill-btn'
  node.title = title
  node.setAttribute('aria-label', label)
  const glyph = document.createElement('fl-icon')
  glyph.setAttribute('name', icon)
  glyph.setAttribute('size', '12')
  node.appendChild(glyph)
  node.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return node
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
        console.warn('flow: could not read the Run setup', error)
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

  #act(intent: (run: NonNullable<FlowApi['run']>, scope: RunScope) => Promise<RunGroupState>): void {
    const run = this.#deps.api.run
    const scope = this.#scope
    if (run === undefined || scope === null) return
    intent(run, scope)
      .then((state) => this.#onUpdated(state))
      .catch((error: unknown) => {
        console.warn('flow: a Run request failed', error)
        document.dispatchEvent(
          new CustomEvent('flow:notify', {
            detail: {
              kind: 'state-change',
              rootId: scope.rootPath,
              title: RUN_STRINGS.run,
              body: RUN_STRINGS.failedToAct,
              timestamp: new Date().toISOString(),
              level: 'error',
            },
          }),
        )
      })
  }

  async #loadSuggestions(): Promise<RunSuggestion[]> {
    if (this.#suggestions !== null) return this.#suggestions
    const run = this.#deps.api.run
    const scope = this.#scope
    if (run === undefined || scope === null) return []
    try {
      this.#suggestions = await run.suggest({ scope })
    } catch (error) {
      console.warn('flow: could not read the Run suggestions', error)
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
    if (this.#panel.isTucked) {
      this.#panel.untuck()
      this.#renderPill()
      return
    }
    const view = this.#view
    if (view === null) return
    this.#panel.open(view, { suggestions: this.#suggestions ?? [] })
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
      const glyph = document.createElement('fl-icon')
      glyph.setAttribute('name', 'play')
      glyph.setAttribute('size', '10')
      start.append(glyph, document.createTextNode(RUN_STRINGS.setUp))
      start.addEventListener('click', () => this.#toggleSetup())
      root.appendChild(start)
      root.appendChild(separator())
      return
    }

    const pill = document.createElement('div')
    pill.className = 'fl-run-pill'
    pill.setAttribute('role', 'group')
    pill.setAttribute('aria-label', RUN_STRINGS.run)
    if (face.canRun) {
      const run = document.createElement('button')
      run.type = 'button'
      run.className = 'fl-run-pill-run'
      run.title = RUN_STRINGS.runTitle
      const glyph = document.createElement('fl-icon')
      glyph.setAttribute('name', 'play')
      glyph.setAttribute('size', '10')
      run.append(glyph, document.createTextNode(RUN_STRINGS.run))
      run.addEventListener('click', () => this.#act((api, scope) => api.start({ scope })))
      pill.appendChild(run)
    }
    // No label or count while it runs: the step tabs already show each
    // step's state, so the pill keeps only its actions (user decision).
    if (face.canReload) {
      pill.appendChild(
        iconButton('refresh', RUN_STRINGS.reloadAll, RUN_STRINGS.reloadAllTitle, () =>
          this.#act((api, scope) => api.reload({ scope })),
        ),
      )
    }
    if (face.canStop) {
      pill.appendChild(
        iconButton('square', RUN_STRINGS.stopAll, RUN_STRINGS.stopAllTitle, () => this.#act((api, scope) => api.stop({ scope }))),
      )
    }
    const setup = document.createElement('button')
    setup.type = 'button'
    setup.className = 'fl-run-pill-setup'
    setup.textContent = RUN_STRINGS.setup
    setup.title = RUN_STRINGS.setupTitle
    setup.setAttribute('aria-pressed', String(this.#panel.isOpen))
    setup.classList.toggle('active', this.#panel.isOpen)
    setup.addEventListener('click', () => this.#toggleSetup())
    pill.appendChild(setup)
    root.appendChild(pill)
    root.appendChild(separator())
  }
}

function separator(): HTMLElement {
  const line = document.createElement('span')
  line.className = 'fl-run-sep'
  line.setAttribute('aria-hidden', 'true')
  return line
}

// ─── styles (Flow tokens only) ───────────────────────────────────────────────

let runStylesInjected = false

function injectRunStyles(): void {
  if (runStylesInjected) return
  runStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-run-group { display: inline-flex; align-items: center; flex: none; gap: var(--fl-space-xs); padding-left: var(--fl-space-xs); }
    .fl-run-group[hidden] { display: none; }
    .fl-run-sep { width: var(--fl-border-width); height: 16px; background: var(--fl-color-separator); margin: 0 var(--fl-space-xxs); }
    .fl-run-setup-entry {
      display: inline-flex; align-items: center; gap: var(--fl-space-xs);
      height: 22px; padding: 0 var(--fl-space-sm);
      border: var(--fl-border-width) dashed var(--fl-color-border);
      border-radius: var(--fl-radius-sm);
      background: transparent; color: var(--fl-color-text-secondary);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
      cursor: pointer; white-space: nowrap;
    }
    .fl-run-setup-entry:hover { color: var(--fl-color-text); border-color: var(--fl-color-accent); }
    .fl-run-pill {
      display: inline-flex; align-items: center; gap: var(--fl-space-xs);
      height: 22px; padding: 0 var(--fl-space-xxs) 0 var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-accent);
      border-radius: var(--fl-radius-sm);
      background: var(--fl-color-accent-muted);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size);
      white-space: nowrap;
    }
    .fl-run-pill-label, .fl-run-pill-run { font-weight: var(--fl-text-ui-weight-medium); color: var(--fl-color-text); }
    .fl-run-pill-run {
      display: inline-flex; align-items: center; gap: var(--fl-space-xs);
      border: none; background: transparent; padding: 0; cursor: pointer;
      font: inherit; font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-run-pill-run:hover { color: var(--fl-color-accent); }
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

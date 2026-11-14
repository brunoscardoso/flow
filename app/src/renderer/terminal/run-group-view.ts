/**
 * THE RUN GROUP — the pill at the start of the terminal tab bar (Run · "4
 * running" · Reload all · Stop all · Setup), or a dashed "Set up Run" before a
 * setup exists; plus the setup panel and the first-time picker it opens.
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
import {
  askAgentPrompt,
  pendingTabAction,
  pickerText,
  pillFace,
  RUN_STRINGS,
  type RunDotTone,
} from './run-group-model'
import { addSuggestion, startDraft, type RunSetupDraft } from './run-setup-model'
import { RunSetupPanel, showRunPicker } from './run-setup-panel'

export interface RunGroupDeps {
  api: FlowApi
  /** The terminal area the setup panel and picker dock in (positioned). */
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
  #closePicker: (() => void) | null = null

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
      hasConversation: () => this.#scope !== null && this.#scope.threadId !== null,
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
    this.#closePicker?.()
    this.#closePicker = null
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

  #toggleSetup(): void {
    if (this.#panel.isOpen) {
      this.#panel.close()
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

  async #openPicker(): Promise<void> {
    const view = this.#view
    const scope = this.#scope
    if (view === null || scope === null || this.#closePicker !== null) return
    const found = await this.#loadSuggestions()
    if (this.#view !== view) return
    const scopeName = view.resolution.projects[0]?.name ?? baseName(scope.rootPath)
    const projects = view.resolution.projects
    const inScope = found.filter((suggestion) => projects.some((project) => project.root === suggestion.projectRoot))
    const threadId = scope.threadId
    this.#closePicker = showRunPicker({
      host: this.#deps.dock,
      text: pickerText(
        scopeName,
        projects.map((project) => project.name),
        inScope.length,
      ),
      suggestions: inScope,
      onAsk:
        threadId === null
          ? null
          : () => {
              this.#closePicker = null
              // The composer's own send, like the chat cards' buttons: a message
              // in this conversation the person can read and interrupt.
              document.dispatchEvent(
                new CustomEvent('flow:send-prompt', { detail: { threadId, text: askAgentPrompt(scopeName, inScope) } }),
              )
            },
      onEmpty: () => {
        this.#closePicker = null
        this.#openPanelWith(view, new Map())
      },
      onContinue: (ticked) => {
        this.#closePicker = null
        const drafts = new Map<string, RunSetupDraft>()
        for (const project of projects) {
          let draft = startDraft(project, 'shared')
          for (const suggestion of ticked) {
            if (suggestion.projectRoot === project.root) draft = addSuggestion(draft, suggestion)
          }
          if (draft.steps.length > 0) drafts.set(project.root, draft)
        }
        this.#openPanelWith(view, drafts)
      },
      onClose: () => {
        this.#closePicker = null
      },
    })
  }

  #openPanelWith(view: RunView, drafts: Map<string, RunSetupDraft>): void {
    if (this.#view !== view) return
    this.#panel.open(view, { suggestions: this.#suggestions ?? [], drafts })
    this.#renderPill()
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
      start.addEventListener('click', () => void this.#openPicker())
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
    } else {
      pill.appendChild(Object.assign(document.createElement('span'), { className: 'fl-run-pill-label', textContent: RUN_STRINGS.run }))
    }
    if (face.summary !== null) {
      const summary = document.createElement('span')
      summary.className = 'fl-run-pill-summary'
      summary.textContent = face.summary
      if (face.summaryTitle !== '') summary.title = face.summaryTitle
      pill.appendChild(summary)
    }
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
      position: absolute; top: 0; right: 0; bottom: 0; z-index: 5;
      width: min(560px, 100%); box-sizing: border-box;
      display: flex; flex-direction: column; gap: var(--fl-space-sm);
      padding: var(--fl-space-md); overflow-y: auto;
      background: var(--fl-color-bg);
      border-left: var(--fl-border-width) solid var(--fl-color-border);
      box-shadow: -8px 0 24px rgba(0, 0, 0, 0.3);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size); color: var(--fl-color-text);
    }
    .fl-run-setup-head { display: flex; align-items: center; gap: var(--fl-space-sm); }
    .fl-run-setup-title { font-weight: var(--fl-text-ui-weight-medium); }
    .fl-run-grow { flex: 1 1 auto; }
    .fl-run-muted { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); margin: 0; }
    .fl-run-note { margin: 0; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); line-height: 1.5; }
    .fl-run-field-row { display: flex; align-items: center; gap: var(--fl-space-sm); }
    .fl-run-label { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-run-segment { display: inline-flex; border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm); overflow: hidden; }
    .fl-run-segment-btn {
      height: 22px; padding: 0 var(--fl-space-sm); border: none; background: transparent;
      color: var(--fl-color-text-secondary); font-family: var(--fl-font-ui);
      font-size: var(--fl-text-caption-size); cursor: pointer;
    }
    .fl-run-segment-btn + .fl-run-segment-btn { border-left: var(--fl-border-width) solid var(--fl-color-border); }
    .fl-run-segment-btn.active { background: var(--fl-color-accent-muted); color: var(--fl-color-text); }
    .fl-run-segment-btn:disabled { opacity: 0.45; cursor: default; }
    .fl-run-steps { display: flex; flex-direction: column; gap: var(--fl-space-xs); }
    .fl-run-step {
      display: flex; flex-direction: column; gap: var(--fl-space-sm);
      padding: var(--fl-space-sm) var(--fl-space-sm);
      background: var(--fl-color-surface);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-md);
    }
    .fl-run-step.expanded { background: var(--fl-color-accent-muted); border-color: var(--fl-color-accent); }
    .fl-run-step.skipped .fl-run-step-name, .fl-run-step.skipped .fl-run-step-command { opacity: 0.5; text-decoration: line-through; }
    .fl-run-step.dragging { opacity: 0.5; }
    .fl-run-step-line { display: flex; align-items: center; gap: var(--fl-space-sm); cursor: pointer; min-width: 0; }
    .fl-run-handle {
      flex: none; width: 8px; height: 14px; cursor: grab;
      background-image: radial-gradient(circle, var(--fl-color-text-secondary) 1px, transparent 1.2px);
      background-size: 4px 4px; opacity: 0.6;
    }
    .fl-run-handle.inert { cursor: default; opacity: 0.25; }
    .fl-run-step-name { flex: none; width: 84px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: var(--fl-text-ui-weight-medium); }
    .fl-run-step-name.accent { width: auto; color: var(--fl-color-accent); }
    .fl-run-origin { color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); }
    .fl-run-step-command {
      flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size); color: var(--fl-color-text-secondary);
    }
    .fl-run-step-when { flex: none; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); white-space: nowrap; }
    .fl-run-step-tools { flex: none; display: inline-flex; gap: 2px; }
    .fl-run-editor { display: grid; grid-template-columns: 110px minmax(0, 1fr); gap: var(--fl-space-sm); }
    .fl-run-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .fl-run-field .fl-run-input + .fl-run-input { margin-top: var(--fl-space-xs); }
    .fl-run-input {
      height: 26px; box-sizing: border-box; padding: 0 var(--fl-space-sm); min-width: 0;
      background: var(--fl-color-surface); color: var(--fl-color-text);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size);
    }
    .fl-run-input.mono { font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size); }
    .fl-run-input:focus { outline: none; border-color: var(--fl-color-focus-ring); }
    .fl-run-input:disabled { opacity: 0.6; }
    .fl-run-chips { display: flex; flex-wrap: wrap; align-items: center; gap: var(--fl-space-xs); }
    .fl-run-chip {
      height: 24px; padding: 0 var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-pill);
      background: var(--fl-color-surface-raised); color: var(--fl-color-text);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-caption-size); cursor: pointer;
    }
    .fl-run-chip.dashed { background: transparent; border-style: dashed; }
    .fl-run-chip:hover { border-color: var(--fl-color-accent); }
    .fl-run-setup-foot { display: flex; align-items: center; gap: var(--fl-space-sm); }
    .fl-run-foot-text { flex: 1 1 auto; display: flex; flex-direction: column; gap: 2px; color: var(--fl-color-text-secondary); font-size: var(--fl-text-caption-size); line-height: 1.45; }
    .fl-run-error { color: var(--fl-color-error); }
    .fl-run-btn {
      flex: none; height: 28px; padding: 0 var(--fl-space-md);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-sm);
      background: transparent; color: var(--fl-color-text);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size); cursor: pointer;
    }
    .fl-run-btn:hover { background: var(--fl-color-surface-raised); }
    .fl-run-btn.primary { background: var(--fl-color-accent); border-color: var(--fl-color-accent); color: var(--fl-color-on-accent); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-run-btn:disabled { opacity: 0.45; cursor: default; }

    .fl-run-picker-overlay {
      position: absolute; inset: 0; z-index: 6;
      display: flex; align-items: center; justify-content: center;
      padding: var(--fl-space-md); box-sizing: border-box;
      background: color-mix(in srgb, var(--fl-color-bg) 60%, transparent);
    }
    .fl-run-picker {
      width: min(620px, 100%); max-height: 100%; overflow-y: auto; box-sizing: border-box;
      display: flex; flex-direction: column; gap: var(--fl-space-md);
      padding: var(--fl-space-lg);
      background: var(--fl-color-surface-raised);
      border: var(--fl-border-width) solid var(--fl-color-border); border-radius: var(--fl-radius-lg);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      font-family: var(--fl-font-ui); font-size: var(--fl-text-ui-size); color: var(--fl-color-text);
    }
    .fl-run-picker-title { font-size: var(--fl-text-heading-size); font-weight: var(--fl-text-ui-weight-medium); }
    .fl-run-picker-body { margin: 0; color: var(--fl-color-text-secondary); line-height: 1.5; }
    .fl-run-picker-list { display: flex; flex-direction: column; gap: var(--fl-space-xs); }
    .fl-run-picker-row {
      display: flex; align-items: center; gap: var(--fl-space-sm);
      padding: var(--fl-space-sm); border-radius: var(--fl-radius-md);
      background: var(--fl-color-surface); cursor: pointer;
    }
    .fl-run-picker-command { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--fl-font-mono); font-size: var(--fl-text-mono-size); }
    .fl-run-picker-actions { display: flex; align-items: center; gap: var(--fl-space-sm); }
  `
  document.head.appendChild(style)
}

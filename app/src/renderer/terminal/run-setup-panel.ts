/**
 * THE RUN SETUP PANEL — docked on the right of the terminal area, over the
 * running terminals, so changing a step never hides what is running; and the
 * first-time picker that lists what Flow found in the projects.
 *
 * All editing logic lives in `run-setup-model.ts` (pure, tested); this file
 * only draws a draft and turns clicks into model calls. Nothing here runs a
 * command: Save sends one request per changed project and main decides what
 * starts, restarts or stops (allowed-pattern #14).
 */
import type {
  RunGroupState,
  RunLayer,
  RunProjectLayers,
  RunSaveAnswer,
  RunSaveChange,
  RunSuggestion,
  RunView,
} from '../../shared/run-setup'
import { pickerRows, RUN_STRINGS, type RunPickerText } from './run-group-model'
import {
  addStep,
  addSuggestion,
  changeStep,
  isDirty,
  isStructural,
  LAYER_LABELS,
  LAYER_TITLES,
  moveStep,
  otherProjectsSentence,
  removeStep,
  saveChange,
  saveSentence,
  SETUP_STRINGS,
  startDraft,
  startsLabel,
  validateDraft,
  type DraftStep,
  type ReadyKind,
  type RunSetupDraft,
} from './run-setup-model'

export interface RunSetupPanelDeps {
  /** The terminal area the panel docks in (positioned). */
  host: HTMLElement
  save(change: RunSaveChange): Promise<RunSaveAnswer>
  /** The group's live state — for the sentence saying what Save will do. */
  state(): RunGroupState | null
  hasConversation(): boolean
  onSaved(view: RunView): void
  onClosed(): void
}

const LAYERS: RunLayer[] = ['shared', 'personal', 'conversation']

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className: string, text: string, onClick: () => void, title?: string): HTMLButtonElement {
  const node = el('button', className, text)
  node.type = 'button'
  if (title !== undefined) node.title = title
  node.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return node
}

function iconButton(icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const node = button('fl-run-icon-btn', '', onClick, label)
  node.setAttribute('aria-label', label)
  const glyph = document.createElement('fl-icon')
  glyph.setAttribute('name', icon)
  glyph.setAttribute('size', '12')
  node.appendChild(glyph)
  return node
}

export class RunSetupPanel {
  readonly #deps: RunSetupPanelDeps
  #root: HTMLElement | null = null
  #view: RunView | null = null
  #drafts = new Map<string, RunSetupDraft>()
  #current = ''
  #expanded: string | null = null
  #suggestions: RunSuggestion[] = []
  #saving = false
  #error: string | null = null
  #footer: HTMLElement | null = null
  #dragId: string | null = null
  readonly #onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.#root !== null && this.#root.contains(document.activeElement)) {
      event.stopPropagation()
      this.close()
    }
  }

  constructor(deps: RunSetupPanelDeps) {
    this.#deps = deps
  }

  get isOpen(): boolean {
    return this.#root !== null
  }

  /** Open on a view; `drafts` seeds unsaved steps (the picker's ticks). */
  open(view: RunView, options: { suggestions?: RunSuggestion[]; drafts?: Map<string, RunSetupDraft> } = {}): void {
    this.#view = view
    this.#suggestions = options.suggestions ?? this.#suggestions
    this.#drafts = options.drafts ?? new Map()
    const projects = view.resolution.projects
    this.#current = [...this.#drafts.keys()][0] ?? projects[0]?.root ?? ''
    for (const project of projects) {
      if (!this.#drafts.has(project.root)) this.#drafts.set(project.root, startDraft(project, 'shared'))
    }
    this.#error = null
    this.#expanded = this.#firstNewStep()
    if (this.#root === null) {
      this.#root = el('div', 'fl-run-setup')
      this.#root.setAttribute('role', 'dialog')
      this.#root.setAttribute('aria-label', SETUP_STRINGS.title)
      this.#root.addEventListener('keydown', this.#onKey)
      this.#deps.host.appendChild(this.#root)
    }
    this.#render()
  }

  close(): void {
    if (this.#root === null) return
    this.#root.remove()
    this.#root = null
    this.#footer = null
    this.#drafts.clear()
    this.#deps.onClosed()
  }

  /** Suggestions arrived after opening — the chips update. */
  setSuggestions(suggestions: RunSuggestion[]): void {
    this.#suggestions = suggestions
    if (this.#root !== null) this.#render()
  }

  /** The Run's state moved — only the sentence can change. */
  stateChanged(): void {
    this.#renderFooter()
  }

  /** The setup changed elsewhere: untouched drafts take the new steps. */
  setView(view: RunView): void {
    this.#view = view
    if (this.#root === null) return
    for (const project of view.resolution.projects) {
      const draft = this.#drafts.get(project.root)
      if (draft === undefined || !isDirty(draft)) this.#drafts.set(project.root, startDraft(project, draft?.layer ?? 'shared'))
    }
    this.#render()
  }

  // ─── state helpers ─────────────────────────────────────────────────────────

  #project(root = this.#current): RunProjectLayers | null {
    return this.#view?.resolution.projects.find((project) => project.root === root) ?? null
  }

  #draft(): RunSetupDraft | null {
    return this.#drafts.get(this.#current) ?? null
  }

  #firstNewStep(): string | null {
    return this.#drafts.get(this.#current)?.steps.find((step) => step.isNew)?.id ?? null
  }

  #update(next: RunSetupDraft, rerender = true): void {
    this.#drafts.set(next.projectRoot, next)
    this.#error = null
    if (rerender) this.#render()
    else this.#renderFooter()
  }

  // ─── drawing ───────────────────────────────────────────────────────────────

  #render(): void {
    const root = this.#root
    const draft = this.#draft()
    if (root === null) return
    root.textContent = ''

    const head = el('div', 'fl-run-setup-head')
    const projectName = draft?.projectName ?? ''
    head.appendChild(el('span', 'fl-run-setup-title', projectName === '' ? SETUP_STRINGS.title : `${SETUP_STRINGS.title} · ${projectName}`))
    head.appendChild(el('span', 'fl-run-grow'))
    head.appendChild(iconButton('close', SETUP_STRINGS.close, () => this.close()))
    root.appendChild(head)

    const projects = this.#view?.resolution.projects ?? []
    if (projects.length > 1) root.appendChild(this.#projectPicker(projects))
    if (draft === null) {
      root.appendChild(el('p', 'fl-run-muted', RUN_STRINGS.failedToRead))
      return
    }
    root.appendChild(this.#layerPicker(draft))
    if (!isStructural(draft.layer)) root.appendChild(el('p', 'fl-run-note', SETUP_STRINGS.structureOnlyEveryone))

    const list = el('div', 'fl-run-steps')
    if (draft.steps.length === 0) list.appendChild(el('p', 'fl-run-muted', SETUP_STRINGS.empty))
    draft.steps.forEach((step, index) => list.appendChild(this.#stepRow(draft, step, index)))
    root.appendChild(list)

    if (isStructural(draft.layer)) root.appendChild(this.#chips(draft))
    root.appendChild(el('span', 'fl-run-grow'))
    this.#footer = el('div', 'fl-run-setup-foot')
    root.appendChild(this.#footer)
    this.#renderFooter()
  }

  #projectPicker(projects: RunProjectLayers[]): HTMLElement {
    const row = el('label', 'fl-run-field-row')
    row.appendChild(el('span', 'fl-run-label', SETUP_STRINGS.project))
    const select = el('select', 'fl-run-input')
    for (const project of projects) {
      const option = el('option', undefined, project.name)
      option.value = project.root
      option.selected = project.root === this.#current
      select.appendChild(option)
    }
    select.addEventListener('change', () => {
      this.#current = select.value
      this.#expanded = this.#firstNewStep()
      this.#render()
    })
    row.appendChild(select)
    return row
  }

  #layerPicker(draft: RunSetupDraft): HTMLElement {
    const row = el('div', 'fl-run-field-row')
    row.appendChild(el('span', 'fl-run-label', SETUP_STRINGS.savesFor))
    const group = el('div', 'fl-run-segment')
    group.setAttribute('role', 'radiogroup')
    group.setAttribute('aria-label', SETUP_STRINGS.savesFor)
    for (const layer of LAYERS) {
      const unavailable = layer === 'conversation' && !this.#deps.hasConversation()
      const option = button('fl-run-segment-btn', LAYER_LABELS[layer], () => {
        if (layer === draft.layer) return
        const project = this.#project(draft.projectRoot)
        if (project === null) return
        // A layer is its own draft: switching starts from what that layer says now.
        this.#update(startDraft(project, layer))
      }, unavailable ? SETUP_STRINGS.noConversation : LAYER_TITLES[layer])
      option.setAttribute('role', 'radio')
      option.setAttribute('aria-checked', String(layer === draft.layer))
      option.classList.toggle('active', layer === draft.layer)
      option.disabled = unavailable
      group.appendChild(option)
    }
    row.appendChild(group)
    return row
  }

  #stepRow(draft: RunSetupDraft, step: DraftStep, index: number): HTMLElement {
    const structural = isStructural(draft.layer)
    const expanded = this.#expanded === step.id
    const row = el('div', 'fl-run-step')
    row.classList.toggle('expanded', expanded)
    row.classList.toggle('skipped', step.skipped)
    row.dataset['stepId'] = step.id

    const line = el('div', 'fl-run-step-line')
    const handle = el('span', 'fl-run-handle')
    handle.setAttribute('aria-hidden', 'true')
    if (structural) {
      handle.title = SETUP_STRINGS.dragHandle
      row.draggable = true
      row.addEventListener('dragstart', (event) => {
        this.#dragId = step.id
        event.dataTransfer?.setData('text/plain', step.id)
        row.classList.add('dragging')
      })
      row.addEventListener('dragend', () => {
        this.#dragId = null
        row.classList.remove('dragging')
      })
      row.addEventListener('dragover', (event) => {
        if (this.#dragId !== null && this.#dragId !== step.id) event.preventDefault()
      })
      row.addEventListener('drop', (event) => {
        event.preventDefault()
        const dragged = this.#dragId
        this.#dragId = null
        if (dragged !== null && dragged !== step.id) this.#update(moveStep(draft, dragged, index))
      })
    } else {
      handle.classList.add('inert')
    }
    line.appendChild(handle)

    if (expanded && step.isNew) {
      line.appendChild(el('span', 'fl-run-step-name accent', SETUP_STRINGS.newStep))
      if (step.origin !== null) line.appendChild(el('span', 'fl-run-origin', `from ${step.origin}`))
      line.appendChild(el('span', 'fl-run-grow'))
    } else {
      line.appendChild(el('span', 'fl-run-step-name', step.name.trim() === '' ? `Step ${index + 1}` : step.name))
      line.appendChild(el('span', 'fl-run-step-command', step.command))
      line.appendChild(
        el('span', 'fl-run-step-when', step.skipped ? SETUP_STRINGS.skipped : startsLabel(draft.steps, index)),
      )
    }

    const tools = el('span', 'fl-run-step-tools')
    if (structural) {
      const up = iconButton('chevron-up', SETUP_STRINGS.moveUp, () => this.#update(moveStep(draft, step.id, index - 1)))
      up.disabled = index === 0
      const down = iconButton('chevron-down', SETUP_STRINGS.moveDown, () =>
        this.#update(moveStep(draft, step.id, index + 1)),
      )
      down.disabled = index === draft.steps.length - 1
      tools.append(up, down)
      tools.appendChild(iconButton('trash', SETUP_STRINGS.remove, () => this.#update(removeStep(draft, step.id))))
    } else {
      tools.appendChild(
        iconButton(step.skipped ? 'plus' : 'minus', step.skipped ? SETUP_STRINGS.unskip : SETUP_STRINGS.skip, () =>
          this.#update(removeStep(draft, step.id)),
        ),
      )
    }
    line.appendChild(tools)
    line.addEventListener('click', () => {
      this.#expanded = expanded ? null : step.id
      this.#render()
    })
    row.appendChild(line)
    if (expanded) row.appendChild(this.#editor(draft, step, index))
    return row
  }

  #editor(draft: RunSetupDraft, step: DraftStep, index: number): HTMLElement {
    const structural = isStructural(draft.layer)
    const grid = el('div', 'fl-run-editor')
    const current = (): RunSetupDraft => this.#draft() ?? draft

    const field = (label: string, control: HTMLElement): HTMLElement => {
      const wrap = el('label', 'fl-run-field')
      wrap.appendChild(el('span', 'fl-run-label', label))
      wrap.appendChild(control)
      return wrap
    }

    const name = el('input', 'fl-run-input')
    name.value = step.name
    name.disabled = !structural
    name.addEventListener('input', () => this.#update(changeStep(current(), step.id, { name: name.value }), false))

    const command = el('input', 'fl-run-input mono')
    command.value = step.command
    command.spellcheck = false
    command.addEventListener('input', () => this.#update(changeStep(current(), step.id, { command: command.value }), false))

    const starts = el('select', 'fl-run-input')
    for (const [value, label] of [
      ['now', SETUP_STRINGS.startsNow],
      ['after-previous', SETUP_STRINGS.startsAfter],
    ] as const) {
      const option = el('option', undefined, label)
      option.value = value
      option.selected = step.start === value
      option.disabled = value === 'after-previous' && index === 0
      starts.appendChild(option)
    }
    starts.disabled = !structural
    starts.addEventListener('change', () =>
      this.#update(changeStep(current(), step.id, { start: starts.value === 'after-previous' ? 'after-previous' : 'now' })),
    )

    const readyKind = el('select', 'fl-run-input')
    for (const [value, label] of [
      ['none', SETUP_STRINGS.readyNone],
      ['port', SETUP_STRINGS.readyPort],
      ['line', SETUP_STRINGS.readyLine],
    ] as const) {
      const option = el('option', undefined, label)
      option.value = value
      option.selected = step.readyKind === value
      readyKind.appendChild(option)
    }
    readyKind.addEventListener('change', () =>
      this.#update(changeStep(current(), step.id, { readyKind: readyKind.value as ReadyKind })),
    )

    grid.appendChild(field(SETUP_STRINGS.name, name))
    grid.appendChild(field(SETUP_STRINGS.command, command))
    grid.appendChild(field(SETUP_STRINGS.starts, starts))
    const readyWrap = field(SETUP_STRINGS.readyWhen, readyKind)
    grid.appendChild(readyWrap)
    if (step.readyKind !== 'none') {
      const value = el('input', step.readyKind === 'port' ? 'fl-run-input' : 'fl-run-input mono')
      value.value = step.readyValue
      value.placeholder = step.readyKind === 'port' ? SETUP_STRINGS.portPlaceholder : SETUP_STRINGS.linePlaceholder
      value.setAttribute('aria-label', value.placeholder)
      if (step.readyKind === 'port') value.inputMode = 'numeric'
      value.addEventListener('input', () => this.#update(changeStep(current(), step.id, { readyValue: value.value }), false))
      readyWrap.appendChild(value)
    }
    queueMicrotask(() => {
      if (step.isNew && step.name === '') name.focus()
    })
    return grid
  }

  #chips(draft: RunSetupDraft): HTMLElement {
    const row = el('div', 'fl-run-chips')
    const have = new Set(draft.steps.map((step) => step.command.trim()))
    const offered = this.#suggestions.filter(
      (suggestion) => suggestion.projectRoot === draft.projectRoot && !have.has(suggestion.command.trim()),
    )
    if (offered.length > 0) row.appendChild(el('span', 'fl-run-muted', SETUP_STRINGS.suggested))
    const seen = new Set<string>()
    for (const suggestion of offered) {
      if (seen.has(suggestion.command)) continue
      seen.add(suggestion.command)
      const chip = button('fl-run-chip', `+ ${suggestion.command}`, () => {
        const next = addSuggestion(draft, suggestion)
        this.#expanded = next.steps[next.steps.length - 1]?.id ?? null
        this.#update(next)
      }, `${suggestion.projectName} · ${suggestion.source}`)
      row.appendChild(chip)
    }
    row.appendChild(
      button('fl-run-chip dashed', SETUP_STRINGS.addStep, () => {
        const next = addStep(draft)
        this.#expanded = next.steps[next.steps.length - 1]?.id ?? null
        this.#update(next)
      }),
    )
    return row
  }

  #renderFooter(): void {
    const foot = this.#footer
    const draft = this.#draft()
    if (foot === null || draft === null) return
    foot.textContent = ''
    const problems = isDirty(draft) ? validateDraft(draft, { hasConversation: this.#deps.hasConversation() }) : []
    const others = [...this.#drafts.values()].filter((other) => other.projectRoot !== draft.projectRoot && isDirty(other))
    const otherProblems = others.flatMap((other) =>
      validateDraft(other, { hasConversation: this.#deps.hasConversation() }).map((text) => `${other.projectName}: ${text}`),
    )
    const text = el('div', 'fl-run-foot-text')
    if (this.#error !== null) {
      text.appendChild(el('span', 'fl-run-error', this.#error))
    } else if (problems.length + otherProblems.length > 0) {
      for (const problem of [...problems, ...otherProblems]) text.appendChild(el('span', 'fl-run-error', problem))
    } else {
      text.appendChild(el('span', undefined, saveSentence(draft, this.#deps.state())))
      const also = otherProjectsSentence(others.map((other) => other.projectName))
      if (also !== null) text.appendChild(el('span', undefined, also))
    }
    foot.appendChild(text)
    foot.appendChild(button('fl-run-btn', SETUP_STRINGS.cancel, () => this.close()))
    const dirty = isDirty(draft) || others.length > 0
    const save = button('fl-run-btn primary', this.#saving ? SETUP_STRINGS.saving : SETUP_STRINGS.save, () => void this.#save())
    save.disabled = this.#saving || !dirty || problems.length + otherProblems.length > 0
    foot.appendChild(save)
  }

  async #save(): Promise<void> {
    if (this.#saving) return
    const dirty = [...this.#drafts.values()].filter(isDirty)
    if (dirty.length === 0) return
    this.#saving = true
    this.#renderFooter()
    let lastView: RunView | null = null
    try {
      for (const draft of dirty) {
        const project = this.#project(draft.projectRoot)
        if (project === null) continue
        const answer = await this.#deps.save(saveChange(draft, project))
        if (!answer.ok) {
          this.#error = answer.reason
          return
        }
        lastView = answer.view
        this.#drafts.delete(draft.projectRoot)
      }
    } catch (error) {
      console.warn('flow: saving the Run setup failed', error)
      this.#error = RUN_STRINGS.failedToAct
      return
    } finally {
      this.#saving = false
      if (this.#error !== null) this.#renderFooter()
    }
    if (lastView !== null) this.#deps.onSaved(lastView)
    this.close()
  }
}

// ─── the first-time picker ───────────────────────────────────────────────────

export interface RunPickerOptions {
  host: HTMLElement
  text: RunPickerText
  suggestions: RunSuggestion[]
  /** Null when there is no conversation to ask in — the button says why. */
  onAsk: (() => void) | null
  onEmpty: () => void
  onContinue: (ticked: RunSuggestion[]) => void
  onClose: () => void
}

/** Show the picker card over the terminal area. Returns its removal. */
export function showRunPicker(options: RunPickerOptions): () => void {
  const overlay = el('div', 'fl-run-picker-overlay')
  const card = el('div', 'fl-run-picker')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', options.text.title)
  const remove = (): void => {
    overlay.remove()
  }
  const finish = (then: () => void) => (): void => {
    remove()
    then()
  }

  const head = el('div', 'fl-run-setup-head')
  head.appendChild(el('span', 'fl-run-picker-title', options.text.title))
  head.appendChild(el('span', 'fl-run-grow'))
  head.appendChild(iconButton('close', RUN_STRINGS.pickerClose, finish(options.onClose)))
  card.appendChild(head)
  card.appendChild(el('p', 'fl-run-picker-body', options.text.body))

  const ticked = new Set<string>()
  const rows = pickerRows(options.suggestions)
  const continueButton = button('fl-run-btn primary', RUN_STRINGS.pickerContinue, () => {
    remove()
    options.onContinue(rows.filter((row) => ticked.has(row.id)).map((row) => row.suggestion))
  })
  if (rows.length > 0) {
    const list = el('div', 'fl-run-picker-list')
    for (const row of rows) {
      const label = el('label', 'fl-run-picker-row')
      const box = el('input')
      box.type = 'checkbox'
      box.addEventListener('change', () => {
        if (box.checked) ticked.add(row.id)
        else ticked.delete(row.id)
        continueButton.disabled = ticked.size === 0
      })
      label.appendChild(box)
      label.appendChild(el('span', 'fl-run-picker-command', row.command))
      label.appendChild(el('span', 'fl-run-muted', row.meta))
      list.appendChild(label)
    }
    card.appendChild(list)
  }
  continueButton.disabled = true

  const actions = el('div', 'fl-run-picker-actions')
  const ask = button(
    'fl-run-btn',
    RUN_STRINGS.pickerAsk,
    () => {
      if (options.onAsk !== null) finish(options.onAsk)()
    },
    options.onAsk === null ? RUN_STRINGS.pickerAskNoConversation : RUN_STRINGS.pickerAskTitle,
  )
  ask.disabled = options.onAsk === null
  actions.appendChild(ask)
  actions.appendChild(el('span', 'fl-run-grow'))
  actions.appendChild(button('fl-run-btn', RUN_STRINGS.pickerEmpty, finish(options.onEmpty)))
  if (rows.length > 0) actions.appendChild(continueButton)
  card.appendChild(actions)

  overlay.appendChild(card)
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      finish(options.onClose)()
    }
  })
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) finish(options.onClose)()
  })
  options.host.appendChild(overlay)
  queueMicrotask(() => card.querySelector<HTMLElement>('input, button.primary, button')?.focus())
  return remove
}

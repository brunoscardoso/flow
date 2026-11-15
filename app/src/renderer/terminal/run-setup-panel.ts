/**
 * THE RUN SETUP PANEL — docked on the right of the terminal area, over the
 * running terminals, so changing a step never hides what is running. "Set up
 * Run" opens it straight away with one empty step to fill in.
 *
 * ONE ORDERED LIST — every step of every project of the conversation,
 * combined in the one order kept on this computer. Every step of the Run is a card: line 1 its name and
 * command, line 2 the project it runs in, when it starts and when it counts as
 * ready; move up / drag / move down on the left, remove on the right. Below
 * the list: "+ Add a step", the short "Suggested" list (its full list behind
 * "Show all"), and "Ask the agent to set it up". The footer says what Save
 * will do, and Save (or Save and run). The setup is the person's own, on this computer —
 * there is no choice of who it is saved for.
 *
 * All editing logic lives in `run-setup-model.ts` (pure, tested); this file
 * only draws the draft and turns clicks into model calls. Nothing here runs a
 * command: Save sends one request and main decides what starts, restarts or
 * stops (allowed-pattern #14).
 */
import type { RunGroupState, RunSaveAnswer, RunSaveChange, RunSuggestion, RunView } from '../../shared/run-setup'
import { RUN_STRINGS } from './run-group-model'
import {
  addStep,
  changeStep,
  draftToSetUp,
  isDirty,
  moveStep,
  removeStep,
  runsInChoices,
  saveChange,
  saveSentence,
  setupTitle,
  SETUP_STRINGS,
  startDraft,
  startsOptions,
  stepSuggestions,
  validateDraft,
  type DraftStep,
  type ReadyKind,
  type RunSetupDraft,
  type StepPatch,
} from './run-setup-model'

export interface RunSetupPanelDeps {
  /** The terminal area the panel docks in (positioned). */
  host: HTMLElement
  save(change: RunSaveChange): Promise<RunSaveAnswer>
  /** The group's live state — for the sentence saying what Save will do. */
  state(): RunGroupState | null
  /** Start the Run (Save and run). */
  startRun(): void
  /** Ask the agent in this conversation, or null when there is none. */
  askAgent(): (() => void) | null
  onSaved(view: RunView): void
  onClosed(): void
}


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

function select<T extends string>(
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>,
  value: T,
  label: string,
): HTMLSelectElement {
  const node = el('select', 'fl-run-input small')
  node.setAttribute('aria-label', label)
  for (const option of options) {
    const item = el('option', undefined, option.label)
    item.value = option.value
    item.selected = option.value === value
    item.disabled = option.disabled === true && option.value !== value
    node.appendChild(item)
  }
  return node
}

export class RunSetupPanel {
  readonly #deps: RunSetupPanelDeps
  #root: HTMLElement | null = null
  #view: RunView | null = null
  #draft: RunSetupDraft | null = null
  #suggestions: RunSuggestion[] = []
  #saving = false
  #error: string | null = null
  #footer: HTMLElement | null = null
  #dragId: string | null = null
  /** The step whose name field takes focus after the next render. */
  #focusId: string | null = null
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
    return this.#root !== null && !this.#root.hidden
  }

  /** Open but tucked away (a terminal tab was chosen): the draft is kept. */
  get isTucked(): boolean {
    return this.#root !== null && this.#root.hidden
  }

  /** Tuck the panel away to show a terminal, keeping the unsaved draft. */
  tuck(): void {
    if (this.#root === null || this.#root.hidden) return
    this.#root.hidden = true
    this.#deps.onClosed()
  }

  /** Bring a tucked panel back exactly as it was left. */
  untuck(): void {
    if (this.#root === null) return
    this.#root.hidden = false
    this.#render()
  }

  /** Open on a view; with no setup yet, the draft starts with one empty step. */
  open(view: RunView, options: { suggestions?: RunSuggestion[]; draft?: RunSetupDraft } = {}): void {
    this.#view = view
    this.#suggestions = options.suggestions ?? this.#suggestions
    this.#draft = options.draft ?? draftToSetUp(view.resolution.project)
    this.#error = null
    this.#focusId = this.#draft.steps.find((step) => step.isNew && step.name === '')?.id ?? null
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
    this.#draft = null
    this.#deps.onClosed()
  }

  /** Suggestions arrived after opening — the list updates. */
  setSuggestions(suggestions: RunSuggestion[]): void {
    this.#suggestions = suggestions
    if (this.#root !== null) this.#render()
  }

  /** The Run's state moved — only the footer can change. */
  stateChanged(): void {
    this.#renderFooter()
  }

  /** The setup changed elsewhere: an untouched draft takes the new steps. */
  setView(view: RunView): void {
    this.#view = view
    if (this.#root === null) return
    const draft = this.#draft
    if (draft === null || !isDirty(draft)) this.#draft = startDraft(view.resolution.project)
    this.#render()
  }

  #update(next: RunSetupDraft, rerender = true): void {
    this.#draft = next
    this.#error = null
    if (rerender) this.#render()
    else this.#renderFooter()
  }

  // ─── drawing ───────────────────────────────────────────────────────────────

  #render(): void {
    const root = this.#root
    const draft = this.#draft
    if (root === null) return
    const scrollTop = root.scrollTop
    root.textContent = ''
    // Full area, but the content sits in a readable column: the steps, and —
    // when there is room — the suggestions beside them (mockup B).
    const page = el('div', 'fl-run-page')
    root.appendChild(page)

    const head = el('div', 'fl-run-setup-head')
    const titles = el('div', 'fl-run-setup-titles')
    titles.appendChild(el('span', 'fl-run-setup-title', setupTitle(this.#view?.resolution.places ?? [], draft?.projectName ?? '')))
    head.appendChild(titles)
    page.appendChild(head)

    if (draft === null) {
      page.appendChild(el('p', 'fl-run-muted', RUN_STRINGS.failedToRead))
      return
    }
    titles.appendChild(el('p', 'fl-run-note', SETUP_STRINGS.intro))

    const body = el('div', 'fl-run-body')
    const main = el('div', 'fl-run-main')
    body.append(main)
    page.appendChild(body)
    for (const problem of this.#view?.resolution.project.problems ?? []) main.appendChild(el('p', 'fl-run-note', problem))

    const list = el('div', 'fl-run-steps')
    if (draft.steps.length === 0) list.appendChild(el('p', 'fl-run-muted', SETUP_STRINGS.empty))
    draft.steps.forEach((step, index) => list.appendChild(this.#card(draft, step, index)))
    main.appendChild(list)

    // Add a step, then Cancel and Save, right under the steps they act on.
    this.#footer = el('div', 'fl-run-setup-foot')
    main.appendChild(this.#footer)

    const ask = this.#deps.askAgent()
    const askButton = button(
      'fl-run-link',
      SETUP_STRINGS.askAgent,
      () => ask?.(),
      ask === null ? SETUP_STRINGS.askAgentNoConversation : SETUP_STRINGS.askAgentTitle,
    )
    askButton.disabled = ask === null
    main.appendChild(askButton)

    this.#renderFooter()
    root.scrollTop = scrollTop

    const focusId = this.#focusId
    this.#focusId = null
    if (focusId !== null) {
      queueMicrotask(() => root.querySelector<HTMLInputElement>(`[data-step-id="${CSS.escape(focusId)}"] .fl-run-name`)?.focus())
    }
  }

  #card(draft: RunSetupDraft, step: DraftStep, index: number): HTMLElement {
    const current = (): RunSetupDraft => this.#draft ?? draft
    const card = el('div', 'fl-run-card')
    card.classList.toggle('skipped', step.skipped)
    card.dataset['stepId'] = step.id

    // Left: move up, drag, move down.
    const move = el('div', 'fl-run-card-move')
    const up = iconButton('chevron-up', SETUP_STRINGS.moveUp, () => this.#update(moveStep(current(), step.id, index - 1)))
    up.disabled = index === 0
    const handle = el('span', 'fl-run-handle')
    handle.setAttribute('aria-hidden', 'true')
    const down = iconButton('chevron-down', SETUP_STRINGS.moveDown, () => this.#update(moveStep(current(), step.id, index + 1)))
    down.disabled = index === draft.steps.length - 1
    move.append(up, handle, down)
    handle.title = SETUP_STRINGS.dragHandle
    // Only the handle starts a drag, so text in the fields stays selectable.
    handle.addEventListener('mousedown', () => {
      card.draggable = true
    })
    card.addEventListener('dragstart', (event) => {
      this.#dragId = step.id
      event.dataTransfer?.setData('text/plain', step.id)
      card.classList.add('dragging')
    })
    card.addEventListener('dragend', () => {
      this.#dragId = null
      card.draggable = false
      card.classList.remove('dragging')
    })
    card.addEventListener('dragover', (event) => {
      if (this.#dragId !== null && this.#dragId !== step.id) event.preventDefault()
    })
    card.addEventListener('drop', (event) => {
      event.preventDefault()
      const dragged = this.#dragId
      this.#dragId = null
      if (dragged !== null && dragged !== step.id) this.#update(moveStep(current(), dragged, index))
    })
    card.appendChild(move)

    const body = el('div', 'fl-run-card-body')

    // Line 1: name, then the command.
    const line1 = el('div', 'fl-run-card-line')
    const name = el('input', 'fl-run-input fl-run-name')
    name.value = step.name
    name.placeholder = SETUP_STRINGS.namePlaceholder
    name.setAttribute('aria-label', SETUP_STRINGS.name)
    name.addEventListener('input', () => this.#update(changeStep(current(), step.id, { name: name.value }), false))
    // The next step's "Starts" names this one: redraw once the name is settled.
    name.addEventListener('change', () => this.#render())
    const command = el('input', 'fl-run-input mono fl-run-command')
    command.value = step.command
    command.placeholder = SETUP_STRINGS.commandPlaceholder
    command.setAttribute('aria-label', SETUP_STRINGS.command)
    command.spellcheck = false
    line1.append(name, command)
    body.appendChild(line1)

    // This step's own suggestions: only for the project its Runs in names,
    // matching what is typed, at most five. Anything else is typed by hand.
    const hints = el('div', 'fl-run-step-hints')
    hints.setAttribute('role', 'listbox')
    hints.setAttribute('aria-label', SETUP_STRINGS.suggested)
    const paintHints = (): void => {
      const now = current()
      const live = now.steps.find((candidate) => candidate.id === step.id)
      const show = live !== undefined && (document.activeElement === command || (live.isNew && live.command.trim() === ''))
      const found = show ? stepSuggestions(now, step.id, this.#suggestions) : []
      hints.textContent = ''
      hints.hidden = found.length === 0
      for (const suggestion of found) {
        const option = document.createElement('button')
        option.type = 'button'
        option.className = 'fl-run-hint'
        option.setAttribute('role', 'option')
        option.appendChild(el('span', 'fl-run-hint-command', suggestion.command))
        option.appendChild(el('span', 'fl-run-muted fl-run-hint-source', suggestion.source))
        // Keep the command field focused through the press, so blur does not hide the list first.
        option.addEventListener('mousedown', (event) => event.preventDefault())
        option.addEventListener('click', () => {
          const latest = current().steps.find((candidate) => candidate.id === step.id)
          const patch: StepPatch = { command: suggestion.command }
          if (latest !== undefined && latest.name.trim() === '') patch.name = suggestion.name
          this.#update(changeStep(current(), step.id, patch))
        })
        hints.appendChild(option)
      }
    }
    command.addEventListener('input', () => {
      this.#update(changeStep(current(), step.id, { command: command.value }), false)
      paintHints()
    })
    command.addEventListener('focus', paintHints)
    command.addEventListener('blur', () => paintHints())
    command.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !hints.hidden) {
        event.stopPropagation()
        hints.hidden = true
      }
    })
    body.appendChild(hints)
    queueMicrotask(paintHints)

    // Line 2: runs in, starts, ready when.
    const line2 = el('div', 'fl-run-card-line small')
    const inline = (label: string, ...controls: HTMLElement[]): HTMLElement => {
      const wrap = el('label', 'fl-run-inline')
      wrap.appendChild(el('span', 'fl-run-label', label))
      wrap.append(...controls)
      return wrap
    }
    const places = this.#view?.resolution.places ?? []
    const runsIn = select(runsInChoices(draft, places, step), step.runsIn ?? '', SETUP_STRINGS.runsIn)
    runsIn.addEventListener('change', () =>
      this.#update(changeStep(current(), step.id, { runsIn: runsIn.value === '' ? null : runsIn.value })),
    )
    const starts = select(startsOptions(draft.steps, index), step.start, SETUP_STRINGS.starts)
    starts.addEventListener('change', () =>
      this.#update(changeStep(current(), step.id, { start: starts.value === 'after-previous' ? 'after-previous' : 'now' })),
    )
    const readyKind = select<ReadyKind>(
      [
        { value: 'none', label: SETUP_STRINGS.readyNone },
        { value: 'port', label: SETUP_STRINGS.readyPort },
        { value: 'line', label: SETUP_STRINGS.readyLine },
      ],
      step.readyKind,
      SETUP_STRINGS.readyWhen,
    )
    readyKind.addEventListener('change', () =>
      this.#update(changeStep(current(), step.id, { readyKind: readyKind.value as ReadyKind })),
    )
    const readyControls: HTMLElement[] = [readyKind]
    if (step.readyKind !== 'none') {
      const value = el('input', step.readyKind === 'port' ? 'fl-run-input small fl-run-port' : 'fl-run-input small mono')
      value.value = step.readyValue
      value.placeholder = step.readyKind === 'port' ? SETUP_STRINGS.portPlaceholder : SETUP_STRINGS.linePlaceholder
      value.setAttribute('aria-label', value.placeholder)
      value.spellcheck = false
      if (step.readyKind === 'port') value.inputMode = 'numeric'
      value.addEventListener('input', () => this.#update(changeStep(current(), step.id, { readyValue: value.value }), false))
      readyControls.push(value)
    }
    line2.append(
      inline(SETUP_STRINGS.runsIn, runsIn),
      inline(SETUP_STRINGS.starts, starts),
      inline(SETUP_STRINGS.readyWhen, ...readyControls),
    )
    if (step.skipped) line2.appendChild(el('span', 'fl-run-skipped', SETUP_STRINGS.skipped))
    body.appendChild(line2)
    card.appendChild(body)

    // Right: the on/off switch (a step turned off stays for later), then remove.
    const tools = el('div', 'fl-run-card-tools')
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = `fl-run-toggle${step.skipped ? '' : ' on'}`
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-checked', step.skipped ? 'false' : 'true')
    toggle.setAttribute('aria-label', step.skipped ? SETUP_STRINGS.unskip : SETUP_STRINGS.skip)
    toggle.title = step.skipped ? SETUP_STRINGS.unskip : SETUP_STRINGS.skip
    toggle.appendChild(el('span', 'fl-run-toggle-knob'))
    toggle.addEventListener('click', () => this.#update(changeStep(current(), step.id, { skipped: !step.skipped })))
    tools.appendChild(toggle)
    tools.appendChild(iconButton('trash', SETUP_STRINGS.remove, () => this.#update(removeStep(current(), step.id))))
    card.appendChild(tools)
    return card
  }

  #renderFooter(): void {
    const foot = this.#footer
    const draft = this.#draft
    if (foot === null || draft === null) return
    foot.textContent = ''
    const row = el('div', 'fl-run-foot-actions')
    const add = button('fl-run-chip dashed', SETUP_STRINGS.addStep, () => {
      const current = this.#draft ?? draft
      const next = addStep(current)
      this.#focusId = next.steps[next.steps.length - 1]?.id ?? null
      this.#update(next)
    })
    add.classList.add('fl-run-add')
    row.appendChild(add)
    const problems = isDirty(draft) ? validateDraft(draft) : []
    const text = el('div', 'fl-run-foot-text')
    if (this.#error !== null) {
      text.appendChild(el('span', 'fl-run-error', this.#error))
    } else if (problems.length > 0) {
      for (const problem of problems) text.appendChild(el('span', 'fl-run-error', problem))
    } else {
      text.appendChild(el('span', undefined, saveSentence(draft, this.#deps.state())))
    }
    const actions = row
    actions.appendChild(el('span', 'fl-run-grow'))
    actions.appendChild(button('fl-run-btn', SETUP_STRINGS.cancel, () => this.close()))
    const blocked = this.#saving || !isDirty(draft) || problems.length > 0
    const nothingGoing = !(this.#deps.state()?.active ?? false)
    const save = button(
      nothingGoing ? 'fl-run-btn' : 'fl-run-btn primary',
      this.#saving ? SETUP_STRINGS.saving : SETUP_STRINGS.save,
      () => void this.#save(false),
    )
    save.disabled = blocked
    actions.appendChild(save)
    if (nothingGoing) {
      const saveAndRun = button('fl-run-btn primary', SETUP_STRINGS.saveAndRun, () => void this.#save(true))
      saveAndRun.disabled = blocked || draft.steps.every((step) => step.skipped)
      actions.appendChild(saveAndRun)
    }
    foot.appendChild(actions)
    foot.appendChild(text)
  }

  async #save(thenRun: boolean): Promise<void> {
    const draft = this.#draft
    if (this.#saving || draft === null || !isDirty(draft)) return
    this.#saving = true
    this.#renderFooter()
    let view: RunView | null = null
    try {
      const answer = await this.#deps.save(saveChange(draft))
      if (!answer.ok) {
        this.#error = answer.reason
        return
      }
      view = answer.view
    } catch (error) {
      console.warn('flow: saving the Run setup failed', error)
      this.#error = RUN_STRINGS.failedToAct
      return
    } finally {
      this.#saving = false
      if (this.#error !== null) this.#renderFooter()
    }
    if (view === null) return
    this.#deps.onSaved(view)
    this.close()
    if (thenRun) this.#deps.startRun()
  }
}

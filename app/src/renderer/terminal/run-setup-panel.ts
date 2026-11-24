/**
 * THE LAUNCHPAD PAGE — over the terminal area. "Set up Launchpad" opens it
 * straight away with one empty step to fill in.
 *
 * TWO SECTIONS — "Keeps running" (the steps Run starts, in order, each in its
 * own tab; "+ Add a running step" under them) and "Runs once" (one-time
 * actions, never started by Run, pressed from the Launchpad menu; each has
 * Runs in and "Ask before running"). "+ Add a one-time action" sits in the
 * footer row beside Cancel and Save.
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
 * A ONE-TIME ACTION runs a Command (one line) or a Script (a code editor with
 * line numbers and light colouring, run as one file): a Command | Script
 * switch beside its name. Pasting several lines into its command field makes
 * it a script holding them. Running steps are always one command.
 *
 * All editing logic lives in `run-setup-model.ts` (pure, tested); this file
 * only draws the draft and turns clicks into model calls. Nothing here runs a
 * command: Save sends one request and main decides what starts, restarts or
 * stops (allowed-pattern #14).
 */
import { guideInfoButton } from '../guides/guide-info'
import { scriptLineCount, type RunScriptProposal, type RunGroupState, type RunSaveAnswer, type RunSaveChange, type RunSuggestion, type RunView } from '../../shared/run-setup'
import { linesLabel, RUN_STRINGS } from './run-group-model'
import { createScriptEditor } from './script-editor'
import { addPracticeSteps, hasPracticeSteps, PRACTICE_STRINGS, removePracticeSteps } from './launchpad-practice'
import { currentPlatform } from '../platform-affordances'
import { proposalOutcome, scriptProposals } from './script-proposals'
import {
  addOnceAction,
  addStep,
  agentScriptLabel,
  agentScriptMode,
  agentScriptPrompt,
  agentWrittenNote,
  applyAgentScript,
  undoAgentScript,
  type AgentScriptUndo,
  changeStep,
  draftToSetUp,
  isDirty,
  moveStep,
  pasteIntoCommand,
  removeStep,
  runsInChoices,
  saveChange,
  saveSentence,
  scriptHint,
  setupTitle,
  SETUP_STRINGS,
  startDraft,
  startsOptions,
  stepsOfKind,
  stepSuggestions,
  switchBody,
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
  /** The conversation the page belongs to, or null when there is none (the agent buttons are off). */
  agentThread(): string | null
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

/**
 * What one action shows under its script after asking the agent:
 *   - `written` — the agent's script is in the editor; its changed lines are
 *     marked until the person types; Undo puts back what was there;
 *   - `offer` — the person typed meanwhile, so the script is only offered.
 * (Waiting is not here: it outlives the page, in `scriptProposals`.)
 */
type AgentNote =
  | { kind: 'written'; changed: number[]; count: number; undo: AgentScriptUndo }
  | { kind: 'offer'; script: string }

function sparkle(): HTMLElement {
  const glyph = document.createElement('fl-icon')
  glyph.setAttribute('name', 'sparkles')
  glyph.setAttribute('size', '12')
  return glyph
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
  /** The step whose script editor takes focus after the next render (it just became a script). */
  #focusScriptId: string | null = null
  /** Per action: the agent's script that arrived (written in, or offered). */
  readonly #notes = new Map<string, AgentNote>()
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
    this.#notes.clear()
    // Scripts the agent wrote while the page was closed are shown now, by the same rules.
    const thread = this.#deps.agentThread()
    if (thread !== null) for (const proposal of scriptProposals.take(thread)) this.#applyProposal(proposal)
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
    this.#notes.clear()
    this.#deps.onClosed()
  }

  /**
   * The agent's script for one action arrived. Shown at once when the page is
   * open (or tucked) for that conversation; otherwise false, and the caller
   * keeps it for the next time the page opens.
   */
  receiveProposal(proposal: RunScriptProposal): boolean {
    if (this.#root === null || this.#draft === null || this.#deps.agentThread() !== proposal.threadId) return false
    this.#applyProposal(proposal)
    if (!this.#root.hidden) this.#render()
    return true
  }

  /** Put an arrived script into the draft, or offer it — never saved, never run. */
  #applyProposal(proposal: RunScriptProposal): void {
    const draft = this.#draft
    if (draft === null) return
    const outcome = proposalOutcome(draft, proposal, scriptProposals.waits(proposal.threadId))
    if (outcome.kind === 'offer') {
      scriptProposals.stopWaiting(proposal.threadId, outcome.stepId)
      this.#notes.set(outcome.stepId, { kind: 'offer', script: proposal.script })
      return
    }
    let base = draft
    let stepId: string
    if (outcome.kind === 'add') {
      base = addStep(draft, { name: proposal.action.trim(), kind: 'once' })
      stepId = base.steps[base.steps.length - 1]?.id ?? ''
    } else {
      stepId = outcome.stepId
    }
    scriptProposals.stopWaiting(proposal.threadId, stepId)
    this.#writeAgentScript(base, stepId, proposal.script)
  }

  #writeAgentScript(draft: RunSetupDraft, stepId: string, script: string): void {
    const applied = applyAgentScript(draft, stepId, script)
    if (applied === null) return
    this.#notes.set(stepId, { kind: 'written', changed: applied.changed, count: applied.changed.length, undo: applied.undo })
    this.#draft = applied.draft
    this.#error = null
  }

  /** "Fix with the agent": one message into the conversation; this action waits for the answer. */
  #askAgentForScript(stepId: string): void {
    const thread = this.#deps.agentThread()
    const draft = this.#draft
    const step = draft?.steps.find((candidate) => candidate.id === stepId)
    if (thread === null || draft === null || step === undefined || step.kind !== 'once' || step.name.trim() === '') return
    const action = step.name.trim()
    scriptProposals.wait(thread, { stepId, action, body: step.body, script: step.script, command: step.command })
    this.#notes.delete(stepId)
    const text = agentScriptPrompt({
      action,
      project: step.runsIn ?? draft.projectName,
      mode: agentScriptMode(step),
      script: step.script,
      command: step.command,
    })
    document.dispatchEvent(new CustomEvent('flow:send-prompt', { detail: { threadId: thread, text } }))
    this.#render()
  }

  #isWaiting(stepId: string): boolean {
    const thread = this.#deps.agentThread()
    return thread !== null && scriptProposals.waitingFor(thread, stepId) !== null
  }

  /** The agent button of one action: its label follows the text, and it says why when it is off. */
  #agentButton(stepId: string): HTMLButtonElement {
    const node = button('fl-run-agent-btn', '', () => this.#askAgentForScript(stepId))
    node.dataset['agentFor'] = stepId
    this.#paintAgentButton(node, stepId)
    return node
  }

  #paintAgentButton(node: HTMLButtonElement, stepId: string): void {
    const step = this.#draft?.steps.find((candidate) => candidate.id === stepId)
    if (step === undefined) return
    node.textContent = ''
    node.append(sparkle(), document.createTextNode(agentScriptLabel(agentScriptMode(step))))
    const thread = this.#deps.agentThread()
    if (thread === null) {
      node.disabled = true
      node.title = SETUP_STRINGS.agentNeedsConversation
    } else if (step.name.trim() === '') {
      node.disabled = true
      node.title = SETUP_STRINGS.agentNeedsName
    } else {
      node.disabled = this.#isWaiting(stepId)
      node.title = node.disabled ? SETUP_STRINGS.agentWaiting : SETUP_STRINGS.agentTitle
    }
  }

  #repaintAgentButton(card: HTMLElement, stepId: string): void {
    const node = card.querySelector<HTMLButtonElement>('.fl-run-agent-btn')
    if (node !== null) this.#paintAgentButton(node, stepId)
  }

  /** The note under an action: waiting, written in, or offered. Null when there is none. */
  #agentNote(stepId: string): HTMLElement | null {
    const thread = this.#deps.agentThread()
    if (thread !== null && scriptProposals.waitingFor(thread, stepId) !== null) {
      const note = el('div', 'fl-run-agent-note waiting')
      note.setAttribute('role', 'status')
      const dot = el('span', 'fl-run-agent-dot')
      dot.setAttribute('aria-hidden', 'true')
      note.append(
        dot,
        el('span', undefined, SETUP_STRINGS.agentWaiting),
        button('fl-run-btn small', SETUP_STRINGS.agentStopWaiting, () => {
          scriptProposals.stopWaiting(thread, stepId)
          this.#render()
        }),
      )
      return note
    }
    const state = this.#notes.get(stepId)
    if (state === undefined) return null
    if (state.kind === 'written') {
      const note = el('div', 'fl-run-agent-note written')
      note.setAttribute('role', 'status')
      note.append(
        el('span', undefined, agentWrittenNote(state.count)),
        button('fl-run-btn small', SETUP_STRINGS.agentUndo, () => {
          const draft = this.#draft
          this.#notes.delete(stepId)
          if (draft !== null) this.#update(undoAgentScript(draft, stepId, state.undo))
        }),
      )
      return note
    }
    const note = el('div', 'fl-run-agent-note')
    note.setAttribute('role', 'status')
    note.append(
      el('span', undefined, SETUP_STRINGS.agentKept),
      button('fl-run-btn small', SETUP_STRINGS.agentUse, () => {
        const draft = this.#draft
        if (draft === null) return
        this.#writeAgentScript(draft, stepId, state.script)
        this.#render()
      }),
      button('fl-run-btn small', SETUP_STRINGS.agentDismiss, () => {
        this.#notes.delete(stepId)
        this.#render()
      }),
    )
    return note
  }

  /** Add a new one-time action to fill in (the menu's "Add one"). */
  addOnceAction(): void {
    const draft = this.#draft
    if (draft === null || this.#root === null) return
    const next = addOnceAction(draft)
    this.#focusId = next.steps[next.steps.length - 1]?.id ?? null
    this.#update(next)
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
    head.append(titles, guideInfoButton('launchpad-setup', 'Launchpad setup'))
    page.appendChild(head)

    if (draft === null) {
      page.appendChild(el('p', 'fl-run-muted', RUN_STRINGS.failedToRead))
      return
    }

    const body = el('div', 'fl-run-body')
    const main = el('div', 'fl-run-main')
    body.append(main)
    page.appendChild(body)
    for (const problem of this.#view?.resolution.project.problems ?? []) main.appendChild(el('p', 'fl-run-note', problem))

    // PRACTICE STEPS: a safe way to watch Launchpad work, added to the draft
    // only (nothing is kept before Save) and taken out again in one click.
    const practicing = hasPracticeSteps(draft)
    const practice = el('div', 'fl-run-practice')
    practice.appendChild(el('span', 'fl-run-practice-text', practicing ? PRACTICE_STRINGS.added : PRACTICE_STRINGS.offer))
    practice.appendChild(
      button('fl-run-chip', practicing ? PRACTICE_STRINGS.remove : PRACTICE_STRINGS.add, () => {
        const currentDraft = this.#draft ?? draft
        this.#update(
          hasPracticeSteps(currentDraft) ? removePracticeSteps(currentDraft) : addPracticeSteps(currentDraft, currentPlatform()),
        )
      }),
    )
    main.appendChild(practice)

    // Keeps running: the steps Run starts, in order.
    const services = stepsOfKind(draft, 'service')
    const running = this.#section(SETUP_STRINGS.keepsRunning, SETUP_STRINGS.keepsRunningNote)
    const list = el('div', 'fl-run-steps')
    if (services.length === 0) list.appendChild(el('p', 'fl-run-muted', SETUP_STRINGS.empty))
    services.forEach((step, index) => list.appendChild(this.#card(draft, step, index, services)))
    running.appendChild(list)
    const addRunning = button('fl-run-chip dashed', SETUP_STRINGS.addStep, () => {
      const next = addStep(this.#draft ?? draft)
      this.#focusId = next.steps[next.steps.length - 1]?.id ?? null
      this.#update(next)
    })
    addRunning.classList.add('fl-run-add')
    running.appendChild(addRunning)
    main.appendChild(running)

    // Runs once: one-time actions, pressed from the Launchpad menu.
    const actions = stepsOfKind(draft, 'once')
    const once = this.#section(SETUP_STRINGS.runsOnce, SETUP_STRINGS.runsOnceNote)
    const onceList = el('div', 'fl-run-steps')
    if (actions.length === 0) onceList.appendChild(el('p', 'fl-run-muted', SETUP_STRINGS.onceEmpty))
    actions.forEach((step, index) => onceList.appendChild(this.#card(draft, step, index, actions)))
    once.appendChild(onceList)
    main.appendChild(once)

    // Add a one-time action, then Cancel and Save, right under what they act on.
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
    const focusScriptId = this.#focusScriptId
    this.#focusScriptId = null
    if (focusScriptId !== null) {
      queueMicrotask(() =>
        root.querySelector<HTMLTextAreaElement>(`[data-step-id="${CSS.escape(focusScriptId)}"] .fl-run-editor-input`)?.focus(),
      )
    }
  }

  #section(title: string, note: string): HTMLElement {
    const section = el('section', 'fl-run-section')
    const head = el('div', 'fl-run-section-head')
    head.append(el('span', 'fl-run-section-name', title), el('p', 'fl-run-note', note))
    section.appendChild(head)
    return section
  }

  /** One entry's card. `index` is its place among `siblings` — the entries of its own kind. */
  #card(draft: RunSetupDraft, step: DraftStep, index: number, siblings: readonly DraftStep[]): HTMLElement {
    const current = (): RunSetupDraft => this.#draft ?? draft
    const once = step.kind === 'once'
    const card = el('div', 'fl-run-card')
    card.classList.toggle('once', once)
    card.classList.toggle('skipped', step.skipped)
    card.dataset['stepId'] = step.id

    // Left: move up, drag, move down.
    const move = el('div', 'fl-run-card-move')
    const up = iconButton('chevron-up', SETUP_STRINGS.moveUp, () => this.#update(moveStep(current(), step.id, index - 1)))
    up.disabled = index === 0
    const handle = el('span', 'fl-run-handle')
    handle.setAttribute('aria-hidden', 'true')
    const down = iconButton('chevron-down', SETUP_STRINGS.moveDown, () => this.#update(moveStep(current(), step.id, index + 1)))
    down.disabled = index === siblings.length - 1
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
    // An entry is dropped only among its own kind: a running step never becomes an action.
    const sameKind = (id: string | null): boolean =>
      id !== null && current().steps.find((candidate) => candidate.id === id)?.kind === step.kind
    card.addEventListener('dragover', (event) => {
      if (this.#dragId !== null && this.#dragId !== step.id && sameKind(this.#dragId)) event.preventDefault()
    })
    card.addEventListener('drop', (event) => {
      event.preventDefault()
      const dragged = this.#dragId
      this.#dragId = null
      if (dragged !== null && dragged !== step.id && sameKind(dragged)) this.#update(moveStep(current(), dragged, index))
    })
    card.appendChild(move)

    const body = el('div', 'fl-run-card-body')

    // Line 1: name, then the command.
    const line1 = el('div', 'fl-run-card-line')
    const name = el('input', 'fl-run-input fl-run-name')
    name.value = step.name
    name.placeholder = SETUP_STRINGS.namePlaceholder
    name.setAttribute('aria-label', SETUP_STRINGS.name)
    name.addEventListener('input', () => {
      this.#update(changeStep(current(), step.id, { name: name.value }), false)
      if (once) this.#repaintAgentButton(card, step.id)
    })
    // The next step's "Starts" names this one: redraw once the name is settled.
    name.addEventListener('change', () => this.#render())
    const command = el('input', 'fl-run-input mono fl-run-command')
    command.value = step.command
    command.placeholder = SETUP_STRINGS.commandPlaceholder
    command.setAttribute('aria-label', SETUP_STRINGS.command)
    command.spellcheck = false
    // While the agent writes this action's script, what it runs is not edited.
    if (once && this.#isWaiting(step.id)) command.readOnly = true
    const script = once && step.body === 'script'
    line1.appendChild(name)
    if (!script) line1.appendChild(command)
    if (once) line1.appendChild(this.#bodySwitch(step, current))
    body.appendChild(line1)
    if (script) body.appendChild(this.#scriptBox(step, current))
    // Several lines pasted into a one-time action's command make it a script holding them.
    command.addEventListener('paste', (event) => {
      const pasted = event.clipboardData?.getData('text/plain') ?? ''
      if (!pasted.includes('\n')) return
      const start = command.selectionStart ?? command.value.length
      const end = command.selectionEnd ?? start
      const next = pasteIntoCommand(current(), step.id, `${command.value.slice(0, start)}${pasted}${command.value.slice(end)}`)
      if (next === null) return
      event.preventDefault()
      this.#focusScriptId = step.id
      this.#update(next)
    })

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
    if (once) {
      // A one-time action: where it runs, and whether it asks first. No start mode, no ready check.
      const check = el('label', 'fl-run-check')
      const box = el('input')
      box.type = 'checkbox'
      box.checked = step.confirm
      box.title = SETUP_STRINGS.askFirstTitle
      box.addEventListener('change', () => this.#update(changeStep(current(), step.id, { confirm: box.checked })))
      // Until the person sets it, the command (or script) decides it (a migration asks first): keep the box in step.
      const follow = (): void => {
        box.checked = current().steps.find((candidate) => candidate.id === step.id)?.confirm ?? box.checked
      }
      command.addEventListener('input', follow)
      card.addEventListener('input', (event) => {
        if ((event.target as HTMLElement | null)?.classList.contains('fl-run-editor-input') === true) follow()
      })
      check.append(box, el('span', 'fl-run-label', SETUP_STRINGS.askFirst))
      check.title = SETUP_STRINGS.askFirstTitle
      line2.append(inline(SETUP_STRINGS.runsIn, runsIn), check)
      if (step.skipped) line2.appendChild(el('span', 'fl-run-skipped', SETUP_STRINGS.skipped))
      // A command's agent button sits at the end of the line under it; a script's is under its editor.
      if (!script) line2.appendChild(this.#agentButton(step.id))
      body.appendChild(line2)
      if (!script) {
        const note = this.#agentNote(step.id)
        if (note !== null) body.appendChild(note)
      }
      card.appendChild(body)
      card.appendChild(this.#tools(step, current))
      return card
    }
    const starts = select(startsOptions(siblings, index), step.start, SETUP_STRINGS.starts)
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

    card.appendChild(this.#tools(step, current))
    return card
  }

  /** A one-time action's Command | Script switch. */
  #bodySwitch(step: DraftStep, current: () => RunSetupDraft): HTMLElement {
    const group = el('div', 'fl-run-segment')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', SETUP_STRINGS.bodyGroup)
    const choices: Array<{ body: DraftStep['body']; label: string }> = [
      { body: 'command', label: SETUP_STRINGS.bodyCommand },
      { body: 'script', label: SETUP_STRINGS.bodyScript },
    ]
    for (const choice of choices) {
      const on = step.body === choice.body
      const node = button(`fl-run-segment-btn${on ? ' active' : ''}`, choice.label, () => {
        if (current().steps.find((candidate) => candidate.id === step.id)?.body === choice.body) return
        if (choice.body === 'script') this.#focusScriptId = step.id
        this.#update(switchBody(current(), step.id, choice.body))
      })
      node.setAttribute('aria-pressed', String(on))
      group.appendChild(node)
    }
    return group
  }

  /** A script's editor and the line under it: where it runs, how many lines it has, and the agent button. */
  #scriptBox(step: DraftStep, current: () => RunSetupDraft): HTMLElement {
    const box = el('div', 'fl-run-script')
    const lines = el('span', 'fl-run-script-lines', linesLabel(scriptLineCount(step.script)))
    const written = this.#notes.get(step.id)
    const agentButton = this.#agentButton(step.id)
    const editor = createScriptEditor({
      value: step.script,
      label: SETUP_STRINGS.script,
      chatLabel: () => current().steps.find((candidate) => candidate.id === step.id)?.name.trim() || SETUP_STRINGS.script,
      marks: written?.kind === 'written' ? written.changed : [],
      readOnly: this.#isWaiting(step.id),
      onInput: (value) => {
        this.#update(changeStep(current(), step.id, { script: value }), false)
        lines.textContent = linesLabel(scriptLineCount(value))
        this.#paintAgentButton(agentButton, step.id)
        // Typing takes the agent's line marks away; the note and its Undo stay.
        const note = this.#notes.get(step.id)
        if (note?.kind === 'written' && note.changed.length > 0) {
          this.#notes.set(step.id, { ...note, changed: [] })
          editor.setMarks([])
        }
      },
    })
    const hint = el('div', 'fl-run-script-hint')
    const project = step.runsIn ?? current().projectName
    const tail = el('span', 'fl-run-script-tail')
    tail.append(lines, agentButton)
    hint.append(el('span', undefined, scriptHint(project)), tail)
    box.append(editor.element, hint)
    const note = this.#agentNote(step.id)
    if (note !== null) box.appendChild(note)
    return box
  }

  /** Right of a card: the on/off switch (an entry turned off stays for later), then remove. */
  #tools(step: DraftStep, current: () => RunSetupDraft): HTMLElement {
    const once = step.kind === 'once'
    const off = once ? SETUP_STRINGS.skipOnce : SETUP_STRINGS.skip
    const on = once ? SETUP_STRINGS.unskipOnce : SETUP_STRINGS.unskip
    const tools = el('div', 'fl-run-card-tools')
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = `fl-run-toggle${step.skipped ? '' : ' on'}`
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-checked', step.skipped ? 'false' : 'true')
    toggle.setAttribute('aria-label', step.skipped ? on : off)
    toggle.title = step.skipped ? on : off
    toggle.appendChild(el('span', 'fl-run-toggle-knob'))
    toggle.addEventListener('click', () => this.#update(changeStep(current(), step.id, { skipped: !step.skipped })))
    tools.appendChild(toggle)
    tools.appendChild(
      iconButton('trash', once ? SETUP_STRINGS.removeOnce : SETUP_STRINGS.remove, () =>
        this.#update(removeStep(current(), step.id)),
      ),
    )
    return tools
  }

  #renderFooter(): void {
    const foot = this.#footer
    const draft = this.#draft
    if (foot === null || draft === null) return
    foot.textContent = ''
    const row = el('div', 'fl-run-foot-actions')
    const add = button('fl-run-chip dashed', SETUP_STRINGS.addOnce, () => {
      const current = this.#draft ?? draft
      const next = addOnceAction(current)
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
      // Save and run starts the running steps: nothing to start, nothing to offer.
      saveAndRun.disabled = blocked || !draft.steps.some((step) => step.kind === 'service' && !step.skipped && step.command.trim() !== '')
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
      console.warn('flow: saving the Launchpad failed', error)
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

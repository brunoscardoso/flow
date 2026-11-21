/**
 * The work row — ONE line for everything between a person's message and the
 * request's final answer (plan_chat-cleanup, FR-1–FR-5).
 *
 *   closed  ▸ Worked 6 min · 25 tools · 1 failed · 3 files changed   Opus 4.8
 *   opened  the same line over numbered steps; each step opens to its message
 *           and its tools, built exactly as the feed builds them elsewhere
 *   live    ● Working · 3 min · 19 tools          +180 −40 in 2 files  Opus 4.8
 *             Reading the frontend hooks…
 *
 * A step that changed files carries a chip per file under its line
 * (`request-file-changes-view.ts`), visible whenever the row is open — a
 * press opens that file's diff without opening the step.
 *
 * Every word comes from `request-row-model.ts`; this file only draws. Like a
 * turn row it carries no `dataset.entryId` (the reconcile reuse harvest keys
 * single entries, and a fold over many entries is none of them).
 *
 * In place, never rebuilt (NFR-3): `update` rewrites the line, the newest
 * step and the step list by index — a live row takes one call per stream
 * batch, and a batch must not cost a repaint of the row, let alone the feed.
 *
 * Step contents are built LAZILY, on first open (or when the pane asks for a
 * step's container to append live cards into): a settled request of fifty
 * tools costs one line until somebody wants to read it.
 */
import type { RequestSummary } from './request-summary'
import { requestRowView, type RequestRowStepInput, type RequestRowView } from './request-row-model'
import { liveTotalsText, type RequestFileChanges } from './request-file-changes'
import { fileChangeChips, fileChipsKey, type FileChangeActions } from './request-file-changes-view'
import { connectorIconLoader, connectorLabelOptions, createConnectorIcon } from './connector-icon'
import { workingMark } from '../components/fl-loading'

export interface RequestRowOptions {
  /** The INITIAL state; not reported through `onToggle` (see TurnRow). */
  expanded?: boolean
  onToggle?: (expanded: boolean) => void
  /** Build a step's contents (its message, then its tools) — called once per
   *  step, the first time it is opened or its container is asked for. */
  buildStep?: (index: number) => HTMLElement[]
  /** Whether a step was open before a rebuild. */
  isStepExpanded?: (index: number) => boolean
  onStepToggle?: (index: number, expanded: boolean) => void
  /** What pressing a step's file chip does. Without it no chips are drawn. */
  fileActions?: FileChangeActions
}

interface StepNodes {
  item: HTMLLIElement
  header: HTMLDivElement
  number: HTMLSpanElement
  text: HTMLSpanElement
  count: HTMLSpanElement
  detail: HTMLDivElement
  /** The step's file chips, between its line and its contents. */
  chips: HTMLElement | null
  chipsKey: string
  built: boolean
  expanded: boolean
  /** What was last drawn, so an unchanged step costs no DOM write. */
  drawn: string
}

export class RequestRow {
  readonly element: HTMLElement
  #header: HTMLDivElement
  #marker: HTMLSpanElement
  #liveMark: HTMLElement | null = null
  #lead: HTMLSpanElement
  #facts: HTMLSpanElement
  /** Small icons of the connectors the request used (plan_connectors, FR-7). */
  #connectors: HTMLSpanElement
  #drawnConnectors = ''
  #model: HTMLSpanElement
  #changes: HTMLSpanElement
  #now: HTMLDivElement
  #list: HTMLOListElement
  #steps: StepNodes[] = []
  #expanded: boolean
  #options: RequestRowOptions
  #drawnLine = ''

  constructor(
    summary: RequestSummary,
    steps: readonly RequestRowStepInput[],
    live: boolean,
    options: RequestRowOptions = {},
    files: RequestFileChanges | null = null,
  ) {
    injectRequestRowStyles()
    this.#options = options
    this.#expanded = options.expanded ?? false

    this.element = document.createElement('div')
    this.element.className = 'fl-request-row'

    const header = document.createElement('div')
    header.className = 'fl-request-row-header'
    header.setAttribute('role', 'button')
    header.tabIndex = 0
    this.#header = header

    this.#marker = document.createElement('span')
    this.#marker.className = 'fl-request-row-marker'
    this.#marker.setAttribute('aria-hidden', 'true')
    this.#lead = document.createElement('span')
    this.#lead.className = 'fl-request-row-lead'
    this.#facts = document.createElement('span')
    this.#facts.className = 'fl-request-row-facts'
    this.#connectors = document.createElement('span')
    this.#connectors.className = 'fl-request-row-connectors'
    this.#connectors.hidden = true
    this.#model = document.createElement('span')
    this.#model.className = 'fl-request-row-model'
    this.#changes = document.createElement('span')
    this.#changes.className = 'fl-request-row-changes'
    this.#changes.hidden = true
    header.append(this.#marker, this.#lead, this.#facts, this.#connectors, this.#changes, this.#model)

    const toggle = (): void => this.setExpanded(!this.#expanded)
    header.addEventListener('click', toggle)
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })

    this.#now = document.createElement('div')
    this.#now.className = 'fl-request-row-now'

    this.#list = document.createElement('ol')
    this.#list.className = 'fl-request-row-steps'

    this.element.append(header, this.#now, this.#list)
    this.update(summary, steps, live, files)
    this.#applyExpanded()
  }

  get expanded(): boolean {
    return this.#expanded
  }

  /** Redraw the counts, the step list and the live line in place (note 18). */
  update(
    summary: RequestSummary,
    steps: readonly RequestRowStepInput[],
    live: boolean,
    files: RequestFileChanges | null = null,
  ): void {
    this.#draw(requestRowView(summary, steps, live, connectorLabelOptions()))
    this.#drawFiles(live, files)
  }

  /** The live total on the line, and each step's chips. */
  #drawFiles(live: boolean, files: RequestFileChanges | null): void {
    const totals = live && files !== null ? liveTotalsText(files) : ''
    if (this.#changes.textContent !== totals) this.#changes.textContent = totals
    this.#changes.hidden = totals === ''
    const actions = this.#options.fileActions
    if (actions === undefined) return
    this.#steps.forEach((nodes, index) => {
      const stepFiles = files?.steps[index] ?? []
      const key = fileChipsKey(stepFiles)
      if (key === nodes.chipsKey) return
      nodes.chipsKey = key
      nodes.chips?.remove()
      nodes.chips = fileChangeChips(stepFiles, actions)
      if (nodes.chips !== null) nodes.item.insertBefore(nodes.chips, nodes.detail)
    })
  }

  /**
   * The container a step's contents live in, built if it was not yet — the
   * pane appends a live request's streaming text and tool cards here. Null
   * for a step the row does not have.
   */
  stepDetail(index: number): HTMLElement | null {
    const step = this.#steps[index]
    if (step === undefined) return null
    this.#ensureBuilt(index)
    return step.detail
  }

  /** Open the row, without reporting it as the reader's choice. */
  reveal(): void {
    if (this.#expanded) return
    this.#expanded = true
    this.#applyExpanded()
  }

  /** Open the row and one step — the reconcile's expand-restore, which is
   *  restoring a state rather than recording a choice (see TurnRow.reveal). */
  revealStep(index: number): void {
    this.reveal()
    const step = this.#steps[index]
    if (step === undefined || step.expanded) return
    this.#setStepExpanded(index, true, false)
  }

  setExpanded(value: boolean): void {
    this.#expanded = value
    this.#applyExpanded()
    this.#options.onToggle?.(value)
  }

  #draw(view: RequestRowView): void {
    this.element.classList.toggle('live', view.live)
    // A live row wears Flow's loading mark where the closed row has its caret.
    if (view.live && this.#liveMark === null) {
      this.#liveMark = workingMark(14)
      this.#liveMark.classList.add('fl-request-row-live')
      this.#liveMark.style.color = 'var(--fl-color-accent)'
      this.#marker.after(this.#liveMark)
    } else if (!view.live && this.#liveMark !== null) {
      this.#liveMark.remove()
      this.#liveMark = null
    }
    this.element.classList.toggle('failed', view.facts.some((fact) => fact.failed))

    // The line: rewritten only when it changed. Most stream batches carry
    // text, not tools, so the counts stay put and so does the DOM.
    const line = [view.live, view.lead, view.label, view.model ?? ''].join('|')
    if (line !== this.#drawnLine) {
      this.#drawnLine = line
      this.#lead.textContent = view.lead
      this.#facts.textContent = ''
      // No dot between the lead and the first fact — the gap separates
      // them, as the approved design draws it.
      view.facts.forEach((fact, index) => {
        if (index > 0) {
          const separator = document.createElement('span')
          separator.className = 'fl-request-row-sep'
          separator.textContent = String.fromCharCode(183)
          this.#facts.appendChild(separator)
        }
        const span = document.createElement('span')
        span.className = fact.failed ? 'fl-request-row-fact fl-request-row-failed' : 'fl-request-row-fact'
        span.textContent = fact.text
        this.#facts.appendChild(span)
      })
      this.#model.textContent = view.model ?? ''
      this.#model.hidden = view.model === null
      if (view.modelId !== null) this.#model.title = view.modelId
      this.#header.title = view.label
      this.#header.setAttribute('aria-label', view.model === null ? view.label : `${view.label} · ${view.model}`)
    }

    // The connectors used: redrawn only when the set changed, so a loaded
    // icon is not dropped by the next stream batch.
    const connectorsKey = view.connectors.map((c) => c.serverName + '|' + c.connectorName).join(',')
    if (connectorsKey !== this.#drawnConnectors) {
      this.#drawnConnectors = connectorsKey
      this.#connectors.textContent = ''
      const load = connectorIconLoader()
      for (const used of view.connectors) {
        const icon = createConnectorIcon({
          name: used.serverName,
          displayName: used.connectorName,
          size: 16,
          load,
        })
        icon.title = used.connectorName
        this.#connectors.appendChild(icon)
      }
      this.#connectors.hidden = view.connectors.length === 0
      this.#connectors.title = view.connectors.map((c) => c.connectorName).join(', ')
    }

    const newest = view.newestStep ?? ''
    if (this.#now.textContent !== newest) this.#now.textContent = newest
    this.#now.hidden = !view.live || newest === ''

    view.steps.forEach((step, index) => {
      const nodes = this.#steps[index] ?? this.#addStep(index)
      const drawn = [step.text, ...step.count.map((part) => part.text)].join('|')
      if (drawn === nodes.drawn) return
      nodes.drawn = drawn
      nodes.text.textContent = step.text
      nodes.text.title = step.text
      nodes.count.textContent = ''
      step.count.forEach((part, partIndex) => {
        if (partIndex > 0) nodes.count.append(' ' + String.fromCharCode(183) + ' ')
        const span = document.createElement('span')
        if (part.failed) span.className = 'fl-request-row-failed'
        span.textContent = part.text
        nodes.count.appendChild(span)
      })
      nodes.item.classList.toggle('failed', step.failed > 0)
    })
    // A step is never removed from a live row (steps only grow), but a row
    // redrawn with fewer steps must not keep stale ones.
    while (this.#steps.length > view.steps.length) {
      this.#steps.pop()?.item.remove()
    }
    this.#list.hidden = !this.#expanded || this.#steps.length === 0
  }

  #addStep(index: number): StepNodes {
    const item = document.createElement('li')
    item.className = 'fl-request-row-step'
    const header = document.createElement('div')
    header.className = 'fl-request-row-step-header'
    header.setAttribute('role', 'button')
    header.tabIndex = 0
    const number = document.createElement('span')
    number.className = 'fl-request-row-step-n'
    number.textContent = String(index + 1)
    const text = document.createElement('span')
    text.className = 'fl-request-row-step-text'
    const count = document.createElement('span')
    count.className = 'fl-request-row-step-count'
    header.append(number, text, count)
    const detail = document.createElement('div')
    detail.className = 'fl-request-row-step-detail'
    detail.hidden = true
    item.append(header, detail)
    this.#list.appendChild(item)

    const nodes: StepNodes = {
      item,
      header,
      number,
      text,
      count,
      detail,
      chips: null,
      chipsKey: '',
      built: false,
      expanded: false,
      drawn: '',
    }
    this.#steps[index] = nodes
    const toggle = (): void => this.#setStepExpanded(index, !nodes.expanded, true)
    header.addEventListener('click', toggle)
    header.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        toggle()
      }
    })
    if (this.#options.isStepExpanded?.(index) === true) this.#setStepExpanded(index, true, false)
    return nodes
  }

  #ensureBuilt(index: number): void {
    const step = this.#steps[index]
    if (step === undefined || step.built) return
    step.built = true
    for (const child of this.#options.buildStep?.(index) ?? []) step.detail.appendChild(child)
  }

  #setStepExpanded(index: number, value: boolean, report: boolean): void {
    const step = this.#steps[index]
    if (step === undefined) return
    if (value) this.#ensureBuilt(index)
    step.expanded = value
    step.detail.hidden = !value
    step.item.classList.toggle('expanded', value)
    step.header.setAttribute('aria-expanded', String(value))
    if (report) this.#options.onStepToggle?.(index, value)
  }

  #applyExpanded(): void {
    this.#list.hidden = !this.#expanded || this.#steps.length === 0
    this.element.classList.toggle('expanded', this.#expanded)
    this.#header.setAttribute('aria-expanded', String(this.#expanded))
  }
}

// ── Styles (light DOM) ───────────────────────────────────────────────────────
// Flow tokens only, so light and dark both come from the theme.

let requestRowStylesInjected = false

/** The text under a person's message that went into a running turn. */
export const SENT_WHILE_WORKING_TEXT = 'Sent while the agent works'

/**
 * The small note under a message the person sent while the agent was working
 * (plan_mid-run-subtasks): the message went into the running turn, so the
 * request above it reads as continued rather than answered.
 */
export function sentWhileWorkingNote(): HTMLElement {
  injectRequestRowStyles()
  const note = document.createElement('div')
  note.className = 'fl-request-midrun-note'
  note.textContent = SENT_WHILE_WORKING_TEXT
  return note
}

function injectRequestRowStyles(): void {
  if (requestRowStylesInjected) return
  requestRowStylesInjected = true
  const style = document.createElement('style')
  style.textContent = `
    .fl-request-midrun-note {
      padding: 2px var(--fl-space-sm) 0;
      font-size: var(--fl-text-caption-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-request-row {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-xs);
      padding: var(--fl-space-xs) var(--fl-space-sm);
      border: var(--fl-border-width) solid var(--fl-color-border);
      border-radius: var(--fl-radius-row);
      font-size: var(--fl-text-ui-size);
      color: var(--fl-color-text-secondary);
    }
    .fl-request-row-header {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      /* Wraps rather than truncates: the failure count is the one fact that
         must stay on the closed row's face (FR-3), so a narrow pane moves the
         model to a second line instead of cutting "1 failed" to an ellipsis. */
      flex-wrap: wrap;
      row-gap: 2px;
      min-height: 24px;
      cursor: pointer;
      user-select: none;
    }
    .fl-request-row-marker {
      flex: none;
      width: 0;
      height: 0;
      margin: 0 2px;
      border-left: 4px solid var(--fl-color-text-secondary);
      border-top: 4px solid transparent;
      border-bottom: 4px solid transparent;
      transition: transform 0.12s ease;
    }
    .fl-request-row.expanded .fl-request-row-marker { transform: rotate(90deg); }
    .fl-request-row.live .fl-request-row-marker { display: none; }
    @media (prefers-reduced-motion: reduce) {
      .fl-request-row-marker { transition: none; }
    }
    .fl-request-row-lead {
      flex: none;
      color: var(--fl-color-text);
      font-weight: var(--fl-text-ui-weight-medium);
    }
    .fl-request-row-facts {
      flex: 0 1 auto;
      min-width: 0;
    }
    .fl-request-row-lead, .fl-request-row-fact, .fl-request-row-model { white-space: nowrap; }
    .fl-request-row-connectors {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .fl-request-row-connectors[hidden] { display: none; }
    .fl-request-row-sep { padding: 0 var(--fl-space-xs); }
    .fl-request-row-failed { color: var(--fl-color-error); }
    .fl-request-row-model {
      flex: none;
      margin-left: auto;
      font-size: var(--fl-text-caption-size);
    }
    /* The live running total sits right, before the model; with it shown the
       model no longer needs to push itself right. */
    .fl-request-row-changes {
      flex: none;
      margin-left: auto;
      font-size: var(--fl-text-caption-size);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .fl-request-row-changes[hidden] { display: none; }
    .fl-request-row-changes:not([hidden]) + .fl-request-row-model { margin-left: 0; }
    .fl-request-row-now {
      padding-left: 18px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .fl-request-row-steps {
      list-style: none;
      margin: 0;
      padding: var(--fl-space-xs) 0 0 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
      border-top: var(--fl-border-width) dashed var(--fl-color-border);
    }
    .fl-request-row-steps[hidden] { display: none; }
    .fl-request-row-step-header {
      display: flex;
      align-items: center;
      gap: var(--fl-space-sm);
      min-height: 22px;
      padding: 0 var(--fl-space-xs);
      border-radius: var(--fl-radius-row);
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
    }
    .fl-request-row-step-header:hover { background: var(--fl-color-surface-raised); }
    .fl-request-row-step-n {
      flex: none;
      width: 18px;
      font-variant-numeric: tabular-nums;
    }
    .fl-request-row-step-text {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--fl-color-text);
      opacity: 0.85;
    }
    .fl-request-row-step-count {
      flex: none;
      margin-left: auto;
      font-size: var(--fl-text-caption-size);
      font-variant-numeric: tabular-nums;
    }
    .fl-request-row-step.failed .fl-request-row-step-count { color: var(--fl-color-error); }
    .fl-request-row-step-detail {
      display: flex;
      flex-direction: column;
      gap: var(--fl-space-sm);
      margin: var(--fl-space-xs) 0 var(--fl-space-sm) var(--fl-space-sm);
      padding-left: var(--fl-space-sm);
      border-left: var(--fl-border-width) solid var(--fl-color-border);
      white-space: normal;
    }
    .fl-request-row-step-detail[hidden] { display: none; }
  `
  document.head.appendChild(style)
}
